import SuperTokens from 'supertokens-web-js';
import EmailPassword from 'supertokens-web-js/recipe/emailpassword';
import Session from 'supertokens-web-js/recipe/session';

export const UI_PREVIEW = import.meta.env.DEV && import.meta.env.MODE === 'ui';

if (!UI_PREVIEW) SuperTokens.init({
  appInfo: {
    appName: 'PALs Psychometrics',
    apiDomain: window.location.origin,
    apiBasePath: '/auth',
  },
  recipeList: [EmailPassword.init(), Session.init()],
});

export { EmailPassword, Session };

export async function apiRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Your session has expired. Please sign in again.' : body.message || 'Service temporarily unavailable. Please try again later.');
    error.status = response.status;
    throw error;
  }
  return body;
}

export function getJson(path) {
  return apiRequest(path);
}
