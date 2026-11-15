import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnonymousResponseCsv, isSurveyId, normalizeAccountEmail, normalizeJoinCode, normalizeRatings, parseSurveyCsv } from '../src/surveys.js';

test('CSV parser reads only the question column and preserves row order', () => {
  const csv = Buffer.from('category,question,score\nProduct,"How easy was setup, overall?",5\nSupport,How was support?,4\n');
  assert.deepEqual(parseSurveyCsv(csv), ['How easy was setup, overall?', 'How was support?']);
});

test('CSV parser accepts a BOM, mixed-case header, quoted newlines, and ignores blank questions', () => {
  const csv = Buffer.from('\uFEFFQuestion,ignored\n"First line\nsecond line",x\n   ,y\nFinal question,z\n');
  assert.deepEqual(parseSurveyCsv(csv), ['First line\nsecond line', 'Final question']);
});

test('CSV parser rejects missing, duplicate, empty, and oversized question columns', () => {
  assert.throws(() => parseSurveyCsv(Buffer.from('name\nExample\n')), /exactly one/);
  assert.throws(() => parseSurveyCsv(Buffer.from('question,Question\nOne,Two\n')), /exactly one/);
  assert.throws(() => parseSurveyCsv(Buffer.from('question\n   \n')), /does not contain any questions/);
  assert.throws(() => parseSurveyCsv(Buffer.from(`question\n${'x'.repeat(2001)}\n`)), /2000 characters/);
});

test('survey IDs accept only version 4 UUIDs', () => {
  assert.equal(isSurveyId('9ed57470-3c62-4a43-89d0-b6ad9da8af18'), true);
  assert.equal(isSurveyId('9ed57470-3c62-1a43-89d0-b6ad9da8af18'), false);
  assert.equal(isSurveyId('../admin'), false);
});

test('join codes and recipient emails are normalized and validated', () => {
  assert.equal(normalizeJoinCode(' 0042 '), '0042');
  assert.throws(() => normalizeJoinCode('42'), /4-digit/);
  assert.throws(() => normalizeJoinCode('abcd'), /4-digit/);
  assert.equal(normalizeAccountEmail(' Member@Example.COM '), 'member@example.com');
  assert.throws(() => normalizeAccountEmail('not-an-email'), /valid registered email/);
});

test('ratings require one whole-number score from 1 to 5 for each answer', () => {
  assert.deepEqual(normalizeRatings([1, 3, 5]), [1, 3, 5]);
  assert.throws(() => normalizeRatings([]), /every question/);
  assert.throws(() => normalizeRatings([0, 3]), /whole number/);
  assert.throws(() => normalizeRatings([2.5]), /whole number/);
  assert.throws(() => normalizeRatings('5'), /every question/);
});

test('anonymous CSV contains original questions and numbered respondents without identity data', () => {
  const csv = buildAnonymousResponseCsv(
    [{ question: 'First question' }, { question: 'Quoted, question' }],
    [{ ratings: [5, 2] }, { ratings: [1, 4] }],
  );
  assert.match(csv, /"question","Respondent 01","Respondent 02"/);
  assert.match(csv, /"First question","5","1"/);
  assert.match(csv, /"Quoted, question","2","4"/);
  assert.doesNotMatch(csv, /@|user[_-]?id/i);
});
