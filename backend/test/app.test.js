import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

async function fixture(t) {
  const roles = new Map([['member', ['user']], ['admin', ['user', 'admin']]]);
  const surveyOwners = [];
  const surveyMutations = [];
  const app = createApp({
    config: { publicUrl: 'http://localhost:3000' },
    authMiddleware: (req, res, next) => req.path === '/auth/signin' ? res.json({ status: 'OK' }) : next(),
    authErrorHandler: (error, _req, _res, next) => next(error),
    verifySession: options => {
      assert.equal(options.checkDatabase, true);
      return (req, res, next) => {
        const id = req.headers['x-test-user'];
        if (!id) return res.status(401).json({ message: 'unauthenticated' });
        req.session = { getUserId: () => id, getTenantId: () => req.headers['x-test-tenant'] || 'public' };
        next();
      };
    },
    users: {
      getUser: async id => ({ emails: [`${id}@example.com`], timeJoined: 1000 }),
      listUsersByAccountInfo: async (_tenant, accountInfo) => accountInfo.email === 'member@example.com' ? [{ id: 'member' }] : [],
    },
    userRoles: { getRolesForUser: async (_tenant, id) => ({ roles: roles.get(id) || [] }) },
    surveyStore: {
      list: async ownerUserId => {
        surveyOwners.push(ownerUserId);
        return [{ id: '9ed57470-3c62-4a43-89d0-b6ad9da8af18', title: 'Test survey', questionCount: 2, responseCount: 1 }];
      },
      get: async (ownerUserId, id) => ({ id, ownerUserId, title: 'Test survey', questions: [], responseCount: 1 }),
      create: async () => assert.fail('upload is not expected in this test'),
      assign: async (_owner, _survey, recipient) => ({ added: recipient === 'member' }),
      recipients: async () => [],
      revoke: async (ownerUserId, surveyId, recipientUserId) => {
        surveyMutations.push({ action: 'revoke', ownerUserId, surveyId, recipientUserId });
        return true;
      },
      delete: async (ownerUserId, surveyId) => {
        surveyMutations.push({ action: 'delete', ownerUserId, surveyId });
        return true;
      },
      join: async (_userId, code) => code === '1234' ? { surveyId: '9ed57470-3c62-4a43-89d0-b6ad9da8af18', added: true } : null,
      inbox: async userId => [{ id: '9ed57470-3c62-4a43-89d0-b6ad9da8af18', title: 'Inbox survey', senderUserId: 'admin', questionCount: 2, source: 'sent', joinedAt: 1000, submittedAt: '2026-11-15T12:00:00.000Z', recipient: userId }],
      getReceived: async () => null,
      submit: async (recipientUserId, surveyId, ratings) => {
        surveyMutations.push({ action: 'submit', recipientUserId, surveyId, ratings });
        return { submittedAt: '2026-11-15T12:00:00.000Z' };
      },
      exportResponses: async () => ({
        questions: [{ position: 1, question: 'First question' }, { position: 2, question: 'Second question' }],
        responses: [{ ratings: [5, 2] }],
      }),
      leave: async (recipientUserId, surveyId) => {
        surveyMutations.push({ action: 'leave', recipientUserId, surveyId });
        return true;
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { roles, surveyOwners, surveyMutations, request: (path, options) => fetch(base + path, options) };
}

test('anonymous requests receive 401; users can only read their own account', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await request('/api/admin/overview')).status, 401);
  const me = await request('/api/me?userId=admin', { headers: { 'x-test-user': 'member' } });
  assert.equal(me.status, 200);
  const account = await me.json();
  assert.equal(account.email, 'member@example.com');
  assert.equal(Object.hasOwn(account, 'userId'), false);
  assert.equal((await request('/api/admin/overview', { headers: { 'x-test-user': 'member', 'x-role': 'admin' } })).status, 403);
});

test('admin access follows stored roles immediately, including demotion', async t => {
  const { request, roles } = await fixture(t);
  const options = { headers: { 'x-test-user': 'admin' } };
  assert.equal((await request('/api/admin/overview', options)).status, 200);
  roles.set('admin', ['user']);
  assert.equal((await request('/api/admin/overview', options)).status, 403);
  assert.equal((await request('/api/me', options)).status, 200);
});

test('survey projects require admin access and are scoped to the session owner', async t => {
  const { request, surveyOwners } = await fixture(t);
  assert.equal((await request('/api/surveys', { headers: { 'x-test-user': 'member' } })).status, 403);
  const response = await request('/api/surveys', { headers: { 'x-test-user': 'admin' } });
  assert.equal(response.status, 200);
  const surveyList = (await response.json()).surveys;
  assert.equal(surveyList[0].title, 'Test survey');
  assert.equal(surveyList[0].responseCount, 1);
  assert.deepEqual(surveyOwners, ['admin']);
  assert.equal((await request('/api/surveys/not-a-uuid', { headers: { 'x-test-user': 'admin' } })).status, 404);
});

test('members can view their inbox and join with a 4-digit code', async t => {
  const { request } = await fixture(t);
  const headers = { 'x-test-user': 'member' };
  const inbox = await request('/api/inbox', { headers });
  assert.equal(inbox.status, 200);
  const body = await inbox.json();
  assert.equal(body.surveys[0].senderEmail, 'admin@example.com');
  assert.equal(body.surveys[0].submittedAt, '2026-11-15T12:00:00.000Z');
  const joined = await request('/api/inbox/join', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ code: '1234' }),
  });
  assert.equal(joined.status, 201);
  assert.equal((await joined.json()).surveyId, '9ed57470-3c62-4a43-89d0-b6ad9da8af18');
});

test('administrators can revoke access and delete only their own survey projects', async t => {
  const { request, surveyMutations } = await fixture(t);
  const id = '9ed57470-3c62-4a43-89d0-b6ad9da8af18';
  const headers = { 'x-test-user': 'admin' };
  const revoked = await request(`/api/surveys/${id}/recipients`, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.com' }),
  });
  assert.equal(revoked.status, 204);
  assert.equal((await request(`/api/surveys/${id}`, { method: 'DELETE', headers })).status, 204);
  assert.deepEqual(surveyMutations, [
    { action: 'revoke', ownerUserId: 'admin', surveyId: id, recipientUserId: 'member' },
    { action: 'delete', ownerUserId: 'admin', surveyId: id },
  ]);
  assert.equal((await request(`/api/surveys/${id}`, { method: 'DELETE', headers: { 'x-test-user': 'member' } })).status, 403);
});

test('members can leave only surveys in their own inbox', async t => {
  const { request, surveyMutations } = await fixture(t);
  const id = '9ed57470-3c62-4a43-89d0-b6ad9da8af18';
  const response = await request(`/api/inbox/${id}`, { method: 'DELETE', headers: { 'x-test-user': 'member' } });
  assert.equal(response.status, 204);
  assert.deepEqual(surveyMutations, [{ action: 'leave', recipientUserId: 'member', surveyId: id }]);
});

test('members submit 1–5 ratings and administrators export only anonymous response columns', async t => {
  const { request, surveyMutations } = await fixture(t);
  const id = '9ed57470-3c62-4a43-89d0-b6ad9da8af18';
  const submitted = await request(`/api/inbox/${id}/responses`, {
    method: 'POST',
    headers: { 'x-test-user': 'member', 'content-type': 'application/json' },
    body: JSON.stringify({ ratings: [5, 2] }),
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(surveyMutations, [{ action: 'submit', recipientUserId: 'member', surveyId: id, ratings: [5, 2] }]);

  const exported = await request(`/api/surveys/${id}/responses.csv`, { headers: { 'x-test-user': 'admin' } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /^text\/csv/);
  const csv = await exported.text();
  assert.match(csv, /Respondent 01/);
  assert.doesNotMatch(csv, /member@example\.com|member/);
  assert.equal((await request(`/api/surveys/${id}/responses.csv`, { headers: { 'x-test-user': 'member' } })).status, 403);
});

test('unknown roles and foreign tenants cannot access the account', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/me', { headers: { 'x-test-user': 'unknown' } })).status, 403);
  assert.equal((await request('/api/me', { headers: { 'x-test-user': 'admin', 'x-test-tenant': 'other' } })).status, 403);
});

test('cross-origin writes are rejected and login attempts are rate limited', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/auth/signin', { method: 'POST', headers: { origin: 'https://untrusted.example' } })).status, 403);
  for (let i = 0; i < 30; i++) assert.equal((await request('/auth/signin', { method: 'POST' })).status, 200);
  assert.equal((await request('/auth/signin', { method: 'POST' })).status, 429);
});
