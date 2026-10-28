# Pinned Impeccable setup

This migration uses Impeccable package 4.8.0, engine 0.1.18, at upstream commit `8409a564d1baee90b2dde4f7a8f06288838e3921`. The source is Apache-2.0 licensed; its original notice is retained in `licenses/impeccable/LICENSE`. Upstream has no root NOTICE file at this revision.

```sh
python3 scripts/setup-impeccable.py
./.agents/skills/impeccable/scripts/impeccable engine-probe
```

The installer downloads a pinned GitHub archive, extracts only `.agents/skills/impeccable`, verifies all 63 files against `impeccable-manifest.json`, preserves executable permission for the launcher, and refuses a changed existing installation. It stages new files before atomically installing them. No private `.agents` settings are tracked or copied, and automatic hooks/trust settings are never enabled by this script. An optional `--dest /absolute/path/impeccable` installs just the skill in another explicit directory.

Verified installation into a fresh `/private/tmp/crewroom-impeccable-verified-20261028` directory completed with `impeccable-engine 0.1.18`; a repeat verified the existing pinned contents without changing files. Initial attempts rejected `/tmp` because it is a symlink on macOS and rejected an undersized 20 MiB archive limit; using the real directory and a 128 MiB source bound completed successfully. Every selected file still requires its independent SHA-256 match. Engine download integrity remains owned by upstream's checksum-pinned launcher.

The orchestration chat separately installed the same pinned skill locally and globally and verified engine/context commands. This installer does not replace or edit those installations. Manual design checks should run once against the final changed UI; engine availability alone does not establish product quality.
