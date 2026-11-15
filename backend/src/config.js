export function readConfig(env = process.env) {
  const publicUrl = new URL(env.PUBLIC_URL || 'http://localhost:3000');
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path or credentials');
  }
  if (!env.SUPERTOKENS_API_KEY || env.SUPERTOKENS_API_KEY.length < 32) {
    throw new Error('SUPERTOKENS_API_KEY must contain at least 32 characters');
  }
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    port,
    publicUrl: publicUrl.origin,
    cookieSecure: publicUrl.protocol === 'https:',
    connectionURI: env.SUPERTOKENS_CONNECTION_URI || 'http://auth:3567',
    apiKey: env.SUPERTOKENS_API_KEY,
    databaseUrl: env.DATABASE_URL || 'postgresql://supertokens:supertokens@database:5432/supertokens',
  };
}
