import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import pg from 'pg';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_QUESTIONS = 500;
const MAX_QUESTION_LENGTH = 2000;

export const surveyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 2 },
  fileFilter: (_req, file, callback) => {
    const isCsv = path.extname(file.originalname).toLowerCase() === '.csv';
    callback(isCsv ? null : new Error('Only CSV files are accepted.'), isCsv);
  },
});

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
  if (rows.length < 2) throw new Error('The CSV must include a header and at least one question.');
  const headers = rows[0].map(value => String(value).trim().toLowerCase());
  const questionColumns = headers.reduce((matches, header, index) => header === 'question' ? [...matches, index] : matches, []);
  if (questionColumns.length !== 1) throw new Error('The CSV must contain exactly one column named question.');
  const questionIndex = questionColumns[0];
  const questions = rows.slice(1)
    .map(row => String(row[questionIndex] ?? '').trim())
    .filter(Boolean);
  if (questions.length === 0) throw new Error('The question column does not contain any questions.');
  if (questions.length > MAX_QUESTIONS) throw new Error(`A survey can contain at most ${MAX_QUESTIONS} questions.`);
  if (questions.some(question => question.length > MAX_QUESTION_LENGTH)) {
    throw new Error(`Each question must be ${MAX_QUESTION_LENGTH} characters or fewer.`);
  }
  return questions;
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

export function normalizeRatings(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error('Submit one rating from 1 to 5 for every question.');
  }
  if (value.some(rating => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('Every answer must be a whole number from 1 to 5.');
  }
  return value;
}

function csvCell(value) {
  const text = String(value ?? '');
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

export function buildAnonymousResponseCsv(questions, responses) {
  const header = ['question', ...responses.map((_response, index) => `Respondent ${String(index + 1).padStart(2, '0')}`)];
  const rows = questions.map((question, questionIndex) => [
    question.question,
    ...responses.map(response => response.ratings[questionIndex] ?? ''),
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
        CREATE INDEX IF NOT EXISTS app_survey_memberships_recipient_idx
          ON app_survey_memberships (recipient_user_id, joined_at DESC);
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let created;
        for (let attempt = 0; attempt < 50 && !created; attempt += 1) {
          const result = await client.query(
            `INSERT INTO app_surveys (id, owner_user_id, title, source_filename, join_code)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (join_code) DO NOTHING
             RETURNING id, title, source_filename AS "sourceFilename", join_code AS "joinCode", created_at AS "createdAt"`,
            [id, ownerUserId, title, filename, newJoinCode()],
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
        return { ...created.rows[0], questionCount: input.questions.length, responseCount: 0 };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async list(ownerUserId) {
      const result = await pool.query(
        `SELECT s.id, s.title, s.source_filename AS "sourceFilename", s.join_code AS "joinCode", s.created_at AS "createdAt",
                COUNT(DISTINCT q.id)::INTEGER AS "questionCount",
                COUNT(DISTINCT r.respondent_user_id)::INTEGER AS "responseCount"
         FROM app_surveys s
         LEFT JOIN app_survey_questions q ON q.survey_id = s.id
         LEFT JOIN app_survey_responses r ON r.survey_id = s.id
         WHERE s.owner_user_id = $1
         GROUP BY s.id
         ORDER BY s.created_at DESC`,
        [ownerUserId],
      );
      return result.rows;
    },
    async get(ownerUserId, id) {
      const survey = await pool.query(
        `SELECT s.id, s.title, s.source_filename AS "sourceFilename", s.join_code AS "joinCode", s.created_at AS "createdAt",
                (SELECT COUNT(*)::INTEGER FROM app_survey_responses r WHERE r.survey_id = s.id) AS "responseCount"
         FROM app_surveys s WHERE s.id = $1 AND s.owner_user_id = $2`,
        [id, ownerUserId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT position, question FROM app_survey_questions
         WHERE survey_id = $1 ORDER BY position`,
        [id],
      );
      return { ...survey.rows[0], questionCount: questions.rowCount, questions: questions.rows };
    },
    async assign(ownerUserId, surveyId, recipientUserId) {
      const result = await pool.query(
        `INSERT INTO app_survey_memberships (survey_id, recipient_user_id, source)
         SELECT id, $3, 'sent' FROM app_surveys WHERE id = $1 AND owner_user_id = $2
         ON CONFLICT (survey_id, recipient_user_id) DO NOTHING
         RETURNING survey_id`,
        [surveyId, ownerUserId, recipientUserId],
      );
      if (result.rowCount === 1) return { added: true };
      const exists = await pool.query(`SELECT 1 FROM app_surveys WHERE id = $1 AND owner_user_id = $2`, [surveyId, ownerUserId]);
      if (exists.rowCount === 0) return null;
      return { added: false };
    },
    async recipients(ownerUserId, surveyId) {
      const result = await pool.query(
        `SELECT m.recipient_user_id AS "userId", m.source, m.joined_at AS "joinedAt"
         FROM app_survey_memberships m
         JOIN app_surveys s ON s.id = m.survey_id
         WHERE m.survey_id = $1 AND s.owner_user_id = $2
         ORDER BY m.joined_at DESC`,
        [surveyId, ownerUserId],
      );
      return result.rows;
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
        `INSERT INTO app_survey_memberships (survey_id, recipient_user_id, source)
         SELECT id, $2, 'code' FROM app_surveys
         WHERE join_code = $1 AND owner_user_id <> $2
         ON CONFLICT (survey_id, recipient_user_id) DO NOTHING
         RETURNING survey_id AS "surveyId"`,
        [code, recipientUserId],
      );
      if (result.rowCount === 1) return { surveyId: result.rows[0].surveyId, added: true };
      const survey = await pool.query(`SELECT id, owner_user_id AS "ownerUserId" FROM app_surveys WHERE join_code = $1`, [code]);
      if (survey.rowCount === 0) return null;
      if (survey.rows[0].ownerUserId === recipientUserId) throw new Error('You already own this survey.');
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
         WHERE m.recipient_user_id = $1
         GROUP BY s.id, m.source, m.joined_at, r.submitted_at
         ORDER BY m.joined_at DESC`,
        [recipientUserId],
      );
      return result.rows;
    },
    async getReceived(recipientUserId, id) {
      const survey = await pool.query(
        `SELECT s.id, s.title, s.owner_user_id AS "senderUserId", m.source, m.joined_at AS "joinedAt"
         FROM app_survey_memberships m JOIN app_surveys s ON s.id = m.survey_id
         WHERE s.id = $1 AND m.recipient_user_id = $2`,
        [id, recipientUserId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT q.position, q.question, a.rating
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
        questions: questions.rows.map(({ rating: _rating, ...question }) => question),
        answers: questions.rows.filter(question => question.rating !== null).map(question => ({ position: question.position, rating: question.rating })),
        submittedAt: response.rows[0]?.submittedAt || null,
      };
    },
    async submit(recipientUserId, id, ratings) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const membership = await client.query(
          `SELECT 1 FROM app_survey_memberships WHERE survey_id = $1 AND recipient_user_id = $2 FOR UPDATE`,
          [id, recipientUserId],
        );
        if (membership.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        const questions = await client.query(
          `SELECT position FROM app_survey_questions WHERE survey_id = $1 ORDER BY position`,
          [id],
        );
        if (questions.rowCount !== ratings.length) throw new Error('Submit one rating from 1 to 5 for every question.');
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
            `INSERT INTO app_survey_answers (survey_id, respondent_user_id, position, rating)
             VALUES ($1, $2, $3, $4)`,
            [id, recipientUserId, questions.rows[index].position, ratings[index]],
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
    async exportResponses(ownerUserId, id) {
      const survey = await pool.query(
        `SELECT id, title FROM app_surveys WHERE id = $1 AND owner_user_id = $2`,
        [id, ownerUserId],
      );
      if (survey.rowCount === 0) return null;
      const questions = await pool.query(
        `SELECT position, question FROM app_survey_questions WHERE survey_id = $1 ORDER BY position`,
        [id],
      );
      const answers = await pool.query(
        `SELECT r.anonymous_key AS "anonymousKey", a.position, a.rating
         FROM app_survey_responses r
         JOIN app_survey_answers a
           ON a.survey_id = r.survey_id AND a.respondent_user_id = r.respondent_user_id
         WHERE r.survey_id = $1
         ORDER BY r.anonymous_key, a.position`,
        [id],
      );
      const grouped = new Map();
      for (const answer of answers.rows) {
        if (!grouped.has(answer.anonymousKey)) grouped.set(answer.anonymousKey, []);
        grouped.get(answer.anonymousKey).push(answer.rating);
      }
      return { survey: survey.rows[0], questions: questions.rows, responses: [...grouped.values()].map(ratings => ({ ratings })) };
    },
    async leave(recipientUserId, id) {
      const result = await pool.query(
        `DELETE FROM app_survey_memberships WHERE survey_id = $1 AND recipient_user_id = $2 RETURNING survey_id`,
        [id, recipientUserId],
      );
      return result.rowCount === 1;
    },
    async close() {
      await pool.end();
    },
  };
}
