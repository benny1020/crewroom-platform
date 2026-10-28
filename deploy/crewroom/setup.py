#!/usr/bin/env python3
"""Generate persistent deployment secrets without displaying them."""
import argparse
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
args = parser.parse_args()
path = args.env_file.absolute()
if path.is_symlink():
    raise SystemExit("Refusing a symlink destination")
if path.exists():
    raise SystemExit("Environment already exists; preserve its signing secrets")
path.parent.mkdir(parents=True, exist_ok=True)
content = "\n".join([
    "CREWROOM_COMPOSE_PROJECT=crewroom-next",
    "CREWROOM_IMAGE=crewroom-next:local",
    "CREWROOM_BIND_ADDRESS=127.0.0.1",
    "CREWROOM_PORT=3118",
    "CREWROOM_PUBLIC_URL=http://localhost:3118",
    "CREWROOM_EXPOSURE=private",
    "CREWROOM_DISABLE_SIGN_UP=false",
    *[key + "=" + secrets.token_hex(32) for key in [
        "CREWROOM_DB_PASSWORD", "BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET",
        "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET"]],
    "",
])
fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(content)
print("Created owner-only deployment environment: " + str(path))
print("Keep this file with the app-data and database backups. Secret values were not printed.")
