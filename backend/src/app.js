import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { permissionsForRoles, TENANT } from './roles.js';
import { buildAnonymousResponseCsv, isSurveyId, normalizeAccountEmail, normalizeAnswerMode, normalizeJoinCode, normalizeRankings, normalizeRatings, normalizeSurveyAccessRole, parseSurveyFile, surveyUpload } from './surveys.js';

export function createApp({ config, authMiddleware, authErrorHandler, verifySession, users, userRoles, surveyStore }) {
  const app = express();
  app.disable('x-powered-by');
  // Backend has no published port; only the nginx proxy reaches it.
  app.set('trust proxy', 1);
  const parseJson = express.json({ limit: '16kb' });
  const parseSurveyResponse = express.json({ limit: '96kb' });
  app.use((req, res, next) => {
    const isSurveyResponse = req.method === 'POST' && /^\/api\/inbox\/[^/]+\/responses\/?$/i.test(req.path);
    return (isSurveyResponse ? parseSurveyResponse : parseJson)(req, res, next);
  });
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== config.publicUrl) {
      return res.status(403).json({ message: 'Request origin is not allowed.' });
    }
    next();
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again in 15 minutes.' },
  });
  const joinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many join attempts. Please try again in 15 minutes.' },
  });
  app.use('/auth', (req, res, next) => {
    if (req.method === 'POST' && /\/(signin|signup)\/?$/i.test(req.path)) return authLimiter(req, res, next);
    next();
  });
  app.use(authMiddleware);

  app.get('/api/health', async (_req, res) => {
    await userRoles.getRolesForUser(TENANT, 'health-probe');
    res.json({ status: 'ok' });
  });
  app.use('/api', verifySession({ checkDatabase: true }));
  app.use('/api', async (req, res, next) => {
    if (req.session.getTenantId() !== TENANT) return res.status(403).json({ message: 'You do not have access to this workspace.' });
    const userId = req.session.getUserId();
    const { roles } = await userRoles.getRolesForUser(TENANT, userId);
    req.identity = { userId, roles, permissions: permissionsForRoles(roles) };
    next();
  });
  const requirePermission = permission => (req, res, next) => {
    if (!req.identity.permissions.includes(permission)) return res.status(403).json({ message: 'Your account does not have permission to access this resource.' });
    next();
  };
  app.get('/api/me', requirePermission('account:read'), async (req, res) => {
    const user = await users.getUser(req.identity.userId);
    if (!user) return res.status(401).json({ message: 'Your account is no longer available. Please sign in again.' });
    const canManageSurveys = req.identity.permissions.includes('admin:access') || await surveyStore.hasManagedSurveys(req.identity.userId);
    res.json({ roles: req.identity.roles, permissions: req.identity.permissions, email: user.emails[0], joinedAt: user.timeJoined, canManageSurveys });
  });
  app.get('/api/admin/overview', requirePermission('admin:access'), (_req, res) => {
    res.json({
      title: 'Research administration',
      message: 'Create psychometric surveys, assign them to participants, and export anonymous response matrices.',
      capabilities: ['Create measures from question-based CSV, Excel, or Word files', 'Assign surveys by email or join code', 'Download anonymous 1–5 response data'],
    });
  });
  app.get('/api/surveys', requirePermission('account:read'), async (req, res) => {
    res.json({ surveys: await surveyStore.list(req.identity.userId) });
  });
  app.post('/api/surveys', requirePermission('admin:access'), surveyUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Select a CSV, Excel, or Word file to upload.' });
    const questions = await parseSurveyFile(req.file);
    const survey = await surveyStore.create(req.identity.userId, {
      title: req.body.title,
      filename: req.file.originalname,
      questions,
      answerMode: normalizeAnswerMode(req.body.answerMode),
    });
    res.status(201).json({ survey });
  });
  app.get('/api/surveys/:id', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const survey = await surveyStore.get(req.identity.userId, req.params.id);
    if (!survey) return res.status(404).json({ message: 'Survey project not found.' });
    const owner = await users.getUser(survey.ownerUserId);
    const { ownerUserId: _ownerUserId, ...publicSurvey } = survey;
    res.json({ survey: { ...publicSurvey, ownerEmail: owner?.emails[0] || 'Unavailable account' } });
  });
  app.get('/api/surveys/:id/responses.csv', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const result = await surveyStore.exportResponses(req.identity.userId, req.params.id);
    if (!result) return res.status(404).json({ message: 'Survey project not found.' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="survey-${req.params.id}-responses.csv"`);
    res.send(buildAnonymousResponseCsv(result.questions, result.responses, result.survey?.answerMode));
  });
  app.delete('/api/surveys/:id', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const deleted = await surveyStore.delete(req.identity.userId, req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Survey project not found.' });
    res.status(204).end();
  });
  app.post('/api/surveys/:id/share', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const email = normalizeAccountEmail(req.body.email);
    const accessRole = normalizeSurveyAccessRole(req.body.accessRole);
    const matches = await users.listUsersByAccountInfo(TENANT, { email });
    if (matches.length === 0) return res.status(404).json({ message: 'No registered user was found for this email address.' });
    if (matches.length > 1) return res.status(409).json({ message: 'More than one account uses this email address.' });
    if (matches[0].id === req.identity.userId) return res.status(400).json({ message: 'You cannot send a survey to yourself.' });
    const assignment = await surveyStore.assign(req.identity.userId, req.params.id, matches[0].id, accessRole);
    if (!assignment) return res.status(404).json({ message: 'Survey project not found.' });
    if (assignment.owner) return res.status(400).json({ message: 'The survey owner already has full access.' });
    res.status(assignment.added ? 201 : 200).json({ email, ...assignment });
  });
  app.get('/api/surveys/:id/recipients', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const survey = await surveyStore.get(req.identity.userId, req.params.id);
    if (!survey) return res.status(404).json({ message: 'Survey project not found.' });
    const assignments = await surveyStore.recipients(req.identity.userId, req.params.id);
    const recipients = await Promise.all(assignments.map(async assignment => {
      const user = await users.getUser(assignment.userId);
      return { email: user?.emails[0] || 'Unavailable account', source: assignment.source, accessRole: assignment.accessRole, joinedAt: assignment.joinedAt, isCurrentUser: assignment.userId === req.identity.userId };
    }));
    const owner = await users.getUser(survey.ownerUserId);
    res.json({ ownerEmail: owner?.emails[0] || 'Unavailable account', currentAccessRole: survey.accessRole, recipients });
  });
  app.patch('/api/surveys/:id/recipients', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const email = normalizeAccountEmail(req.body.email);
    const accessRole = normalizeSurveyAccessRole(req.body.accessRole);
    const matches = await users.listUsersByAccountInfo(TENANT, { email });
    if (matches.length === 0) return res.status(404).json({ message: 'No registered user was found for this email address.' });
    if (matches.length > 1) return res.status(409).json({ message: 'More than one account uses this email address.' });
    if (matches[0].id === req.identity.userId) return res.status(400).json({ message: 'A Co-owner cannot change their own access.' });
    const changed = await surveyStore.changeAccess(req.identity.userId, req.params.id, matches[0].id, accessRole);
    if (!changed) return res.status(404).json({ message: 'Survey access record not found.' });
    res.json({ email, accessRole });
  });
  app.delete('/api/surveys/:id/recipients', requirePermission('admin:access'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey project not found.' });
    const email = normalizeAccountEmail(req.body.email);
    const matches = await users.listUsersByAccountInfo(TENANT, { email });
    if (matches.length === 0) return res.status(404).json({ message: 'No registered user was found for this email address.' });
    if (matches.length > 1) return res.status(409).json({ message: 'More than one account uses this email address.' });
    const survey = await surveyStore.get(req.identity.userId, req.params.id);
    if (!survey) return res.status(404).json({ message: 'Survey project not found.' });
    const removed = await surveyStore.revoke(req.identity.userId, req.params.id, matches[0].id);
    if (!removed) return res.status(404).json({ message: 'This user does not currently have access to the survey.' });
    res.status(204).end();
  });
  app.get('/api/inbox', requirePermission('account:read'), async (req, res) => {
    const assignments = await surveyStore.inbox(req.identity.userId);
    const surveys = await Promise.all(assignments.map(async assignment => {
      const sender = await users.getUser(assignment.senderUserId);
      const { senderUserId: _senderUserId, ...survey } = assignment;
      return { ...survey, senderEmail: sender?.emails[0] || 'Unavailable account' };
    }));
    res.json({ surveys });
  });
  app.post('/api/inbox/join', requirePermission('account:read'), joinLimiter, async (req, res) => {
    const code = normalizeJoinCode(req.body.code);
    const result = await surveyStore.join(req.identity.userId, code);
    if (!result) return res.status(404).json({ message: 'No survey was found for this code.' });
    res.status(result.added ? 201 : 200).json(result);
  });
  app.get('/api/inbox/:id', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    const received = await surveyStore.getReceived(req.identity.userId, req.params.id);
    if (!received) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    const sender = await users.getUser(received.senderUserId);
    const { senderUserId: _senderUserId, ...survey } = received;
    res.json({ survey: { ...survey, senderEmail: sender?.emails[0] || 'Unavailable account' } });
  });
  app.post('/api/inbox/:id/responses', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    const { ratings, rankings } = req.body ?? {};
    if (ratings !== undefined && rankings !== undefined) {
      return res.status(400).json({ message: 'Submit a single answer format.' });
    }
    const isRanking = rankings !== undefined;
    const answers = isRanking ? normalizeRankings(rankings) : normalizeRatings(ratings);
    const result = await surveyStore.submit(req.identity.userId, req.params.id, answers, isRanking ? 'ranking' : 'rating');
    if (!result) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    res.json({ submittedAt: result.submittedAt });
  });
  app.delete('/api/inbox/:id', requirePermission('account:read'), async (req, res) => {
    if (!isSurveyId(req.params.id)) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    const removed = await surveyStore.leave(req.identity.userId, req.params.id);
    if (!removed) return res.status(404).json({ message: 'Survey not found in your inbox.' });
    res.status(204).end();
  });
  app.use((_req, res) => res.status(404).json({ message: 'Endpoint not found.' }));
  app.use(authErrorHandler);
  app.use((error, _req, res, _next) => {
    const validationError = error.name === 'MulterError' || [
      'Upload a CSV, Excel (.xlsx), or Word (.docx) file.',
      'The CSV file could not be parsed.',
      'The Excel file could not be parsed.',
      'The Word file could not be parsed.',
      'The Excel workbook must contain at least one worksheet.',
      'The Word file must begin with a standalone question heading.',
      'The question field does not contain any questions.',
      'Project name is required.',
      'Project name must be 160 characters or fewer.',
      'Enter a valid registered email address.',
      'Enter a valid 4-digit survey code.',
      'You already own this survey.',
      'Co-owners cannot join their managed survey as participants.',
      'Choose Participant or Co-owner access.',
      'Submit one rating from 1 to 5 for every question.',
      'Every answer must be a whole number from 1 to 5.',
      'Choose a valid survey answer mode.',
      'Submit a dimension ranking for every question.',
      'Rank between one and eight distinct wellness dimensions for each question.',
      'The response format does not match this survey.',
    ].includes(error.message) || /question header|column named question|questions?\.|characters or fewer/.test(error.message);
    const status = error.type === 'entity.parse.failed' || validationError ? 400 : error.status === 413 ? 413 : 503;
    console.error('Request failed:', error.name || 'Error');
    res.status(status).json({ message: validationError ? error.message : status === 400 ? 'Invalid request format.' : status === 413 ? 'Request body is too large.' : 'Service temporarily unavailable. Please try again later.' });
  });
  return app;
}
