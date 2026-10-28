import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('crewroom_smoke_contracts', Path(__file__).with_name('smoke_contracts.py'))
contracts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contracts)

COMPANY = 'fixture-company'
TOKEN = 'SYNTHETIC_TEST_VALUE'
RECEIPT = {'id': 'fixture-request', 'companyId': COMPANY, 'requestType': 'human',
           'requestingUserId': 'fixture-viewer', 'status': 'approved'}
MEMBER = {'companyId': COMPANY, 'principalType': 'user', 'principalId': 'fixture-viewer',
          'membershipRole': 'viewer', 'status': 'active'}


class OfflineOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.method, request.full_url))
        status, payload = self.responses.pop(0)
        body = json.dumps(payload).encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, 'offline fixture', None, io.BytesIO(body))
        return SimpleNamespace(status=status, read=lambda: body)


def client(*responses):
    result = contracts.Client('http://smoke.invalid')
    result.opener = OfflineOpener(responses)
    return result


class InviteSmokeContractTests(unittest.TestCase):
    def test_202_already_approved_still_checks_active_viewer_membership(self):
        admin = client((200, {'members': [MEMBER]}))
        viewer = client((202, RECEIPT))
        self.assertEqual(contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)['id'], RECEIPT['id'])
        self.assertEqual([method for method, _ in admin.opener.calls], ['GET'])
        self.assertIn('/members', admin.opener.calls[0][1])

    def test_202_nested_pending_receipt_requires_same_request_admin_approval(self):
        admin = client((200, RECEIPT), (200, {'members': [MEMBER]}))
        viewer = client((202, {'joinRequest': {**RECEIPT, 'status': 'pending_approval'}}))
        contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
        self.assertEqual([method for method, _ in admin.opener.calls], ['POST', 'GET'])
        self.assertTrue(admin.opener.calls[0][1].endswith('/join-requests/fixture-request/approve'))

    def test_accept_denials_and_wrong_success_codes_are_not_ignored(self):
        for status in [200, 201, 401, 403, 404, 409, 500]:
            with self.subTest(status=status):
                admin = client()
                viewer = client((status, {**RECEIPT, 'private': TOKEN}))
                with self.assertRaises(RuntimeError) as error:
                    contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
                self.assertNotIn(TOKEN, str(error.exception))
                self.assertEqual(admin.opener.calls, [])

    def test_approval_denial_is_not_membership_success(self):
        admin = client((403, {'status': 'approved', 'private': TOKEN}))
        viewer = client((202, {**RECEIPT, 'status': 'pending_approval'}))
        with self.assertRaises(RuntimeError) as error:
            contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
        self.assertNotIn(TOKEN, str(error.exception))
        self.assertEqual(len(admin.opener.calls), 1)

    def test_receipt_must_be_approved_after_admin_call(self):
        for status in ['pending_approval', 'rejected', None]:
            with self.subTest(status=status):
                admin = client((200, {**RECEIPT, 'status': status}))
                viewer = client((202, {**RECEIPT, 'status': 'pending_approval'}))
                with self.assertRaises(RuntimeError):
                    contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
                self.assertEqual(len(admin.opener.calls), 1)

    def test_rejected_missing_or_mismatched_receipts_do_not_claim_membership(self):
        for changes in [{'status': 'rejected'}, {'status': None}, {'id': None},
                        {'companyId': 'other-company'}, {'requestType': 'agent'}, {'requestingUserId': None}]:
            with self.subTest(changes=changes):
                admin = client()
                viewer = client((202, {**RECEIPT, **changes}))
                with self.assertRaises(RuntimeError):
                    contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
                self.assertEqual(admin.opener.calls, [])

    def test_admin_approval_cannot_change_request_or_user(self):
        for changes in [{'id': 'other-request'}, {'requestingUserId': 'other-user'}]:
            with self.subTest(changes=changes):
                admin = client((200, {**RECEIPT, **changes}))
                viewer = client((202, {**RECEIPT, 'status': 'pending_approval'}))
                with self.assertRaises(RuntimeError):
                    contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)
                self.assertEqual(len(admin.opener.calls), 1)

    def test_approved_receipt_is_insufficient_without_active_viewer_role(self):
        for members in [[], [{**MEMBER, 'membershipRole': 'operator'}],
                        [{**MEMBER, 'status': 'suspended'}], [{**MEMBER, 'principalId': 'other-user'}]]:
            with self.subTest(members=members):
                admin = client((200, {'members': members}))
                viewer = client((202, RECEIPT))
                with self.assertRaises(RuntimeError):
                    contracts.accept_viewer_invite(admin, viewer, TOKEN, COMPANY)


if __name__ == '__main__':
    unittest.main()
