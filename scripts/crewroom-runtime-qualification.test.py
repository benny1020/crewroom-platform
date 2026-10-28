#!/usr/bin/env python3
"""Offline receipt-gate and exact-owner cleanup checks; no Docker or product execution."""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("crewroom-runtime-qualification.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)
export_spec = importlib.util.spec_from_file_location("qualification_export", Path(__file__).with_name("crewroom-runtime-export-binaries.py"))
qualification_export = importlib.util.module_from_spec(export_spec)
export_spec.loader.exec_module(qualification_export)


def report(titles):
    return {"success": True, "numFailedTests": 0, "numPassedTests": len(titles),
            "testResults": [{"assertionResults": [{"title": title, "status": "passed"} for title in titles]}]}


class ReceiptGateTests(unittest.TestCase):
    def test_all_eight_real_process_cases_must_pass(self):
        counts = qualification.report_counts(report(qualification.LOCAL_CASES), qualification.LOCAL_CASES)
        self.assertEqual((counts["passed"], counts["skipped"], counts["status"]), (8, 0, "passed"))

    def test_missing_or_duplicate_title_is_failure(self):
        for titles in [qualification.LOCAL_CASES[:-1], qualification.LOCAL_CASES + [qualification.LOCAL_CASES[0]]]:
            self.assertEqual(qualification.report_counts(report(titles), qualification.LOCAL_CASES)["status"], "failed")

    def test_selected_skips_never_qualify(self):
        for status in ["pending", "skipped", "todo", "disabled"]:
            value = report(qualification.LOCAL_CASES)
            value["testResults"][0]["assertionResults"][0]["status"] = status
            self.assertEqual(qualification.report_counts(value, qualification.LOCAL_CASES)["status"], "failed")

    def test_remote_five_must_pass_and_unselected_pending_is_separate(self):
        value = report(qualification.REMOTE_CASES)
        value["testResults"][0]["assertionResults"].append({"title": qualification.LOCAL_CASES[0], "status": "pending"})
        counts = qualification.report_counts(value, qualification.REMOTE_CASES, only_selected=True)
        self.assertEqual((counts["passed"], counts["skipped"], counts["unselectedSkipped"], counts["status"]), (5, 0, 1, "passed"))

    def test_unexpected_remote_pass_or_report_failure_cannot_qualify(self):
        extra = report(qualification.REMOTE_CASES + ["unselected case"])
        failed = report(qualification.REMOTE_CASES)
        failed["success"] = False
        for value in [extra, failed]:
            self.assertEqual(qualification.report_counts(value, qualification.REMOTE_CASES, only_selected=True)["status"], "failed")

    def test_revision_requires_full_hex_commit(self):
        self.assertEqual(qualification.revision("a" * 40), "a" * 40)
        for value in ["main", "HEAD", "abc", "$(echo x)", "g" * 40]:
            with self.assertRaises(qualification.QualificationFailure):
                qualification.revision(value)


class PassivePhaseTests(unittest.TestCase):
    def snapshot(self):
        return {"version": 1, "status": "available", "diagnosticOnly": True, "workerCwdRelation": "product_root", "pulseCount": 9,
                "lastPulseMs": 9000, "active": [{"title": qualification.REMOTE_CASES[0], "phase": "execute_session", "invocation": 1}],
                "events": [{"title": qualification.REMOTE_CASES[0], "phase": "docker_execute", "invocation": 2, "edge": "leave", "sequence": 3,
                            "elapsedMs": 10, "exitCode": 0, "timedOut": False, "private": "SYNTHETIC_PRIVATE_PHASE"}], "private": "SYNTHETIC_PRIVATE_PHASE"}

    def test_phase_snapshot_reconstructs_only_bounded_enums_and_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "phases.json"
            filename.write_text(json.dumps(self.snapshot()))
            result = qualification.phase_diagnostics(filename)
            self.assertEqual(result["status"], "available")
            self.assertEqual(result["workerCwdRelation"], "product_root")
            self.assertEqual(result["active"][0]["phase"], "execute_session")
            self.assertNotIn("SYNTHETIC_PRIVATE_PHASE", json.dumps(result))

    def test_invalid_phase_title_type_and_bounds_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "phases.json"
            for key, value in [("title", "private"), ("phase", "private"), ("invocation", True), ("sequence", 10000000), ("edge", "private")]:
                report = self.snapshot()
                report["events"][0][key] = value
                filename.write_text(json.dumps(report))
                self.assertEqual(qualification.phase_diagnostics(filename)["status"], "unavailable")

    def test_generated_overlay_leaves_original_sources_and_cwd_contract_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            source, private = Path(directory) / "product", Path(directory) / "private"
            (source / "server").mkdir(parents=True)
            private.mkdir()
            original = source / "server/vitest.config.ts"
            original.write_text("export default {test:{setupFiles:['./original.ts']}};")
            before = original.read_bytes()
            config, receipt = qualification.prepare_phase_overlay(source, private)
            self.assertEqual(original.read_bytes(), before)
            text = config.read_text()
            for contract in ["...original", "configFile:false", "...original.test", "...original.test.setupFiles", 'name:"@paperclipai/server"']:
                self.assertIn(contract, text)
            self.assertNotIn("chdir", text)
            self.assertTrue(receipt["diagnosticOnly"])
            self.assertEqual(receipt["configSha256"], qualification.digest(config))


class InspectorCaptureTests(unittest.TestCase):
    def capture(self):
        return {"version": 1, "nonce": "a" * 32, "diagnosticOnly": True, "coordinateSpace": "runtime_transformed", "phase": "close_idle",
                "title": qualification.REMOTE_CASES[0], "invocation": 1, "status": "captured", "reason": "frames_captured",
                "paused": True, "resumeConfirmed": True, "disconnectConfirmed": True,
                "frames": [{"file": qualification.STACK_FILES[0], "line": 5, "column": 2, "private": "SYNTHETIC_PRIVATE_STACK"}]}

    def test_capture_requires_exact_nonce_resume_disconnect_and_current_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            filename, phases = Path(directory) / "capture.json", Path(directory) / "phases.json"
            phase = PassivePhaseTests().snapshot()
            phase["active"][0]["phase"] = "close_idle"
            phases.write_text(json.dumps(phase))
            value = self.capture()
            filename.write_text(json.dumps(value))
            self.assertTrue(qualification.diagnostic_capture_ready(filename, "a" * 32, phases))
            self.assertNotIn("SYNTHETIC_PRIVATE_STACK", json.dumps(qualification.stack_diagnostics(filename, "a" * 32)))
            for key, invalid in [("nonce", "b" * 32), ("resumeConfirmed", False), ("disconnectConfirmed", False), ("frames", []), ("invocation", 2)]:
                changed = {**value, key: invalid}
                filename.write_text(json.dumps(changed))
                self.assertFalse(qualification.diagnostic_capture_ready(filename, "a" * 32, phases))

    def test_capture_rejects_private_source_and_invalid_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "capture.json"
            for frame in [{"file": "/private/key", "line": 1, "column": 1}, {"file": qualification.STACK_FILES[0], "line": True, "column": 1}]:
                value = self.capture()
                value["frames"] = [frame]
                filename.write_text(json.dumps(value))
                self.assertEqual(qualification.stack_diagnostics(filename, "a" * 32)["status"], "unavailable")

    def test_polling_stops_only_on_confirmed_capture_and_keeps_original_deadline(self):
        process = Mock(args=["synthetic"])
        process.communicate.side_effect = subprocess.TimeoutExpired("synthetic", 0.25)
        with self.assertRaises(qualification.DiagnosticCaptureComplete):
            qualification.communicate_with_diagnostic_capture(process, 1200, lambda: True)
        with patch.object(qualification.time, "monotonic", side_effect=[0, 0, 1200]):
            with self.assertRaises(subprocess.TimeoutExpired):
                qualification.communicate_with_diagnostic_capture(process, 1200, lambda: False)

    def test_actual_early_stop_reaps_only_its_owned_process(self):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
        try:
            with self.assertRaises(qualification.DiagnosticCaptureComplete):
                qualification.communicate_with_diagnostic_capture(child, 5, lambda: True)
            self.assertEqual(os.getpgid(child.pid), child.pid)
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=3)
            self.assertIsNotNone(child.returncode)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)


class SafeDiagnosticsTests(unittest.TestCase):
    source = Path("/synthetic/product")

    def test_numeric_assertion_has_only_fixed_class_comparison_and_relative_fixture(self):
        fixture = qualification.RECOVERY_FILE
        failure = f"AssertionError: expected 5 to be 8 // Object.is equality\n    at runCase ({self.source}/{fixture}:1512:13)\n    at /private/session-token.key:99:2"
        result = qualification.safe_failure(failure, self.source)
        self.assertEqual(result, {"errorClass": "assertion", "comparison": {"operator": "equal", "expected": 8, "actual": 5},
                                  "locations": [{"file": fixture, "line": 1512, "column": 13}]})
        self.assertNotIn(str(self.source), json.dumps(result))
        self.assertNotIn("session-token", json.dumps(result))

    def test_boolean_primitives_and_file_url_stack_are_safe(self):
        result = qualification.safe_failure(f"AssertionError: expected false to be true\n    at file://{self.source}/{qualification.RECOVERY_FILE}:9:3", self.source)
        self.assertEqual(result["comparison"], {"operator": "equal", "expected": True, "actual": False})
        self.assertEqual(result["locations"][0]["line"], 9)

    def test_string_object_large_numeric_and_environment_values_are_never_emitted(self):
        for message in ["AssertionError: expected 'SYNTHETIC_SECRET' to be 'OTHER_SECRET'",
                        "AssertionError: expected { token: 'SYNTHETIC_SECRET' } to equal {}",
                        "AssertionError: expected 12345678901234567890 to be 0",
                        "Error: DATABASE_URL=postgres://SYNTHETIC_SECRET@private/db"]:
            result = qualification.safe_failure(message + "\n    at /private/SYNTHETIC_SECRET.key:4:2", self.source)
            encoded = json.dumps(result)
            self.assertNotIn("SYNTHETIC_SECRET", encoded)
            self.assertNotIn("12345678901234567890", encoded)
            self.assertNotIn("comparison", result)
            self.assertNotIn("locations", result)

    def test_collection_length_exports_counts_without_any_collection_content(self):
        result = qualification.safe_failure("AssertionError: expected [ 'SYNTHETIC_SECRET' ] to have a length of 2 but got 1", self.source)
        self.assertEqual(result["comparison"], {"operator": "length_equal", "expected": 2, "actual": 1})
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(result))

    def test_nonfixture_traversal_and_message_path_are_not_source_frames(self):
        failure = f"TypeError: private error at {self.source}/{qualification.RECOVERY_FILE}:1:2\n    at {self.source}/../private/tls.key:3:4\n    at {self.source}/server/src/auth/better-auth.ts:5:6\n excerpt {self.source}/{qualification.RECOVERY_FILE}:7:8"
        self.assertEqual(qualification.safe_failure(failure, self.source), {"errorClass": "type_error"})

    def test_only_expected_titles_and_sanitized_statuses_enter_diagnostics(self):
        value = report(qualification.LOCAL_CASES)
        value["testResults"][0]["assertionResults"].append({"title": "SYNTHETIC_SECRET", "status": "failed", "failureMessages": ["SYNTHETIC_SECRET"]})
        first = value["testResults"][0]["assertionResults"][0]
        first.update(status="SYNTHETIC_SECRET", location={"line": "SYNTHETIC_SECRET", "column": True})
        cases = qualification.report_diagnostics(value, qualification.LOCAL_CASES, self.source)
        self.assertEqual(len(cases), 8)
        self.assertEqual(cases[0]["status"], "unknown")
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(cases))

    def test_failure_without_stack_keeps_declaration_and_fixed_class(self):
        value = report(qualification.REMOTE_CASES)
        value["testResults"][0]["assertionResults"][0].update(status="failed", failureMessages=["Error: Test timed out in 45000ms. PRIVATE"], location={"line": 323, "column": 3})
        case = qualification.report_diagnostics(value, qualification.REMOTE_CASES, self.source)[0]
        self.assertEqual(case["failures"], [{"errorClass": "timeout"}])
        self.assertEqual(case["declaration"], {"file": qualification.RECOVERY_FILE, "line": 323, "column": 3})
        self.assertNotIn("PRIVATE", json.dumps(case))

    def test_entered_local_failures_allow_remote_but_skips_missing_duplicates_do_not(self):
        value = report(qualification.LOCAL_CASES)
        value["success"] = False
        value["testResults"][0]["assertionResults"][0]["status"] = "failed"
        self.assertTrue(qualification.selected_cases_entered(value, qualification.LOCAL_CASES))
        self.assertEqual(qualification.report_counts(value, qualification.LOCAL_CASES)["status"], "failed")
        for status in ["skipped", "pending"]:
            value["testResults"][0]["assertionResults"][0]["status"] = status
            self.assertFalse(qualification.selected_cases_entered(value, qualification.LOCAL_CASES))
        self.assertFalse(qualification.selected_cases_entered(report(qualification.LOCAL_CASES[:-1]), qualification.LOCAL_CASES))
        self.assertFalse(qualification.selected_cases_entered(report(qualification.LOCAL_CASES + [qualification.LOCAL_CASES[0]]), qualification.LOCAL_CASES))


class CauseBoundaryTests(unittest.TestCase):
    def test_reporter_and_stock_gate_whitelists_stay_identical(self):
        source = Path(__file__).with_name("crewroom-runtime-cause-reporter.mjs").read_text()
        match = qualification.re.search(r"export const EXPECTED_CASES = (\[.*?\]);", source, qualification.re.S)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match[1]), qualification.LOCAL_CASES + qualification.REMOTE_CASES)
        for name, expected in [("ALLOWED_SOURCE_FILES", qualification.CAUSE_SOURCE_FILES), ("ERROR_CODES", qualification.CAUSE_ERROR_CODES)]:
            match = qualification.re.search(r"export const " + name + r" = (\[.*?\]);", source, qualification.re.S)
            self.assertIsNotNone(match)
            self.assertEqual(json.loads(match[1]), expected)

    def test_double_sanitization_preserves_nested_classes_only_and_does_not_change_gate(self):
        with tempfile.TemporaryDirectory(prefix="cause-boundary-offline-") as directory:
            filename = Path(directory) / "causes.json"
            fixture = qualification.RECOVERY_FILE
            title = qualification.LOCAL_CASES[0]
            filename.write_text(json.dumps({"version": 1, "status": "available", "cases": [{"title": title, "chains": [{"chainState": "complete", "entries": [
                {"depth": 0, "relation": "root", "errorClass": "error", "message": "SYNTHETIC_SECRET"},
                {"depth": 1, "relation": "cause", "errorClass": "assertion", "locations": [{"file": fixture, "line": 444, "column": 3}, {"file": "/private/SYNTHETIC_SECRET.key", "line": 1, "column": 1}], "comparison": {"operator": "equal", "expected": True, "actual": False}, "stack": "SYNTHETIC_SECRET"}]}]}]}))
            value = report(qualification.LOCAL_CASES)
            value["testResults"][0]["assertionResults"][0]["status"] = "failed"
            value.update(success=False, numFailedTests=1)
            counts = qualification.report_counts(value, qualification.LOCAL_CASES)
            counts["cases"] = qualification.report_diagnostics(value, qualification.LOCAL_CASES, Path("/synthetic/product"))
            qualification.attach_cause_diagnostics(counts, filename, qualification.LOCAL_CASES)
            self.assertEqual(counts["status"], "failed")
            self.assertEqual(counts["causeDiagnosticsStatus"], "available")
            self.assertEqual(counts["cases"][0]["causeChains"][0]["entries"][1]["locations"], [{"file": fixture, "line": 444, "column": 3}])
            self.assertNotIn("SYNTHETIC_SECRET", json.dumps(counts))

    def test_missing_report_is_unavailable_and_never_changes_failed_gate(self):
        counts = {"status": "failed", "cases": []}
        qualification.attach_cause_diagnostics(counts, Path("/missing/causes.json"), qualification.LOCAL_CASES)
        self.assertEqual(counts, {"status": "failed", "cases": [], "causeDiagnosticsStatus": "unavailable"})


class PublicArtifactStagingTests(unittest.TestCase):
    def test_normalizes_only_copy_and_preserves_original_bytes_and_mode(self):
        with tempfile.TemporaryDirectory(prefix="provider-staging-offline-") as directory:
            root = Path(directory)
            provider = root / "built-provider"
            provider.write_bytes(b"synthetic public compiled artifact")
            provider.chmod(0o700)
            expected = qualification.digest(provider)
            staged = qualification.stage_public_provider(provider, root, expected)
            self.assertNotEqual(staged, provider)
            self.assertEqual(staged.stat().st_mode & 0o777, 0o555)
            self.assertEqual(provider.stat().st_mode & 0o777, 0o700)
            self.assertEqual(qualification.digest(staged), expected)
            self.assertEqual(qualification.digest(provider), expected)

    def test_rejects_source_or_staged_hash_mismatch(self):
        with tempfile.TemporaryDirectory(prefix="provider-staging-offline-") as directory:
            root = Path(directory)
            provider = root / "built-provider"
            provider.write_bytes(b"synthetic public compiled artifact")
            with self.assertRaisesRegex(qualification.QualificationFailure, "^provider_source_artifact_mismatch$"):
                qualification.stage_public_provider(provider, root, "0" * 64)
            with patch.object(qualification.shutil, "copyfile", side_effect=lambda _source, destination: destination.write_bytes(b"changed bytes")):
                with self.assertRaisesRegex(qualification.QualificationFailure, "^provider_staged_artifact_mismatch$"):
                    qualification.stage_public_provider(provider, root, qualification.digest(provider))


class AdoptedReaperTests(unittest.TestCase):
    def test_protected_direct_child_is_never_waited_and_live_adopted_child_is_not_killed(self):
        reaper = qualification.AdoptedZombieReaper(42)
        def wait_one(pid, _flags):
            return (43, 0) if pid == 43 else (0, 0)
        with patch.object(Path, "read_text", return_value="42 43 44"), \
             patch.object(qualification.os, "waitpid", side_effect=wait_one) as waitpid, \
             patch.object(qualification.os, "kill") as kill, \
             patch.object(reaper.done, "wait", side_effect=lambda _timeout: reaper.done.set()):
            reaper._loop()
        self.assertEqual(waitpid.call_args_list, [call(43, os.WNOHANG), call(44, os.WNOHANG)])
        self.assertEqual(reaper.reaped, 1)
        self.assertFalse(reaper.error)
        kill.assert_not_called()

    def test_reaper_read_error_is_reported_to_main_after_join(self):
        reaper = qualification.AdoptedZombieReaper(42)
        with patch.object(Path, "read_text", side_effect=OSError("synthetic private detail")):
            reaper._loop()
        self.assertTrue(reaper.error)
        reaper.thread = SimpleNamespace(join=Mock(), is_alive=lambda: False)
        with self.assertRaisesRegex(qualification.QualificationFailure, "^adopted_reaper_failed$"):
            reaper.stop()
        self.assertTrue(reaper.joined)

    def test_unconfirmed_join_cannot_report_a_stopped_thread(self):
        reaper = qualification.AdoptedZombieReaper(42)
        reaper.thread = SimpleNamespace(join=Mock(), is_alive=lambda: True)
        with self.assertRaisesRegex(qualification.QualificationFailure, "^adopted_reaper_join_unconfirmed$"):
            reaper.stop()
        self.assertFalse(reaper.joined)


class PipelineControlTests(unittest.TestCase):
    def run_mock_pipeline(self, mode="assertion_failure", diagnostic=False, export=False):
        # Exercise the actual helper orchestration without starting commands,
        # containers, Rust, PostgreSQL or test processes.
        with tempfile.TemporaryDirectory(prefix="qualification-offline-") as directory:
            root = Path(directory)
            source = root / "product"
            for binary in [qualification.RUNNER, qualification.PROVIDER]:
                path = source / binary
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic offline binary")
                path.chmod(0o700)
            (source / "packages/paperclip-runner/rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.97.1"\n')
            (source / "packages/paperclip-runner/runner/Cargo.lock").write_text("public synthetic offline Cargo lock")
            output = root / "public"
            commands = []
            cleanup_calls = []
            active_reapers = []

            class FakeReaper:
                def __init__(self, protected_pid):
                    self.protected_pid = protected_pid
                    self.joined = False
                    self.reaped = 0

                def start(self):
                    active_reapers.append(self)

                def stop(self):
                    active_reapers.remove(self)
                    self.joined = True
                    if mode == "reaper_error":
                        raise qualification.QualificationFailure("adopted_reaper_failed")
                    if mode == "reaper_join_failure":
                        self.joined = False
                        active_reapers.append(self)
                        raise qualification.QualificationFailure("adopted_reaper_join_unconfirmed")

            def cleanup_children(_diagnostic=None):
                if active_reapers:
                    raise AssertionError("cleanup raced a command reaper")
                cleanup_calls.append(True)
                return not (mode == "cleanup_failure" and len(cleanup_calls) == 1)

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    if active_reapers:
                        raise AssertionError("next spawn raced a command reaper")
                    self.pid = 12345
                    commands.append(command)
                    self.simulate_timeout = False
                    self.returncode = 0
                    self.stdout = b""
                    if command[:3] == ["git", "rev-parse", "HEAD"]:
                        self.stdout = ("a" * 40).encode()
                    elif command == ["node", "--version"]:
                        self.stdout = b"v24.14.0"
                    elif command == ["pnpm", "--version"]:
                        self.stdout = b"9.15.4"
                    elif command == ["rustc", "--version"]:
                        self.stdout = b"rustc 1.97.1 (abcdef01 2026-10-01)"
                    elif command == ["cargo", "--version"]:
                        self.stdout = b"cargo 1.97.1 (abcdef01 2026-10-01)"
                    elif command[0] == "python3" and command[1].endswith("crewroom-runtime-export-binaries.py"):
                        # Exercise the real export owner using only inert files;
                        # no executable or command is started by this fixture.
                        binding = json.loads(Path(command[command.index("--binding") + 1]).read_text())
                        with patch.object(qualification_export, "checkout_revision", return_value="a" * 40), \
                             patch.object(qualification_export, "mit_notice", return_value="PUBLIC_SYNTHETIC_MIT_NOTICE"), \
                             patch.object(qualification_export, "notice_sha256", return_value="c" * 64):
                            qualification_export.stage(source, Path(command[command.index("--output") + 1]), binding)
                    elif command[0] == "node" and "--input-type=module" in command:
                        self.stdout = str(source / qualification.RUNNER).encode()
                    elif command[:2] == ["docker", "run"]:
                        if len(cleanup_calls) != 1:
                            raise AssertionError("remote started without prior local cleanup")
                        self.stdout = b"owned-container-id"
                    elif command[:2] == ["docker", "inspect"]:
                        self.stdout = b'[{"HostConfig":{"Binds":null,"Privileged":false}}]'
                    elif command[:2] == ["docker", "pull"] and mode == "image_pull_failure":
                        self.returncode = 125
                    elif command[:2] == ["docker", "exec"] and command[-1] == "setsid" and mode == "missing_tool":
                        self.returncode = 127
                    elif command[:2] == ["docker", "exec"] and "node" in command and "-e" in command:
                        self.stdout = ("0" * 64 if mode == "provider_hash_failure" else qualification.digest(source / qualification.PROVIDER)).encode()
                    elif command[:2] == ["docker", "exec"] and command[-1].startswith("test -r /opt/continuity") and mode == "provider_permissions_failure":
                        self.returncode = 1
                    elif command[:2] == ["docker", "port"]:
                        self.stdout = b"127.0.0.1:43210"
                    elif command[:2] == ["docker", "exec"] and command[-2:] == ["node", "--version"]:
                        self.stdout = b"v24.14.0"
                    if "vitest" in command:
                        remote = "-t" in command
                        value = report(qualification.REMOTE_CASES if remote else qualification.LOCAL_CASES)
                        if not remote:
                            if mode == "preparation_failure":
                                value["testResults"][0]["assertionResults"][0]["status"] = "pending"
                            elif mode != "all_pass":
                                for case in value["testResults"][0]["assertionResults"][:3]:
                                    case.update(status="failed", failureMessages=["AssertionError: expected 0 to be 1"])
                                value.update(success=False, numFailedTests=3, numPassedTests=5)
                                self.returncode = 1
                        destination = next(value for value in command if value.startswith("--outputFile="))
                        Path(destination.split("=", 1)[1]).write_text(json.dumps(value))
                        if remote and mode in ["host_timeout", "missing_report", "invalid_report"]:
                            destination_path = Path(destination.split("=", 1)[1])
                            if mode == "invalid_report": destination_path.write_text("{")
                            else: destination_path.unlink()
                            if mode == "host_timeout":
                                self.simulate_timeout = True
                                cause_path = Path(_kwargs["env"]["CREWROOM_QUALIFICATION_CAUSE_OUTPUT"])
                                cause_path.write_text(json.dumps({"version":2,"status":"available","complete":False,"cases":[
                                    {"title":qualification.REMOTE_CASES[0],"status":"failed","chains":[]},
                                    {"title":qualification.REMOTE_CASES[1],"status":"running","chains":[]}],"events":[
                                    {"sequence":1,"type":"case_start","title":qualification.REMOTE_CASES[0],"elapsedMs":1},
                                    {"sequence":2,"type":"case_end","title":qualification.REMOTE_CASES[0],"status":"failed","elapsedMs":2},
                                    {"sequence":3,"type":"case_start","title":qualification.REMOTE_CASES[1],"elapsedMs":3}]}))

                def communicate(self, timeout=None):
                    if self.simulate_timeout:
                        raise qualification.subprocess.TimeoutExpired(["synthetic"], timeout)
                    return self.stdout, None

                def poll(self):
                    return self.returncode

            original_signals = {event: signal.getsignal(event) for event in [signal.SIGINT, signal.SIGTERM]}
            try:
                with patch.dict(os.environ, {"PRODUCT_REVISION": "a" * 40, "HELPER_REVISION": "b" * 40, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
                         "GITHUB_ACTIONS": "true", "RUNNER_OS": "Linux", "RUNNER_TEMP": str(root), "HOME": str(root),
                         "CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS": "1" if diagnostic else "0",
                         "CREWROOM_QUALIFICATION_EXPORT_BINARIES": "1" if export else "0"}, clear=True), \
                     patch.object(qualification, "state_directory", return_value=root / "private"), \
                     patch.object(qualification.platform, "machine", return_value="x86_64"), \
                     patch.object(qualification.sys, "platform", "linux"), \
                     patch.object(qualification, "private_mount_identity", return_value=1), \
                     patch.object(qualification.ctypes, "CDLL", return_value=SimpleNamespace(prctl=lambda *_args: 0)), \
                     patch.object(qualification.subprocess, "Popen", FakeProcess), \
                     patch.object(qualification, "AdoptedZombieReaper", FakeReaper), \
                     patch.object(qualification.subprocess, "run", return_value=SimpleNamespace(stdout="b" * 40)), \
                     patch.object(qualification, "owned_children_cleanup", side_effect=cleanup_children), \
                     patch.object(qualification, "container_cleanup", return_value=True), \
                     patch("builtins.print"):
                    code = qualification.run_qualification(source, output)
            finally:
                for event, handler in original_signals.items():
                    signal.signal(event, handler)
            receipt = json.loads((output / "receipt.json").read_text())
            if export:
                manifest = root / "qualification-binaries/manifest.json"
                self.assertEqual(receipt["stages"]["diagnostic_binary_export"]["manifestSha256"], qualification.digest(manifest))
                self.assertEqual(set(os.listdir(manifest.parent)), {"manifest.json", "paperclip-runnerd", "fake-codex-app-server"})
                self.assertEqual(receipt["stages"]["cleanup"]["status"], "passed")
                self.assertFalse((root / "private").exists())
            return code, receipt, commands

    def test_ambient_diagnostic_export_inputs_do_not_change_the_default_mock_fixture(self):
        with patch.dict(os.environ, {"CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS": "1", "CREWROOM_QUALIFICATION_EXPORT_BINARIES": "1"}):
            code, receipt, commands = self.run_mock_pipeline()
            self.assertEqual(os.environ["CREWROOM_QUALIFICATION_EXPORT_BINARIES"], "1")
        self.assertEqual(code, 1)
        self.assertEqual(receipt["stages"]["local_real_processes"]["failed"], 3)
        self.assertEqual(receipt["stages"]["remote_continuity"]["passed"], 5)
        self.assertNotIn("diagnostic_binary_export", receipt["stages"])
        self.assertFalse(any(command[0] == "python3" for command in commands))

    def test_explicit_diagnostic_export_stages_public_binaries_before_runtime_and_preserves_failure(self):
        code, receipt, commands = self.run_mock_pipeline(diagnostic=True, export=True)
        build = next(index for index, command in enumerate(commands) if command[:2] == ["cargo", "build"])
        exported = next(index for index, command in enumerate(commands) if command[0] == "python3")
        local = next(index for index, command in enumerate(commands) if "vitest" in command)
        self.assertLess(build, exported)
        self.assertLess(exported, local)
        remote = next(command for command in commands if "vitest" in command and "-t" in command)
        self.assertIn("--config", remote)
        self.assertEqual(receipt["stages"]["phase_overlay_smoke"]["status"], "passed")
        self.assertEqual(receipt["stages"]["local_real_processes"]["failed"], 3)
        self.assertEqual(receipt["stages"]["remote_continuity"]["passed"], 5)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(code, 1)

    def test_all_passed_instrumented_pipeline_is_diagnostic_only_and_nonzero(self):
        code, receipt, _commands = self.run_mock_pipeline("all_pass", diagnostic=True, export=True)
        self.assertEqual(receipt["stages"]["local_real_processes"]["passed"], 8)
        self.assertEqual(receipt["stages"]["remote_continuity"]["passed"], 5)
        self.assertTrue(receipt["diagnosticOnly"])
        self.assertFalse(receipt["stockQualification"])
        self.assertEqual(receipt["status"], "diagnostic_only")
        self.assertEqual(code, 1)

    def test_local_assertion_failures_collect_remote_evidence_but_job_stays_failed(self):
        code, receipt, commands = self.run_mock_pipeline()
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["stages"]["local_real_processes"]["failed"], 3)
        self.assertEqual(receipt["stages"]["local_process_cleanup"]["status"], "passed")
        self.assertEqual(receipt["stages"]["remote_continuity"]["passed"], 5)
        self.assertEqual(receipt["stages"]["cleanup"]["status"], "passed")
        self.assertEqual(sum("vitest" in command for command in commands), 2)

    def test_remote_preparation_reports_only_fixed_operation_exit_and_missing_tool(self):
        code, receipt, _commands = self.run_mock_pipeline("image_pull_failure")
        self.assertEqual(code, 1)
        self.assertEqual(receipt["stages"]["remote_container"]["operations"], [{"operation": "image_pull", "status": "failed", "exitCode": 125}])
        code, receipt, _commands = self.run_mock_pipeline("missing_tool")
        self.assertEqual(code, 1)
        self.assertEqual(receipt["stages"]["remote_container"]["missingTools"], {"node": False, "ps": False, "setsid": True, "tar": False, "base64": False})
        self.assertNotIn("remote_continuity", receipt["stages"])

    def test_provider_preparation_uses_normalized_copy_and_hash_without_chmod_or_extra_capabilities(self):
        code, receipt, commands = self.run_mock_pipeline()
        self.assertEqual(code, 1)  # Local assertion failures still keep the job failed.
        self.assertTrue(receipt["stages"]["remote_container"]["providerStagingValid"])
        self.assertTrue(receipt["stages"]["remote_container"]["providerHashMatches"])
        self.assertFalse(any(command[:2] == ["docker", "exec"] and "chmod" in command for command in commands))
        self.assertFalse(any("--cap-add" in command or "--privileged" in command for command in commands))
        container_start = next(command for command in commands if command[:2] == ["docker", "run"])
        self.assertNotIn("--rm", container_start)  # One explicit cleanup owner; no auto-remove race.
        copied = next(command for command in commands if command[:2] == ["docker", "cp"])
        self.assertTrue(copied[2].endswith("/private/remote-fake-codex-app-server"))

    def test_provider_permission_or_hash_failure_stops_before_remote_tests(self):
        for mode in ["provider_permissions_failure", "provider_hash_failure"]:
            code, receipt, _commands = self.run_mock_pipeline(mode)
            self.assertEqual(code, 1)
            self.assertNotIn("remote_continuity", receipt["stages"])
            self.assertEqual(receipt["stages"]["remote_container"]["status"], "failed")
            if mode == "provider_hash_failure":
                self.assertFalse(receipt["stages"]["remote_container"]["providerHashMatches"])

    def test_thread_failure_fails_closed_and_unconfirmed_join_blocks_general_cleanup(self):
        for mode in ["reaper_error", "reaper_join_failure"]:
            code, receipt, commands = self.run_mock_pipeline(mode)
            self.assertEqual(code, 1)
            self.assertEqual(receipt["stages"]["adopted_child_reaping"]["status"], "failed")
            self.assertEqual(receipt["stages"]["cleanup"]["status"], "failed" if mode == "reaper_join_failure" else "passed")
            self.assertEqual(len(commands), 1)

    def test_outer_failure_classes_and_partial_results_never_pass_stock_gate(self):
        for mode, expected in [("host_timeout","host_command_timeout"),("missing_report","missing_report"),("invalid_report","invalid_report_json")]:
            code, receipt, _commands = self.run_mock_pipeline(mode)
            self.assertEqual(code,1)
            stage=receipt["stages"]["remote_continuity"]
            self.assertEqual(stage["stageFailureClass"],expected)
            self.assertEqual(stage["stockGate"],"incomplete")
            self.assertNotIn("passed",stage)
            if mode=="host_timeout":
                self.assertEqual(stage["timeoutSeconds"],1200)
                partial=stage["partialDiagnostics"]
                self.assertEqual(partial["snapshotState"],"partial")
                self.assertEqual([case["status"] for case in partial["cases"]], ["finished","running","not_started","not_started","not_started"])
                self.assertEqual(partial["cases"][0]["observedResult"],"failed")
                self.assertEqual(len(partial["events"]),3)

    def test_preparation_or_unconfirmed_cleanup_never_starts_remote(self):
        for mode in ["preparation_failure", "cleanup_failure"]:
            code, receipt, commands = self.run_mock_pipeline(mode)
            self.assertEqual(code, 1)
            self.assertEqual(receipt["status"], "failed")
            self.assertNotIn("remote_continuity", receipt["stages"])
            self.assertFalse(any(command[:2] == ["docker", "pull"] for command in commands))


class CleanupTests(unittest.TestCase):
    def test_daemon_failure_is_not_absence(self):
        with patch.object(qualification.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="")):
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))

    def test_wrong_owner_never_stops_a_container(self):
        responses = [SimpleNamespace(returncode=0, stdout="abcdef123456\n"),
                     SimpleNamespace(returncode=0, stdout='[{"Id":"abcdef123456","Config":{"Labels":{}}}]')]
        with patch.object(qualification.subprocess, "run", side_effect=responses) as run:
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))
            self.assertEqual(run.call_count, 2)

    def test_stop_then_daemon_failure_is_not_success(self):
        label = qualification.OWNER_LABEL
        responses = [SimpleNamespace(returncode=0, stdout="abcdef123456\n"),
                     SimpleNamespace(returncode=0, stdout='[{"Id":"abcdef123456","Config":{"Labels":{"' + label + '":"owner"}}}]'),
                     SimpleNamespace(returncode=0), SimpleNamespace(returncode=1, stdout="")]
        with patch.object(qualification.subprocess, "run", side_effect=responses) as run:
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))
            self.assertEqual(run.call_args_list[2].args[0], ["docker", "stop", "--timeout", "20", "abcdef123456"])


class CleanupDiagnosticsTests(unittest.TestCase):
    def test_stop_failure_preserves_fixed_exit_and_no_owner_identifier(self):
        owner = "SYNTHETIC_PRIVATE_OWNER"
        responses = [SimpleNamespace(returncode=0, stdout="private-container-id\n"),
                     SimpleNamespace(returncode=0, stdout=json.dumps([{"Id":"private-container-id", "State":{"Status":"running"}, "Config":{"Labels":{qualification.OWNER_LABEL:owner}}}])),
                     SimpleNamespace(returncode=1, stdout="SYNTHETIC_PRIVATE_DAEMON_OUTPUT")]
        detail = {}
        with patch.object(qualification.subprocess, "run", side_effect=responses):
            self.assertFalse(qualification.container_cleanup({"container":"private-name", "owner":owner, "containerId":"private-container-id"}, detail))
        self.assertEqual(detail["operations"][-1], {"operation":"stop", "status":"failed", "exitCode":1})
        self.assertTrue(detail["ownerMatches"])
        self.assertTrue(detail["idMatches"])
        self.assertEqual(detail["containerState"], "running")
        self.assertNotIn("SYNTHETIC_PRIVATE", json.dumps(detail))
        self.assertNotIn("private-container", json.dumps(detail))

    def test_cleanup_timeout_and_invalid_shape_use_fixed_classes(self):
        detail = {}
        with patch.object(qualification.subprocess, "run", side_effect=qualification.subprocess.TimeoutExpired(["private"], 30)):
            self.assertFalse(qualification.container_cleanup({"container":"name", "owner":"owner"}, detail))
        self.assertEqual(detail["operations"][-1]["errorClass"], "timeout")
        responses = [SimpleNamespace(returncode=0, stdout="id"), SimpleNamespace(returncode=0, stdout="{}")]
        with patch.object(qualification.subprocess, "run", side_effect=responses):
            self.assertFalse(qualification.container_cleanup({"container":"name", "owner":"owner"}, detail))
        self.assertEqual(detail["operations"][-1]["errorClass"], "json_shape")

    def test_children_cleanup_distinguishes_settlement_and_read_failure(self):
        detail = {}
        with patch.object(qualification.os, "waitpid", side_effect=ChildProcessError()):
            self.assertTrue(qualification.owned_children_cleanup(detail))
        self.assertEqual(detail["reason"], "echild")
        with patch.object(qualification.os, "waitpid", return_value=(0,0)), patch.object(Path, "read_text", side_effect=OSError("private")):
            self.assertFalse(qualification.owned_children_cleanup(detail))
        self.assertEqual(detail["reason"], "read_error")

    def test_recovery_cannot_erase_initial_failure_or_unconfirmed_children(self):
        for children_confirmed in [True, False]:
            with tempfile.TemporaryDirectory(prefix="cleanup-recovery-offline-") as directory:
                root = Path(directory); private=root/"private"; private.mkdir(); output=root/"public";output.mkdir()
                (private/"owner.json").write_text(json.dumps({"container":"name", "owner":"owner"}))
                initial={"status":"failed", "childrenCleanup":children_confirmed, "reaperJoined":True}
                (output/"receipt.json").write_text(json.dumps({"status":"failed", "stages":{"initialCleanup":initial, "cleanup":{"status":"failed"}}}))
                with patch.object(qualification, "state_directory", return_value=private), patch.object(qualification, "container_cleanup", return_value=True):
                    self.assertEqual(qualification.cleanup_only(output), 0 if children_confirmed else 1)
                receipt=json.loads((output/"receipt.json").read_text())
                self.assertEqual(receipt["stages"]["initialCleanup"], initial)
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(private.exists(), not children_confirmed)


class PrivateFixtureCleanupTests(unittest.TestCase):
    def test_owned_readonly_tree_and_external_symlink_target_are_handled_without_file_chmod(self):
        with tempfile.TemporaryDirectory(prefix="private-cleanup-offline-") as directory:
            root=Path(directory);private=root/"private";private.mkdir();(private/"owner.json").write_text("{}")
            asset=private/"asset";asset.mkdir();(asset/"file").write_text("inert");(asset/"file").chmod(0o444);asset.chmod(0o555)
            outside=root/"outside";outside.mkdir();(outside/"sentinel").write_text("preserved");(outside/"sentinel").chmod(0o444);outside.chmod(0o555)
            (private/"link").symlink_to(outside,target_is_directory=True)
            detail={}
            with patch.object(qualification,"state_directory",return_value=private):
                self.assertTrue(qualification.cleanup_private_fixture(private,True,detail))
            self.assertEqual(detail["reason"],"removed")
            self.assertFalse(private.exists());self.assertEqual((outside/"sentinel").read_text(),"preserved")
            self.assertEqual(outside.stat().st_mode&0o777,0o555);self.assertEqual((outside/"sentinel").stat().st_mode&0o777,0o444)
            outside.chmod(0o700)

    def test_unconfirmed_processes_and_symlink_root_are_not_followed(self):
        with tempfile.TemporaryDirectory(prefix="private-cleanup-offline-") as directory:
            root=Path(directory);private=root/"private";outside=root/"outside";outside.mkdir();(outside/"sentinel").write_text("preserved");private.symlink_to(outside,target_is_directory=True)
            detail={}
            with patch.object(qualification,"state_directory",return_value=private),patch.object(qualification.os,"fchmod") as chmod:
                self.assertFalse(qualification.cleanup_private_fixture(private,False,detail));chmod.assert_not_called()
                self.assertFalse(qualification.cleanup_private_fixture(private,True,detail));chmod.assert_not_called()
            self.assertTrue(private.is_symlink());self.assertEqual((outside/"sentinel").read_text(),"preserved")

    def test_foreign_entry_or_mount_fails_closed_and_preserves_owner_marker(self):
        for mode in ["owner","mount"]:
            with tempfile.TemporaryDirectory(prefix="private-cleanup-offline-") as directory:
                root=Path(directory);private=root/"private";private.mkdir();(private/"owner.json").write_text("{}")
                asset=private/"asset";asset.mkdir();(asset/"foreign").write_text("inert")
                original_stat=qualification.os.stat
                def changed_stat(name,*args,**kwargs):
                    result=original_stat(name,*args,**kwargs)
                    if name=="foreign":
                        fields=list(result);fields[4]+=1;return os.stat_result(fields)
                    return result
                detail={}
                with patch.object(qualification,"state_directory",return_value=private):
                    if mode=="owner":
                        with patch.object(qualification.os,"stat",side_effect=changed_stat):self.assertFalse(qualification.cleanup_private_fixture(private,True,detail))
                        self.assertEqual(detail["reason"],"unsafe_owner")
                    else:
                        with patch.object(qualification,"private_mount_identity",side_effect=[1,1,1,2]):self.assertFalse(qualification.cleanup_private_fixture(private,True,detail))
                        self.assertEqual(detail["reason"],"external_mount")
                    self.assertTrue((private/"owner.json").exists())
                    self.assertTrue(qualification.cleanup_private_fixture(private,True,{}))

    def test_missing_owner_after_old_readonly_failure_is_recovered_only_from_trusted_settlement(self):
        with tempfile.TemporaryDirectory(prefix="cleanup-old-shape-") as directory:
            root=Path(directory);private=root/"private";private.mkdir();asset=private/"asset";asset.mkdir();(asset/"file").write_text("inert");asset.chmod(0o555)
            output=root/"public";output.mkdir();initial={"status":"passed","childrenCleanup":True,"reaperJoined":True,"containerCleanup":True}
            (output/"receipt.json").write_text(json.dumps({"status":"failed","stages":{"initialCleanup":initial,"cleanup":{"status":"passed"},"remote_continuity":{"status":"failed"}}}))
            with patch.object(qualification,"state_directory",return_value=private):self.assertEqual(qualification.cleanup_only(output),0)
            receipt=json.loads((output/"receipt.json").read_text());self.assertFalse(private.exists());self.assertEqual(receipt["status"],"failed");self.assertEqual(receipt["stages"]["initialCleanup"],initial)
            self.assertEqual(receipt["stages"]["recoveryCleanup"]["privateCleanup"]["reason"],"removed")

    def test_owner_marker_symlink_is_never_followed(self):
        with tempfile.TemporaryDirectory(prefix="cleanup-owner-link-") as directory:
            root=Path(directory);private=root/"private";private.mkdir();outside=root/"outside.json";outside.write_text('{"synthetic":"private"}');(private/"owner.json").symlink_to(outside)
            output=root/"public";output.mkdir();(output/"receipt.json").write_text(json.dumps({"status":"failed","stages":{"initialCleanup":{"status":"passed","childrenCleanup":True,"reaperJoined":True,"containerCleanup":True}}}))
            with patch.object(qualification,"state_directory",return_value=private):self.assertEqual(qualification.cleanup_only(output),1)
            self.assertEqual(outside.read_text(),'{"synthetic":"private"}');self.assertTrue((private/"owner.json").is_symlink())

    def test_private_root_mount_replacement_is_rejected_before_any_mutation(self):
        with tempfile.TemporaryDirectory(prefix="cleanup-root-mount-") as directory:
            root=Path(directory);private=root/"private";private.mkdir();(private/"owner.json").write_text("{}");(private/"sentinel").write_text("preserved")
            detail={}
            with patch.object(qualification,"state_directory",return_value=private),patch.object(qualification,"private_mount_identity",side_effect=[1,2]),patch.object(qualification.os,"fchmod") as chmod,patch.object(qualification.os,"unlink") as unlink:
                self.assertFalse(qualification.cleanup_private_fixture(private,True,detail));chmod.assert_not_called();unlink.assert_not_called()
            self.assertEqual(detail["reason"],"external_mount");self.assertEqual((private/"sentinel").read_text(),"preserved");self.assertTrue((private/"owner.json").exists())

    def test_absent_private_state_is_success_only_with_trusted_initial_settlement(self):
        for trusted in [True,False]:
            with tempfile.TemporaryDirectory(prefix="cleanup-absent-offline-") as directory:
                root=Path(directory);private=root/"absent";output=root/"public";output.mkdir()
                stages={"initialCleanup":{"status":"passed","childrenCleanup":True,"reaperJoined":True,"containerCleanup":True}} if trusted else {}
                (output/"receipt.json").write_text(json.dumps({"status":"failed","stages":stages}))
                with patch.object(qualification,"state_directory",return_value=private):self.assertEqual(qualification.cleanup_only(output),0 if trusted else 1)
                value=json.loads((output/"receipt.json").read_text());self.assertEqual(value["status"],"failed")
                self.assertEqual(value["stages"]["recoveryCleanup"]["status"],"passed" if trusted else "failed")


if __name__ == "__main__":
    unittest.main()
