import React, { useEffect, useRef, useState } from 'react';

function makeSocketUrl(projectId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return `${proto}://${window.location.host}/${suffix}`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function AuthPage({ mode, setMode, form, setForm, busy, error, onSubmit }) {
  const isSignup = mode === 'signup';

  return (
    <div className="mainBg authPageBg">
      <div className="authShell">
        <section className="authFormPane">
          <h1 className="authTitle">Sign into your account</h1>
          <p className="authSubtitle">Access your builder workspace and continue your projects.</p>

          <div className="authTabs" role="tablist" aria-label="Authentication mode">
            <button
              className={`authTab ${isSignup ? 'active' : ''}`}
              type="button"
              onClick={() => setMode('signup')}
            >
              Sign up
            </button>
            <button
              className={`authTab ${!isSignup ? 'active' : ''}`}
              type="button"
              onClick={() => setMode('login')}
            >
              Log in
            </button>
          </div>

          <form className="authForm" onSubmit={onSubmit}>
            {isSignup ? (
              <label className="authLabel">
                Full name
                <input
                  className="authInput"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Enter your name"
                  autoComplete="name"
                  required
                />
              </label>
            ) : null}

            <label className="authLabel">
              Email
              <input
                className="authInput"
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="Enter your email"
                autoComplete="email"
                required
              />
            </label>

            <label className="authLabel">
              Password
              <input
                className="authInput"
                type="password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Enter your password"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
                minLength={8}
              />
            </label>

            {isSignup ? (
              <label className="authLabel">
                Repeat the password
                <input
                  className="authInput"
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                  placeholder="Repeat your password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </label>
            ) : null}

            {error ? <div className="authError">{error}</div> : null}

            <button className="authSubmit" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
            </button>
          </form>
        </section>

        <section className="authVisualPane" aria-hidden="true">
          <img
            className="authVisualImg"
            src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80"
            alt=""
          />
          <div className="authVisualOverlay">
            <p>
              Build faster with guided sessions, saved project IDs, and authenticated workspaces made for
              iterative shipping.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function ChatWorkspace({ user, projectId, onLogout, onNewProject, onOpenHistory }) {
  const [connection, setConnection] = useState('connecting');
  const [statusText, setStatusText] = useState('Initializing');
  const [progress, setProgress] = useState(0);
  const [input, setInput] = useState('');
  const [todayText, setTodayText] = useState('');
  const [messages, setMessages] = useState([]);

  const wsRef = useRef(null);
  const msgEndRef = useRef(null);
  const displayName = (user.name || 'there').trim();

  useEffect(() => {
    let active = true;

    // Reset visible chat state when project context changes so messages never leak across projects.
    setMessages([]);
    setProgress(0);
    setStatusText('Initializing');
    setInput('');

    async function loadProjectEvents() {
      if (!projectId) return;
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/events`);
      const json = await readJson(res);
      if (!active || !res.ok || !Array.isArray(json.events)) return;

      const restored = json.events
        .map((e) => {
          if (e.role === 'user') return { role: 'user', text: e.message || '' };
          if (e.event_type === 'stream') return { role: 'assistant', text: e.message || '' };
          if (e.event_type === 'clarification') return { role: 'assistant', text: e.message || '' };
          if (e.event_type === 'confirmation') return { role: 'assistant', text: e.message || '' };
          if (e.event_type === 'error') return { role: 'error', text: e.message || '' };
          if (e.event_type === 'done') return { role: 'system', text: e.message || '' };
          return null;
        })
        .filter((m) => m && m.text)
        .slice(-30);

      if (restored.length > 0) {
        setMessages(restored);
      }
    }

    loadProjectEvents().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    setTodayText(new Date().toLocaleDateString('en-US', options));
  }, []);

  function pushMessage(role, text) {
    setMessages((prev) => [...prev, { role, text }]);
  }

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    const ws = new WebSocket(makeSocketUrl(projectId));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnection('connected');
      pushMessage('system', `Connected to live build assistant for project ${projectId}.`);
    };

    ws.onclose = () => {
      setConnection('disconnected');
      pushMessage('error', 'Socket disconnected. Refresh to reconnect.');
    };

    ws.onerror = () => {
      setConnection('disconnected');
      pushMessage('error', 'WebSocket error occurred.');
    };

    ws.onmessage = (event) => {
      let payload = event.data;
      try {
        payload = JSON.parse(event.data);
      } catch {
        pushMessage('assistant', String(event.data));
        return;
      }

      switch (payload.type) {
        case 'info':
          pushMessage('system', payload.message || 'Info received.');
          break;
        case 'progress':
          setProgress(Math.max(0, Math.min(1, Number(payload.progress) || 0)));
          setStatusText(payload.status || 'Working');
          break;
        case 'stream':
          pushMessage('assistant', payload.token || '');
          break;
        case 'clarification':
          pushMessage('assistant', payload.question || 'Please clarify your request.');
          break;
        case 'confirmation':
          pushMessage('assistant', payload.message || 'Please confirm to proceed.');
          break;
        case 'done':
          setProgress(1);
          setStatusText('Complete');
          pushMessage('system', payload.message || 'Flow finished.');
          if (payload.frontend_url) {
            pushMessage('system', `🔗 Your deployed app: ${payload.frontend_url}`);
          }
          if (payload.backend_url) {
            pushMessage('system', `🛠 Backend URL: ${payload.backend_url}`);
          }
          if (payload.vercel_inspect_url) {
            pushMessage('system', `🔍 Inspect deployment: ${payload.vercel_inspect_url}`);
          }
          if (payload.frontend_access_warning) {
            pushMessage('error', `⚠️ ${payload.frontend_access_warning}`);
          }
          break;
        case 'error':
          pushMessage('error', payload.message || 'Unknown error.');
          break;
        default:
          pushMessage('assistant', JSON.stringify(payload));
      }
    };

    return () => {
      ws.close();
    };
  }, [projectId]);

  useEffect(() => {
    if (msgEndRef.current) {
      msgEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  function sendText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushMessage('error', 'Socket is not connected.');
      return;
    }

    ws.send(trimmed);
    pushMessage('user', trimmed);
    setInput('');
  }

  function onSubmit(e) {
    e.preventDefault();
    sendText(input);
  }

  return (
    <div className="mainBg">
      <div className="assistantWrapper">
        <div className="bgDecor" aria-hidden="true">
          <span className="bgBubble bubbleOne" />
          <span className="bgBubble bubbleTwo" />
          <span className="bgBubble bubbleThree" />
          <span className="bgRing" />
        </div>
        <section className="assistantLeft">
          <div className="assistantHeaderRow">
            <div>
              <h1 className="assistantTitle">
                Hello <span className="assistantName">{displayName}</span>,
              </h1>
              <div className="assistantQuestion">How can I help you?</div>
            </div>
            <div className="assistantHeaderRight">
              <div className="assistantDate assistantDateCompact">{todayText}</div>
              <div className="chatTopActions">
                <button
                  className="iconActionBtn"
                  type="button"
                  onClick={onNewProject}
                  aria-label="Start a new project"
                  title="New Project"
                >
                  +
                </button>
                <button
                  className="iconActionBtn ghost"
                  type="button"
                  onClick={onOpenHistory}
                  aria-label="Open project history"
                  title="History"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                    <path
                      d="M12 3a9 9 0 0 0-8.485 6H2a1 1 0 1 0 0 2h2.4a1 1 0 0 0 1-1 6.6 6.6 0 1 1 1.912 4.668 1 1 0 1 0-1.414 1.414A8.6 8.6 0 1 0 3.4 10h.115A9 9 0 0 0 12 3zm0 4a1 1 0 0 0-1 1v4.2a1 1 0 0 0 .4.8l2.8 2.1a1 1 0 1 0 1.2-1.6L13 11.8V8a1 1 0 0 0-1-1z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <button
                  className="iconActionBtn ghost"
                  type="button"
                  onClick={onLogout}
                  aria-label="Log out"
                  title="Logout"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                    <path
                      d="M10 5a1 1 0 0 0 0 2h5v10h-5a1 1 0 1 0 0 2h6a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-6zm-4.707 6.293a1 1 0 0 0 0 1.414l2.999 3a1 1 0 1 0 1.414-1.414L8.414 13H14a1 1 0 1 0 0-2H8.414l1.292-1.293a1 1 0 0 0-1.414-1.414l-2.999 3z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div className="socketStatus socketStatusCentered">
            <span className={`socketChip socket-${connection}`}>{connection}</span>
            <span className="socketText" title={statusText}>
              {statusText}
            </span>
            <span className="socketPct">{Math.round(progress * 100)}%</span>
          </div>

          <div className="buildHint">Describe what to build and follow live progress below.</div>

          <div className="activityBox">
            {messages.slice(-6).map((m, idx) => (
              <div key={`${m.role}-${idx}`} className={`msg ${m.role}`}>
                {m.text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
                  /^https?:\/\//.test(part)
                    ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{color:'inherit',textDecoration:'underline',wordBreak:'break-all'}}>{part}</a>
                    : part
                )}
              </div>
            ))}
            <div ref={msgEndRef} />
          </div>

          <div className="projectMeta">Project session: {projectId}</div>

          <form className="assistantInputRow" onSubmit={onSubmit}>
            <input
              className="assistantInput"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter text here..."
            />
            <button className="assistantSend" type="submit" disabled={connection !== 'connected'}>
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [projectId, setProjectId] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectHistory, setProjectHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function loadCurrentProject() {
    const res = await fetch('/api/projects/current');
    const json = await readJson(res);
    if (!res.ok) {
      throw new Error(json.error || 'Could not load project session.');
    }
    setProjectId(json.projectId || '');
    return json.projectId || '';
  }

  async function loadProjectHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/projects/history');
      const json = await readJson(res);
      if (res.ok && Array.isArray(json.projects)) {
        setProjectHistory(json.projects);
      }
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
          if (active) {
            setLoading(false);
          }
          return;
        }

        const json = await readJson(res);
        if (active && json.user) {
          setUser(json.user);
          await loadCurrentProject();
          await loadProjectHistory();
        }
      } catch {
        // no-op
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    boot();

    return () => {
      active = false;
    };
  }, []);

  async function onSubmitAuth(e) {
    e.preventDefault();
    setError('');

    if (mode === 'signup' && form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const payload =
        mode === 'signup'
          ? { name: form.name.trim(), email: form.email.trim(), password: form.password }
          : { email: form.email.trim(), password: form.password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await readJson(res);

      if (!res.ok) {
        throw new Error(json.error || 'Authentication failed.');
      }

      setUser(json.user);
      setForm({ name: '', email: '', password: '', confirmPassword: '' });
      await loadCurrentProject();
      await loadProjectHistory();
    } catch (err) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setProjectId('');
    setProjectHistory([]);
    setMode('login');
  }

  async function onNewProject() {
    const res = await fetch('/api/projects/new', { method: 'POST' });
    const json = await readJson(res);
    if (res.ok && json.projectId) {
      setProjectId(json.projectId);
      await loadProjectHistory();
    }
  }

  async function onSelectProject(nextProjectId) {
    const res = await fetch('/api/projects/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: nextProjectId }),
    });
    const json = await readJson(res);
    if (res.ok && json.projectId) {
      setProjectId(json.projectId);
      setHistoryOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="mainBg authPageBg">
        <div className="authLoading">Loading your workspace...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage
        mode={mode}
        setMode={setMode}
        form={form}
        setForm={setForm}
        busy={busy}
        error={error}
        onSubmit={onSubmitAuth}
      />
    );
  }

  return (
    <>
      <ChatWorkspace
        user={user}
        projectId={projectId}
        onLogout={onLogout}
        onNewProject={onNewProject}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      {historyOpen ? (
        <div className="historyOverlay" role="dialog" aria-modal="true">
          <div className="historyPanel">
            <div className="historyHeader">
              <h3>Project History</h3>
              <button className="topActionBtn ghost" type="button" onClick={() => setHistoryOpen(false)}>
                Close
              </button>
            </div>

            <div className="historyBody">
              {historyLoading ? <div className="historyEmpty">Loading history...</div> : null}
              {!historyLoading && projectHistory.length === 0 ? (
                <div className="historyEmpty">No previous projects yet.</div>
              ) : null}

              {projectHistory.map((p) => (
                <button
                  key={p.id}
                  className={`historyItem ${p.id === projectId ? 'active' : ''}`}
                  type="button"
                  onClick={() => onSelectProject(p.id)}
                >
                  <div className="historyItemTop">
                    <span className="historyId">{p.id}</span>
                    <span className="historyStatus">{p.status}</span>
                  </div>
                  <div className="historyMeta">
                    {Math.round((Number(p.progress) || 0) * 100)}% | {p.current_step || 'init'}
                  </div>
                  {p.frontend_url || p.backend_url ? (
                    <div className="historyMeta">
                      {p.frontend_url ? `Vercel: ${p.frontend_url}` : ''}
                      {p.frontend_url && p.backend_url ? ' | ' : ''}
                      {p.backend_url ? `Railway: ${p.backend_url}` : ''}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
