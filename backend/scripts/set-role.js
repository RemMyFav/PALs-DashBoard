import { initAuth, SuperTokens, UserRoles, Session } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { setAccountRoleByEmail } from '../src/roles.js';

const [email, role, ...extra] = process.argv.slice(2);
if (!email || !['admin', 'user'].includes(role) || extra.length) {
  console.error('Usage: npm run set-role -- <email> <admin|user>');
  process.exit(1);
}
try {
  initAuth(readConfig());
  await setAccountRoleByEmail({ email, role, users: SuperTokens, userRoles: UserRoles, sessions: Session });
  console.log(`Role for ${email.trim().toLowerCase()} set to ${role}. The user must sign in again.`);
} catch (error) {
  console.error(`Role change failed: ${error.message}`);
  process.exitCode = 1;
}
