"""Read-only upstream source snapshots; never installs or executes project code."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent
REPOS = {
    "paperclip": "paperclipai/paperclip",
    "lobehub": "lobehub/lobehub",
    "openclaw": "openclaw/openclaw",
    "hermes": "NousResearch/hermes-agent",
    "letta": "letta-ai/letta",
    "mastra": "mastra-ai/mastra",
    "langgraph": "langchain-ai/langgraph",
    "dify": "langgenius/dify",
    "openhands": "OpenHands/OpenHands",
}

def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True, stderr=subprocess.PIPE)

def collect(item):
    slug, repo = item
    target = ROOT / "upstream" / slug
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not (target / ".git").exists():
            subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none", "--no-checkout", f"https://github.com/{repo}.git", str(target)],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=100,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
        sha = git(target, "rev-parse", "HEAD").strip()
        tree = git(target, "ls-tree", "-r", "--name-only", "HEAD").splitlines()
        (ROOT / f"{slug}-tree.txt").write_text("\n".join(tree) + "\n")
        return {"slug": slug, "repo": repo, "sha": sha,
                "commit_date": git(target, "show", "-s", "--format=%cI", "HEAD").strip(),
                "branch": git(target, "symbolic-ref", "--short", "HEAD").strip(),
                "file_count": len(tree), "read_files": []}
    except Exception as exc:
        return {"slug": slug, "repo": repo, "error": str(exc)}

def fetch_source(record, path):
    url = f"https://raw.githubusercontent.com/{record['repo']}/{record['sha']}/{path}"
    request = urllib.request.Request(url, headers={"User-Agent": "Gyeot-Source-Research"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
    target = ROOT / "sources" / record["slug"] / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"path": path, "bytes": len(data), "lines": len(data.splitlines()),
            "url": f"https://github.com/{record['repo']}/blob/{record['sha']}/{path}"}

if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(collect, REPOS.items()))
    manifest = {"retrieved_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "method": "Shallow metadata-only clones, pinned raw source downloads; no install or runtime execution", "repositories": results}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for record in results:
        print(json.dumps(record, ensure_ascii=False), flush=True)
