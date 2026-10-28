#!/usr/bin/env python3
"""CI-only qualification of an immutable product checkout; publish counts, never raw state."""
import argparse
import ctypes
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


class QualificationFailure(Exception):
    pass


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


def owned_children_cleanup():
    # This helper is a subreaper. Only its own unreaped direct children are
    # signalled; no process-name scan, borrowed PID or unrelated service is used.
    deadline = time.monotonic() + 20
    children_file = Path(f"/proc/self/task/{os.getpid()}/children")
    while time.monotonic() < deadline:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return True
        for child in children_file.read_text().split():
            try:
                os.kill(int(child), signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.02)
    return False


def container_cleanup(state):
    name = state.get("container")
    if not name:
        return True
    inventory = subprocess.run(["docker", "ps", "-a", "--filter", "label=" + OWNER_LABEL + "=" + state["owner"], "--format", "{{.ID}}"], capture_output=True, text=True, timeout=30)
    if inventory.returncode:
        return False
    owned = inventory.stdout.split()
    if not owned:
        return True  # Confirmed absent, including an already-removed container.
    if len(owned) != 1:
        return False
    inspection = subprocess.run(["docker", "inspect", owned[0]], capture_output=True, text=True, timeout=30)
    if inspection.returncode:
        return False
    records = json.loads(inspection.stdout)
    if len(records) != 1 or records[0].get("Config", {}).get("Labels", {}).get(OWNER_LABEL) != state.get("owner"):
        return False
    container_id = records[0]["Id"]
    if state.get("containerId") and state["containerId"] != container_id:
        return False
    stopped = subprocess.run(["docker", "stop", "--timeout", "20", container_id], capture_output=True, timeout=30)
    if stopped.returncode:
        return False
    # --rm may already have removed the stopped container. Only a successful
    # inventory, not an inspect error or an unavailable daemon, proves absence.
    remaining = subprocess.run(["docker", "ps", "-a", "--filter", "label=" + OWNER_LABEL + "=" + state["owner"], "--format", "{{.ID}}"], capture_output=True, text=True, timeout=30)
    if remaining.returncode:
        return False
    if not remaining.stdout.split():
        return True
    if remaining.stdout.split() != [container_id[:12]] and remaining.stdout.split() != [container_id]:
        return False
    removed = subprocess.run(["docker", "rm", container_id], capture_output=True, timeout=30)
    if removed.returncode:
        return False
    verified = subprocess.run(["docker", "ps", "-a", "--filter", "label=" + OWNER_LABEL + "=" + state["owner"], "--format", "{{.ID}}"], capture_output=True, text=True, timeout=30)
    return verified.returncode == 0 and not verified.stdout.split()



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
    current = None
    # Build/test children receive no ambient provider/account credentials.
    allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "RUSTUP_HOME", "CARGO_HOME", "PNPM_HOME", "COREPACK_HOME"]
    child_env = {name: os.environ[name] for name in allowed if name in os.environ}
    child_env.update(CI="true", GITHUB_ACTIONS="true", RUSTUP_TOOLCHAIN="1.97.1", CARGO_BUILD_JOBS="2",
                     CARGO_PROFILE_DEV_DEBUG="0", GOMAXPROCS="2", GOMEMLIMIT="3GiB", NODE_OPTIONS="--max-old-space-size=4096",
                     PAPERCLIP_TELEMETRY_DISABLED="1", PAPERCLIP_ANNOUNCEMENTS_ENABLED="false", HEARTBEAT_SCHEDULER_ENABLED="false",
                     PAPERCLIP_TEST_CONTROLLER_OUTAGE_MS="1000", TMPDIR=str(private))

    def run(command, timeout=600, capture=False, env=None, allow_failure=False):
        nonlocal current
        log = private / (stage + ".log")
        with log.open("ab") as stream:
            current = subprocess.Popen(command, cwd=source, env=env or child_env, start_new_session=True,
                                       stdout=subprocess.PIPE if capture else stream, stderr=stream)
            try:
                stdout, _ = current.communicate(timeout=timeout)
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
        stage = "local_real_processes"
        local_report = private / "local-report.json"
        code = run(["pnpm", "exec", "vitest", "run", "--project", "@paperclipai/server", RECOVERY_FILE,
                    "--maxWorkers=1", "--reporter=json", "--outputFile=" + str(local_report)], timeout=1200, allow_failure=True)
        counts = report_counts(json.loads(local_report.read_text()), LOCAL_CASES)
        receipt["stages"][stage] = counts
        if code != 0 or counts["status"] != "passed":
            raise QualificationFailure("local_exact_case_gate_failed")
        if not owned_children_cleanup():
            raise QualificationFailure("local_process_cleanup_unconfirmed")
        stage = "remote_container"
        name = "crewroom-qualification-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
        state["container"] = name
        state_path.write_text(json.dumps(state))
        run(["docker", "pull", IMAGE], timeout=300)
        container_id = run(["docker", "run", "-d", "--rm", "--init", "--name", name, "--label", OWNER_LABEL + "=" + state["owner"],
                            "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                            "--publish", "127.0.0.1::43127", "--entrypoint", "/bin/sh", IMAGE, "-c", "exec sleep infinity"], capture=True)
        state["containerId"] = container_id
        state_path.write_text(json.dumps(state))
        inspection = json.loads(run(["docker", "inspect", container_id], capture=True))[0]
        if inspection["HostConfig"].get("Binds") or inspection["HostConfig"].get("Privileged"):
            raise QualificationFailure("container_isolation_mismatch")
        run(["docker", "exec", name, "sh", "-c", "command -v node && command -v ps && command -v setsid && command -v tar && command -v base64"])
        if run(["docker", "exec", name, "node", "--version"], capture=True) != "v24.14.0":
            raise QualificationFailure("container_node_mismatch")
        run(["docker", "exec", "-u", "root", name, "mkdir", "-p", "/opt/continuity"])
        run(["docker", "cp", str(provider), name + ":/opt/continuity/fake-codex-app-server"])
        run(["docker", "exec", "-u", "root", name, "chmod", "755", "/opt/continuity/fake-codex-app-server"])
        port = run(["docker", "port", name, "43127/tcp"], capture=True)
        if not re.fullmatch(r"127\.0\.0\.1:[0-9]+", port):
            raise QualificationFailure("published_port_not_loopback")
        key, cert = private / "continuity.key", private / "continuity.crt"
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
             "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"])
        wrapper = private / "fake-codex"
        wrapper.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex-cli 0.999.0"\n  exit 0\nfi\nexec /opt/continuity/fake-codex-app-server --state-file-in-codex-home --durable-turn-ids --record-process-start --call-log "$PWD/provider-calls.log" "$@"\n')
        wrapper.chmod(0o700)
        receipt["stages"][stage] = {"status": "passed"}
        stage = "remote_continuity"
        remote_report = private / "remote-report.json"
        remote_env = {**child_env, "NODE_EXTRA_CA_CERTS": str(cert), "PAPERCLIP_TEST_RUNNER_TLS_KEY": str(key),
                      "PAPERCLIP_TEST_RUNNER_CONTAINER": name, "PAPERCLIP_TEST_RUNNER_PORT": port.rsplit(":", 1)[1],
                      "PAPERCLIP_TEST_LINUX_RUNNER_BINARY": str(runner), "PAPERCLIP_TEST_FAKE_CODEX_WRAPPER": str(wrapper)}
        code = run(["pnpm", "exec", "vitest", "run", "--project", "@paperclipai/server", RECOVERY_FILE,
                    "-t", "preserves remote warm continuity across completed turns:", "--maxWorkers=1", "--reporter=json", "--outputFile=" + str(remote_report)],
                   timeout=1200, env=remote_env, allow_failure=True)
        counts = report_counts(json.loads(remote_report.read_text()), REMOTE_CASES, only_selected=True)
        receipt["stages"][stage] = counts
        if code != 0 or counts["status"] != "passed":
            raise QualificationFailure("remote_exact_case_gate_failed")
        stage = "source_integrity"
        run(["git", "diff", "--exit-code", "HEAD", "--"])
        receipt["stages"][stage] = {"status": "passed"}
        receipt["status"] = "passed"
    except BaseException:
        receipt["stages"].setdefault(stage, {})["status"] = "failed"
        receipt["status"] = "failed"
    finally:
        for event in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(event, signal.SIG_IGN)
        container_ok = False
        try:
            container_ok = container_cleanup(state)
        except Exception:
            pass
        cleanup_ok = owned_children_cleanup() and container_ok
        receipt["stages"]["cleanup"] = {"status": "passed" if cleanup_ok else "failed"}
        if not cleanup_ok:
            receipt["status"] = "failed"
        write_receipt(output, receipt)
        if cleanup_ok:
            shutil.rmtree(private)
    print("Runtime qualification: " + receipt["status"])
    return 0 if receipt["status"] == "passed" else 1


def cleanup_only(output):
    private = state_directory()
    if not private.exists():
        return 0
    state = json.loads((private / "owner.json").read_text())
    ok = container_cleanup(state)
    if ok:
        shutil.rmtree(private)
    else:
        path = output / "receipt.json"
        receipt = json.loads(path.read_text()) if path.exists() else {"status": "failed", "stages": {}}
        receipt["status"] = "failed"
        receipt["stages"]["cleanup"] = {"status": "failed"}
        write_receipt(output, receipt)
    return 0 if ok else 1


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
