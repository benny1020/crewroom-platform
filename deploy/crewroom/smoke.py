#!/usr/bin/env python3
"""Verify authenticated privacy and DB/file persistence on an isolated test instance."""
import argparse, hashlib, http.cookiejar, json, os, secrets, urllib.request, urllib.error
from pathlib import Path

os.umask(0o077)
p = argparse.ArgumentParser()
p.add_argument('phase', choices=['seed', 'check'])
p.add_argument('--base', default='http://localhost:3118')
p.add_argument('--state-file', type=Path, required=True, help='Private state for an isolated disposable verification instance')
args = p.parse_args()
state_path = args.state_file.absolute()
state_path.parent.mkdir(parents=True, exist_ok=True)

class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, data=None, expected=(200,), raw=None, content_type=None):
        payload = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        headers = {'Origin': args.base, 'Content-Type': content_type or 'application/json'}
        request = urllib.request.Request(args.base + path, data=payload, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=60)
            status, body = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read()
        if status not in expected:
            raise RuntimeError(f'HTTP smoke failed: method={method}, status={status}, expected={expected}')
        return json.loads(body) if body and content_type is None else body
    def login(self, account):
        return self.call('POST', '/api/auth/sign-in/email', account)

admin, viewer = Client(), Client()
expected_commit = os.environ.get('EXPECTED_COMMIT')
if expected_commit:
    assert admin.call('GET', '/api/health').get('commit') == expected_commit, 'Served image commit does not match the requested source'
if args.phase == 'seed':
    if state_path.exists():
        raise SystemExit('Smoke state exists; refusing to create duplicate accounts')
    state = {role: {'email': role + '-' + secrets.token_hex(5) + '@crewroom.test', 'password': secrets.token_urlsafe(24)} for role in ['admin', 'viewer']}
    state_path.write_text(json.dumps(state))
    for role, client in [('admin', admin), ('viewer', viewer)]:
        client.call('POST', '/api/auth/sign-up/email', {**state[role], 'name': 'Deployment ' + role}, expected=(200,201))
    admin.call('POST', '/api/bootstrap/claim', {})
    company = admin.call('POST', '/api/companies', {'name': 'Deployment persistence verification'}, expected=(200,201))
    company_id = state['companyId'] = company['id']
    state_path.write_text(json.dumps(state))
    admin.call('PATCH', '/api/companies/' + company_id, {'requireBoardApprovalForNewAgents': False})
    admin.call('PATCH', '/api/instance/settings/experimental', {'enableAgentChat': True})
    invite = admin.call('POST', f'/api/companies/{company_id}/invites', {'allowedJoinTypes': 'human', 'humanRole': 'viewer'}, expected=(201,))
    joined = viewer.call('POST', '/api/invites/' + invite['token'] + '/accept', {'requestType': 'human'}, expected=(200,201))
    request_id = joined.get('id') or joined.get('joinRequest', {}).get('id')
    if not request_id:
        raise RuntimeError('Join request receipt missing ID')
    if joined.get('status') == 'pending_approval':
        admin.call('POST', f'/api/companies/{company_id}/join-requests/{request_id}/approve', {})
    agent = admin.call('POST', f'/api/companies/{company_id}/agents', {'name': 'Persistence verifier', 'role': 'engineer', 'adapterType': 'process', 'adapterConfig': {'command': '/bin/false'}, 'runtimeConfig': {'heartbeat': {'enabled': False, 'wakeOnDemand': False}}}, expected=(200,201))
    state['agentId'] = agent['id']
    chat = admin.call('POST', f'/api/companies/{company_id}/chats/' + agent['id'], {})
    assert chat['visibility'] == 'private'
    state['chatId'] = chat['id']
    marker = ('crewroom persistent private attachment ' + secrets.token_hex(12)).encode()
    boundary = 'crewroom-' + secrets.token_hex(12)
    upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="persistence-marker.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode() + marker + f'\r\n--{boundary}--\r\n'.encode())
    attachment = admin.call('POST', f'/api/companies/{company_id}/issues/' + chat['id'] + '/attachments', expected=(200,201), raw=upload, content_type='multipart/form-data; boundary=' + boundary)
    attachment = json.loads(attachment)
    state['contentPath'] = attachment['contentPath']
    state['sha256'] = hashlib.sha256(marker).hexdigest()
    state_path.write_text(json.dumps(state))
else:
    state = json.loads(state_path.read_text())

admin.login(state['admin'])
viewer.login(state['viewer'])
chat = admin.call('GET', '/api/issues/' + state['chatId'])
assert chat['id'] == state['chatId'] and chat['visibility'] == 'private'
owner_chats = admin.call('GET', f'/api/companies/{state["companyId"]}/chats')
assert any(item['id'] == state['chatId'] for item in owner_chats)
viewer_chats = viewer.call('GET', f'/api/companies/{state["companyId"]}/chats')
assert all(item['id'] != state['chatId'] for item in viewer_chats)
content = admin.call('GET', state['contentPath'], content_type='application/octet-stream')
assert hashlib.sha256(content).hexdigest() == state['sha256']
viewer.call('GET', '/api/issues/' + state['chatId'], expected=(404,))
viewer.call('GET', state['contentPath'], expected=(404,))
caps = viewer.call('GET', f'/api/companies/{state["companyId"]}/crewroom/capabilities')
assert caps['canAssignTasks'] is False and caps['canCreateUnassignedTask'] is False
print('PASS: authenticated admin, invited viewer, private conversation, attachment checksum and denied viewer reads (' + args.phase + ')')
