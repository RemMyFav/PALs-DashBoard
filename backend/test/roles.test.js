import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionsForRoles, withDefaultUserRole, setAccountRole, setAccountRoleByEmail } from '../src/roles.js';
import { readConfig } from '../src/config.js';

test('unknown roles grant nothing; only admin grants admin access', () => {
  assert.deepEqual(permissionsForRoles(['user']), ['account:read']);
  assert.deepEqual(permissionsForRoles(['owner', 'toString']), []);
  assert.deepEqual(permissionsForRoles(['user', 'admin']), ['account:read', 'admin:access']);
});

test('public registration ignores client-supplied admin role', async () => {
  const calls = [];
  const signUp = withDefaultUserRole(async () => ({ status: 'OK', user: { id: 'u1' } }), {
    addRoleToUser: async (...args) => { calls.push(args); return { status: 'OK' }; },
  });
  await signUp({ tenantId: 'public', role: 'admin', formFields: [{ id: 'role', value: 'admin' }] });
  assert.deepEqual(calls, [['public', 'u1', 'user']]);
  await assert.rejects(signUp({ tenantId: 'other' }), /Unsupported tenant/);
});

test('failed registration never assigns a role', async () => {
  const signUp = withDefaultUserRole(async () => ({ status: 'EMAIL_ALREADY_EXISTS_ERROR' }), {
    addRoleToUser: async () => assert.fail('must not assign a role'),
  });
  assert.equal((await signUp({ tenantId: 'public' })).status, 'EMAIL_ALREADY_EXISTS_ERROR');
});

test('role storage errors fail closed during registration', async () => {
  const signUp = withDefaultUserRole(async () => ({ status: 'OK', user: { id: 'u1' } }), {
    addRoleToUser: async () => ({ status: 'UNKNOWN_ROLE_ERROR' }),
  });
  await assert.rejects(signUp({ tenantId: 'public' }), /Unable to assign/);
});

test('admin promotion and demotion revoke sessions and retain user access', async () => {
  const events = [];
  const dependencies = {
    users: { getUser: async () => ({ tenantIds: ['public'] }) },
    userRoles: {
      createNewRoleOrAddPermissions: async () => ({ status: 'OK' }),
      addRoleToUser: async (...args) => { events.push(['add', ...args]); return { status: 'OK' }; },
      removeUserRole: async (...args) => { events.push(['remove', ...args]); return { status: 'OK' }; },
    },
    sessions: { revokeAllSessionsForUser: async (...args) => events.push(['revoke', ...args]) },
  };
  await setAccountRole({ ...dependencies, userId: 'u1', role: 'admin' });
  await setAccountRole({ ...dependencies, userId: 'u1', role: 'user' });
  assert.deepEqual(events, [
    ['add', 'public', 'u1', 'user'], ['add', 'public', 'u1', 'admin'], ['revoke', 'u1', true, 'public'],
    ['add', 'public', 'u1', 'user'], ['remove', 'public', 'u1', 'admin'], ['revoke', 'u1', true, 'public'],
  ]);
  await assert.rejects(setAccountRole({ ...dependencies, userId: 'u1', role: 'owner' }), /Role must be/);
  await assert.rejects(setAccountRole({ ...dependencies, userId: 'missing', role: 'admin', users: { getUser: async () => undefined } }), /User not found/);
});

test('role commands resolve a normalized email to the internal account ID', async () => {
  const events = [];
  const dependencies = {
    users: {
      listUsersByAccountInfo: async (tenantId, accountInfo) => {
        events.push(['lookup', tenantId, accountInfo]);
        return [{ id: 'u1' }];
      },
      getUser: async () => ({ tenantIds: ['public'] }),
    },
    userRoles: {
      createNewRoleOrAddPermissions: async () => ({ status: 'OK' }),
      addRoleToUser: async () => ({ status: 'OK' }),
      removeUserRole: async () => ({ status: 'OK' }),
    },
    sessions: { revokeAllSessionsForUser: async userId => events.push(['revoke', userId]) },
  };
  await setAccountRoleByEmail({ ...dependencies, email: '  Admin@Example.COM ', role: 'admin' });
  assert.deepEqual(events, [
    ['lookup', 'public', { email: 'admin@example.com' }],
    ['revoke', 'u1'],
  ]);
  await assert.rejects(setAccountRoleByEmail({ ...dependencies, email: 'invalid', role: 'admin' }), /valid email/);
  await assert.rejects(setAccountRoleByEmail({
    ...dependencies,
    email: 'missing@example.com',
    role: 'admin',
    users: { listUsersByAccountInfo: async () => [] },
  }), /No account/);
});

test('config requires a secret and derives secure cookies from the public origin', () => {
  assert.throws(() => readConfig({}), /API_KEY/);
  const env = { SUPERTOKENS_API_KEY: 'x'.repeat(64), PUBLIC_URL: 'https://example.com' };
  assert.equal(readConfig(env).cookieSecure, true);
  assert.equal(readConfig({ ...env, PUBLIC_URL: 'http://localhost:3000' }).cookieSecure, false);
  assert.throws(() => readConfig({ ...env, PUBLIC_URL: 'https://example.com/path' }), /origin/);
});
