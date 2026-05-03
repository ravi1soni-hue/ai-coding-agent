import React, { useEffect, useState } from 'react';
import AuthPage from './components/AuthPage';
import ChatWorkspace from './components/ChatWorkspace';
import ProjectHistory from './components/ProjectHistory';
import { readJson } from './utils/helpers';

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
  const [redeployingProjectId, setRedeployingProjectId] = useState('');
  const [redeployStatus, setRedeployStatus] = useState('');
  const [redeployError, setRedeployError] = useState('');

  async function loadCurrentProject() {
    const res = await fetch('/api/projects/current');
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error || 'Could not load project session.');
    setProjectId(json.projectId || '');
    return json.projectId || '';
  }

  async function loadProjectHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/projects/history');
      const json = await readJson(res);
      if (res.ok && Array.isArray(json.projects)) setProjectHistory(json.projects);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) { if (active) setLoading(false); return; }
        const json = await readJson(res);
        if (active && json.user) {
          setUser(json.user);
          await loadCurrentProject();
          await loadProjectHistory();
        }
      } catch { /* no-op */ } finally {
        if (active) setLoading(false);
      }
    }
    boot();
    return () => { active = false; };
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
      const payload = mode === 'signup'
        ? { name: form.name.trim(), email: form.email.trim(), password: form.password }
        : { email: form.email.trim(), password: form.password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error || 'Authentication failed.');
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

  async function onRedeployProject(projectIdToRedeploy) {
    setRedeployError('');
    setRedeployStatus('');
    setRedeployingProjectId(projectIdToRedeploy);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectIdToRedeploy)}/redeploy`, { method: 'POST' });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error || 'Redeploy failed.');
      setRedeployStatus(`Redeploy started successfully. New URL: ${json.deployment?.frontend_url || 'See history for updates.'}`);
      await loadProjectHistory();
    } catch (err) {
      setRedeployError(err.message || 'Redeploy failed.');
    } finally {
      setRedeployingProjectId('');
    }
  }

  if (loading) {
    return <div className="mainBg authPageBg"><div className="authLoading">Loading your workspace...</div></div>;
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
        <ProjectHistory
          projectId={projectId}
          projectHistory={projectHistory}
          historyLoading={historyLoading}
          redeployingProjectId={redeployingProjectId}
          redeployStatus={redeployStatus}
          redeployError={redeployError}
          onClose={() => setHistoryOpen(false)}
          onSelectProject={onSelectProject}
          onRedeployProject={onRedeployProject}
        />
      ) : null}
    </>
  );
}
