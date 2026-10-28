#!/usr/bin/env python3
"""CI-only qualification of an immutable product checkout; publish counts, never raw state."""
import argparse
import ctypes
import stat
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import threading

RECOVERY_FILE = "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts"
RUNNER = "packages/paperclip-runner/runner/target/debug/paperclip-runnerd"
PROVIDER = "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"
IMAGE = "node:24.14.0-trixie@sha256:11ff3307eb61506b6e469dcc0e13a453ef74b1b8b5ef30cea7c9c3f9a07df529"
OWNER_LABEL = "com.crewroom.runtime-qualification.owner"
LOCAL_CASES = [
    "keeps checkpoint SQL independent of streamed output volume with a real Postgres writer",
    "adopts the same runner from Postgres after losing the controller filesystem (prepared task: false)",
    "adopts the same runner from Postgres after losing the controller filesystem (prepared task: true)",
    "adopts one active runner across hot and hard controller restarts without duplicating steering",
    "hard-restarts a dead runner with a current prompt on the same run and provider session",
    "hot-restarts a dead runner with a historical prompt on the same run and provider session",
    "hot-restarts a dead runner with a unregistered prompt on the same run and provider session",
    "quarantines a pre-auth runner root and bootstraps the same run",
]
REMOTE_CASES = ["preserves remote warm continuity across completed turns: " + scenario
                for scenario in ["warm", "hard", "legacy", "changed", "same-server"]]

CAUSE_SOURCE_FILES = ['server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts', 'server/src/services/native-runtime/native-session-executor.ts', 'packages/paperclip-runner/src/live/runnerd-codex-transport.ts']
CAUSE_ERROR_CODES = ['runner_remote_directory_staging_failed', 'runner_remote_staging_failed', 'runner_remote_artifact_verification_failed', 'runner_remote_artifact_metadata_invalid', 'runner_remote_artifact_contract_incompatible', 'runner_remote_codex_artifact_verification_failed', 'runner_remote_codex_artifact_unavailable', 'runner_remote_codex_install_failed', 'runner_remote_provider_artifact_incompatible', 'runner_remote_session_capability_missing', 'runner_remote_preinstalled_link_failed', 'runner_remote_codex_source_conflict', 'runner_harness_state_mismatch', 'runner_state_identity_mismatch', 'runner_state_directory_unsafe', 'runner_local_connect_failed', 'provider_transport_failed', 'native_provider_terminal_failed', 'native_event_replay_conflict']

PHASES = ['tls', 'asset', 'execution_input', 'prepare_run', 'finalize_run', 'execute_session', 'close_idle', 'tunnel_close', 'docker_execute', 'sync_tar', 'sync_ps']
STACK_FILES = ['server/src/services/native-runtime/native-session-executor.ts', 'server/src/realtime/runner-prp-outbound.ts', 'server/src/realtime/runner-prp-ws.ts', 'server/src/redaction.ts', 'packages/paperclip-runner/src/live/runnerd-codex-transport.ts', 'packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts', 'packages/paperclip-runner/src/drivers/codex/codex-harness-session.ts', 'packages/paperclip-runner/src/native-session-runtime.ts']


class DiagnosticCaptureComplete(Exception):
    pass


def stack_diagnostics(filename, nonce):
    try:
        if filename.stat().st_size > 20_000:
            raise ValueError()
        raw = json.loads(filename.read_text())
        if (raw.get("version") != 1 or raw.get("nonce") != nonce or raw.get("diagnosticOnly") is not True
                or raw.get("coordinateSpace") != "runtime_transformed" or raw.get("phase") != "close_idle"
                or raw.get("title") not in REMOTE_CASES or type(raw.get("invocation")) is not int or not 1 <= raw["invocation"] <= 9_999_999
                or raw.get("status") not in ["captured", "unavailable"] or raw.get("reason") not in ["not_captured", "frames_captured", "no_allowed_frames", "capture_unconfirmed"]):
            raise ValueError()
        safe = {key: raw[key] for key in ["diagnosticOnly", "coordinateSpace", "phase", "title", "invocation", "status", "reason"]}
        for key in ["paused", "resumeConfirmed", "disconnectConfirmed"]:
            if type(raw.get(key)) is not bool:
                raise ValueError()
            safe[key] = raw[key]
        frames = raw.get("frames")
        if not isinstance(frames, list) or len(frames) > 8:
            raise ValueError()
        safe["frames"] = []
        for frame in frames:
            if (not isinstance(frame, dict) or frame.get("file") not in STACK_FILES or type(frame.get("line")) is not int
                    or type(frame.get("column")) is not int or not 1 <= frame["line"] <= 1_000_000 or not 1 <= frame["column"] <= 100_000):
                raise ValueError()
            safe["frames"].append({key: frame[key] for key in ["file", "line", "column"]})
        if safe["status"] == "captured" and not (safe["paused"] and safe["resumeConfirmed"] and safe["disconnectConfirmed"] and frames and safe["reason"] == "frames_captured"):
            raise ValueError()
        return safe
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unavailable", "diagnosticOnly": True}


def diagnostic_capture_ready(filename, nonce, phases):
    capture = stack_diagnostics(filename, nonce)
    phase = phase_diagnostics(phases)
    return capture.get("status") == "captured" and phase.get("status") == "available" and any(
        active.get("phase") == "close_idle" and active.get("title") == capture["title"] and active.get("invocation") == capture["invocation"]
        for active in phase.get("active", []))


def communicate_with_diagnostic_capture(process, timeout, capture_ready=None):
    if capture_ready is None:
        return process.communicate(timeout=timeout)
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, timeout)
        try:
            return process.communicate(timeout=min(0.25, remaining))
        except subprocess.TimeoutExpired:
            if capture_ready():
                raise DiagnosticCaptureComplete() from None
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(process.args, timeout) from None


def phase_diagnostics(filename):
    result = {"status": "unavailable", "diagnosticOnly": True}
    try:
        if filename.stat().st_size > 200_000:
            return result
        value = json.loads(filename.read_text())
        if value.get("version") != 1 or value.get("status") != "available" or value.get("diagnosticOnly") is not True:
            return result
        def bounded(number):
            return type(number) is int and 0 <= number <= 9_999_999
        def item(raw, event=False):
            if not isinstance(raw, dict) or raw.get("title") not in REMOTE_CASES or raw.get("phase") not in PHASES or not bounded(raw.get("invocation")):
                raise ValueError()
            safe = {key: raw[key] for key in ["title", "phase", "invocation"]}
            if event:
                if raw.get("edge") not in ["enter", "leave", "throw", "reject"] or not bounded(raw.get("sequence")) or not bounded(raw.get("elapsedMs")):
                    raise ValueError()
                safe.update({key: raw[key] for key in ["edge", "sequence", "elapsedMs"]})
                if raw["phase"] == "docker_execute" and raw["edge"] == "leave":
                    if type(raw.get("exitCode")) is int and abs(raw["exitCode"]) <= 9999:
                        safe["exitCode"] = raw["exitCode"]
                    if type(raw.get("timedOut")) is bool:
                        safe["timedOut"] = raw["timedOut"]
            return safe
        if not bounded(value.get("pulseCount")) or not bounded(value.get("lastPulseMs")) or value.get("workerCwdRelation") not in ["product_root", "server_root", "other"]:
            return result
        events, active = value.get("events"), value.get("active")
        if not isinstance(events, list) or len(events) > 256 or not isinstance(active, list) or len(active) > 256:
            return result
        result.update(status="available", pulseCount=value["pulseCount"], lastPulseMs=value["lastPulseMs"], workerCwdRelation=value["workerCwdRelation"], events=[item(raw, True) for raw in events], active=[item(raw) for raw in active])
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unavailable", "diagnosticOnly": True}
    return result


def prepare_phase_overlay(source, private):
    """Keep the product config/cwd intact; add a private diagnostic setup only."""
    directory = private / "phase-overlay"
    directory.mkdir(mode=0o700)
    scripts = Path(__file__).resolve().parent
    template = (scripts / "crewroom-runtime-phase-setup.mjs").read_text()
    # JSON escaping keeps the substituted root a literal module identifier.
    root = json.dumps(str(source))[1:-1]
    setup = directory / "setup.mjs"
    setup.write_text(template.replace('__PRODUCT_ROOT__', root))
    core = directory / "crewroom-runtime-phase-core.mjs"
    core.write_bytes((scripts / core.name).read_bytes())
    worker = directory / "crewroom-runtime-stack-worker.mjs"
    worker.write_bytes((scripts / worker.name).read_bytes())
    (directory / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
    config = directory / "vitest.config.mjs"
    config.write_text('import path from "node:path";\nimport original from ' + json.dumps(str(source / 'server/vitest.config.ts')) + ';\n'
        + 'const serverRoot=' + json.dumps(str(source / 'server')) + ';\n'
        + 'export default {root:' + json.dumps(str(source)) + ',test:{projects:[{...original,configFile:false,root:serverRoot,test:{...original.test,name:"@paperclipai/server",setupFiles:[...original.test.setupFiles.map(file=>path.resolve(serverRoot,file)),' + json.dumps(str(setup)) + ']}}]}};\n')
    return config, {"diagnosticOnly": True, "configSha256": digest(config), "setupSha256": digest(setup), "coreSha256": digest(core), "stackWorkerSha256": digest(worker)}


class QualificationFailure(Exception):
    pass


class ReportFailure(QualificationFailure):
    def __init__(self, classification):
        self.classification = classification
        super().__init__(classification)


def read_stock_report(filename):
    try:
        content = filename.read_bytes()
    except FileNotFoundError:
        raise ReportFailure("missing_report") from None
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError):
        raise ReportFailure("invalid_report_json") from None
    if not isinstance(value, dict) or not isinstance(value.get("testResults"), list):
        raise ReportFailure("invalid_report_shape")
    return value


def revision(value):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", value or ""):
        raise QualificationFailure("revision_invalid")
    return value.lower()


def state_directory():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_OS") != "Linux":
        raise QualificationFailure("github_linux_runner_required")
    identity = os.environ.get("GITHUB_RUN_ID", "") + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[0-9]+-[0-9]+", identity):
        raise QualificationFailure("run_identity_invalid")
    return Path(os.environ["RUNNER_TEMP"]).resolve() / ("crewroom-runtime-" + identity)


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def stage_public_provider(provider, private, expected_sha256):
    """Normalize only a private copy of the public build artifact, not source.

    Docker cp can retain the host UID. With all capabilities dropped, container
    root cannot chmod another UID's 0700 file. A readable/executable copy avoids
    any container privilege or ownership change.
    """
    if not provider.is_file() or provider.stat().st_uid != os.getuid() or digest(provider) != expected_sha256:
        raise QualificationFailure("provider_source_artifact_mismatch")
    staged = private / "remote-fake-codex-app-server"
    shutil.copyfile(provider, staged)
    staged.chmod(0o555)
    if digest(staged) != expected_sha256 or digest(provider) != expected_sha256:
        raise QualificationFailure("provider_staged_artifact_mismatch")
    return staged


def report_counts(report, expected, only_selected=False):
    assertions = [case for suite in report.get("testResults", []) for case in suite.get("assertionResults", [])]
    selected = [case for case in assertions if case.get("title") in expected]
    counts = {"expected": len(expected), "passed": 0, "failed": 0, "skipped": 0}
    for case in selected:
        status = case.get("status")
        counts["passed" if status == "passed" else "failed" if status == "failed" else "skipped"] += 1
    counts["unselectedSkipped"] = sum(case.get("title") not in expected and case.get("status") in ["pending", "skipped", "todo", "disabled"] for case in assertions)
    valid = (len(selected) == len(expected) and {case.get("title") for case in selected} == set(expected)
             and counts["passed"] == len(expected) and counts["failed"] == counts["skipped"] == 0
             and report.get("numFailedTests") == 0 and report.get("success") is True)
    if only_selected:
        valid = valid and report.get("numPassedTests") == len(expected) and not any(
            case.get("status") == "passed" and case.get("title") not in expected for case in assertions)
    counts["status"] = "passed" if valid else "failed"
    return counts


def selected_cases_entered(report, expected):
    assertions = [case for suite in report.get("testResults", []) for case in suite.get("assertionResults", [])]
    selected = [case for case in assertions if case.get("title") in expected]
    return (len(selected) == len(expected) and {case.get("title") for case in selected} == set(expected)
            and all(case.get("status") in ["passed", "failed"] for case in selected))


def safe_source_location(value, source):
    # Only this exact public fixture may enter the receipt. Resolve absolute,
    # file: and relative paths before checking; never echo arbitrary stack paths.
    match = re.fullmatch(r"(.+):(\d{1,7}):(\d{1,6})", value)
    if not match:
        return None
    name, line, column = match.groups()
    if name.startswith("file://"):
        name = name[7:]
    candidate = Path(name)
    if not candidate.is_absolute():
        candidate = source / candidate
    try:
        relative = candidate.resolve().relative_to(source.resolve()).as_posix()
    except (ValueError, OSError):
        return None
    if relative != RECOVERY_FILE or not (0 < int(line) <= 1_000_000 and 0 < int(column) <= 100_000):
        return None
    return {"file": RECOVERY_FILE, "line": int(line), "column": int(column)}


def safe_failure(failure, source):
    # This function consumes private text but only emits fixed enums, the exact
    # allowlisted fixture path, and bounded primitive comparisons. Never copy
    # error text, exception properties, arbitrary values or paths into output.
    if not isinstance(failure, str):
        return {"errorClass": "unknown"}
    clean = re.sub(r"\x1b\[[0-9;]*m", "", failure[:200_000])
    first = clean.splitlines()[0] if clean else ""
    classes = {"AssertionError": "assertion", "TypeError": "type_error", "RangeError": "range_error",
               "ReferenceError": "reference_error", "SyntaxError": "syntax_error", "TimeoutError": "timeout", "Error": "error"}
    kind = re.match(r"^(AssertionError|TypeError|RangeError|ReferenceError|SyntaxError|TimeoutError|Error):", first)
    result = {"errorClass": classes[kind[1]] if kind else "unknown"}
    if re.match(r"^Error: (?:(?:Test|Hook) timed out|Timed out)(?: in| after| waiting|\.)", first):
        result["errorClass"] = "timeout"
    locations = []
    for line in clean.splitlines()[1:]:
        # Stack-only records, not source excerpts or error messages containing
        # path-like text. Absolute private/TLS paths cannot pass the allowlist.
        frame = re.fullmatch(r"\s+at (?:[^()\r\n]+ \()?([^()\r\n]+:\d+:\d+)\)?\s*", line)
        if frame:
            location = safe_source_location(frame[1], source)
            if location and location not in locations:
                locations.append(location)
    if locations:
        result["locations"] = locations[:3]
    primitive = r"(true|false|[+-]?(?:0|[1-9]\d{0,6}))"
    comparison = re.fullmatch(r"AssertionError: expected " + primitive + r" to (be|equal|deeply equal|be greater than|be less than|be greater than or equal to|be less than or equal to) " + primitive + r"(?: // Object\.is equality)?", first)
    if comparison:
        def value(raw):
            return raw == "true" if raw in ["true", "false"] else int(raw)
        actual, expected = value(comparison[1]), value(comparison[3])
        operators = {"be": "equal", "equal": "equal", "deeply equal": "equal", "be greater than": "greater_than",
                     "be less than": "less_than", "be greater than or equal to": "greater_or_equal", "be less than or equal to": "less_or_equal"}
        result["comparison"] = {"operator": operators[comparison[2]], "expected": expected, "actual": actual}
    length = re.fullmatch(r"AssertionError: expected .+ to have a length of ([0-9]{1,7}) but got ([0-9]{1,7})", first)
    if length:
        # Collection content stays private; only its reported cardinality leaves.
        result["comparison"] = {"operator": "length_equal", "expected": int(length[1]), "actual": int(length[2])}
    return result


def report_diagnostics(report, expected, source):
    assertions = [case for suite in report.get("testResults", []) for case in suite.get("assertionResults", [])]
    cases = []
    for title in expected:
        matches = [case for case in assertions if case.get("title") == title]
        status = "missing" if not matches else "duplicate" if len(matches) != 1 else matches[0].get("status")
        if status not in ["passed", "failed", "pending", "skipped", "todo", "disabled", "missing", "duplicate"]:
            status = "unknown"
        case = {"title": title, "status": status}
        if len(matches) == 1:
            failures = matches[0].get("failureMessages")
            if status == "failed":
                case["failures"] = [safe_failure(failure, source) for failure in failures[:3]] if isinstance(failures, list) and failures else [{"errorClass": "unknown"}]
            # Vitest's declaration location is a useful fallback if the failure
            # stack lacks a source frame. The file is constant, never report.name.
            location = matches[0].get("location")
            if isinstance(location, dict):
                line, column = location.get("line"), location.get("column")
                if type(line) is int and type(column) is int and 0 < line <= 1_000_000 and 0 < column <= 100_000:
                    case["declaration"] = {"file": RECOVERY_FILE, "line": line, "column": column}
        cases.append(case)
    return cases


def attach_cause_diagnostics(counts, filename, expected):
    # Treat the infrastructure reporter as another private input boundary.
    # Reconstruct only enum/int/bool/constant-path fields, never copy objects.
    error_classes = {"assertion", "type_error", "range_error", "reference_error", "syntax_error", "timeout", "error", "unknown"}
    operators = {"equal", "greater_than", "less_than", "greater_or_equal", "less_or_equal", "length_equal"}
    counts["causeDiagnosticsStatus"] = "unavailable"
    try:
        if filename.stat().st_size > 1_000_000:
            return
        report = json.loads(filename.read_text())
        if report.get("version") not in [1, 2] or report.get("status") != "available" or not isinstance(report.get("cases"), list):
            return
        by_title = {}
        for case in report["cases"]:
            title = case.get("title")
            if title not in expected:
                continue
            if title in by_title or not isinstance(case.get("chains"), list):
                return
            chains = []
            for chain in case["chains"][:3]:
                state = chain.get("chainState")
                entries = chain.get("entries")
                if state not in ["absent", "complete", "cycle", "truncated"] or not isinstance(entries, list) or not (1 <= len(entries) <= 8):
                    return
                safe_entries = []
                for depth, entry in enumerate(entries):
                    if entry.get("depth") != depth or entry.get("relation") != ("root" if depth == 0 else "cause") or entry.get("errorClass") not in error_classes:
                        return
                    safe = {"depth": depth, "relation": "root" if depth == 0 else "cause", "errorClass": entry["errorClass"]}
                    if entry.get("errorCode") in CAUSE_ERROR_CODES:
                        safe["errorCode"] = entry["errorCode"]
                    locations = []
                    for location in entry.get("locations", [])[:3]:
                        line, column = location.get("line"), location.get("column")
                        if location.get("file") in CAUSE_SOURCE_FILES and type(line) is int and type(column) is int and 0 < line <= 1_000_000 and 0 < column <= 100_000:
                            locations.append({"file": location["file"], "line": line, "column": column})
                    if locations:
                        safe["locations"] = locations
                    comparison = entry.get("comparison")
                    if isinstance(comparison, dict) and comparison.get("operator") in operators:
                        actual, wanted = comparison.get("actual"), comparison.get("expected")
                        if all(type(value) is bool or (type(value) is int and abs(value) <= 9_999_999) for value in [actual, wanted]):
                            safe["comparison"] = {"operator": comparison["operator"], "expected": wanted, "actual": actual}
                    safe_entries.append(safe)
                chains.append({"chainState": state, "entries": safe_entries})
            by_title[title] = chains
        for case in counts["cases"]:
            if case["status"] == "failed":
                case["causeDiagnosticsStatus"] = "available" if case["title"] in by_title else "unavailable"
                if case["title"] in by_title:
                    case["causeChains"] = by_title[case["title"]]
        counts["causeDiagnosticsStatus"] = "available"
    except (OSError, ValueError, TypeError, AttributeError):
        return


def partial_diagnostics(filename, expected):
    value = {"status": "unavailable", "snapshotState": "unknown", "cases": [{"title": title, "status": "unknown"} for title in expected], "events": []}
    try:
        if filename is None or filename.stat().st_size > 1_000_000:
            return value
        report = json.loads(filename.read_text())
        if report.get("version") != 2 or not isinstance(report.get("cases"), list):
            return value
        value["snapshotState"] = "final" if report.get("complete") is True else "partial"
        if report.get("status") == "available":
            for case in value["cases"]:
                case["status"] = "not_started"
        # Reuse the existing double whitelist for error chains.
        counts = {"cases": [{"title": title, "status": "failed"} for title in expected]}
        attach_cause_diagnostics(counts, filename, expected)
        value["status"] = counts.get("causeDiagnosticsStatus", "unavailable")
        seen = set()
        for raw in report["cases"]:
            title = raw.get("title")
            if title not in expected or title in seen:
                continue
            seen.add(title)
            case = next(item for item in value["cases"] if item["title"] == title)
            state = raw.get("status")
            if state in ["running", "not_started"]:
                case["status"] = state
            elif state in ["passed", "failed", "skipped"]:
                case.update(status="finished", observedResult=state)
            else:
                case["status"] = "unknown"
            safe = next(item for item in counts["cases"] if item["title"] == title)
            if "causeChains" in safe:
                case["causeChains"] = safe["causeChains"]
        for event in report.get("events", [])[-256:]:
            kind = event.get("type")
            sequence, elapsed = event.get("sequence"), event.get("elapsedMs")
            if kind not in ["run_start", "run_end", "module_start", "module_end", "case_start", "case_end", "hook_start", "hook_end"] or type(sequence) is not int or not 0 < sequence <= 1_000_000 or type(elapsed) is not int or not 0 <= elapsed <= 9_999_999:
                continue
            safe = {"type": kind, "sequence": sequence, "elapsedMs": elapsed}
            if kind in ["case_start", "case_end"]:
                if event.get("title") not in expected:
                    continue
                safe["title"] = event["title"]
                if kind == "case_end":
                    safe["status"] = event.get("status") if event.get("status") in ["passed", "failed", "skipped", "unknown"] else "unknown"
            if kind in ["hook_start", "hook_end"]:
                if event.get("hook") not in ["beforeAll", "afterAll", "beforeEach", "afterEach"]:
                    continue
                safe["hook"] = event["hook"]
                if event.get("title") in expected:
                    safe["title"] = event["title"]
            value["events"].append(safe)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return value


class AdoptedZombieReaper:
    """One command's adopted children; never consume its Popen wait status.

    Construct/start only after Popen has returned its immutable protected PID.
    Stop/join before a next spawn, direct subprocess.run or final broad cleanup.
    """
    def __init__(self, protected_pid):
        self.protected_pid = protected_pid
        self.parent_pid = os.getpid()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="qualification-adopted-reaper", daemon=True)
        self.error = False
        self.reaped = 0
        self.joined = False

    def start(self):
        self.thread.start()

    def _loop(self):
        try:
            children = Path(f"/proc/self/task/{self.parent_pid}/children")
            while not self.done.is_set():
                for value in children.read_text().split():
                    pid = int(value)
                    if pid == self.protected_pid:
                        continue
                    # Kernel child ownership is rechecked by waitpid. WNOHANG
                    # never signals or stops a still-live adopted child. The
                    # protected direct Popen child is never passed to waitpid.
                    try:
                        reaped, _status = os.waitpid(pid, os.WNOHANG)
                        self.reaped += int(reaped != 0)
                    except ChildProcessError:
                        pass
                self.done.wait(0.02)
        except Exception:
            self.error = True

    def stop(self):
        self.done.set()
        self.thread.join(timeout=5)
        self.joined = not self.thread.is_alive()
        if not self.joined:
            raise QualificationFailure("adopted_reaper_join_unconfirmed")
        if self.error:
            raise QualificationFailure("adopted_reaper_failed")


def owned_children_cleanup(diagnostic=None):
    detail = diagnostic if diagnostic is not None else {}
    detail.update(reason="running", reaped=0, signals=0)
    deadline = time.monotonic() + 20
    children_file = Path(f"/proc/self/task/{os.getpid()}/children")
    while time.monotonic() < deadline:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                detail["reaped"] = min(detail["reaped"] + 1, 1_000_000)
        except ChildProcessError:
            detail["reason"] = "echild"
            return True
        except OSError:
            detail["reason"] = "wait_error"
            return False
        try:
            children = children_file.read_text().split()
        except OSError:
            detail["reason"] = "read_error"
            return False
        for child in children:
            try:
                os.kill(int(child), signal.SIGKILL)
                detail["signals"] = min(detail["signals"] + 1, 1_000_000)
            except ProcessLookupError:
                pass
            except (OSError, ValueError):
                detail["reason"] = "signal_error"
                return False
        time.sleep(0.02)
    detail["reason"] = "deadline"
    return False


def container_cleanup(state, diagnostic=None):
    detail = diagnostic if diagnostic is not None else {}
    detail.update(status="running", operations=[])

    def check(operation, command):
        result = {"operation": operation, "status": "running"}
        detail["operations"].append(result)
        try:
            process = subprocess.run(command, capture_output=True, text=True, timeout=30)
            if type(process.returncode) is int and -255 <= process.returncode <= 65535:
                result["exitCode"] = process.returncode
            result["status"] = "passed" if process.returncode == 0 else "failed"
            return process
        except subprocess.TimeoutExpired:
            result.update(status="failed", errorClass="timeout")
        except OSError:
            result.update(status="failed", errorClass="os_error")
        return None

    def finish(ok):
        detail["status"] = "passed" if ok else "failed"
        return ok

    name = state.get("container")
    if not name:
        detail["containerRequested"] = False
        return finish(True)
    detail["containerRequested"] = True
    inventory_args = ["docker", "ps", "-a", "--filter", "label=" + OWNER_LABEL + "=" + state["owner"], "--format", "{{.ID}}"]
    inventory = check("inventory", inventory_args)
    if inventory is None or inventory.returncode:
        return finish(False)
    owned = inventory.stdout.split()
    detail["ownedCount"] = min(len(owned), 1_000_000)
    if not owned:
        detail["confirmedAbsent"] = True
        return finish(True)
    if len(owned) != 1:
        return finish(False)
    inspection = check("inspect", ["docker", "inspect", owned[0]])
    if inspection is None or inspection.returncode:
        return finish(False)
    try:
        records = json.loads(inspection.stdout)
        if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
            raise ValueError()
        config = records[0].get("Config", {})
        labels = config.get("Labels", {})
        state_record = records[0].get("State", {})
        if not isinstance(state_record, dict):
            raise ValueError()
        container_id = records[0]["Id"]
        if not isinstance(labels, dict) or not isinstance(container_id, str) or not container_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError, KeyError):
        detail["operations"].append({"operation": "inspect_shape", "status": "failed", "errorClass": "json_shape"})
        return finish(False)
    status = state_record.get("Status")
    detail["containerState"] = status if status in ["created", "running", "paused", "restarting", "removing", "exited", "dead"] else "unknown"
    detail["ownerMatches"] = labels.get(OWNER_LABEL) == state.get("owner")
    detail["operations"].append({"operation": "owner_check", "status": "passed" if detail["ownerMatches"] else "failed"})
    if not detail["ownerMatches"]:
        return finish(False)
    detail["idMatches"] = not state.get("containerId") or state["containerId"] == container_id
    detail["operations"].append({"operation": "id_check", "status": "passed" if detail["idMatches"] else "failed"})
    if not detail["idMatches"]:
        return finish(False)
    stopped = check("stop", ["docker", "stop", "--timeout", "20", container_id])
    if stopped is None or stopped.returncode:
        return finish(False)
    remaining = check("post_stop_inventory", inventory_args)
    if remaining is None or remaining.returncode:
        return finish(False)
    if not remaining.stdout.split():
        detail["confirmedAbsent"] = True
        return finish(True)
    detail["remainingIdMatches"] = remaining.stdout.split() in [[container_id[:12]], [container_id]]
    if not detail["remainingIdMatches"]:
        return finish(False)
    removed = check("remove", ["docker", "rm", container_id])
    if removed is None or removed.returncode:
        return finish(False)
    verified = check("final_inventory", inventory_args)
    detail["confirmedAbsent"] = verified is not None and verified.returncode == 0 and not verified.stdout.split()
    return finish(detail["confirmedAbsent"])


def private_mount_identity(fd):
    if sys.platform != "linux":
        return None
    info = Path(f"/proc/self/fdinfo/{fd}").read_text()
    match = re.search(r"^mnt_id:\s*(\d+)$", info, re.MULTILINE)
    if not match:
        raise PermissionError("mount_unverified")
    return int(match[1])


def cleanup_private_fixture(private, processes_confirmed, diagnostic):
    diagnostic.update(status="failed", reason="processes_unconfirmed", directories=0, entries=0)
    if not processes_confirmed:
        return False
    parent_fd = root_fd = None
    try:
        if os.path.abspath(private) != os.path.abspath(state_directory()):
            diagnostic["reason"] = "unsafe_path"
            return False
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent_fd = os.open(private.parent, flags)
        parent_stat = os.fstat(parent_fd)
        if parent_stat.st_uid != os.getuid():
            diagnostic["reason"] = "unsafe_owner"
            return False
        try:
            root_fd = os.open(private.name, flags, dir_fd=parent_fd)
        except FileNotFoundError:
            diagnostic.update(status="passed", reason="already_absent")
            return True
        root_stat = os.fstat(root_fd)
        root_mount = private_mount_identity(root_fd)
        if root_stat.st_dev != parent_stat.st_dev or root_mount != private_mount_identity(parent_fd):
            diagnostic["reason"] = "external_mount"
            return False
        if root_stat.st_uid != os.getuid():
            diagnostic["reason"] = "unsafe_owner"
            return False

        def sweep(directory_fd, keep_owner=False):
            current = os.fstat(directory_fd)
            if current.st_uid != os.getuid() or not stat.S_ISDIR(current.st_mode):
                raise PermissionError("unsafe_owner")
            if current.st_dev != root_stat.st_dev or private_mount_identity(directory_fd) != root_mount:
                raise PermissionError("external_mount")
            # Only owned directories gain owner access; never chmod a file or
            # follow a symlink. The directory FD pins the verified inode.
            os.fchmod(directory_fd, stat.S_IMODE(current.st_mode) | stat.S_IRWXU)
            diagnostic["directories"] = min(diagnostic["directories"] + 1, 1_000_000)
            names = os.listdir(directory_fd)
            names.sort(key=lambda name: name == "owner.json" if keep_owner else False)
            for name in names:
                before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if before.st_uid != os.getuid():
                    raise PermissionError("unsafe_owner")
                if before.st_dev != root_stat.st_dev:
                    raise PermissionError("external_mount")
                if stat.S_ISDIR(before.st_mode):
                    child_fd = os.open(name, flags, dir_fd=directory_fd)
                    try:
                        opened = os.fstat(child_fd)
                        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                            raise PermissionError("entry_changed")
                        sweep(child_fd)
                    finally:
                        os.close(child_fd)
                    after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
                        raise PermissionError("entry_changed")
                    os.rmdir(name, dir_fd=directory_fd)
                else:
                    # A link is unlinked as a link; its target is never opened.
                    os.unlink(name, dir_fd=directory_fd)
                diagnostic["entries"] = min(diagnostic["entries"] + 1, 1_000_000)
        sweep(root_fd, keep_owner=True)
        after = os.stat(private.name, dir_fd=parent_fd, follow_symlinks=False)
        if (after.st_dev, after.st_ino) != (root_stat.st_dev, root_stat.st_ino):
            diagnostic["reason"] = "entry_changed"
            return False
        os.rmdir(private.name, dir_fd=parent_fd)
        diagnostic.update(status="passed", reason="removed")
        return True
    except (OSError, QualificationFailure) as error:
        diagnostic["reason"] = str(error) if isinstance(error, PermissionError) and str(error) in ["unsafe_owner", "external_mount", "entry_changed", "mount_unverified"] else "unsafe_path" if isinstance(error, QualificationFailure) else "os_error"
        return False
    finally:
        if root_fd is not None:
            os.close(root_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def write_receipt(output, receipt):
    output.mkdir(parents=True, exist_ok=True)
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


def run_qualification(source, output):
    product_revision = revision(os.environ.get("PRODUCT_REVISION"))
    helper_revision = revision(os.environ.get("HELPER_REVISION"))
    private = state_directory()
    private.mkdir(mode=0o700, exist_ok=False)
    os.umask(0o077)
    receipt = {"productRevision": product_revision, "helperRevision": helper_revision, "status": "running", "stages": {}}
    state = {"owner": os.urandom(16).hex(), "container": None}
    state_path = private / "owner.json"
    state_path.write_text(json.dumps(state))
    stage = "preflight"
    qualification_passed = True
    current = None
    active_reaper = None
    reaped_children = 0
    reaper_failed = False
    partial_file = None
    partial_expected = []
    phase_file = None
    stack_file, capture_nonce = None, None
    phase_enabled = os.environ.get("CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS") == "1"
    if phase_enabled:
        receipt.update(diagnosticOnly=True, stockQualification=False)
    last_timeout = None
    # Build/test children receive no ambient provider/account credentials.
    allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "RUSTUP_HOME", "CARGO_HOME", "PNPM_HOME", "COREPACK_HOME"]
    child_env = {name: os.environ[name] for name in allowed if name in os.environ}
    child_env.update(CI="true", GITHUB_ACTIONS="true", RUSTUP_TOOLCHAIN="1.97.1", CARGO_BUILD_JOBS="2",
                     CARGO_PROFILE_DEV_DEBUG="0", GOMAXPROCS="2", GOMEMLIMIT="3GiB", NODE_OPTIONS="--max-old-space-size=4096",
                     PAPERCLIP_TELEMETRY_DISABLED="1", PAPERCLIP_ANNOUNCEMENTS_ENABLED="false", HEARTBEAT_SCHEDULER_ENABLED="false",
                     PAPERCLIP_TEST_CONTROLLER_OUTAGE_MS="1000", TMPDIR=str(private))

    def run(command, timeout=600, capture=False, env=None, allow_failure=False, diagnostic=None, diagnostic_capture=None):
        nonlocal current, active_reaper, reaped_children, reaper_failed, last_timeout
        last_timeout = timeout
        log = private / (stage + ".log")
        with log.open("ab") as stream:
            current = subprocess.Popen(command, cwd=source, env=env or child_env, start_new_session=True,
                                       stdout=subprocess.PIPE if capture else stream, stderr=stream)
            try:
                # Spawn registration is complete before this command-scoped
                # reaper can run. No other direct subprocess is created until
                # it has stopped and joined in finally.
                active_reaper = AdoptedZombieReaper(current.pid)
                active_reaper.start()
                stdout, _ = communicate_with_diagnostic_capture(current, timeout, diagnostic_capture)
                if diagnostic is not None:
                    diagnostic["exitCode"] = current.returncode
                if current.returncode and not allow_failure:
                    raise QualificationFailure("command_failed")
                return stdout.decode().strip() if capture else current.returncode
            except BaseException:
                if current.poll() is None:
                    os.killpg(current.pid, signal.SIGTERM)
                    try:
                        current.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(current.pid, signal.SIGKILL)
                        current.wait()
                raise
            finally:
                try:
                    if active_reaper is not None:
                        active_reaper.stop()
                except Exception:
                    reaper_failed = True
                    raise
                finally:
                    if active_reaper is not None and active_reaper.joined:
                        reaped_children += active_reaper.reaped
                        active_reaper = None
                    current = None

    try:
        if platform.machine() != "x86_64":
            raise QualificationFailure("amd64_runner_required")
        if sys.platform != "linux" or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise QualificationFailure("subreaper_unavailable")
        if source == Path(__file__).resolve().parents[1] or run(["git", "rev-parse", "HEAD"], capture=True) != product_revision:
            raise QualificationFailure("product_checkout_mismatch")
        infrastructure = Path(__file__).resolve().parents[1]
        actual_helper = subprocess.run(["git", "rev-parse", "HEAD"], cwd=infrastructure, capture_output=True, text=True, check=True).stdout.strip()
        if actual_helper != helper_revision:
            raise QualificationFailure("helper_checkout_mismatch")
        if run(["git", "status", "--porcelain"], capture=True):
            raise QualificationFailure("product_checkout_dirty")
        if not re.search(r'^channel\s*=\s*"1\.97\.1"\s*$', (source / "packages/paperclip-runner/rust-toolchain.toml").read_text(), re.MULTILINE):
            raise QualificationFailure("product_toolchain_mismatch")
        toolchain = {"node": run(["node", "--version"], capture=True), "pnpm": run(["pnpm", "--version"], capture=True),
                     "rustc": run(["rustc", "--version"], capture=True), "cargo": run(["cargo", "--version"], capture=True)}
        if (toolchain["node"] != "v24.14.0" or toolchain["pnpm"] != "9.15.4" or
                not toolchain["rustc"].startswith("rustc 1.97.1 ") or not toolchain["cargo"].startswith("cargo 1.97.1 ")):
            raise QualificationFailure("toolchain_mismatch")
        receipt["toolchain"] = {**toolchain, "cargoProfile": "dev-debug0", "remoteImage": IMAGE, "architecture": "x86_64"}
        receipt["stages"][stage] = {"status": "passed"}
        stage = "install"
        run(["pnpm", "install", "--frozen-lockfile"], timeout=900)
        run(["pnpm", "preflight:workspace-links"])
        run(["pnpm", "--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"])
        receipt["stages"][stage] = {"status": "passed"}
        stage = "reporter_smoke"
        run(["node", str(Path(__file__).resolve().with_name("crewroom-runtime-cause-reporter-smoke.mjs"))],
            env={**child_env, "CREWROOM_QUALIFICATION_DEPENDENCY_ROOT": str(source)})
        receipt["stages"][stage] = {"status": "passed"}
        if phase_enabled:
            stage = "phase_overlay_smoke"
            run(["node", str(Path(__file__).resolve().with_name("crewroom-runtime-phase-smoke.mjs"))],
                timeout=60, env={**child_env, "CREWROOM_QUALIFICATION_DEPENDENCY_ROOT": str(source)})
            run(["node", str(Path(__file__).resolve().with_name("crewroom-runtime-stack-smoke.mjs"))], timeout=60,
                env={**child_env, "CREWROOM_QUALIFICATION_DEPENDENCY_ROOT": str(source)})
            receipt["stages"][stage] = {"status": "passed", "diagnosticOnly": True}
        stage = "debug_binaries"
        run(["cargo", "build", "--manifest-path", "packages/paperclip-runner/runner/Cargo.toml", "--locked", "-j", "2",
             "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server"], timeout=2400)
        runner, provider = source / RUNNER, source / PROVIDER
        for binary in [runner, provider]:
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise QualificationFailure("binary_missing")
        selected = run(["node", "--import", "./cli/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e",
                        'import {defaultCapabilityRunnerdBinary} from "./packages/paperclip-runner/src/live/runnerd-codex-transport.ts"; console.log(defaultCapabilityRunnerdBinary());'], capture=True)
        if Path(selected).resolve() != runner.resolve():
            raise QualificationFailure("default_runner_not_built_debug_binary")
        receipt["binaries"] = {"defaultRunner": {"path": RUNNER, "sha256": digest(runner)}, "fakeProvider": {"path": PROVIDER, "sha256": digest(provider)}}
        receipt["stages"][stage] = {"status": "passed"}
        if os.environ.get("CREWROOM_QUALIFICATION_EXPORT_BINARIES") == "1":
            stage = "diagnostic_binary_export"
            binding = {"productRevision": product_revision, "helperRevision": helper_revision, "target": "linux-amd64",
                "toolchain": {**toolchain, "cargoProfile": "dev-debug0"}, "cargoLockSha256": digest(source / "packages/paperclip-runner/runner/Cargo.lock"),
                "binaries": {"paperclip-runnerd": {"buildSha256": receipt["binaries"]["defaultRunner"]["sha256"]},
                    "fake-codex-app-server": {"buildSha256": receipt["binaries"]["fakeProvider"]["sha256"]}}}
            binding_file = private / "public-binary-binding.json"
            binding_file.write_text(json.dumps(binding))
            binary_output = output.parent / "qualification-binaries"
            run(["python3", str(Path(__file__).resolve().with_name("crewroom-runtime-export-binaries.py")), "stage", "--source", str(source),
                 "--output", str(binary_output), "--binding", str(binding_file)], env={**child_env,
                    "CREWROOM_QUALIFICATION_EXPORT_BINARIES": "1", "CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS": "1"})
            receipt["stages"][stage] = {"status": "staged", "diagnosticOnly": True, "manifestSha256": digest(binary_output / "manifest.json")}
        stage = "local_real_processes"
        local_report = private / "local-report.json"
        local_causes = private / "local-causes.json"
        partial_file, partial_expected = local_causes, LOCAL_CASES
        cause_reporter = str(Path(__file__).resolve().with_name("crewroom-runtime-cause-reporter.mjs"))
        local_env = {**child_env, "CREWROOM_QUALIFICATION_SOURCE_ROOT": str(source), "CREWROOM_QUALIFICATION_CAUSE_OUTPUT": str(local_causes)}
        code = run(["pnpm", "exec", "vitest", "run", "--project", "@paperclipai/server", RECOVERY_FILE,
                    "--maxWorkers=1", "--includeTaskLocation", "--reporter=json", "--reporter=" + cause_reporter, "--outputFile=" + str(local_report)], timeout=1200, allow_failure=True, env=local_env)
        report = read_stock_report(local_report)
        counts = report_counts(report, LOCAL_CASES)
        counts["cases"] = report_diagnostics(report, LOCAL_CASES, source)
        attach_cause_diagnostics(counts, local_causes, LOCAL_CASES)
        counts["exitCode"] = code
        if code != 0:
            counts["status"] = "failed"
        receipt["stages"][stage] = counts
        qualification_passed = counts["status"] == "passed"
        # Independent remote cases may still collect evidence after an entered
        # local assertion fails. Missing/skipped cases indicate preparation did
        # not complete, so those still stop the subsequent stages.
        if not selected_cases_entered(report, LOCAL_CASES):
            raise QualificationFailure("local_cases_not_entered")
        stage = "local_process_cleanup"
        child_detail = {}
        child_ok = owned_children_cleanup(child_detail)
        receipt["stages"][stage] = {"status": "passed" if child_ok else "failed", "children": child_detail}
        if not child_ok:
            raise QualificationFailure("local_process_cleanup_unconfirmed")
        stage = "remote_container"
        remote_details = {"status": "running", "operations": [], "missingTools": {}}
        receipt["stages"][stage] = remote_details

        def prepare(operation, command, *, tool=None, **options):
            allowed_operations = {"image_pull", "container_start", "isolation_probe", "required_tool", "node_version",
                                  "provider_directory", "provider_copy", "provider_permissions", "provider_hash", "port_probe", "tls_fixture"}
            if operation not in allowed_operations or (tool is not None and tool not in ["node", "ps", "setsid", "tar", "base64"]):
                raise QualificationFailure("preparation_operation_invalid")
            detail = {"operation": operation, "status": "running"}
            if tool is not None:
                detail["tool"] = tool
            remote_details["operations"].append(detail)
            try:
                result = run(command, diagnostic=detail, **options)
                detail["status"] = "passed" if detail.get("exitCode") == 0 else "failed"
                return result
            except BaseException:
                detail["status"] = "failed"
                raise

        name = "crewroom-qualification-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
        state["container"] = name
        state_path.write_text(json.dumps(state))
        prepare("image_pull", ["docker", "pull", IMAGE], timeout=300)
        container_id = prepare("container_start", ["docker", "run", "-d", "--init", "--name", name, "--label", OWNER_LABEL + "=" + state["owner"],
                            "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                            "--publish", "127.0.0.1::43127", "--entrypoint", "/bin/sh", IMAGE, "-c", "exec sleep infinity"], capture=True)
        state["containerId"] = container_id
        state_path.write_text(json.dumps(state))
        inspection = json.loads(prepare("isolation_probe", ["docker", "inspect", container_id], capture=True))[0]
        remote_details["isolationValid"] = not (inspection["HostConfig"].get("Binds") or inspection["HostConfig"].get("Privileged"))
        if not remote_details["isolationValid"]:
            raise QualificationFailure("container_isolation_mismatch")
        for tool in ["node", "ps", "setsid", "tar", "base64"]:
            tool_code = prepare("required_tool", ["docker", "exec", name, "sh", "-c", 'command -v "$1" >/dev/null 2>&1', "qualification-tool", tool], tool=tool, allow_failure=True)
            remote_details["missingTools"][tool] = tool_code != 0
        if any(remote_details["missingTools"].values()):
            raise QualificationFailure("container_required_tool_missing")
        remote_details["nodeVersionMatches"] = prepare("node_version", ["docker", "exec", name, "node", "--version"], capture=True) == "v24.14.0"
        if not remote_details["nodeVersionMatches"]:
            raise QualificationFailure("container_node_mismatch")
        remote_details["providerStagingValid"] = False
        staged_provider = stage_public_provider(provider, private, receipt["binaries"]["fakeProvider"]["sha256"])
        remote_details["providerStagingValid"] = True
        prepare("provider_directory", ["docker", "exec", "-u", "root", name, "mkdir", "-p", "/opt/continuity"])
        prepare("provider_copy", ["docker", "cp", str(staged_provider), name + ":/opt/continuity/fake-codex-app-server"])
        # Match the existing Docker command runner's execution UID. Capability
        # set stays empty; check permissions rather than trying to change them.
        prepare("provider_permissions", ["docker", "exec", "-u", "root", name, "sh", "-c",
                'test -r /opt/continuity && test -x /opt/continuity && test -r /opt/continuity/fake-codex-app-server && test -x /opt/continuity/fake-codex-app-server'])
        container_hash = prepare("provider_hash", ["docker", "exec", "-u", "root", name, "node", "-e",
                'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/opt/continuity/fake-codex-app-server")).digest("hex"));'], capture=True)
        remote_details["providerHashMatches"] = container_hash == receipt["binaries"]["fakeProvider"]["sha256"]
        if not remote_details["providerHashMatches"]:
            raise QualificationFailure("container_provider_artifact_mismatch")
        port = prepare("port_probe", ["docker", "port", name, "43127/tcp"], capture=True)
        remote_details["portLoopbackValid"] = re.fullmatch(r"127\.0\.0\.1:[0-9]+", port) is not None
        if not remote_details["portLoopbackValid"]:
            raise QualificationFailure("published_port_not_loopback")
        key, cert = private / "continuity.key", private / "continuity.crt"
        prepare("tls_fixture", ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
             "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"])
        wrapper = private / "fake-codex"
        wrapper.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex-cli 0.999.0"\n  exit 0\nfi\nexec /opt/continuity/fake-codex-app-server --state-file-in-codex-home --durable-turn-ids --record-process-start --call-log "$PWD/provider-calls.log" "$@"\n')
        wrapper.chmod(0o700)
        remote_details["status"] = "passed"
        stage = "remote_continuity"
        remote_report = private / "remote-report.json"
        remote_causes = private / "remote-causes.json"
        phase_file = private / "remote-phases.json" if phase_enabled else None
        partial_file, partial_expected = remote_causes, REMOTE_CASES
        remote_env = {**child_env, "CREWROOM_QUALIFICATION_SOURCE_ROOT": str(source), "CREWROOM_QUALIFICATION_CAUSE_OUTPUT": str(remote_causes), "NODE_EXTRA_CA_CERTS": str(cert), "PAPERCLIP_TEST_RUNNER_TLS_KEY": str(key),
                      "PAPERCLIP_TEST_RUNNER_CONTAINER": name, "PAPERCLIP_TEST_RUNNER_PORT": port.rsplit(":", 1)[1],
                      "PAPERCLIP_TEST_LINUX_RUNNER_BINARY": str(runner), "PAPERCLIP_TEST_FAKE_CODEX_WRAPPER": str(wrapper)}
        phase_args = []
        if phase_enabled:
            phase_config, overlay_receipt = prepare_phase_overlay(source, private)
            receipt["stages"]["phase_overlay"] = {**overlay_receipt, "helperRevision": helper_revision}
            remote_env["CREWROOM_QUALIFICATION_PHASE_OUTPUT"] = str(phase_file)
            stack_file, capture_nonce = private / "remote-stack.json", os.urandom(16).hex()
            remote_env.update(CREWROOM_QUALIFICATION_STACK_OUTPUT=str(stack_file), CREWROOM_QUALIFICATION_CAPTURE_NONCE=capture_nonce)
            phase_args = ["--config", str(phase_config)]
        code = run(["pnpm", "exec", "vitest", "run", *phase_args, "--project", "@paperclipai/server", RECOVERY_FILE,
                    "-t", "preserves remote warm continuity across completed turns:", "--maxWorkers=1", "--includeTaskLocation", "--reporter=json", "--reporter=" + cause_reporter, "--outputFile=" + str(remote_report)],
                   timeout=1200, env=remote_env, allow_failure=True,
                   diagnostic_capture=(lambda: diagnostic_capture_ready(stack_file, capture_nonce, phase_file)) if phase_enabled else None)
        report = read_stock_report(remote_report)
        counts = report_counts(report, REMOTE_CASES, only_selected=True)
        counts["cases"] = report_diagnostics(report, REMOTE_CASES, source)
        attach_cause_diagnostics(counts, remote_causes, REMOTE_CASES)
        counts["exitCode"] = code
        if phase_file:
            counts["phaseDiagnostics"] = phase_diagnostics(phase_file)
            counts["stackDiagnostics"] = stack_diagnostics(stack_file, capture_nonce)
        if code != 0:
            counts["status"] = "failed"
        receipt["stages"][stage] = counts
        qualification_passed = qualification_passed and counts["status"] == "passed"
        stage = "source_integrity"
        run(["git", "diff", "--exit-code", "HEAD", "--"])
        receipt["stages"][stage] = {"status": "passed"}
        receipt["status"] = "diagnostic_only" if qualification_passed and phase_enabled else "passed" if qualification_passed else "failed"
    except BaseException as error:
        failure = receipt["stages"].setdefault(stage, {})
        failure["status"] = "failed"
        failure["stageFailureClass"] = "diagnostic_capture_complete" if isinstance(error, DiagnosticCaptureComplete) else "host_command_timeout" if isinstance(error, subprocess.TimeoutExpired) else error.classification if isinstance(error, ReportFailure) and error.classification in ["missing_report", "invalid_report_json", "invalid_report_shape"] else "other_stage_failure"
        if isinstance(error, subprocess.TimeoutExpired) and type(last_timeout) is int:
            failure["timeoutSeconds"] = last_timeout
        if stage in ["local_real_processes", "remote_continuity"]:
            failure["stockGate"] = "incomplete"
            failure["partialDiagnostics"] = partial_diagnostics(partial_file, partial_expected)
            if stage == "remote_continuity" and phase_file:
                failure["phaseDiagnostics"] = phase_diagnostics(phase_file)
                failure["stackDiagnostics"] = stack_diagnostics(stack_file, capture_nonce)
        receipt["status"] = "failed"
    finally:
        for event in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(event, signal.SIG_IGN)
        # A reaper that did not join must not race a new Docker Popen or the
        # final waitpid(-1) cleanup. Keep the owner state for always() recovery.
        reaper_joined = active_reaper is None
        container_ok = False
        children_ok = False
        container_detail = {}
        children_detail = {}
        if reaper_joined:
            try:
                container_ok = container_cleanup(state, container_detail)
            except Exception:
                container_detail.update(status="failed", errorClass="unexpected_error")
            children_ok = owned_children_cleanup(children_detail)
        cleanup_ok = reaper_joined and children_ok and container_ok
        receipt["stages"]["initialCleanup"] = {"status": "passed" if cleanup_ok else "failed", "reaperJoined": reaper_joined,
            "containerCleanup": container_ok, "childrenCleanup": children_ok, "container": container_detail, "children": children_detail}
        receipt["stages"]["adopted_child_reaping"] = {"status": "passed" if reaper_joined and not reaper_failed else "failed", "reaped": reaped_children}
        receipt["stages"]["cleanup"] = {"status": "passed" if cleanup_ok else "failed"}
        if not cleanup_ok:
            receipt["status"] = "failed"
        private_detail = {}
        private_ok = cleanup_private_fixture(private, cleanup_ok, private_detail)
        receipt["stages"]["privateCleanup"] = private_detail
        if not private_ok:
            receipt["status"] = "failed"
        write_receipt(output, receipt)
    print("Runtime qualification: " + receipt["status"])
    return 0 if receipt["status"] == "passed" else 1


def read_private_owner_state(private):
    root_fd = owner_fd = None
    try:
        root_fd = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if os.fstat(root_fd).st_uid != os.getuid():
            raise PermissionError()
        owner_fd = os.open("owner.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
        info = os.fstat(owner_fd)
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
            raise PermissionError()
        value = json.loads(os.read(owner_fd, 8193))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    finally:
        if owner_fd is not None: os.close(owner_fd)
        if root_fd is not None: os.close(root_fd)


def cleanup_only(output):
    private = state_directory()
    path = output / "receipt.json"
    try:
        receipt = json.loads(path.read_text())
    except (OSError, ValueError):
        receipt = {"status": "failed", "stages": {}}
    initial = receipt.get("stages", {}).get("initialCleanup", {})
    children_confirmed = initial.get("childrenCleanup") is True and initial.get("reaperJoined") is True
    initial_container = initial.get("containerCleanup") is True
    private_detail = {}
    container_detail = {}
    ok = False
    try:
        if not private.exists():
            ok = children_confirmed and initial_container and initial.get("status") == "passed"
            container_detail.update(status="passed" if ok else "failed", reason="initial_settlement_verified" if ok else "unconfirmed_absence")
        else:
            try:
                state = read_private_owner_state(private)
            except FileNotFoundError:
                # The former rmtree could remove owner.json before failing on
                # a readonly child. Only trusted initial settlement permits
                # cleaning this still-owned private tree without that marker.
                ok = children_confirmed and initial_container and initial.get("status") == "passed"
                container_detail.update(status="passed" if ok else "failed", reason="initial_settlement_verified" if ok else "missing_state")
            else:
                ok = container_cleanup(state, container_detail)
    except (OSError, ValueError, TypeError):
        container_detail.update(status="failed", reason="state_unavailable")
    recovered = cleanup_private_fixture(private, ok and children_confirmed, private_detail)
    receipt.setdefault("stages", {})["recoveryCleanup"] = {"status": "passed" if recovered else "failed", "containerCleanup": ok,
        "initialChildrenConfirmed": children_confirmed, "container": container_detail, "privateCleanup": private_detail}
    if not recovered:
        receipt["status"] = "failed"
    # Always persist recovery diagnostics, never erase initial failure/history.
    write_receipt(output, receipt)
    return 0 if recovered else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "run", "cleanup"])
    parser.add_argument("--source", type=Path)
    parser.add_argument("--public-output", type=Path, default=Path("qualification-public"))
    args = parser.parse_args()
    if args.action == "cleanup":
        return cleanup_only(args.public_output.resolve())
    revision(os.environ.get("PRODUCT_REVISION"))
    revision(os.environ.get("HELPER_REVISION"))
    if os.environ.get("CREWROOM_QUALIFICATION_EXPORT_BINARIES") == "1" and os.environ.get("CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS") != "1":
        raise QualificationFailure("binary_export_requires_diagnostic_mode")
    if args.action == "validate":
        print("Qualification revisions: valid")
        return 0
    if not args.source:
        raise QualificationFailure("source_required")
    for event in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(event, lambda _signal, _frame: (_ for _ in ()).throw(QualificationFailure("interrupted")))
    return run_qualification(args.source.resolve(), args.public_output.resolve())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Runtime qualification: failed before execution")
        sys.exit(1)
