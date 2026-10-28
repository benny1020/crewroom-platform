#!/usr/bin/env python3
"""Offline stock receipt/privacy checks; no product execution or dependencies."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('core_ci', Path(__file__).with_name('crewroom-runner-control-plane.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def report(source, total=171):
    return {'success': True, 'startTime': 1, 'numTotalTests': total, 'numPassedTests': total,
            'numFailedTests': 0, 'numPendingTests': 0, 'numTodoTests': 0,
            'testResults': [{'name': str(source / ci.TEST_FILE), 'status': 'passed',
                             'assertionResults': [{'title': title, 'status': 'passed'} for title in ci.CASES]
                             + [{'title': 'SYNTHETIC_PRIVATE_CASE_' + str(i), 'status': 'passed',
                                 'failureMessages': ['SYNTHETIC_PRIVATE_MESSAGE']} for i in range(total - 3)]}]}


class StockGateTests(unittest.TestCase):
    def setUp(self):
        self.source = Path('/synthetic-public-product')

    def test_all_actual_assertions_and_three_exact_new_cases_pass(self):
        value = ci.summarize(report(self.source), 0, self.source)
        self.assertEqual(value['counts'], {'total': 171, 'passed': 171, 'failed': 0, 'skipped': 0})
        self.assertEqual(value['status'], 'passed')
        self.assertTrue(value['started'] and value['completed'])
        self.assertEqual([case['records'] for case in value['newRegressions']], [1, 1, 1])
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(value))

    def test_future_source_can_add_tests_without_faking_171(self):
        value = ci.summarize(report(self.source, 172), 0, self.source)
        self.assertEqual(value['counts']['passed'], 172)
        self.assertEqual(value['status'], 'passed')

    def test_nonzero_stock_exit_cannot_be_repaired_by_successful_json(self):
        self.assertEqual(ci.summarize(report(self.source), 1, self.source)['status'], 'failed')

    def test_missing_duplicate_or_failed_new_case_fails(self):
        for mode in ['missing', 'duplicate', 'failed']:
            value = report(self.source)
            cases = value['testResults'][0]['assertionResults']
            if mode == 'missing':
                cases.pop(0)
            elif mode == 'duplicate':
                cases.append(copy.deepcopy(cases[0]))
            else:
                cases[0]['status'] = 'failed'
            self.assertEqual(ci.summarize(value, 0, self.source)['status'], 'failed')

    def test_any_skipped_unselected_or_incomplete_count_fails(self):
        for status in ['pending', 'skipped', 'todo', 'disabled']:
            value = report(self.source)
            value['testResults'][0]['assertionResults'][-1]['status'] = status
            self.assertEqual(ci.summarize(value, 0, self.source)['status'], 'failed')
        for key in ['numTotalTests', 'numPassedTests', 'numPendingTests']:
            value = report(self.source)
            value[key] += 1
            self.assertEqual(ci.summarize(value, 0, self.source)['status'], 'failed')

    def test_wrong_multiple_or_missing_owner_files_fail(self):
        for suites in [[], [{'name': '/private/other.test.ts'}], [report(self.source)['testResults'][0]] * 2]:
            with self.assertRaises(ValueError):
                ci.summarize({**report(self.source), 'testResults': suites}, 0, self.source)

    def test_no_start_or_global_failure_cannot_pass(self):
        for key, changed in [('success', False), ('startTime', 0)]:
            value = report(self.source)
            value[key] = changed
            self.assertEqual(ci.summarize(value, 0, self.source)['status'], 'failed')

    def test_revision_is_full_immutable_lowercase_hex(self):
        self.assertEqual(ci.revision('a' * 40), 'a' * 40)
        for value in ['HEAD', 'main', '1234', '${{ secrets.VALUE }}', 'g' * 40, 'a' * 40 + '\n']:
            with self.assertRaises(ValueError):
                ci.revision(value)

    def test_missing_raw_report_publishes_only_a_failed_safe_receipt(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PRODUCT_REVISION': 'a' * 40, 'HELPER_REVISION': 'b' * 40}):
            private = Path(directory) / 'private'
            private.mkdir(mode=0o700)
            output = Path(directory) / 'public'
            self.assertEqual(ci.finalize(self.source, private, output), 1)
            value = json.loads((output / 'receipt.json').read_text())
            self.assertFalse(value['started'] or value['completed'])
            self.assertEqual(value['status'], 'failed')
            self.assertNotIn(directory, json.dumps(value))

    def test_complete_safe_receipt_preserves_exit_hashes_and_all_clean_checks(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PRODUCT_REVISION': 'a' * 40, 'HELPER_REVISION': 'b' * 40}):
            private = Path(directory) / 'private'
            private.mkdir(mode=0o700)
            binding = {'productRevision': 'a' * 40, 'sourceSha256': 'c' * 64, 'testFileSha256': 'd' * 64, 'cleanGit': True}
            for name in ['binding.json', 'started.json']:
                (private / name).write_text(json.dumps(binding))
            (private / 'exit.txt').write_text('0\n')
            (private / 'report.json').write_text(json.dumps(report(self.source)))
            output = Path(directory) / 'public'
            with patch.object(ci, 'source_binding', return_value=binding):
                self.assertEqual(ci.finalize(self.source, private, output), 0)
            value = json.loads((output / 'receipt.json').read_text())
            self.assertTrue(all(value[key] for key in ['cleanGitBeforePreparation', 'cleanGitBeforeTests', 'cleanGitAfterTests']))
            self.assertEqual(value['exitCode'], 0)
            self.assertEqual(value['counts']['passed'], 171)
            self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(value))

    def test_invalid_json_keeps_the_real_nonzero_exit_and_fails(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PRODUCT_REVISION': 'a' * 40, 'HELPER_REVISION': 'b' * 40}):
            private = Path(directory) / 'private'
            private.mkdir(mode=0o700)
            binding = {'productRevision': 'a' * 40, 'cleanGit': True}
            for name in ['binding.json', 'started.json']:
                (private / name).write_text(json.dumps(binding))
            (private / 'exit.txt').write_text('1\n')
            (private / 'report.json').write_text('SYNTHETIC_PRIVATE_BROKEN_JSON')
            output = Path(directory) / 'public'
            with patch.object(ci, 'source_binding', return_value=binding):
                self.assertEqual(ci.finalize(self.source, private, output), 1)
            value = json.loads((output / 'receipt.json').read_text())
            self.assertEqual(value['exitCode'], 1)
            self.assertFalse(value['completed'])
            self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(value))

    def test_changed_source_binding_never_qualifies(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PRODUCT_REVISION': 'a' * 40, 'HELPER_REVISION': 'b' * 40}):
            private = Path(directory) / 'private'
            private.mkdir(mode=0o700)
            (private / 'binding.json').write_text(json.dumps({'productRevision': 'a' * 40}))
            with patch.object(ci, 'source_binding', return_value={'productRevision': 'a' * 40, 'cleanGit': False}):
                self.assertEqual(ci.finalize(self.source, private, Path(directory) / 'public'), 1)


if __name__ == '__main__':
    unittest.main()
