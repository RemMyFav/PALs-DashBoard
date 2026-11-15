import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmailPassword, Session, getJson, UI_PREVIEW } from './auth';
import Surveys from './Surveys';
import Inbox from './Inbox';
import './styles.css';

function Brand() {
  return <a className="brand" href="/" aria-label="PALs home"><span className="brand-mark">p.</span><span>PALs<span className="brand-sub">PSYCHOMETRICS</span></span></a>;
}

function AuthForm({ register, onSuccess, navigate }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setFields({});
    if (register && password !== confirm) {
      setFields({ confirm: 'Passwords do not match.' });
      return;
    }
    if (UI_PREVIEW) {
      setError('This is a UI preview. Authentication is not connected, so no account will be created or signed in.');
      return;
    }
    setBusy(true);
    try {
      const response = await (register ? EmailPassword.signUp : EmailPassword.signIn)({
        formFields: [{ id: 'email', value: email.trim() }, { id: 'password', value: password }],
      });
      if (response.status === 'OK') {
        setPassword('');
        setConfirm('');
        await onSuccess();
      } else if (response.status === 'FIELD_ERROR') {
        const errors = {};
        for (const field of response.formFields) {
          errors[field.id] = field.id === 'email'
            ? (/already|exists/i.test(field.error) ? 'This email is already registered. Please sign in.' : 'Enter a valid email address.')
            : 'Your password must be 12–128 characters long.';
        }
        setFields(errors);
      } else if (response.status === 'WRONG_CREDENTIALS_ERROR') {
        setError('Incorrect email or password. Please try again.');
      } else {
        setError('Unable to complete this request. Please try again later.');
      }
    } catch (cause) {
      setError(cause.status === 429 ? 'Too many attempts. Please try again in 15 minutes.' : 'Unable to connect. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-layout">
    <section className="intro-panel">
      <Brand />
      <div className="intro-copy">
        <span className="eyebrow light">PSYCHOMETRIC QUESTIONNAIRES</span>
        <h1>Your response.<br />It matters.</h1>
        <p>Thoughtfully designed measures begin with honest answers.<br />Sign in to complete your questionnaires and help turn questions into meaningful insight.</p>
      </div>
      <div className="intro-footer"><span className="status-dot" /> Private participation · Anonymous response exports</div>
      <div className="orbit orbit-one" aria-hidden="true" /><div className="orbit orbit-two" aria-hidden="true" />
    </section>
    <section className="form-panel">
      <div className="auth-top">{register ? 'Already have an account?' : 'New here?'} <button type="button" className="text-button" disabled={busy} onClick={() => navigate(register ? '/login' : '/register')}>{register ? 'Sign in' : 'Create account'} <span aria-hidden="true">↗</span></button></div>
      <div className="form-wrap">
        {UI_PREVIEW && <p className="notice preview-notice" role="status">UI preview only. Explore the sign-in and registration pages without connecting to authentication.</p>}
        <span className="eyebrow">{register ? 'BEGIN HERE' : 'WELCOME BACK'}</span>
        <h2>{register ? 'Create your participant account' : 'Continue your questionnaires'}</h2>
        <p className="muted form-description">{register ? 'Use your email to receive and complete psychometric questionnaires in one secure place.' : 'Sign in to review assigned measures and continue where you left off.'}</p>
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy}>
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" required autoComplete="email" maxLength={254} placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-invalid={Boolean(fields.email)} aria-describedby={fields.email ? 'email-error' : undefined} />
            {fields.email && <p id="email-error" className="field-error" role="alert">{fields.email}</p>}
            <label htmlFor="password">Password</label>
            <div className="password-input">
              <input id="password" name="password" type={visible ? 'text' : 'password'} required minLength={register ? 12 : undefined} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'At least 12 characters' : 'Enter your password'} value={password} onChange={e => setPassword(e.target.value)} aria-invalid={Boolean(fields.password)} aria-describedby={fields.password ? 'password-error' : undefined} />
              <button className="reveal" type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Hide' : 'Show'}</button>
            </div>
            {fields.password && <p id="password-error" className="field-error" role="alert">{fields.password}</p>}
            {register && <>
              <label htmlFor="confirm">Confirm password</label>
              <input id="confirm" name="confirm" type={visible ? 'text' : 'password'} required autoComplete="new-password" maxLength={128} placeholder="Enter your password again" value={confirm} onChange={e => setConfirm(e.target.value)} aria-invalid={Boolean(fields.confirm)} aria-describedby={fields.confirm ? 'confirm-error' : undefined} />
              {fields.confirm && <p id="confirm-error" className="field-error" role="alert">{fields.confirm}</p>}
            </>}
            {error && <p className="notice error" role="alert">{error}</p>}
            <button className="primary submit" type="submit">{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'} {!busy && <span aria-hidden="true">→</span>}</button>
          </fieldset>
        </form>
        <p className="form-note">{register ? 'Your email identifies your PALs account; response exports do not include it.' : 'Your thoughtful responses are the most important part of every measure.'}</p>
      </div>
      <footer className="form-footer">PALs Psychometrics <span>Responses that matter</span></footer>
    </section>
  </main>;
}

function AdminPanel({ onExpired }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getJson('/api/admin/overview').then(value => { if (active) setData(value); }).catch(cause => {
      if (!active) return;
      if (cause.status === 401) onExpired();
      else setError(cause.message);
    });
    return () => { active = false; };
  }, []);
  if (error) return <section className="card"><h2>Admin access unavailable</h2><p className="notice error" role="alert">{error}</p></section>;
  if (!data) return <section className="card" role="status">Verifying admin access…</section>;
  return <section className="card"><span className="eyebrow">RESEARCH ADMINISTRATION</span><h2>{data.title}</h2><p className="muted">{data.message}</p><ul className="capabilities">{data.capabilities.map(item => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul></section>;
}

function Dashboard({ me, path, navigate, onExpired, onLogout }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const admin = me.permissions.includes('admin:access');
  const surveyPath = path === '/surveys' || path.startsWith('/surveys/');
  const inboxPath = path === '/inbox' || path.startsWith('/inbox/');
  async function logout() {
    setBusy(true);
    setError('');
    try {
      await Session.signOut();
      onLogout();
    } catch {
      setError('Unable to sign out. Check your connection and try again.');
    } finally { setBusy(false); }
  }
  return <div className="workspace">
    <header className="workspace-header"><Brand /><div className="header-actions"><span className="role-badge">{admin ? 'Admin' : 'Member'}</span><button className="secondary" disabled={busy} onClick={logout}>{busy ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="workspace-main">
      <div className="page-heading"><span className="eyebrow">PSYCHOMETRIC SURVEY HUB</span><h1>Every response moves understanding forward.</h1><p className="muted">Review assigned questionnaires, contribute your perspective, and track what you have completed.</p></div>
      <nav className="tabs" aria-label="Account navigation"><button className={path === '/' ? 'active' : ''} aria-current={path === '/' ? 'page' : undefined} onClick={() => navigate('/')}>Account</button><button className={inboxPath ? 'active' : ''} aria-current={inboxPath ? 'page' : undefined} onClick={() => navigate('/inbox')}>My surveys</button>{admin && <button className={surveyPath ? 'active' : ''} aria-current={surveyPath ? 'page' : undefined} onClick={() => navigate('/surveys')}>Manage surveys</button>}{admin && <button className={path === '/admin' ? 'active' : ''} aria-current={path === '/admin' ? 'page' : undefined} onClick={() => navigate('/admin')}>Admin access</button>}</nav>
      {error && <p className="notice error" role="alert">{error}</p>}
      {inboxPath ? <Inbox path={path} navigate={navigate} onExpired={onExpired} /> : surveyPath && admin ? <Surveys path={path} navigate={navigate} onExpired={onExpired} /> : path === '/admin' && admin ? <AdminPanel onExpired={onExpired} /> : <div className="account-grid">
        <section className="card"><div className="card-heading"><h2>Account details</h2><span className="small-tag">Signed in</span></div><dl><dt>Email address</dt><dd>{me.email}</dd><dt>Account role</dt><dd>{admin ? 'Admin' : 'Member'}</dd><dt>Member since</dt><dd>{new Date(me.joinedAt).toLocaleDateString('en')}</dd></dl></section>
        <section className="card access-card"><span className="eyebrow">PARTICIPATION</span><h2>Your survey access</h2><ul className="capabilities"><li><span aria-hidden="true">✓</span>Complete assigned psychometric surveys</li><li><span aria-hidden="true">✓</span>Submit and update 1–5 responses</li><li><span aria-hidden="true">✓</span>Join a survey with a 4-digit code</li>{admin && <li><span aria-hidden="true">✓</span>Create, assign, and export survey results</li>}</ul><p className="muted small">Administrator exports use anonymous respondent labels instead of account emails.</p></section>
      </div>}
    </main>
    <footer className="workspace-footer">PALs Psychometrics <span>Thoughtful questions. Meaningful responses.</span></footer>
  </div>;
}

function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  function navigate(next, replace = false, state = {}) {
    window.history[replace ? 'replaceState' : 'pushState'](state, '', next);
    setPath(next);
  }
  function expired() {
    setMe(null);
    navigate('/login', true);
  }
  async function loadAccount() {
    setLoading(true);
    setError('');
    if (UI_PREVIEW) {
      setMe(null);
      if (!['/login', '/register'].includes(window.location.pathname)) navigate('/login', true);
      setLoading(false);
      return;
    }
    try {
      if (await Session.doesSessionExist()) {
        const account = await getJson('/api/me');
        setMe(account);
        if (['/login', '/register'].includes(window.location.pathname)) navigate('/', true);
      } else {
        setMe(null);
        if (!['/login', '/register'].includes(window.location.pathname)) navigate('/login', true);
      }
    } catch (cause) {
      if (cause.status === 401) expired();
      else setError(cause.message || 'Unable to connect. Please try again later.');
    } finally { setLoading(false); }
  }
  useEffect(() => {
    loadAccount();
    const pop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  if (loading) return <div className="loading" role="status"><span className="brand-mark">p.</span><p>Preparing your surveys…</p></div>;
  if (error) return <main className="loading"><h1>PALs is temporarily unavailable</h1><p role="alert">{error}</p><button className="primary" onClick={loadAccount}>Try again</button></main>;
  if (!me) return <AuthForm key={path} register={path === '/register'} navigate={navigate} onSuccess={loadAccount} />;
  return <Dashboard me={me} path={path} navigate={navigate} onExpired={expired} onLogout={expired} />;
}

createRoot(document.getElementById('root')).render(<App />);
