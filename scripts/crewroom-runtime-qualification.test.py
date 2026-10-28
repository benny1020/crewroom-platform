#!/usr/bin/env python3
"""Offline receipt-gate and exact-owner cleanup checks; no Docker or product execution."""
import importlib.util
import json
import os
import signal
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("crewroom-runtime-qualification.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


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
    def run_mock_pipeline(self, mode="assertion_failure"):
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

            def cleanup_children():
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
                    self.returncode = 0
                    self.stdout = b""
                    if command[:3] == ["git", "rev-parse", "HEAD"]:
                        self.stdout = ("a" * 40).encode()
                    elif command == ["node", "--version"]:
                        self.stdout = b"v24.14.0"
                    elif command == ["pnpm", "--version"]:
                        self.stdout = b"9.15.4"
                    elif command == ["rustc", "--version"]:
                        self.stdout = b"rustc 1.97.1 (synthetic)"
                    elif command == ["cargo", "--version"]:
                        self.stdout = b"cargo 1.97.1 (synthetic)"
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
                            else:
                                for case in value["testResults"][0]["assertionResults"][:3]:
                                    case.update(status="failed", failureMessages=["AssertionError: expected 0 to be 1"])
                                value.update(success=False, numFailedTests=3, numPassedTests=5)
                                self.returncode = 1
                        destination = next(value for value in command if value.startswith("--outputFile="))
                        Path(destination.split("=", 1)[1]).write_text(json.dumps(value))

                def communicate(self, timeout=None):
                    return self.stdout, None

                def poll(self):
                    return self.returncode

            original_signals = {event: signal.getsignal(event) for event in [signal.SIGINT, signal.SIGTERM]}
            try:
                with patch.dict(os.environ, {"PRODUCT_REVISION": "a" * 40, "HELPER_REVISION": "b" * 40, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}), \
                     patch.object(qualification, "state_directory", return_value=root / "private"), \
                     patch.object(qualification.platform, "machine", return_value="x86_64"), \
                     patch.object(qualification.sys, "platform", "linux"), \
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
            return code, json.loads((output / "receipt.json").read_text()), commands

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

    def test_thread_failure_fails_closed_and_unconfirmed_join_blocks_general_cleanup(self):
        for mode in ["reaper_error", "reaper_join_failure"]:
            code, receipt, commands = self.run_mock_pipeline(mode)
            self.assertEqual(code, 1)
            self.assertEqual(receipt["stages"]["adopted_child_reaping"]["status"], "failed")
            self.assertEqual(receipt["stages"]["cleanup"]["status"], "failed" if mode == "reaper_join_failure" else "passed")
            self.assertEqual(len(commands), 1)

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


if __name__ == "__main__":
    unittest.main()
