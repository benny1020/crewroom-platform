#!/usr/bin/env python3
"""Inert files only: no Rust builds, executable launches, Docker or network."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("crewroom-runtime-export-binaries.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class PublicBinaryExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.source, self.output = self.root / "product", self.root / "export"
        for name, relative in exporter.FILES.items():
            filename = self.source / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_bytes(b"PUBLIC_INERT_BINARY_FIXTURE_" + name.encode())
            filename.chmod(0o700)
        lock = self.source / "packages/paperclip-runner/runner/Cargo.lock"
        lock.write_text("public lock fixture")
        self.binding = {"productRevision": "a" * 40, "helperRevision": "b" * 40, "target": "linux-amd64",
            "cargoLockSha256": exporter.sha256(lock), "toolchain": {"node": "v24.14.0", "pnpm": "9.15.4", "cargoProfile": "dev-debug0",
                "rustc": "rustc 1.97.1 (abcdef01 2026-10-01)", "cargo": "cargo 1.97.1 (abcdef01 2026-10-01)"},
            "binaries": {name: {"buildSha256": exporter.sha256(self.source / relative)} for name, relative in exporter.FILES.items()}}
        for function, value in [("checkout_revision", "a" * 40), ("mit_notice", "PUBLIC_SYNTHETIC_MIT_NOTICE"), ("notice_sha256", "c" * 64)]:
            manager = patch.object(exporter, function, return_value=value)
            manager.start()
            self.addCleanup(manager.stop)

    def test_only_exact_two_public_files_manifest_hashes_and_source_modes_preserved(self):
        exporter.stage(self.source, self.output, self.binding)
        manifest = exporter.verify(self.source, self.output, "a" * 40, "b" * 40)
        self.assertEqual(set(os.listdir(self.output)), {*exporter.FILES, "manifest.json"})
        for name, relative in exporter.FILES.items():
            self.assertEqual((self.source / relative).stat().st_mode & 0o777, 0o700)
            self.assertEqual((self.output / name).stat().st_mode & 0o777, 0o555)
            self.assertEqual(manifest["binaries"][name]["buildSha256"], exporter.sha256(self.output / name))

    def test_wrong_build_hash_and_symlink_are_rejected_without_touching_source(self):
        self.binding["binaries"]["paperclip-runnerd"]["buildSha256"] = "0" * 64
        with self.assertRaises(ValueError):
            exporter.stage(self.source, self.output, self.binding)
        self.assertFalse(self.output.exists())
        original = self.source / exporter.FILES["paperclip-runnerd"]
        outside = self.root / "public-outside"
        outside.write_bytes(original.read_bytes())
        original.unlink()
        original.symlink_to(outside)
        with self.assertRaises(ValueError):
            exporter.stage(self.source, self.output, self.binding)
        self.assertTrue(outside.is_file())
        self.assertFalse(self.output.exists())

    def test_final_verification_rejects_content_or_manifest_injection(self):
        exporter.stage(self.source, self.output, self.binding)
        manifest = self.output / "manifest.json"
        value = json.loads(manifest.read_text())
        value["private"] = "SYNTHETIC_PRIVATE_EXPORT"
        manifest.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            exporter.verify(self.source, self.output, "a" * 40, "b" * 40)
        del value["private"]
        manifest.write_text(json.dumps(value))
        binary = self.output / "fake-codex-app-server"
        binary.chmod(0o700)
        binary.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            exporter.verify(self.source, self.output, "a" * 40, "b" * 40)

    def test_existing_output_and_unknown_toolchain_fields_fail_closed(self):
        self.output.mkdir()
        marker = self.output / "preserve"
        marker.write_text("owned by another operation")
        with self.assertRaises(FileExistsError):
            exporter.stage(self.source, self.output, self.binding)
        self.assertTrue(marker.exists())
        self.binding["toolchain"]["private"] = "SYNTHETIC_PRIVATE_EXPORT"
        with self.assertRaises(ValueError):
            exporter.stage(self.source, self.root / "other-export", self.binding)


if __name__ == "__main__":
    unittest.main()
