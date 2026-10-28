#!/usr/bin/env python3
"""Optional public test executables only; never runtime/session artifacts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

FILES = {"paperclip-runnerd": "packages/paperclip-runner/runner/target/debug/paperclip-runnerd",
         "fake-codex-app-server": "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"}


def sha256(filename):
    value = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def owned_file(filename, maximum=512 * 1024 * 1024):
    value = filename.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or not 0 < value.st_size <= maximum:
        raise ValueError("invalid_public_file")
    return value


def revision(value):
    if not re.fullmatch(r"[a-f0-9]{40}", value or ""):
        raise ValueError("invalid_revision")
    return value


def checkout_revision(source):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()


def binding_valid(source, binding):
    revision(binding.get("productRevision"))
    revision(binding.get("helperRevision"))
    if checkout_revision(source) != binding["productRevision"] or binding.get("target") != "linux-amd64":
        raise ValueError("build_binding_mismatch")
    tools = binding.get("toolchain", {})
    if (set(tools) != {"node", "pnpm", "rustc", "cargo", "cargoProfile"} or tools.get("node") != "v24.14.0" or tools.get("pnpm") != "9.15.4" or tools.get("cargoProfile") != "dev-debug0"
            or not re.fullmatch(r"rustc 1\.97\.1 \([a-f0-9]+ \d{4}-\d{2}-\d{2}\)", tools.get("rustc", ""))
            or not re.fullmatch(r"cargo 1\.97\.1 \([a-f0-9]+ \d{4}-\d{2}-\d{2}\)", tools.get("cargo", ""))):
        raise ValueError("toolchain_mismatch")
    lock = source / "packages/paperclip-runner/runner/Cargo.lock"
    owned_file(lock, 2_000_000)
    if sha256(lock) != binding.get("cargoLockSha256"):
        raise ValueError("lock_mismatch")


def mit_notice(source, commit):
    value = subprocess.check_output(["git", "show", commit + ":LICENSE"], cwd=source)
    if len(value) > 20_000:
        raise ValueError("license_too_large")
    return value.decode()


def notice_sha256(source, commit):
    return hashlib.sha256(subprocess.check_output(["git", "show", commit + ":THIRD_PARTY_NOTICES.md"], cwd=source)).hexdigest()


def copy_public_binary(original, copied):
    descriptor = os.open(original, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or not 0 < value.st_size <= 512 * 1024 * 1024:
            raise ValueError("invalid_public_file")
        with os.fdopen(os.dup(descriptor), "rb") as source, copied.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
    finally:
        os.close(descriptor)


def verify(source, output, expected_product, expected_helper):
    source, output = source.resolve(), output.resolve()
    metadata = output.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise ValueError("invalid_export_directory")
    owned_file(output / "manifest.json", 100_000)
    manifest = json.loads((output / "manifest.json").read_text())
    if set(manifest) != {"productRevision", "helperRevision", "toolchain", "target", "cargoLockSha256", "diagnosticOnly", "binaries", "licenseScope", "upstreamMitNotice", "thirdPartyNotices", "thirdPartyNoticesSha256"}:
        raise ValueError("manifest_shape")
    binding_valid(source, manifest)
    if manifest["productRevision"] != revision(expected_product) or manifest["helperRevision"] != revision(expected_helper):
        raise ValueError("revision_mismatch")
    if (manifest["diagnosticOnly"] is not True or manifest["licenseScope"] != "Paperclip MIT and dependency licenses; not Crewroom 0BSD"
            or manifest["upstreamMitNotice"] != mit_notice(source, expected_product)
            or manifest["thirdPartyNotices"] != "https://github.com/benny1020/crewroom-platform/blob/" + expected_product + "/THIRD_PARTY_NOTICES.md"
            or manifest["thirdPartyNoticesSha256"] != notice_sha256(source, expected_product)):
        raise ValueError("public_notice_mismatch")
    if set(os.listdir(output)) != {*FILES, "manifest.json"}:
        raise ValueError("unexpected_export_entry")
    binaries = manifest.get("binaries", {})
    if set(binaries) != set(FILES):
        raise ValueError("binary_manifest_mismatch")
    for name, relative in FILES.items():
        original, copied = source / relative, output / name
        if original.resolve() != original or copied.resolve() != copied:
            raise ValueError("binary_symlink")
        before, exported = owned_file(original), owned_file(copied)
        record = binaries[name]
        if (set(record) != {"path", "size", "buildSha256", "copySha256"} or record.get("path") != relative or type(record.get("size")) is not int or record.get("size") != before.st_size or exported.st_size != before.st_size
                or not re.fullmatch(r"[a-f0-9]{64}", record.get("buildSha256", "")) or record.get("copySha256") != record["buildSha256"]
                or sha256(original) != record["buildSha256"] or sha256(copied) != record["buildSha256"]):
            raise ValueError("binary_hash_mismatch")
    return manifest


def stage(source, output, binding):
    source = source.resolve()
    binding_valid(source, binding)
    for name, relative in FILES.items():
        original = source / relative
        if original.resolve() != original:
            raise ValueError("binary_symlink")
        owned_file(original)
        if sha256(original) != binding.get("binaries", {}).get(name, {}).get("buildSha256"):
            raise ValueError("build_hash_mismatch")
    # A new directory has one owner and exactly three public entries.
    output.mkdir(mode=0o700, exist_ok=False)
    try:
        manifest = {key: binding[key] for key in ["productRevision", "helperRevision", "toolchain", "target", "cargoLockSha256"]}
        manifest.update(diagnosticOnly=True, binaries={}, licenseScope="Paperclip MIT and dependency licenses; not Crewroom 0BSD")
        # Preserve the upstream MIT notice in the fixed manifest, without adding
        # arbitrary source/runtime files to the artifact allowlist.
        manifest["upstreamMitNotice"] = mit_notice(source, binding["productRevision"])
        manifest["thirdPartyNotices"] = "https://github.com/benny1020/crewroom-platform/blob/" + binding["productRevision"] + "/THIRD_PARTY_NOTICES.md"
        manifest["thirdPartyNoticesSha256"] = notice_sha256(source, binding["productRevision"])
        for name, relative in FILES.items():
            original, copied = source / relative, output / name
            copy_public_binary(original, copied)
            copied.chmod(0o555)
            manifest["binaries"][name] = {"path": relative, "size": owned_file(copied).st_size,
                "buildSha256": binding["binaries"][name]["buildSha256"], "copySha256": sha256(copied)}
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        verify(source, output, binding["productRevision"], binding["helperRevision"])
        return manifest
    except BaseException:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["stage", "verify"])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--binding", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if os.environ.get("CREWROOM_QUALIFICATION_EXPORT_BINARIES") != "1" or os.environ.get("CREWROOM_QUALIFICATION_PHASE_DIAGNOSTICS") != "1":
        raise ValueError("diagnostic_export_not_enabled")
    if args.action == "stage":
        owned_file(args.binding, 100_000)
        stage(args.source, args.output, json.loads(args.binding.read_text()))
    else:
        owned_file(args.receipt, 1_000_000)
        receipt = json.loads(args.receipt.read_text())
        if (receipt.get("productRevision") != os.environ.get("PRODUCT_REVISION") or receipt.get("helperRevision") != os.environ.get("HELPER_REVISION")
                or receipt.get("stages", {}).get("diagnostic_binary_export", {}).get("manifestSha256") != sha256(args.output / "manifest.json")):
            raise ValueError("build_receipt_mismatch")
        verify(args.source, args.output, os.environ.get("PRODUCT_REVISION"), os.environ.get("HELPER_REVISION"))
    print("Public diagnostic binary hashes: verified")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Public diagnostic binary export: failed")
        raise SystemExit(1)
