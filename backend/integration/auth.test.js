import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initAuth, SuperTokens, UserRoles, Session } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { setAccountRole } from '../src/roles.js';

// Run inside the backend container against the actual nginx + Core + PostgreSQL stack.
initAuth(readConfig());
const base = process.env.TEST_BASE_URL || 'http://frontend:8080';
const email = `integration-${randomUUID()}@example.com`;
const password = `Test-${randomUUID()}!`;

async function request(path, { body, token, method = body ? 'POST' : 'GET' } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'st-auth-mode': 'header',
      rid: /signup|signin/.test(path) ? 'emailpassword' : 'session',
      origin: process.env.PUBLIC_URL || 'http://localhost:3000',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function credentials(value = password) {
  return { formFields: [{ id: 'email', value: email }, { id: 'password', value }] };
}

async function login() {
  const response = await request('/auth/signin', { body: credentials() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'OK');
  const token = response.headers.get('st-access-token');
  assert.ok(token, 'login should issue an access token');
  return { token, refresh: response.headers.get('st-refresh-token') };
}

test('real signup, login, refresh, role enforcement, revocation and logout', { timeout: 60000 }, async t => {
  // Cleanup only the uniquely named account created by this test, including partial signup failures.
  t.after(async () => {
    const users = await SuperTokens.listUsersByAccountInfo('public', { email });
    for (const user of users) await SuperTokens.deleteUser(user.id);
  });
  assert.equal((await request('/api/me')).status, 401);
  const weak = await request('/auth/signup', { body: credentials('short') });
  assert.equal((await weak.json()).status, 'FIELD_ERROR');

  const registered = await request('/auth/signup', { body: { ...credentials(), role: 'admin' } });
  assert.equal(registered.status, 200);
  const result = await registered.json();
  assert.equal(result.status, 'OK');
  const userId = result.user.id;
  assert.deepEqual((await UserRoles.getRolesForUser('public', userId)).roles, ['user']);
  const duplicate = await request('/auth/signup', { body: credentials() });
  assert.equal((await duplicate.json()).status, 'FIELD_ERROR');
  const wrong = await request('/auth/signin', { body: credentials('Incorrect-password-123') });
  assert.equal((await wrong.json()).status, 'WRONG_CREDENTIALS_ERROR');

  let { token, refresh } = await login();
  const me = await request('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, email);
  assert.equal((await request('/api/admin/overview', { token })).status, 403);

  const renewed = await request('/auth/session/refresh', { method: 'POST', token: refresh });
  assert.equal(renewed.status, 200);
  token = renewed.headers.get('st-access-token');
  assert.ok(token);
  assert.equal((await request('/api/me', { token })).status, 200);

  const dependencies = { userId, users: SuperTokens, userRoles: UserRoles, sessions: Session };
  await setAccountRole({ ...dependencies, role: 'admin' });
  assert.equal((await request('/api/me', { token })).status, 401);
  ({ token } = await login());
  assert.equal((await request('/api/admin/overview', { token })).status, 200);

  await setAccountRole({ ...dependencies, role: 'user' });
  assert.equal((await request('/api/admin/overview', { token })).status, 401);
  ({ token } = await login());
  assert.equal((await request('/api/admin/overview', { token })).status, 403);

  assert.equal((await request('/auth/signout', { method: 'POST', token })).status, 200);
  assert.equal((await request('/api/me', { token })).status, 401);
});
