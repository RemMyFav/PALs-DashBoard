export const TENANT = 'public';
export const ROLE_PERMISSIONS = Object.freeze({
  user: ['account:read'],
  admin: ['account:read', 'admin:access'],
});

export function permissionsForRoles(roles) {
  return [...new Set(roles.flatMap(role => Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : []))];
}

export async function ensureRoles(userRoles) {
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const result = await userRoles.createNewRoleOrAddPermissions(role, permissions);
    if (result.status !== 'OK') throw new Error('Unable to initialize roles');
  }
}

export function withDefaultUserRole(originalAuthenticate, userRoles) {
  return async input => {
    if (input.tenantId !== TENANT) throw new Error('Unsupported tenant');
    const result = await originalAuthenticate(input);
    if (result.status === 'OK') {
      // Never accept a role from request fields, metadata, or email address.
      const added = await userRoles.addRoleToUser(TENANT, result.user.id, 'user');
      if (added.status !== 'OK') throw new Error('Unable to assign default role');
    }
    return result;
  };
}

export async function setAccountRole({ userId, role, users, userRoles, sessions }) {
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error('Role must be user or admin');
  const user = await users.getUser(userId);
  if (!user || !user.tenantIds.includes(TENANT)) throw new Error('User not found in public tenant');
  await ensureRoles(userRoles);
  const base = await userRoles.addRoleToUser(TENANT, userId, 'user');
  if (base.status !== 'OK') throw new Error('Unable to assign user role');
  const result = role === 'admin'
    ? await userRoles.addRoleToUser(TENANT, userId, 'admin')
    : await userRoles.removeUserRole(TENANT, userId, 'admin');
  if (result.status !== 'OK') throw new Error('Unable to update role');
  await sessions.revokeAllSessionsForUser(userId, true, TENANT);
}

export async function setAccountRoleByEmail({ email, role, users, userRoles, sessions }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Enter a valid email address');
  const matches = await users.listUsersByAccountInfo(TENANT, { email: normalizedEmail });
  if (matches.length === 0) throw new Error('No account found for this email address');
  if (matches.length > 1) throw new Error('Multiple accounts use this email address');
  await setAccountRole({ userId: matches[0].id, role, users, userRoles, sessions });
}
