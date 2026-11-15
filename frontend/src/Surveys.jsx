import React, { useEffect, useState } from 'react';
import { apiRequest, getJson } from './auth';

function formatDate(value) {
  return new Date(value).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function SurveyDetail({ id, navigate, onExpired }) {
  const [survey, setSurvey] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([getJson(`/api/surveys/${id}`), getJson(`/api/surveys/${id}/recipients`)]).then(([surveyResult, recipientResult]) => {
      if (active) {
        setSurvey(surveyResult.survey);
        setRecipients(recipientResult.recipients);
      }
    }).catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    });
    return () => { active = false; };
  }, [id]);

  async function send(event) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    setMessage('');
    try {
      const result = await apiRequest(`/api/surveys/${id}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setMessage(result.added ? `Assigned to ${result.email}.` : `${result.email} already has access to this survey.`);
      setEmail('');
      const refreshed = await getJson(`/api/surveys/${id}/recipients`);
      setRecipients(refreshed.recipients);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setSending(false);
    }
  }
  async function revoke(emailAddress) {
    if (!window.confirm(`Remove ${emailAddress}'s access to this survey and delete their submitted response?`)) return;
    setRemoving(emailAddress);
    setError('');
    setMessage('');
    try {
      await apiRequest(`/api/surveys/${id}/recipients`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailAddress }),
      });
      setRecipients(current => current.filter(recipient => recipient.email !== emailAddress));
      setMessage(`Access removed for ${emailAddress}.`);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setRemoving('');
    }
  }
  async function deleteSurvey() {
    if (!window.confirm('Delete this survey project? Everyone will lose access. This cannot be undone.')) return;
    setDeleting(true);
    setError('');
    try {
      await apiRequest(`/api/surveys/${id}`, { method: 'DELETE' });
      navigate('/surveys');
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
      setDeleting(false);
    }
  }
  async function downloadResponses() {
    if (downloading) return;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(`/api/surveys/${id}/responses.csv`, { credentials: 'include' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const downloadError = new Error(response.status === 401 ? 'Your session has expired. Please sign in again.' : body.message || 'The response export could not be downloaded.');
        downloadError.status = response.status;
        throw downloadError;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `survey-${id}-responses.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setDownloading(false);
    }
  }
  return <section className="survey-view">
    <button className="back-button" type="button" onClick={() => navigate('/surveys')}>← Survey library</button>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!survey && !error && <div className="card" role="status">Loading survey…</div>}
    {survey && <>
      <div className="survey-title-row">
        <div><span className="eyebrow">PSYCHOMETRIC SURVEY</span><h2>{survey.title}</h2><p className="muted">{survey.questionCount} {survey.questionCount === 1 ? 'question' : 'questions'} · {survey.responseCount} {survey.responseCount === 1 ? 'response' : 'responses'} · Created {formatDate(survey.createdAt)}</p></div>
        <div className="survey-meta-actions"><div className="join-code"><span>JOIN CODE</span><strong>{survey.joinCode}</strong></div><span className="file-chip">{survey.sourceFilename}</span><button className="secondary" type="button" disabled={downloading} onClick={downloadResponses}>{downloading ? 'Downloading…' : 'Download anonymous CSV'}</button><button className="danger-button" type="button" disabled={deleting} onClick={deleteSurvey}>{deleting ? 'Deleting…' : 'Delete survey'}</button></div>
      </div>
      <div className="sharing-panel">
        <div><span className="eyebrow">ASSIGN SURVEY</span><h3>Invite a registered participant</h3><p>Enter their PALs account email. The questionnaire will appear under My surveys.</p></div>
        <form onSubmit={send}><label htmlFor="recipient-email">Participant email</label><div className="inline-form"><input id="recipient-email" type="email" required maxLength={254} placeholder="participant@example.com" value={email} onChange={event => setEmail(event.target.value)} /><button className="primary" type="submit" disabled={sending}>{sending ? 'Assigning…' : 'Assign'}</button></div>{message && <p className="success-message" role="status">{message}</p>}</form>
        {recipients.length > 0 && <div className="recipient-list"><span>PARTICIPANTS WITH ACCESS</span>{recipients.map(recipient => <div key={recipient.email}><span className="recipient-details"><strong>{recipient.email}</strong><small>{recipient.source === 'code' ? 'Joined with code' : 'Assigned directly'} · {formatDate(recipient.joinedAt)}</small></span><button className="text-danger" type="button" disabled={Boolean(removing)} onClick={() => revoke(recipient.email)}>{removing === recipient.email ? 'Removing…' : 'Remove access'}</button></div>)}</div>}
      </div>
      <ol className="question-list">
        {survey.questions.map(item => <li key={item.position}><span className="question-number">{String(item.position).padStart(2, '0')}</span><p>{item.question}</p></li>)}
      </ol>
    </>}
  </section>;
}

function SurveyList({ navigate, onExpired }) {
  const [surveys, setSurveys] = useState([]);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson('/api/surveys').then(result => {
      if (active) setSurveys(result.surveys);
    }).catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function upload(event) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('file', file);
      const result = await apiRequest('/api/surveys', { method: 'POST', body: form });
      navigate(`/surveys/${result.survey.id}`);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return <section>
    <div className="survey-layout">
      <div>
        <span className="eyebrow">ASSESSMENT LIBRARY</span>
        <h2 className="section-title">Your psychometric surveys</h2>
        <p className="muted">Build each measure from the <code>question</code> column in a CSV, then assign it and collect 1–5 responses.</p>
      </div>
      <form className="upload-card" onSubmit={upload}>
        <h3>Create a survey</h3>
        <label htmlFor="survey-title">Measure name</label>
        <input id="survey-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} placeholder="Wellbeing Scale — Baseline" />
        <label htmlFor="survey-file">CSV file</label>
        <input id="survey-file" className="file-input" type="file" accept=".csv,text/csv" required onChange={event => setFile(event.target.files?.[0] || null)} />
        <p className="upload-help">Maximum 2 MB and 500 questions. Other columns are ignored.</p>
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy || !file}>{busy ? 'Creating survey…' : 'Create survey'}</button>
      </form>
    </div>
    <div className="survey-grid" aria-live="polite">
      {loading && <div className="card" role="status">Loading your survey library…</div>}
      {!loading && surveys.length === 0 && <div className="empty-surveys"><span>01</span><h3>No measures yet</h3><p>Upload a question CSV to create your first psychometric survey.</p></div>}
      {surveys.map(survey => <button className="survey-card" type="button" key={survey.id} onClick={() => navigate(`/surveys/${survey.id}`)}>
        <span className="survey-card-arrow" aria-hidden="true">↗</span>
        <span className="eyebrow">MEASURE</span>
        <h3>{survey.title}</h3>
        <p>{survey.questionCount} {survey.questionCount === 1 ? 'question' : 'questions'} · {survey.responseCount} {survey.responseCount === 1 ? 'response' : 'responses'}</p>
        <div><span>{formatDate(survey.createdAt)}</span><span>{survey.sourceFilename}</span></div>
      </button>)}
    </div>
  </section>;
}

export default function Surveys({ path, navigate, onExpired }) {
  const match = path.match(/^\/surveys\/([0-9a-f-]+)$/i);
  return match
    ? <SurveyDetail id={match[1]} navigate={navigate} onExpired={onExpired} />
    : <SurveyList navigate={navigate} onExpired={onExpired} />;
}
