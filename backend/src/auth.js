import SuperTokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword/index.js';
import Session from 'supertokens-node/recipe/session/index.js';
import UserRoles from 'supertokens-node/recipe/userroles/index.js';
import { withDefaultUserRole } from './roles.js';

export function initAuth(config) {
  SuperTokens.init({
    framework: 'express',
    supertokens: { connectionURI: config.connectionURI, apiKey: config.apiKey },
    appInfo: {
      appName: 'PALs Psychometrics',
      apiDomain: config.publicUrl,
      websiteDomain: config.publicUrl,
      apiBasePath: '/auth',
      websiteBasePath: '/login',
    },
    recipeList: [
      EmailPassword.init({
        signUpFeature: {
          formFields: [{
            id: 'password',
            validate: async value => typeof value === 'string' && value.length >= 12 && value.length <= 128
              ? undefined : 'Your password must be 12–128 characters long.',
          }],
        },
        override: {
          functions: original => ({
            ...original,
            signUp: withDefaultUserRole(original.signUp.bind(original), UserRoles),
            // Repair the base role if a previous signup was interrupted after user creation.
            signIn: withDefaultUserRole(original.signIn.bind(original), UserRoles),
          }),
          // Email delivery is not configured in this login/register milestone.
          apis: original => ({
            ...original,
            generatePasswordResetTokenPOST: undefined,
            passwordResetPOST: undefined,
          }),
        },
      }),
      Session.init({
        cookieSecure: config.cookieSecure,
        cookieSameSite: 'lax',
        antiCsrf: 'VIA_CUSTOM_HEADER',
      }),
      UserRoles.init({
        // Authorization reads current roles from Core, not a stale token claim.
        skipAddingRolesToAccessToken: true,
        skipAddingPermissionsToAccessToken: true,
      }),
    ],
  });
}

export { SuperTokens, Session, UserRoles };
