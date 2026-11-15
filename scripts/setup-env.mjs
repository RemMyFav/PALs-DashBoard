import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const contents = [
  'COMPOSE_PROJECT_NAME=pals-dashboard',
  'WEB_PORT=3000',
  'PUBLIC_URL=http://localhost:3000',
  `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
  `SUPERTOKENS_API_KEY=${randomBytes(32).toString('hex')}`,
  '',
].join('\n');

try {
  await writeFile('.env', contents, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random secrets. Existing files are never overwritten.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; kept unchanged.');
  else throw error;
}
