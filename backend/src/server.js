import { middleware, errorHandler } from 'supertokens-node/framework/express/index.js';
import { verifySession } from 'supertokens-node/recipe/session/framework/express/index.js';
import { initAuth, SuperTokens, UserRoles } from './auth.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { ensureRoles } from './roles.js';
import { createSurveyStore } from './surveys.js';

const config = readConfig();
initAuth(config);
await ensureRoles(UserRoles);
const surveyStore = createSurveyStore(config.databaseUrl);
await surveyStore.init();
const app = createApp({
  config,
  authMiddleware: middleware(),
  authErrorHandler: errorHandler(),
  verifySession,
  users: SuperTokens,
  userRoles: UserRoles,
  surveyStore,
});
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Backend listening on ${config.port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await surveyStore.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
