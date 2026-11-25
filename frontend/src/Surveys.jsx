import React, { useEffect, useState } from 'react';
import { apiRequest, getJson } from './auth';

function formatDate(value) {
  return new Date(value).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function accessLabel(role) {
  return role === 'co_owner' ? 'Co-owner' : role === 'owner' ? 'Owner' : 'Participant';
}

function SurveyDetail({ id, navigate, onExpired }) {
  const [survey, setSurvey] = useState(null);
  const [access, setAccess] = useState({ ownerEmail: '', recipients: [] });
  const [view, setView] = useState('overview');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('participant');
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function loadAccess() {
    const result = await getJson(`/api/surveys/${id}/recipients`);
    setAccess(result);
  }

  useEffect(() => {
    let active = true;
    Promise.all([getJson(`/api/surveys/${id}`), getJson(`/api/surveys/${id}/recipients`)]).then(([surveyResult, accessResult]) => {
      if (active) {
        setSurvey(surveyResult.survey);
        setAccess(accessResult);
      }
    }).catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    });
    return () => { active = false; };
  }, [id]);

  async function invite(event) {
    event.preventDefault();
    if (sending) return;
    if (inviteRole === 'co_owner' && !window.confirm('Add this account as a Co-owner? Co-owners cannot answer this survey, and any existing response from this account will be deleted.')) return;
    setSending(true);
    setError('');
    setMessage('');
    try {
      const result = await apiRequest(`/api/surveys/${id}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, accessRole: inviteRole }),
      });
      const action = result.added ? 'added' : result.updated ? 'updated' : 'already set';
      setMessage(`${result.email} ${action} as ${accessLabel(result.accessRole)}.`);
      setEmail('');
      await loadAccess();
      const refreshed = await getJson(`/api/surveys/${id}`);
      setSurvey(refreshed.survey);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setSending(false);
    }
  }

  async function changeRole(recipient, nextRole) {
    if (recipient.accessRole === nextRole || changing) return;
    if (nextRole === 'co_owner' && !window.confirm(`Make ${recipient.email} a Co-owner? They will no longer be able to answer, and any existing response from this account will be deleted.`)) return;
    setChanging(recipient.email);
    setError('');
    setMessage('');
    try {
      await apiRequest(`/api/surveys/${id}/recipients`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: recipient.email, accessRole: nextRole }),
      });
      setAccess(current => ({ ...current, recipients: current.recipients.map(item => item.email === recipient.email ? { ...item, accessRole: nextRole } : item) }));
      setMessage(`${recipient.email} is now a ${accessLabel(nextRole)}.`);
      const refreshed = await getJson(`/api/surveys/${id}`);
      setSurvey(refreshed.survey);
    } catch (cause) {
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    } finally {
      setChanging('');
    }
  }

  async function deleteSurvey() {
    if (!window.confirm('Delete this survey project? Everyone will lose access and all responses will be deleted. This cannot be undone.')) return;
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
      <div className="survey-title-row compact-title-row"><div><span className="eyebrow">{accessLabel(survey.accessRole).toUpperCase()} · PSYCHOMETRIC SURVEY</span><h2>{survey.title}</h2><p className="muted">Created {formatDate(survey.createdAt)} · {survey.sourceFilename} · {survey.answerMode === 'ranking' ? 'Dimension ranking' : '1–5 rating scale'}</p></div><span className="role-badge">{accessLabel(survey.accessRole)}</span></div>
      <nav className="detail-tabs" aria-label="Survey management sections">{['overview', 'questions', 'access'].map(section => <button key={section} type="button" className={view === section ? 'active' : ''} aria-current={view === section ? 'page' : undefined} onClick={() => { setView(section); setError(''); setMessage(''); }}>{section[0].toUpperCase() + section.slice(1)}</button>)}</nav>
      {message && <p className="notice management-message" role="status">{message}</p>}

      {view === 'overview' && <div className="overview-stack">
        <div className="metrics-grid"><section className="metric-card"><span>COMPLETED RESPONSES</span><strong>{survey.responseCount}</strong><p>Current participants who submitted every question.</p></section><section className="metric-card"><span>QUESTIONS</span><strong>{survey.questionCount}</strong><p>Items imported from the original question column.</p></section></div>
        <section className="export-panel"><div><span className="eyebrow">ANONYMOUS DATA</span><h3>Download the response matrix</h3><p>Questions are rows and anonymous respondents are columns. Emails and account IDs are never included.</p></div><button className="primary" type="button" disabled={downloading} onClick={downloadResponses}>{downloading ? 'Downloading…' : 'Download anonymous CSV'}</button></section>
        {survey.accessRole === 'owner' && <section className="danger-zone"><div><strong>Delete survey</strong><p>Permanently delete the project, assignments, questions, and every response.</p></div><button className="danger-button" type="button" disabled={deleting} onClick={deleteSurvey}>{deleting ? 'Deleting…' : 'Delete survey'}</button></section>}
      </div>}

      {view === 'questions' && <ol className="question-list">{survey.questions.map(item => <li key={item.position}><span className="question-number">{String(item.position).padStart(2, '0')}</span><p>{item.question}</p></li>)}</ol>}

      {view === 'access' && <div className="access-stack">
        <section className="access-summary"><div><span className="eyebrow">JOIN CODE</span><div className="join-code light-code"><strong>{survey.joinCode}</strong></div><p>Anyone with a PALs account can use this code to join as a Participant.</p></div><div><span className="eyebrow">OWNER</span><strong>{access.ownerEmail || survey.ownerEmail}</strong><p>The Owner has permanent full access and is the only person who can delete this survey.</p></div></section>
        <section className="invite-panel"><div><span className="eyebrow">INVITE ACCESS</span><h3>Add a participant or Co-owner</h3><p>Co-owners can manage questions, access, counts, and exports, but cannot answer or delete the survey.</p></div><form onSubmit={invite}><label htmlFor="recipient-email">Account email</label><div className="permission-form"><input id="recipient-email" type="email" required maxLength={254} placeholder="professor@example.com" value={email} onChange={event => setEmail(event.target.value)} /><select aria-label="Access role" value={inviteRole} onChange={event => setInviteRole(event.target.value)}><option value="participant">Participant</option><option value="co_owner">Co-owner</option></select><button className="primary" type="submit" disabled={sending}>{sending ? 'Adding…' : 'Add access'}</button></div></form></section>
        <section className="people-panel"><div className="people-heading"><div><span className="eyebrow">PEOPLE AND PERMISSIONS</span><h3>Survey access</h3></div><span>{access.recipients.length} {access.recipients.length === 1 ? 'person' : 'people'}</span></div><div className="permission-row owner-row"><div><strong>{access.ownerEmail || survey.ownerEmail}</strong><small>Created this survey</small></div><span className="fixed-role">Owner</span></div>{access.recipients.map(recipient => <div className="permission-row" key={recipient.email}><div><strong>{recipient.email}{recipient.isCurrentUser ? ' (you)' : ''}</strong><small>{recipient.source === 'code' ? 'Joined with code' : 'Invited directly'} · {formatDate(recipient.joinedAt)}</small></div><select aria-label={`Access for ${recipient.email}`} value={recipient.accessRole} disabled={recipient.isCurrentUser || Boolean(changing)} onChange={event => changeRole(recipient, event.target.value)}><option value="participant">Participant</option><option value="co_owner">Co-owner</option></select></div>)}</section>
      </div>}
    </>}
  </section>;
}

function SurveyList({ navigate, onExpired, canCreate }) {
  const [surveys, setSurveys] = useState([]);
  const [title, setTitle] = useState('');
  const [answerMode, setAnswerMode] = useState('rating');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson('/api/surveys').then(result => { if (active) setSurveys(result.surveys); }).catch(cause => {
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
      form.append('answerMode', answerMode);
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
    <div className={`survey-layout${canCreate ? '' : ' manager-only'}`}><div><span className="eyebrow">MANAGE SURVEYS · PROJECTS YOU CONTROL</span><h2 className="section-title">Surveys you own or co-manage</h2><p className="muted">Manage surveys is for projects where you are the Owner or a Co-owner. Surveys you only need to answer stay in Inbox.</p></div>{canCreate && <form className="upload-card" onSubmit={upload}><h3>Create a survey</h3><p className="upload-intro">Upload a CSV, Excel, or Word file. Every supported format must use <code>question</code> as the identifier.</p><label htmlFor="survey-title">Measure name</label><input id="survey-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} placeholder="Wellbeing Scale — Baseline" />
      <label htmlFor="survey-answer-mode">Answer format</label>
      <select id="survey-answer-mode" value={answerMode} onChange={event => setAnswerMode(event.target.value)}>
        <option value="rating">1–5 rating scale</option>
        <option value="ranking">Rank wellness dimensions</option>
      </select>
      <label htmlFor="survey-file">Survey file</label>
      <input id="survey-file" className="file-input" type="file" accept=".csv,.xlsx,.docx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required onChange={event => setFile(event.target.files?.[0] || null)} /><div className="format-help"><strong>Required file structure</strong><ul><li><b>CSV / Excel (.xlsx):</b> include exactly one column named <code>question</code>. Each row is one question.</li><li><b>Word (.docx):</b> begin with a standalone <code>question</code> heading. Each following paragraph is one question.</li></ul><p>Maximum 2 MB and 500 questions. Other CSV or Excel columns are ignored. Legacy .xls and .doc files are not supported.</p></div>{error && <p className="notice error" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy || !file}>{busy ? 'Creating survey…' : 'Create survey'}</button></form>}</div>
    {!canCreate && error && <p className="notice error" role="alert">{error}</p>}
    <div className="survey-grid" aria-live="polite">{loading && <div className="card" role="status">Loading your managed surveys…</div>}{!loading && surveys.length === 0 && <div className="empty-surveys"><span>00</span><h3>You are not managing any surveys</h3><p>{canCreate ? 'Create a survey above, or wait until another Owner adds you as a Co-owner.' : 'Only Admin accounts can create new surveys. A project will appear here when its Owner adds you as a Co-owner; surveys assigned for you to answer remain in Inbox.'}</p></div>}{surveys.map(survey => <button className="survey-card" type="button" key={survey.id} onClick={() => navigate(`/surveys/${survey.id}`)}><span className="survey-card-arrow" aria-hidden="true">↗</span><span className="eyebrow">{accessLabel(survey.accessRole).toUpperCase()}</span><h3>{survey.title}</h3><p>{survey.questionCount} {survey.questionCount === 1 ? 'question' : 'questions'} · {survey.responseCount} {survey.responseCount === 1 ? 'response' : 'responses'}</p><div><span>{formatDate(survey.createdAt)}</span><span>{survey.sourceFilename}</span></div></button>)}</div>
  </section>;
}

export default function Surveys({ path, navigate, onExpired, canCreate }) {
  const match = path.match(/^\/surveys\/([0-9a-f-]+)$/i);
  return match ? <SurveyDetail id={match[1]} navigate={navigate} onExpired={onExpired} /> : <SurveyList navigate={navigate} onExpired={onExpired} canCreate={canCreate} />;
}
