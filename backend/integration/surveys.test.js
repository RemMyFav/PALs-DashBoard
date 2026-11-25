import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initAuth, Session, SuperTokens, UserRoles } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { setAccountRole } from '../src/roles.js';

const config = readConfig();
initAuth(config);
const base = process.env.TEST_BASE_URL || 'http://frontend:8080';
const suffix = randomUUID();
const password = `Survey-${randomUUID()}!`;
const emails = {
  admin: `survey-admin-${suffix}@example.com`,
  direct: `survey-direct-${suffix}@example.com`,
  code: `survey-code-${suffix}@example.com`,
  coowner: `survey-coowner-${suffix}@example.com`,
};

async function api(path, { method = 'GET', token, json, form } = {}) {
  const headers = {
    'st-auth-mode': 'header',
    rid: /signup|signin/.test(path) ? 'emailpassword' : 'session',
    origin: process.env.PUBLIC_URL || 'http://localhost:3000',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
  return fetch(base + path, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  });
}

function credentials(email) {
  return { formFields: [{ id: 'email', value: email }, { id: 'password', value: password }] };
}

async function register(email) {
  const response = await api('/auth/signup', { method: 'POST', json: credentials(email) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'OK');
  return body.user.id;
}

async function login(email) {
  const response = await api('/auth/signin', { method: 'POST', json: credentials(email) });
  assert.equal(response.status, 200);
  assert.equal((await response.clone().json()).status, 'OK');
  const token = response.headers.get('st-access-token');
  assert.ok(token);
  return token;
}

test('survey sharing, joining, revocation, leaving, and deletion work across the real stack', { timeout: 60000 }, async t => {
  const userIds = [];
  let surveyId;
  const database = new pg.Pool({ connectionString: config.databaseUrl });
  t.after(async () => {
    if (surveyId) await database.query('DELETE FROM app_surveys WHERE id = $1', [surveyId]);
    await database.end();
    for (const userId of userIds) await SuperTokens.deleteUser(userId);
  });

  const adminId = await register(emails.admin);
  userIds.push(adminId);
  userIds.push(await register(emails.direct));
  userIds.push(await register(emails.code));
  userIds.push(await register(emails.coowner));
  await setAccountRole({ userId: adminId, role: 'admin', users: SuperTokens, userRoles: UserRoles, sessions: Session });

  const adminToken = await login(emails.admin);
  const form = new FormData();
  form.append('title', 'Integration survey');
  form.append('file', new Blob(['question,ignored\nFirst question,x\n"Second, quoted question",y\n'], { type: 'text/csv' }), 'survey.csv');
  const uploaded = await api('/api/surveys', { method: 'POST', token: adminToken, form });
  assert.equal(uploaded.status, 201);
  const project = (await uploaded.json()).survey;
  surveyId = project.id;
  assert.match(project.joinCode, /^\d{4}$/);
  assert.equal(project.questionCount, 2);

  const shared = await api(`/api/surveys/${surveyId}/share`, {
    method: 'POST', token: adminToken, json: { email: emails.direct, accessRole: 'participant' },
  });
  assert.equal(shared.status, 201);

  const coownerInvite = await api(`/api/surveys/${surveyId}/share`, {
    method: 'POST', token: adminToken, json: { email: emails.coowner, accessRole: 'co_owner' },
  });
  assert.equal(coownerInvite.status, 201);
  const coownerToken = await login(emails.coowner);
  const coownerList = await api('/api/surveys', { token: coownerToken });
  assert.equal((await coownerList.json()).surveys.find(survey => survey.id === surveyId).accessRole, 'co_owner');
  assert.deepEqual((await (await api('/api/inbox', { token: coownerToken })).json()).surveys, []);
  assert.equal((await api(`/api/surveys/${surveyId}/responses.csv`, { token: coownerToken })).status, 200);
  assert.equal((await api(`/api/surveys/${surveyId}`, { method: 'DELETE', token: coownerToken })).status, 404);

  const directToken = await login(emails.direct);
  const directInbox = await api('/api/inbox', { token: directToken });
  assert.equal(directInbox.status, 200);
  const directSurveys = (await directInbox.json()).surveys;
  assert.equal(directSurveys[0].senderEmail, emails.admin);
  assert.equal(directSurveys[0].title, 'Integration survey');

  const codeToken = await login(emails.code);
  const joined = await api('/api/inbox/join', {
    method: 'POST', token: codeToken, json: { code: project.joinCode },
  });
  assert.equal(joined.status, 201);
  assert.equal((await joined.json()).surveyId, surveyId);
  const received = await api(`/api/inbox/${surveyId}`, { token: codeToken });
  assert.equal(received.status, 200);
  const receivedSurvey = (await received.json()).survey;
  assert.deepEqual(receivedSurvey.questions.map(item => item.question), ['First question', 'Second, quoted question']);

  const submitted = await api(`/api/inbox/${surveyId}/responses`, {
    method: 'POST', token: codeToken, json: { ratings: [5, 2] },
  });
  assert.equal(submitted.status, 200);
  const completedInbox = await api('/api/inbox', { token: codeToken });
  assert.ok((await completedInbox.json()).surveys.find(survey => survey.id === surveyId).submittedAt);
  const adminListAfterSubmit = await api('/api/surveys', { token: adminToken });
  assert.equal((await adminListAfterSubmit.json()).surveys.find(survey => survey.id === surveyId).responseCount, 1);
  const responseExport = await api(`/api/surveys/${surveyId}/responses.csv`, { token: adminToken });
  assert.equal(responseExport.status, 200);
  const responseCsv = await responseExport.text();
  assert.match(responseCsv, /"question","Respondent 01"/);
  assert.match(responseCsv, /"First question","5"/);
  assert.doesNotMatch(responseCsv, new RegExp(emails.code.replaceAll('.', '\\.')));
  assert.doesNotMatch(responseCsv, new RegExp(userIds[2]));

  const left = await api(`/api/inbox/${surveyId}`, { method: 'DELETE', token: codeToken });
  assert.equal(left.status, 204);
  assert.equal((await api(`/api/inbox/${surveyId}`, { token: codeToken })).status, 404);
  const adminListAfterLeave = await api('/api/surveys', { token: adminToken });
  assert.equal((await adminListAfterLeave.json()).surveys.find(survey => survey.id === surveyId).responseCount, 0);
  const exportAfterLeave = await api(`/api/surveys/${surveyId}/responses.csv`, { token: adminToken });
  assert.doesNotMatch(await exportAfterLeave.text(), /Respondent 01/);

  const revoked = await api(`/api/surveys/${surveyId}/recipients`, {
    method: 'DELETE', token: adminToken, json: { email: emails.direct },
  });
  assert.equal(revoked.status, 204);
  assert.deepEqual((await (await api('/api/inbox', { token: directToken })).json()).surveys, []);

  const sharedAgain = await api(`/api/surveys/${surveyId}/share`, {
    method: 'POST', token: adminToken, json: { email: emails.direct, accessRole: 'participant' },
  });
  assert.equal(sharedAgain.status, 201);
  assert.equal((await api(`/api/surveys/${surveyId}`, { method: 'DELETE', token: adminToken })).status, 204);
  assert.deepEqual((await (await api('/api/inbox', { token: directToken })).json()).surveys, []);
  assert.equal((await api(`/api/surveys/${surveyId}`, { token: adminToken })).status, 404);

  form.set('title', 'Integration dimension ranking');
  form.set('answerMode', 'ranking');
  const rankingUpload = await api('/api/surveys', { method: 'POST', token: adminToken, form });
  assert.equal(rankingUpload.status, 201);
  const rankingSurvey = (await rankingUpload.json()).survey;
  surveyId = rankingSurvey.id;
  assert.equal(rankingSurvey.answerMode, 'ranking');
  assert.equal((await api('/api/inbox/join', {
    method: 'POST', token: codeToken, json: { code: rankingSurvey.joinCode },
  })).status, 201);
  const responsesPath = `/api/inbox/${surveyId}/responses`;
  assert.equal((await api(responsesPath, {
    method: 'POST', token: codeToken, json: { ratings: [5, 2] },
  })).status, 400);
  const rankings = [['Social', 'Physical'], ['Emotional']];
  assert.equal((await api(responsesPath, {
    method: 'POST', token: codeToken, json: { rankings },
  })).status, 200);
  const rankedSurvey = await api(`/api/inbox/${surveyId}`, { token: codeToken });
  const rankedResult = (await rankedSurvey.json()).survey;
  assert.equal(rankedResult.answerMode, 'ranking');
  assert.deepEqual(rankedResult.answers, rankings.map((ranking, index) => ({ position: index + 1, ranking })));
  const rankingExport = await api(`/api/surveys/${surveyId}/responses.csv`, { token: adminToken });
  assert.equal(rankingExport.status, 200);
  const rankingCsv = await rankingExport.text();
  assert.match(rankingCsv, /"First question","Social, Physical"/);
  assert.doesNotMatch(rankingCsv, /Financial|@/);
});
