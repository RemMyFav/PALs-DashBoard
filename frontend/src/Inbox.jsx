import React, { useEffect, useState } from 'react';
import { apiRequest, getJson } from './auth';

const WELLNESS_DIMENSIONS = [
  'Emotional', 'Environmental', 'Financial', 'Intellectual',
  'Occupational', 'Physical', 'Social', 'Spiritual',
];

function formatDate(value) {
  return new Date(value).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function InboxDetail({ id, navigate, onExpired }) {
  const [survey, setSurvey] = useState(null);
  const [ratings, setRatings] = useState({});
  const [rankings, setRankings] = useState({});
  const isRanking = survey?.answerMode === 'ranking';
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [missingPosition, setMissingPosition] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getJson(`/api/inbox/${id}`).then(result => {
      if (active) {
        setSurvey(result.survey);
        const answers = result.survey.answers ?? [];
        if (result.survey.answerMode === 'ranking') {
          setRankings(Object.fromEntries(answers.map(({ position, ranking }) => [position, ranking])));
        } else {
          setRatings(Object.fromEntries(answers.map(({ position, rating }) => [position, rating])));
        }
      }
    }).catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    });
    return () => { active = false; };
  }, [id]);
  async function deleteSurvey() {
    if (!window.confirm("Delete this survey from your Inbox? Your submitted responses will also be deleted. The administrator's original survey will not be affected.")) return;
    setDeleting(true);
    setError('');
    try {
      await apiRequest(`/api/inbox/${id}`, { method: 'DELETE' });
      navigate('/inbox');
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
      setDeleting(false);
    }
  }
  function toggleDimension(position, dimension) {
    setRankings(current => {
      const ranking = current[position] ?? [];
      const updated = ranking.includes(dimension) ? ranking.filter(value => value !== dimension) : [...ranking, dimension];
      return { ...current, [position]: updated };
    });
    if (missingPosition === position) setMissingPosition(null);
  }

  async function submitResponses(event) {
    event.preventDefault();
    if (saving || !survey) return;
    const unanswered = survey.questions.find(({ position }) => isRanking
      ? !rankings[position]?.length
      : !Number.isInteger(ratings[position]));
    if (unanswered) {
      setError('');
      setMissingPosition(unanswered.position);
      window.requestAnimationFrame(() => {
        const question = document.getElementById(`response-question-${unanswered.position}`);
        question?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        question?.querySelector(isRanking ? '.dimension-option' : 'input[type="radio"]')?.focus({ preventScroll: true });
      });
      return;
    }
    setSaving(true);
    setMissingPosition(null);
    setError('');
    try {
      await apiRequest(`/api/inbox/${id}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isRanking
          ? { rankings: survey.questions.map(({ position }) => rankings[position]) }
          : { ratings: survey.questions.map(({ position }) => ratings[position]) }),
      });
      navigate('/inbox', false, { responseSubmitted: true });
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setSaving(false);
    }
  }
  return <section>
    <button className="back-button" type="button" onClick={() => navigate('/inbox')}>← Inbox</button>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!survey && !error && <div className="card" role="status">Loading survey…</div>}
    {survey && <>
      <div className="survey-title-row"><div><span className="eyebrow">ASSIGNED QUESTIONNAIRE</span><h2>{survey.title}</h2><p className="muted">Assigned by {survey.senderEmail} · Received {formatDate(survey.joinedAt)}</p></div><div className="detail-actions"><span className="role-badge">{isRanking ? 'Dimension ranking' : '1–5 response scale'}</span><button className="danger-button" type="button" disabled={deleting} onClick={deleteSurvey}>{deleting ? 'Deleting…' : 'Delete survey'}</button></div></div>
      <form className="response-form" onSubmit={submitResponses}>
        {isRanking && <p className="muted">Select the dimensions that fit each question, starting with the closest match. Select a dimension again to remove it. Unselected dimensions are left out.</p>}
        <ol className="question-list response-list">
          {survey.questions.map(item => {
            const { position } = item;
            const missing = missingPosition === position;
            const ranking = rankings[position] ?? [];
            return <li id={`response-question-${position}`} className={missing ? 'missing-question' : ''} key={position}>
              <span className="question-number">{String(position).padStart(2, '0')}</span>
              <div className="response-question">
                <p>{item.question}</p>
                <fieldset aria-invalid={missing} aria-describedby={missing ? `missing-answer-${position}` : undefined}>
                  <legend className="visually-hidden">{isRanking ? 'Dimension ranking' : 'Rating'} for question {position}</legend>
                  {isRanking ? <div className="dimension-options">
                    {WELLNESS_DIMENSIONS.map(dimension => {
                      const rank = ranking.indexOf(dimension) + 1;
                      return <button key={dimension} type="button" className="dimension-option" aria-pressed={rank > 0}
                        onClick={() => toggleDimension(position, dimension)}>
                        {dimension}{rank > 0 && <span className="dimension-rank">Rank {rank}</span>}
                      </button>;
                    })}
                  </div> : <div className="rating-scale">
                    {[1, 2, 3, 4, 5].map(value => <label className="rating-option" key={value}>
                      <input type="radio" name={`question-${position}`} value={value} checked={ratings[position] === value}
                        onChange={() => {
                          setRatings(current => ({ ...current, [position]: value }));
                          if (missing) setMissingPosition(null);
                        }} />
                      <span>{value}</span>
                    </label>)}
                  </div>}
                  {missing && <p id={`missing-answer-${position}`} className="missing-answer" role="alert">
                    {isRanking ? 'Select at least one dimension before submitting.' : 'Choose a rating from 1 to 5 before submitting.'}
                  </p>}
                </fieldset>
              </div>
            </li>;
          })}
        </ol>
        <div className="response-actions"><p>{survey.submittedAt ? `Last submitted ${formatDate(survey.submittedAt)}.` : 'Please answer every question as thoughtfully as you can.'} Your email and account ID are not included in the administrator's CSV export.</p><button className="primary" type="submit" disabled={saving}>{saving ? 'Submitting…' : survey.submittedAt ? 'Update responses' : 'Submit responses'}</button></div>
      </form>
    </>}
  </section>;
}

function InboxList({ navigate, onExpired }) {
  const [surveys, setSurveys] = useState([]);
  const [showThanks] = useState(() => window.history.state?.responseSubmitted === true);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const result = await getJson('/api/inbox');
    setSurveys(result.surveys);
  }
  useEffect(() => {
    let active = true;
    if (showThanks) window.history.replaceState({}, '', window.location.pathname);
    load().catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function join(event) {
    event.preventDefault();
    if (joining) return;
    setJoining(true);
    setError('');
    try {
      const result = await apiRequest('/api/inbox/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      navigate(`/inbox/${result.surveyId}`);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setJoining(false);
    }
  }

  return <section>
    {showThanks && <div className="thank-you-banner" role="status"><span aria-hidden="true">✓</span><div><strong>Thank you for your response.</strong><p>Your answers have been recorded. Every thoughtful response helps create clearer, more meaningful measurement.</p></div></div>}
    <div className="inbox-heading"><div><span className="eyebrow">INBOX · SURVEYS TO COMPLETE</span><h2 className="section-title">Surveys assigned to you by someone else</h2><p className="muted">Inbox is for questionnaires you have been asked to answer. Surveys you own or co-manage are listed separately under Manage surveys.</p></div><form className="join-form" onSubmit={join}><label htmlFor="join-code">Join with a survey code</label><div className="inline-form"><input id="join-code" className="code-input" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required placeholder="0000" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))} /><button className="primary" type="submit" disabled={joining || code.length !== 4}>{joining ? 'Joining…' : 'Join'}</button></div></form></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="survey-grid">
      {loading && <div className="card" role="status">Loading your questionnaires…</div>}
      {!loading && surveys.length === 0 && <div className="empty-surveys"><span>00</span><h3>No questionnaires yet</h3><p>An assigned survey will appear here, or you can join one with a 4-digit code.</p></div>}
      {surveys.map(survey => <button className={`survey-card inbox-card${survey.submittedAt ? ' completed' : ''}`} type="button" key={survey.id} onClick={() => navigate(`/inbox/${survey.id}`)}><span className="survey-card-arrow" aria-hidden="true">↗</span>{survey.submittedAt && <span className="completion-badge">COMPLETED</span>}<span className="eyebrow">ASSIGNED BY {survey.senderEmail}</span><h3>{survey.title}</h3><p>{survey.questionCount} {survey.questionCount === 1 ? 'question' : 'questions'}</p><div><span>{survey.submittedAt ? `Completed ${formatDate(survey.submittedAt)}` : `Received ${formatDate(survey.joinedAt)}`}</span><span>{survey.source === 'code' ? 'Joined by code' : 'Assigned to you'}</span></div></button>)}
    </div>
  </section>;
}

export default function Inbox({ path, navigate, onExpired }) {
  const match = path.match(/^\/inbox\/([0-9a-f-]+)$/i);
  return match ? <InboxDetail id={match[1]} navigate={navigate} onExpired={onExpired} /> : <InboxList navigate={navigate} onExpired={onExpired} />;
}
