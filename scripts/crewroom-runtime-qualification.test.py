#!/usr/bin/env python3
"""Offline receipt-gate and exact-owner cleanup checks; no Docker or product execution."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("crewroom-runtime-qualification.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def report(titles):
    return {"success": True, "numFailedTests": 0, "numPassedTests": len(titles),
            "testResults": [{"assertionResults": [{"title": title, "status": "passed"} for title in titles]}]}


class ReceiptGateTests(unittest.TestCase):
    def test_all_eight_real_process_cases_must_pass(self):
        counts = qualification.report_counts(report(qualification.LOCAL_CASES), qualification.LOCAL_CASES)
        self.assertEqual((counts["passed"], counts["skipped"], counts["status"]), (8, 0, "passed"))

    def test_missing_or_duplicate_title_is_failure(self):
        for titles in [qualification.LOCAL_CASES[:-1], qualification.LOCAL_CASES + [qualification.LOCAL_CASES[0]]]:
            self.assertEqual(qualification.report_counts(report(titles), qualification.LOCAL_CASES)["status"], "failed")

    def test_selected_skips_never_qualify(self):
        for status in ["pending", "skipped", "todo", "disabled"]:
            value = report(qualification.LOCAL_CASES)
            value["testResults"][0]["assertionResults"][0]["status"] = status
            self.assertEqual(qualification.report_counts(value, qualification.LOCAL_CASES)["status"], "failed")

    def test_remote_five_must_pass_and_unselected_pending_is_separate(self):
        value = report(qualification.REMOTE_CASES)
        value["testResults"][0]["assertionResults"].append({"title": qualification.LOCAL_CASES[0], "status": "pending"})
        counts = qualification.report_counts(value, qualification.REMOTE_CASES, only_selected=True)
        self.assertEqual((counts["passed"], counts["skipped"], counts["unselectedSkipped"], counts["status"]), (5, 0, 1, "passed"))

    def test_unexpected_remote_pass_or_report_failure_cannot_qualify(self):
        extra = report(qualification.REMOTE_CASES + ["unselected case"])
        failed = report(qualification.REMOTE_CASES)
        failed["success"] = False
        for value in [extra, failed]:
            self.assertEqual(qualification.report_counts(value, qualification.REMOTE_CASES, only_selected=True)["status"], "failed")

    def test_revision_requires_full_hex_commit(self):
        self.assertEqual(qualification.revision("a" * 40), "a" * 40)
        for value in ["main", "HEAD", "abc", "$(echo x)", "g" * 40]:
            with self.assertRaises(qualification.QualificationFailure):
                qualification.revision(value)


class CleanupTests(unittest.TestCase):
    def test_daemon_failure_is_not_absence(self):
        with patch.object(qualification.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="")):
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))

    def test_wrong_owner_never_stops_a_container(self):
        responses = [SimpleNamespace(returncode=0, stdout="abcdef123456\n"),
                     SimpleNamespace(returncode=0, stdout='[{"Id":"abcdef123456","Config":{"Labels":{}}}]')]
        with patch.object(qualification.subprocess, "run", side_effect=responses) as run:
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))
            self.assertEqual(run.call_count, 2)

    def test_stop_then_daemon_failure_is_not_success(self):
        label = qualification.OWNER_LABEL
        responses = [SimpleNamespace(returncode=0, stdout="abcdef123456\n"),
                     SimpleNamespace(returncode=0, stdout='[{"Id":"abcdef123456","Config":{"Labels":{"' + label + '":"owner"}}}]'),
                     SimpleNamespace(returncode=0), SimpleNamespace(returncode=1, stdout="")]
        with patch.object(qualification.subprocess, "run", side_effect=responses) as run:
            self.assertFalse(qualification.container_cleanup({"container": "owned-name", "owner": "owner"}))
            self.assertEqual(run.call_args_list[2].args[0], ["docker", "stop", "--timeout", "20", "abcdef123456"])


if __name__ == "__main__":
    unittest.main()
