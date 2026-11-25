import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import pg from 'pg';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_QUESTIONS = 500;
const MAX_QUESTION_LENGTH = 2000;

export const surveyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 2 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const supported = ['.csv', '.xlsx', '.docx'].includes(extension);
    callback(supported ? null : new Error('Upload a CSV, Excel (.xlsx), or Word (.docx) file.'), supported);
  },
});

function validateQuestions(questions) {
  const cleaned = questions.map(value => String(value ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) throw new Error('The question field does not contain any questions.');
  if (cleaned.length > MAX_QUESTIONS) throw new Error(`A survey can contain at most ${MAX_QUESTIONS} questions.`);
  if (cleaned.some(question => question.length > MAX_QUESTION_LENGTH)) {
    throw new Error(`Each question must be ${MAX_QUESTION_LENGTH} characters or fewer.`);
  }
  return cleaned;
}

function questionsFromRows(rows, fileType) {
  if (rows.length < 2) throw new Error(`The ${fileType} file must include a question header and at least one question.`);
  const headers = rows[0].map(value => String(value ?? '').trim().toLowerCase());
  const questionColumns = headers.reduce((matches, header, index) => header === 'question' ? [...matches, index] : matches, []);
  if (questionColumns.length !== 1) throw new Error(`The ${fileType} file must contain exactly one column named question.`);
  return validateQuestions(rows.slice(1).map(row => row[questionColumns[0]]));
}

export function parseSurveyCsv(buffer) {
  let rows;
  try {
    rows = parse(buffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch {
    throw new Error('The CSV file could not be parsed.');
  }
  return questionsFromRows(rows, 'CSV');
}

export function parseSurveyXlsx(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false });
  } catch {
    throw new Error('The Excel file could not be parsed.');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('The Excel workbook must contain at least one worksheet.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  return questionsFromRows(rows, 'Excel');
}

export async function parseSurveyDocx(buffer) {
  let text;
  try {
    ({ value: text } = await mammoth.extractRawText({ buffer }));
  } catch {
    throw new Error('The Word file could not be parsed.');
  }
  const paragraphs = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (paragraphs[0]?.toLowerCase() !== 'question') {
    throw new Error('The Word file must begin with a standalone question heading.');
  }
  return validateQuestions(paragraphs.slice(1));
}

export async function parseSurveyFile(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv') return parseSurveyCsv(file.buffer);
  if (extension === '.xlsx') return parseSurveyXlsx(file.buffer);
  if (extension === '.docx') return parseSurveyDocx(file.buffer);
  throw new Error('Upload a CSV, Excel (.xlsx), or Word (.docx) file.');
}

function cleanTitle(value) {
  const title = String(value || '').trim();
  if (!title) throw new Error('Project name is required.');
  if (title.length > 160) throw new Error('Project name must be 160 characters or fewer.');
  return title;
}

function cleanFilename(value) {
  return path.basename(String(value || 'survey.csv')).slice(0, 255);
}

export function isSurveyId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function normalizeJoinCode(value) {
  const code = String(value || '').trim();
  if (!/^\d{4}$/.test(code)) throw new Error('Enter a valid 4-digit survey code.');
  return code;
}

export function normalizeAccountEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid registered email address.');
  return email;
}

export function normalizeSurveyAccessRole(value) {
  if (!['participant', 'co_owner'].includes(value)) throw new Error('Choose Participant or Co-owner access.');
  return value;
}

export function normalizeRatings(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error('Submit one rating from 1 to 5 for every question.');
  }
  if (value.some(rating => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('Every answer must be a whole number from 1 to 5.');
  }
  return value;
}

export const WELLNESS_DIMENSIONS = Object.freeze([
  'Emotional', 'Environmental', 'Financial', 'Intellectual',
  'Occupational', 'Physical', 'Social', 'Spiritual',
]);

export function normalizeAnswerMode(value = 'rating') {
  if (value !== 'rating' && value !== 'ranking') throw new Error('Choose a valid survey answer mode.');
  return value;
}

export function normalizeRankings(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error('Submit a dimension ranking for every question.');
  }
  for (const ranking of value) {
    if (!Array.isArray(ranking) || ranking.length === 0 || ranking.length > WELLNESS_DIMENSIONS.length ||
        new Set(ranking).size !== ranking.length || ranking.some(dimension => !WELLNESS_DIMENSIONS.includes(dimension))) {
      throw new Error('Rank between one and eight distinct wellness dimensions for each question.');
    }
  }
  return value;
}

function csvCell(value) {
  const text = String(value ?? '');
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

export function buildAnonymousResponseCsv(questions, responses, answerMode = 'rating') {
  const header = ['question', ...responses.map((_response, index) => `Respondent ${String(index + 1).padStart(2, '0')}`)];
  const rows = questions.map((question, questionIndex) => [
    question.question,
    ...responses.map(response => answerMode === 'ranking'
      ? (response.rankings[questionIndex] ?? []).join(', ')
      : response.ratings[questionIndex] ?? ''),
  ]);
  return `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function newJoinCode() {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

export function createSurveyStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_surveys (
          id UUID PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          title VARCHAR(160) NOT NULL,
          source_filename VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE app_surveys ADD COLUMN IF NOT EXISTS join_code CHAR(4);
        ALTER TABLE app_surveys ADD COLUMN IF NOT EXISTS answer_mode TEXT NOT NULL DEFAULT 'rating'
          CHECK (answer_mode IN ('rating', 'ranking'));
        CREATE UNIQUE INDEX IF NOT EXISTS app_surveys_join_code_uq ON app_surveys (join_code);
        CREATE INDEX IF NOT EXISTS app_surveys_owner_created_idx
          ON app_surveys (owner_user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS app_survey_questions (
          id BIGSERIAL PRIMARY KEY,
          survey_id UUID NOT NULL REFERENCES app_surveys(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          question TEXT NOT NULL,
          UNIQUE (survey_id, position)
        );
        CREATE TABLE IF NOT EXISTS app_survey_memberships (
          survey_id UUID NOT NULL REFERENCES app_surveys(id) ON DELETE CASCADE,
          recipient_user_id TEXT NOT NULL,
          source VARCHAR(10) NOT NULL CHECK (source IN ('sent', 'code')),
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (survey_id, recipient_user_id)
        );
        ALTER TABLE app_survey_memberships
          ADD COLUMN IF NOT EXISTS access_role VARCHAR(20) NOT NULL DEFAULT 'participant';
        DO $migration$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_survey_memberships_access_role_check') THEN
            ALTER TABLE app_survey_memberships
              ADD CONSTRAINT app_survey_memberships_access_role_check
              CHECK (access_role IN ('participant', 'co_owner'));
          END IF;
        END $migration$;
        CREATE INDEX IF NOT EXISTS app_survey_memberships_recipient_idx
          ON app_survey_memberships (recipient_user_id, joined_at DESC);
        CREATE INDEX IF NOT EXISTS app_survey_memberships_manager_idx
          ON app_survey_memberships (recipient_user_id, access_role);
        CREATE TABLE IF NOT EXISTS app_survey_responses (
          survey_id UUID NOT NULL,
          respondent_user_id TEXT NOT NULL,
          anonymous_key UUID NOT NULL,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (survey_id, respondent_user_id),
          UNIQUE (survey_id, anonymous_key),
          FOREIGN KEY (survey_id, respondent_user_id)
            REFERENCES app_survey_memberships(survey_id, recipient_user_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS app_survey_answers (
          survey_id UUID NOT NULL,
          respondent_user_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
          PRIMARY KEY (survey_id, respondent_user_id, position),
          FOREIGN KEY (survey_id, respondent_user_id)
            REFERENCES app_survey_responses(survey_id, respondent_user_id) ON DELETE CASCADE,
          FOREIGN KEY (survey_id, position)
            REFERENCES app_survey_questions(survey_id, position) ON DELETE CASCADE
        );
        ALTER TABLE app_survey_answers ADD COLUMN IF NOT EXISTS ranking TEXT[];
        ALTER TABLE app_survey_answers ALTER COLUMN rating DROP NOT NULL;
        DO $migration$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app_survey_answers'::regclass
                         AND conname = 'app_survey_answer_value_check') THEN
            ALTER TABLE app_survey_answers ADD CONSTRAINT app_survey_answer_value_check CHECK (
              (rating IS NOT NULL AND ranking IS NULL) OR
              (rating IS NULL AND ranking IS NOT NULL AND cardinality(ranking) BETWEEN 1 AND 8)
            );
          END IF;
        END $migration$;
      `);
      const missingCodes = await pool.query(`SELECT id FROM app_surveys WHERE join_code IS NULL ORDER BY created_at`);
      for (const survey of missingCodes.rows) {
        let assigned = false;
        for (let attempt = 0; attempt < 50 && !assigned; attempt += 1) {
          const result = await pool.query(
            `UPDATE app_surveys SET join_code = $1
             WHERE id = $2 AND join_code IS NULL
               AND NOT EXISTS (SELECT 1 FROM app_surveys WHERE join_code = $1)
             RETURNING id`,
            [newJoinCode(), survey.id],
          );
          assigned = result.rowCount === 1;
        }
        if (!assigned) throw new Error('Unable to assign survey join codes.');
      }
    },
    async create(ownerUserId, input) {
      const id = randomUUID();
      const title = cleanTitle(input.title);
      const filename = cleanFilename(input.filename);
      const answerMode = normalizeAnswerMode(input.answerMode);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let created;
        for (let attempt = 0; attempt < 50 && !created; attempt += 1) {
          const result = await client.query(
            `INSERT INTO app_surveys (id, owner_user_id, title, source_filename, join_code, answer_mode)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (join_code) DO NOTHING
             RETURNING id, title, source_filename AS "sourceFilename", join_code AS "joinCode", created_at AS "createdAt"`,
            [id, ownerUserId, title, filename, newJoinCode(), answerMode],
          );
          if (result.rowCount === 1) created = result;
        }
        if (!created) throw new Error('Unable to generate a unique survey code.');
        for (let index = 0; index < input.questions.length; index += 1) {
          await client.query(
            `INSERT INTO app_survey_questions (survey_id, position, question) VALUES ($1, $2, $3)`,
            [id, index + 1, input.questions[index]],
          );
        }
        await client.query('COMMIT');
        return { ...created.rows[0], answerMode, questionCount: input.questions.length, responseCount: 0, accessRole: 'owner' };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async hasManagedSurveys(userId) {
      const result = await pool.query(
        `SELECT 1 FROM app_surveys s
         LEFT JOIN app_survey_memberships m
           ON m.survey_id = s.id AND m.recipient_user_id = $1 AND m.access_role = 'co_owner'
         WHERE s.owner_user_id = $1 OR m.recipient_user_id IS NOT NULL LIMIT 1`,
        [userId],
      );
      return result.rowCount === 1;
    },
    async list(userId) {
      const result = await pool.query(
        `SELECT s.id, s.title, s.source_filename AS "sourceFilename", s.join_code AS "joinCode", s.created_at AS "createdAt",
                COUNT(DISTINCT q.id)::INTEGER AS "questionCount",
                COUNT(DISTINCT r.respondent_user_id)::INTEGER AS "responseCount",
                CASE WHEN s.owner_user_id = $1 THEN 'owner' ELSE 'co_owner' END AS "accessRole"
         FROM app_surveys s
         LEFT JOIN app_survey_memberships manager
           ON manager.survey_id = s.id AND manager.recipient_user_id = $1 AND manager.access_role = 'co_owner'
         LEFT JOIN app_survey_questions q ON q.survey_id = s.id
         LEFT JOIN app_survey_responses r ON r.survey_id = s.id
         WHERE s.owner_user_id = $1 OR manager.recipient_user_id IS NOT NULL
         GROUP BY s.id, manager.access_role
         ORDER BY s.created_at DESC`,
        [userId],
      );
      return result.rows;
    },
    async get(userId, id) {
      const survey = await pool.query(
        `SELECT s.id, s.owner_user_id AS "ownerUserId", s.title, s.source_filename AS "sourceFilename",
                s.join_code AS "joinCode", s.created_at AS "createdAt", s.answer_mode AS "answerMode",
                (SELECT COUNT(*)::INTEGER FROM app_survey_responses r WHERE r.survey_id = s.id) AS "responseCount",
                CASE WHEN s.owner_user_id = $2 THEN 'owner' ELSE 'co_owner' END AS "accessRole"
         FROM app_surveys s
         LEFT JOIN app_survey_memberships m
           ON m.survey_id = s.id AND m.recipient_user_id = $2 AND m.access_role = 'co_owner'
         WHERE s.id = $1 AND (s.owner_user_id = $2 OR m.recipient_user_id IS NOT NULL)`,
        [id, userId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT position, question FROM app_survey_questions
         WHERE survey_id = $1 ORDER BY position`,
        [id],
      );
      return { ...survey.rows[0], questionCount: questions.rowCount, questions: questions.rows };
    },
    async assign(managerUserId, surveyId, recipientUserId, accessRole) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const survey = await client.query(
          `SELECT s.owner_user_id AS "ownerUserId" FROM app_surveys s
           LEFT JOIN app_survey_memberships m
             ON m.survey_id = s.id AND m.recipient_user_id = $2 AND m.access_role = 'co_owner'
           WHERE s.id = $1 AND (s.owner_user_id = $2 OR m.recipient_user_id IS NOT NULL)
           FOR UPDATE OF s`,
          [surveyId, managerUserId],
        );
        if (survey.rowCount === 0) { await client.query('ROLLBACK'); return null; }
        if (survey.rows[0].ownerUserId === recipientUserId) { await client.query('ROLLBACK'); return { owner: true }; }
        const existing = await client.query(
          `SELECT access_role AS "accessRole" FROM app_survey_memberships
           WHERE survey_id = $1 AND recipient_user_id = $2 FOR UPDATE`,
          [surveyId, recipientUserId],
        );
        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO app_survey_memberships (survey_id, recipient_user_id, source, access_role)
             VALUES ($1, $2, 'sent', $3)`,
            [surveyId, recipientUserId, accessRole],
          );
          await client.query('COMMIT');
          return { added: true, updated: false, accessRole };
        }
        if (existing.rows[0].accessRole === accessRole) {
          await client.query('COMMIT');
          return { added: false, updated: false, accessRole };
        }
        await client.query(
          `UPDATE app_survey_memberships SET access_role = $3
           WHERE survey_id = $1 AND recipient_user_id = $2`,
          [surveyId, recipientUserId, accessRole],
        );
        if (accessRole === 'co_owner') {
          await client.query(
            `DELETE FROM app_survey_responses WHERE survey_id = $1 AND respondent_user_id = $2`,
            [surveyId, recipientUserId],
          );
        }
        await client.query('COMMIT');
        return { added: false, updated: true, accessRole };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async recipients(managerUserId, surveyId) {
      const result = await pool.query(
        `SELECT m.recipient_user_id AS "userId", m.source, m.access_role AS "accessRole", m.joined_at AS "joinedAt"
         FROM app_survey_memberships m
         JOIN app_surveys s ON s.id = m.survey_id
         LEFT JOIN app_survey_memberships manager
           ON manager.survey_id = s.id AND manager.recipient_user_id = $2 AND manager.access_role = 'co_owner'
         WHERE m.survey_id = $1 AND (s.owner_user_id = $2 OR manager.recipient_user_id IS NOT NULL)
         ORDER BY m.joined_at DESC`,
        [surveyId, managerUserId],
      );
      return result.rows;
    },
    async changeAccess(managerUserId, surveyId, recipientUserId, accessRole) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE app_survey_memberships target SET access_role = $4
           FROM app_surveys s
           LEFT JOIN app_survey_memberships manager
             ON manager.survey_id = s.id AND manager.recipient_user_id = $2 AND manager.access_role = 'co_owner'
           WHERE target.survey_id = $1 AND target.recipient_user_id = $3
             AND target.recipient_user_id <> $2
             AND s.id = target.survey_id AND (s.owner_user_id = $2 OR manager.recipient_user_id IS NOT NULL)
           RETURNING target.survey_id`,
          [surveyId, managerUserId, recipientUserId, accessRole],
        );
        if (result.rowCount === 0) { await client.query('ROLLBACK'); return false; }
        if (accessRole === 'co_owner') {
          await client.query(
            `DELETE FROM app_survey_responses WHERE survey_id = $1 AND respondent_user_id = $2`,
            [surveyId, recipientUserId],
          );
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async revoke(ownerUserId, surveyId, recipientUserId) {
      const result = await pool.query(
        `DELETE FROM app_survey_memberships m
         USING app_surveys s
         WHERE m.survey_id = $1 AND m.recipient_user_id = $3
           AND s.id = m.survey_id AND s.owner_user_id = $2
         RETURNING m.survey_id`,
        [surveyId, ownerUserId, recipientUserId],
      );
      return result.rowCount === 1;
    },
    async delete(ownerUserId, id) {
      const result = await pool.query(
        `DELETE FROM app_surveys WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
        [id, ownerUserId],
      );
      return result.rowCount === 1;
    },
    async join(recipientUserId, code) {
      const result = await pool.query(
        `INSERT INTO app_survey_memberships (survey_id, recipient_user_id, source, access_role)
         SELECT id, $2, 'code', 'participant' FROM app_surveys
         WHERE join_code = $1 AND owner_user_id <> $2
         ON CONFLICT (survey_id, recipient_user_id) DO NOTHING
         RETURNING survey_id AS "surveyId"`,
        [code, recipientUserId],
      );
      if (result.rowCount === 1) return { surveyId: result.rows[0].surveyId, added: true };
      const survey = await pool.query(
        `SELECT s.id, s.owner_user_id AS "ownerUserId", m.access_role AS "accessRole"
         FROM app_surveys s LEFT JOIN app_survey_memberships m
           ON m.survey_id = s.id AND m.recipient_user_id = $2
         WHERE s.join_code = $1`,
        [code, recipientUserId],
      );
      if (survey.rowCount === 0) return null;
      if (survey.rows[0].ownerUserId === recipientUserId) throw new Error('You already own this survey.');
      if (survey.rows[0].accessRole === 'co_owner') throw new Error('Co-owners cannot join their managed survey as participants.');
      return { surveyId: survey.rows[0].id, added: false };
    },
    async inbox(recipientUserId) {
      const result = await pool.query(
        `SELECT s.id, s.title, s.owner_user_id AS "senderUserId", m.source, m.joined_at AS "joinedAt",
                r.submitted_at AS "submittedAt",
                COUNT(q.id)::INTEGER AS "questionCount"
         FROM app_survey_memberships m
         JOIN app_surveys s ON s.id = m.survey_id
         LEFT JOIN app_survey_questions q ON q.survey_id = s.id
         LEFT JOIN app_survey_responses r
           ON r.survey_id = s.id AND r.respondent_user_id = m.recipient_user_id
         WHERE m.recipient_user_id = $1 AND m.access_role = 'participant'
         GROUP BY s.id, m.source, m.joined_at, r.submitted_at
         ORDER BY m.joined_at DESC`,
        [recipientUserId],
      );
      return result.rows;
    },
    async getReceived(recipientUserId, id) {
      const survey = await pool.query(
        `SELECT s.id, s.title, s.answer_mode AS "answerMode", s.owner_user_id AS "senderUserId", m.source, m.joined_at AS "joinedAt"
         FROM app_survey_memberships m JOIN app_surveys s ON s.id = m.survey_id
         WHERE s.id = $1 AND m.recipient_user_id = $2 AND m.access_role = 'participant'`,
        [id, recipientUserId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT q.position, q.question, a.rating, a.ranking
         FROM app_survey_questions q
         LEFT JOIN app_survey_answers a
           ON a.survey_id = q.survey_id AND a.position = q.position AND a.respondent_user_id = $2
         WHERE q.survey_id = $1 ORDER BY q.position`,
        [id, recipientUserId],
      );
      const response = await pool.query(
        `SELECT submitted_at AS "submittedAt" FROM app_survey_responses
         WHERE survey_id = $1 AND respondent_user_id = $2`,
        [id, recipientUserId],
      );
      return {
        ...survey.rows[0],
        questionCount: questions.rowCount,
        questions: questions.rows.map(({ position, question }) => ({ position, question })),
        answers: survey.rows[0].answerMode === 'ranking'
          ? questions.rows.filter(({ ranking }) => ranking !== null).map(({ position, ranking }) => ({ position, ranking }))
          : questions.rows.filter(({ rating }) => rating !== null).map(({ position, rating }) => ({ position, rating })),
        submittedAt: response.rows[0]?.submittedAt || null,
      };
    },
    async submit(recipientUserId, id, answers, answerMode = 'rating') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const membership = await client.query(
          `SELECT s.answer_mode AS "answerMode"
           FROM app_survey_memberships m JOIN app_surveys s ON s.id = m.survey_id
           WHERE m.survey_id = $1 AND m.recipient_user_id = $2 AND m.access_role = 'participant' FOR UPDATE OF m`,
          [id, recipientUserId],
        );
        if (membership.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        if (membership.rows[0].answerMode !== answerMode) throw new Error('The response format does not match this survey.');
        const isRanking = answerMode === 'ranking';
        const questions = await client.query(
          `SELECT position FROM app_survey_questions WHERE survey_id = $1 ORDER BY position`,
          [id],
        );
        if (questions.rowCount !== answers.length) {
          throw new Error(isRanking ? 'Submit a dimension ranking for every question.' : 'Submit one rating from 1 to 5 for every question.');
        }
        const response = await client.query(
          `INSERT INTO app_survey_responses (survey_id, respondent_user_id, anonymous_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (survey_id, respondent_user_id)
           DO UPDATE SET submitted_at = NOW()
           RETURNING submitted_at AS "submittedAt"`,
          [id, recipientUserId, randomUUID()],
        );
        await client.query(
          `DELETE FROM app_survey_answers WHERE survey_id = $1 AND respondent_user_id = $2`,
          [id, recipientUserId],
        );
        for (let index = 0; index < questions.rows.length; index += 1) {
          await client.query(
            `INSERT INTO app_survey_answers (survey_id, respondent_user_id, position, rating, ranking)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, recipientUserId, questions.rows[index].position, isRanking ? null : answers[index], isRanking ? answers[index] : null],
          );
        }
        await client.query('COMMIT');
        return { submittedAt: response.rows[0].submittedAt };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async exportResponses(managerUserId, id) {
      const survey = await pool.query(
        `SELECT s.id, s.title, s.answer_mode AS "answerMode" FROM app_surveys s
         LEFT JOIN app_survey_memberships m
           ON m.survey_id = s.id AND m.recipient_user_id = $2 AND m.access_role = 'co_owner'
         WHERE s.id = $1 AND (s.owner_user_id = $2 OR m.recipient_user_id IS NOT NULL)`,
        [id, managerUserId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT position, question FROM app_survey_questions WHERE survey_id = $1 ORDER BY position`,
        [id],
      );
      const answers = await pool.query(
        `SELECT r.anonymous_key AS "anonymousKey", a.position, a.rating, a.ranking
         FROM app_survey_responses r
         JOIN app_survey_answers a
           ON a.survey_id = r.survey_id AND a.respondent_user_id = r.respondent_user_id
         WHERE r.survey_id = $1
         ORDER BY r.anonymous_key, a.position`,
        [id],
      );
      const isRanking = survey.rows[0].answerMode === 'ranking';
      const grouped = new Map();
      for (const answer of answers.rows) {
        if (!grouped.has(answer.anonymousKey)) grouped.set(answer.anonymousKey, []);
        grouped.get(answer.anonymousKey).push(isRanking ? answer.ranking : answer.rating);
      }
      const responses = [...grouped.values()].map(answers => isRanking ? { rankings: answers } : { ratings: answers });
      return { survey: survey.rows[0], questions: questions.rows, responses };
    },
    async leave(recipientUserId, id) {
      const result = await pool.query(
        `DELETE FROM app_survey_memberships
         WHERE survey_id = $1 AND recipient_user_id = $2 AND access_role = 'participant' RETURNING survey_id`,
        [id, recipientUserId],
      );
      return result.rowCount === 1;
    },
    async close() {
      await pool.end();
    },
  };
}
