#!/usr/bin/env python3
"""Private stock JSON -> allowlisted runner owner regression receipt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

SOURCE_FILE = 'packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts'
TEST_FILE = 'packages/paperclip-runner/src/control-plane/durable-prp-control-plane.test.ts'
CASES = [
    'drains synchronously buffered wire frames without starving timers (1 connections)',
    'drains synchronously buffered wire frames without starving timers (2 connections)',
    'does not retain a ghost connection when a wire replays close during activation',
]
PRIVATE_FILES = {'binding.json', 'started.json', 'install.log', 'prepare.log', 'test.log', 'report.json', 'exit.txt'}


def revision(value):
    if not re.fullmatch(r'[a-f0-9]{40}', value or ''):
        raise ValueError('invalid_revision')
    return value


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(source, *args):
    return subprocess.check_output(['git', *args], cwd=source, stderr=subprocess.DEVNULL, text=True).strip()


def source_binding(source):
    expected = revision(os.environ.get('PRODUCT_REVISION', ''))
    actual = git(source, 'rev-parse', 'HEAD')
    clean = not git(source, 'status', '--porcelain', '--untracked-files=no')
    if actual != expected or not clean:
        raise ValueError('product_identity_or_cleanliness')
    return {'productRevision': actual, 'sourceSha256': digest(source / SOURCE_FILE),
            'testFileSha256': digest(source / TEST_FILE), 'cleanGit': clean}


def private_directory(path):
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o700:
        raise ValueError('private_directory_invalid')
    return path


def read_private(path, limit=64 * 1024 * 1024):
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or value.st_size > limit:
        raise ValueError('private_file_invalid')
    return path.read_text()


def summarize(report, exit_code, source):
    suites = report.get('testResults')
    if not isinstance(suites, list) or len(suites) != 1 or Path(suites[0].get('name', '')).resolve() != (source / TEST_FILE).resolve():
        raise ValueError('single_owner_file_required')
    assertions = suites[0].get('assertionResults')
    if not isinstance(assertions, list) or not assertions:
        raise ValueError('assertions_missing')
    counts = {'total': len(assertions), 'passed': 0, 'failed': 0, 'skipped': 0}
    for case in assertions:
        status = case.get('status')
        if status not in ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']:
            raise ValueError('unknown_status')
        counts['passed' if status == 'passed' else 'failed' if status == 'failed' else 'skipped'] += 1
    selected = []
    for title in CASES:
        matches = [case for case in assertions if case.get('title') == title]
        selected.append({'title': title, 'records': len(matches),
                         'status': 'passed' if len(matches) == 1 and matches[0].get('status') == 'passed' else 'failed'})
    aggregate_keys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']
    complete = (all(type(report.get(key)) is int for key in aggregate_keys) and report.get('numTotalTests') == counts['total'] and report.get('numPassedTests') == counts['passed']
                and report.get('numFailedTests') == counts['failed'] and report.get('numPendingTests') == 0
                and report.get('numTodoTests', 0) == 0 and suites[0].get('status') == 'passed')
    started = type(report.get('startTime')) is int and report['startTime'] > 0
    passed = (started and complete and exit_code == 0 and report.get('success') is True and counts['failed'] == counts['skipped'] == 0
              and all(case['status'] == 'passed' for case in selected))
    return {'file': TEST_FILE, 'counts': counts, 'newRegressions': selected, 'completed': complete,
            'started': started, 'exitCode': exit_code, 'status': 'passed' if passed else 'failed'}


def finalize(source, private, output):
    receipt = {'schemaVersion': 1, 'status': 'failed', 'productRevision': revision(os.environ.get('PRODUCT_REVISION', '')),
               'helperRevision': revision(os.environ.get('HELPER_REVISION', '')), 'file': TEST_FILE,
               'executionAttempted': False, 'started': False, 'completed': False, 'exitCode': None, 'cleanGit': False, 'failureClass': 'preparation_incomplete'}
    try:
        private_directory(private)
        binding = json.loads(read_private(private / 'binding.json', 4096))
        current = source_binding(source)
        if current != binding:
            raise ValueError('binding_changed')
        receipt.update(current)
        receipt['cleanGitBeforePreparation'] = binding.get('cleanGit') is True
        receipt['cleanGitAfterTests'] = current['cleanGit']
        receipt['executionAttempted'] = json.loads(read_private(private / 'started.json', 4096)) == binding
        if not receipt['executionAttempted']:
            raise ValueError('not_started')
        receipt['cleanGitBeforeTests'] = True
        raw_code = read_private(private / 'exit.txt', 16).strip()
        if not re.fullmatch(r'[0-9]{1,3}', raw_code) or not 0 <= int(raw_code) <= 255:
            raise ValueError('exit_invalid')
        receipt['exitCode'] = int(raw_code)
        summary = summarize(json.loads(read_private(private / 'report.json')), int(raw_code), source)
        receipt.update(summary)
        receipt['failureClass'] = 'none' if receipt['status'] == 'passed' else 'stock_gate_failed'
    except FileNotFoundError:
        receipt['failureClass'] = 'report_or_preparation_missing'
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        receipt['failureClass'] = 'invalid_report_or_binding'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return 0 if receipt['status'] == 'passed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['validate', 'prepare', 'start', 'finalize', 'clean'])
    parser.add_argument('--source', type=Path, default=Path('runner-product'))
    parser.add_argument('--private', type=Path)
    parser.add_argument('--output', type=Path, default=Path('runner-public'))
    args = parser.parse_args()
    os.umask(0o077)
    revision(os.environ.get('PRODUCT_REVISION', '')); helper = revision(os.environ.get('HELPER_REVISION', ''))
    if args.mode == 'validate':
        return 0
    private = args.private
    if args.mode == 'finalize':
        return finalize(args.source.resolve(), private, args.output)
    if args.mode == 'prepare':
        if git(Path(__file__).resolve().parents[1], 'rev-parse', 'HEAD') != helper:
            raise ValueError('helper_identity')
        if subprocess.check_output(['node', '--version'], text=True).strip() != 'v24.14.0' or subprocess.check_output(['pnpm', '--version'], text=True).strip() != '9.15.4':
            raise ValueError('toolchain_mismatch')
        private.mkdir(mode=0o700)
        (private / 'binding.json').write_text(json.dumps(source_binding(args.source.resolve())))
    elif args.mode == 'start':
        private_directory(private)
        binding = json.loads(read_private(private / 'binding.json', 4096))
        if source_binding(args.source.resolve()) != binding:
            raise ValueError('product_changed_during_preparation')
        (private / 'started.json').write_text(json.dumps(binding))
    else:
        if not private.exists():
            return 0
        private_directory(private)
        entries = list(private.iterdir())
        if any(p.name not in PRIVATE_FILES or not stat.S_ISREG(p.lstat().st_mode) or p.lstat().st_uid != os.getuid() for p in entries):
            raise ValueError('private_cleanup_unconfirmed')
        for path in entries:
            path.unlink()
        private.rmdir()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print('Runner control-plane regression infrastructure failed.')
        raise SystemExit(1)
