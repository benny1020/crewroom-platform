#!/usr/bin/env python3
"""Collect only allowlisted failure facts; never emit or persist raw logs or env."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

CONTAINER_STATES = {"created", "running", "paused", "restarting", "removing", "exited", "dead"}
HEALTH_STATES = {"healthy", "unhealthy", "starting", "none"}
ERROR_CLASSES = {
    "permission_denied": r"EACCES|EPERM|permission denied|read-only file system",
    "runtime_dependency_missing": r"ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|cannot find (?:module|package)|shared object file|library not loaded",
    "database_authentication_failed": r"28P01|password authentication failed",
    "connection_failed": r"ECONNREFUSED|ENOTFOUND|ENETUNREACH|connection refused|could not translate host name",
    "database_migration_failed": r"(?:migration[^\n]*(?:failed|error)|(?:failed|error)[^\n]*migration)|42P01|42703|42P07",
    "authentication_configuration_invalid": r"auth\.baseUrlMode=explicit requires|authenticated public exposure requires|BETTER_AUTH_SECRET[^\n]*(?:missing|required|invalid)",
    "request_origin_rejected": r"invalid origin|untrusted origin|origin[^\n]*not[^\n]*allowed",
    "secret_configuration_invalid": r"(?:master key|signing secret|JWT secret)[^\n]*(?:missing|required|invalid|failed)",
    "port_binding_failed": r"EADDRINUSE|EADDRNOTAVAIL",
    "memory_exhausted": r"heap out of memory|out of memory|cannot allocate memory",
    "process_limit_reached": r"EAGAIN|resource temporarily unavailable",
    "startup_recovery_failed": r"startup[^\n]*recovery[^\n]*failed",
    "server_start_failed": r"Paperclip server failed to start",
    "logged_error": r"\b(?:ERROR|FATAL)\b|\"level\"\s*:\s*(?:50|60)\b",
}
MILESTONES = {
    "entrypoint_started": r"docker-entrypoint\.sh: starting",
    "application_launched": r"docker-entrypoint\.sh: starting app as",
    "listener_bound": r"Server listener bound on",
    "startup_recovery_ready": r"Server startup recovery complete",
}
STATE_TEMPLATE = ('{"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},'
    '"oomKilled":{{.State.OOMKilled}},"restartCount":{{.RestartCount}},'
    '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},'
    '"healthExitCodes":[{{if .State.Health}}{{range $i,$e:=.State.Health.Log}}{{if $i}},{{end}}{{$e.ExitCode}}{{end}}{{end}}]}')
HEALTH_PROBE = """fetch('http://127.0.0.1:3100/api/health',{signal:AbortSignal.timeout(4000)})
.then(async r=>{let j;try{j=await r.json()}catch{};
console.log(JSON.stringify({statusCode:r.status,status:['ok','starting'].includes(j?.status)?j.status:'invalid'}))})
.catch(()=>console.log(JSON.stringify({status:'unavailable'})))"""


def integer(value, minimum=0, maximum=2147483647):
    return value if type(value) is int and minimum <= value <= maximum else None


def sanitize_state(value):
    if not isinstance(value, dict):
        return {"status": "unknown"}
    codes = value.get("healthExitCodes")
    return {
        "status": value.get("status") if isinstance(value.get("status"), str) and value.get("status") in CONTAINER_STATES else "unknown",
        "exitCode": integer(value.get("exitCode"), 0, 255),
        "oomKilled": value.get("oomKilled") is True,
        "restartCount": integer(value.get("restartCount")),
        "health": value.get("health") if isinstance(value.get("health"), str) and value.get("health") in HEALTH_STATES else "unknown",
        "healthExitCodes": [n for n in codes[-10:] if integer(n, -1, 255) is not None] if isinstance(codes, list) else [],
    }


def sanitize_health(value):
    if not isinstance(value, dict):
        return {"status": "unavailable"}
    status = value.get("status")
    return {
        "status": status if isinstance(status, str) and status in {"ok", "starting", "invalid", "unavailable"} else "invalid",
        "statusCode": integer(value.get("statusCode"), 100, 599),
    }


def classify_logs(text):
    # Raw strings are consumed only in memory. Output keys/values are fixed literals.
    return {
        "errorClasses": sorted(name for name, pattern in ERROR_CLASSES.items() if re.search(pattern, text, re.I)),
        "milestones": {name: bool(re.search(pattern, text)) for name, pattern in MILESTONES.items()},
    }


def capture(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
        return result.returncode == 0, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return False, "", ""


def collect(project, env_file, label="primary", runner=capture):
    # No container environment, command args, health output or arbitrary error text is selected.
    report = {"schemaVersion": 1, "scope": label, "rawLogsRetained": False, "services": {}}
    compose = ["docker", "compose", "--env-file", str(env_file), "-p", project, "-f", str(Path(__file__).with_name("compose.yaml"))]
    for service in ["app", "db"]:
        item = {"collectionErrors": []}
        report["services"][service] = item
        ok, stdout, _ = runner([*compose, "ps", "--all", "--quiet", service])
        container_id = stdout.strip()
        if not ok or not re.fullmatch(r"[a-f0-9]{12,64}", container_id):
            item["collectionErrors"].append("container_lookup_unavailable")
            continue
        ok, stdout, _ = runner(["docker", "inspect", "--format", STATE_TEMPLATE, container_id])
        try:
            item["state"] = sanitize_state(json.loads(stdout)) if ok else {"status": "unknown"}
        except (ValueError, TypeError):
            item["state"] = {"status": "unknown"}
        if item["state"]["status"] == "unknown":
            item["collectionErrors"].append("container_state_unavailable")
        ok, stdout, stderr = runner(["docker", "logs", "--tail", "300", container_id])
        if ok:
            item.update(classify_logs(stdout + "\n" + stderr))
        else:
            item["collectionErrors"].append("container_logs_unavailable")
        if service == "app":
            ok, stdout, _ = runner(["docker", "exec", container_id, "node", "-e", HEALTH_PROBE])
            try:
                item["anonymousHealth"] = sanitize_health(json.loads(stdout)) if ok else {"status": "unavailable"}
            except (ValueError, TypeError):
                item["anonymousHealth"] = {"status": "unavailable"}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--label", choices=["primary", "restored"], default="primary")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.project):
        raise SystemExit("Invalid compose project name")
    report = collect(args.project, args.env_file, args.label)
    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
