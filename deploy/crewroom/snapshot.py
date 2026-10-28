#!/usr/bin/env python3
"""Quiesced app-data + PostgreSQL snapshots; restore only to a new Compose project."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("action", choices=["backup", "restore"])
parser.add_argument("directory", type=Path)
parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
parser.add_argument("--project", required=True, help="Exact Compose project; restore requires a fresh name")
args = parser.parse_args()
if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,60}", args.project):
    raise SystemExit("Use a valid explicit Compose project name")
env_file = args.env_file.resolve()
if not env_file.is_file():
    raise SystemExit("Deployment environment is missing")
os.umask(0o077)
directory = args.directory.absolute()
compose = ["docker", "compose", "--env-file", str(env_file), "-p", args.project, "-f", str(ROOT / "compose.yaml")]

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def dc(*command, **kwargs):
    return run([*compose, *command], **kwargs)

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

if args.action == "backup":
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    app_running = bool(dc("ps", "--status", "running", "-q", "app", capture_output=True, text=True).stdout.strip())
    try:
        # No API/run/file writes while the two persistent stores are captured.
        # The image's 90-second grace period allows upstream run drain.
        dc("stop", "app")
        with (directory / "database.dump").open("wb") as output:
            dc("exec", "-T", "db", "pg_dump", "-U", "crewroom", "-d", "crewroom", "-Fc", stdout=output)
        with (directory / "appdata.tar.gz").open("wb") as output:
            dc("run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "app", "-czf", "-", "-C", "/paperclip", ".", stdout=output)
        shutil.copyfile(env_file, directory / "deployment.env")
        files = {name: digest(directory / name) for name in ["database.dump", "appdata.tar.gz", "deployment.env"]}
        manifest = {"format": 1, "sourceProject": args.project,
                    "createdAt": datetime.now(timezone.utc).isoformat(), "files": files,
                    "images": dc("images", "--format", "json", capture_output=True, text=True).stdout.strip()}
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    finally:
        if app_running:
            dc("start", "app")
    print("Snapshot complete: " + str(directory))
else:
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("format") != 1 or set(manifest.get("files", {})) != {"database.dump", "appdata.tar.gz", "deployment.env"}:
        raise SystemExit("Unsupported snapshot manifest")
    for name, expected in manifest["files"].items():
        if digest(directory / name) != expected:
            raise SystemExit("Snapshot checksum mismatch: " + name)
    if args.project == manifest["sourceProject"]:
        raise SystemExit("Restore requires a new project, preserving the source")
    # No destructive replace/clean path. An existing app or DB volume aborts.
    for name in [args.project + "_postgres", args.project + "_appdata"]:
        probe = subprocess.run(["docker", "volume", "inspect", name], capture_output=True)
        if probe.returncode == 0:
            raise SystemExit("Restore target already exists: " + name)
    existing = dc("ps", "-a", "-q", capture_output=True, text=True).stdout.strip()
    if existing:
        raise SystemExit("Restore target already has containers")
    # Destination env preserves the snapshot's keys but may change URL/port.
    # Require identity secrets to match without ever printing their values.
    def read_env(path):
        return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#") and "=" in line)
    saved, target = read_env(directory / "deployment.env"), read_env(env_file)
    for key in ["CREWROOM_DB_PASSWORD", "BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET"]:
        if not saved.get(key) or saved[key] != target.get(key):
            raise SystemExit("Restore must preserve saved signing/database secrets: " + key)
    dc("up", "-d", "--wait", "db")
    with (directory / "database.dump").open("rb") as source:
        dc("exec", "-T", "db", "pg_restore", "--exit-on-error", "-U", "crewroom", "-d", "crewroom", stdin=source)
    with (directory / "appdata.tar.gz").open("rb") as source:
        dc("run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "app", "-xzf", "-", "-C", "/paperclip", stdin=source)
    dc("up", "-d", "--wait", "app")
    print("Snapshot restored into new project: " + args.project)
