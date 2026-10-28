"""Strict, offline-testable HTTP and invite contracts for the disposable smoke."""
import http.cookiejar
import json
import urllib.error
import urllib.request


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, data=None, expected=(200,), raw=None, content_type=None):
        payload = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        headers = {'Origin': self.base, 'Content-Type': content_type or 'application/json'}
        request = urllib.request.Request(self.base + path, data=payload, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=60)
            status, body = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read()
        if status not in expected:
            # Never include a token-bearing URL, response body or credentials.
            raise RuntimeError(f'HTTP smoke failed: method={method}, status={status}, expected={expected}')
        return json.loads(body) if body and content_type is None else body

    def login(self, account):
        return self.call('POST', '/api/auth/sign-in/email', account)


def _human_receipt(body, company_id):
    receipt = body.get('joinRequest', body) if isinstance(body, dict) else None
    if (not isinstance(receipt, dict) or not receipt.get('id')
            or receipt.get('companyId') != company_id
            or receipt.get('requestType') != 'human'
            or not receipt.get('requestingUserId')):
        raise RuntimeError('Human join request receipt missing or mismatched')
    return receipt


def accept_viewer_invite(admin, viewer, token, company_id):
    # The route accepts a request with HTTP 202; only its receipt and membership
    # establish approval. Current human invites may already be auto-approved.
    joined = viewer.call('POST', '/api/invites/' + token + '/accept',
                         {'requestType': 'human'}, expected=(202,))
    receipt = _human_receipt(joined, company_id)
    if receipt.get('status') == 'pending_approval':
        approved = admin.call('POST', f'/api/companies/{company_id}/join-requests/{receipt["id"]}/approve', {})
        approved = _human_receipt(approved, company_id)
        if (approved.get('id') != receipt['id']
                or approved.get('requestingUserId') != receipt['requestingUserId']):
            raise RuntimeError('Join approval receipt does not match the request')
        receipt = approved
    if receipt.get('status') != 'approved':
        raise RuntimeError('Human join request has not been approved')
    members = admin.call('GET', f'/api/companies/{company_id}/members')
    if not any(member.get('companyId') == company_id
               and member.get('principalType') == 'user'
               and member.get('principalId') == receipt['requestingUserId']
               and member.get('membershipRole') == 'viewer'
               and member.get('status') == 'active'
               for member in members.get('members', [])):
        raise RuntimeError('Approved invite has no active viewer membership')
    return receipt
