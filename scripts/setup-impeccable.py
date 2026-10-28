#!/usr/bin/env python3
"""Install only the pinned Impeccable skill; do not configure hooks or trust."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "crewroom/impeccable-manifest.json").read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--dest", type=Path, default=ROOT / ".agents/skills/impeccable", help="Exact destination skill directory")
args = parser.parse_args()
dest = args.dest.absolute()
if dest.is_symlink() or any(p.is_symlink() for p in dest.parents):
    raise SystemExit("Destination must not redirect through a symlink")
expected = MANIFEST["files"]

def verify(directory):
    for name, digest in expected.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise SystemExit("Pinned skill verification failed: " + name)

if dest.exists():
    verify(dest)
    print("Existing pinned Impeccable skill verified; no files changed: " + str(dest))
    raise SystemExit(0)

revision = MANIFEST["revision"]
url = "https://codeload.github.com/pbakaus/impeccable/zip/" + revision
request = urllib.request.Request(url, headers={"User-Agent": "Crewroom-pinned-skill-setup"})
with urllib.request.urlopen(request, timeout=60) as response:
    archive = response.read(128 * 1024 * 1024 + 1)
if len(archive) > 128 * 1024 * 1024:
    raise SystemExit("Pinned source archive exceeds setup limit")
prefix = "impeccable-" + revision + "/" + MANIFEST["skillPath"] + "/"
dest.parent.mkdir(parents=True, exist_ok=True)
stage = Path(tempfile.mkdtemp(prefix=".impeccable-setup-", dir=dest.parent))
try:
    seen = set()
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        for member in source.infolist():
            if not member.filename.startswith(prefix) or member.is_dir():
                continue
            relative = member.filename[len(prefix):]
            path = PurePosixPath(relative)
            mode = member.external_attr >> 16
            if path.is_absolute() or ".." in path.parts or "\\" in relative or stat.S_ISLNK(mode):
                raise SystemExit("Unsafe source archive entry")
            if relative not in expected or relative in seen:
                raise SystemExit("Unexpected or duplicate skill file: " + relative)
            data = source.read(member)
            if hashlib.sha256(data).hexdigest() != expected[relative]:
                raise SystemExit("Pinned source content differs: " + relative)
            target = stage.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if relative == "scripts/impeccable" or mode & 0o111 else 0o644)
            seen.add(relative)
    if seen != set(expected):
        raise SystemExit("Pinned source archive is missing skill files")
    verify(stage)
    # Refuse a concurrent installation instead of replacing any user edits.
    if dest.exists():
        raise SystemExit("Destination appeared during setup; no existing files changed")
    os.rename(stage, dest)
    print("Installed pinned Impeccable 4.8.0 skill (engine 0.1.18): " + str(dest))
    print("Automatic hooks and trust were not changed. Run scripts/impeccable engine-probe explicitly.")
finally:
    if stage.exists():
        shutil.rmtree(stage)
