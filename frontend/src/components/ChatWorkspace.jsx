import React, { useEffect, useMemo, useRef, useState } from 'react';
import { makeSocketUrl, readJson, buildDetailedLogPayload, copyTextToClipboard } from '../utils/helpers';

function MessageText({ text }) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function countLines(text) {
  if (!text) return 0;
  return String(text).replace(/\n$/, '').split('\n').length;
}

function FileCodeDialog({ file, onClose }) {
  if (!file) return null;
  return (
    <div className="historyOverlay fileDialogOverlay" role="dialog" aria-modal="true">
      <div className="historyPanel fileDialogPanel">
        <div className="historyHeader">
          <div>
            <h3>Generated file</h3>
            <div className="historyMeta fileDialogMeta">
              {file.path} · {countLines(file.content)} lines
            </div>
          </div>
          <button className="topActionBtn ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="fileDialogBody">
          <pre className="fileDialogCode">{file.content || '(empty file)'}</pre>
        </div>
      </div>
    </div>
  );
}

export default function ChatWorkspace({ user, projectId, onLogout, onNewProject, onOpenHistory }) {
  const [connection, setConnection] = useState('connecting');
  const [statusText, setStatusText] = useState('Initializing');
  const [progress, setProgress] = useState(0);
  const [stageStatus, setStageStatus] = useState('');
  const [input, setInput] = useState('');
  const [todayText, setTodayText] = useState('');
  const [messages, setMessages] = useState([]);
  const [copyState, setCopyState] = useState('Copy logs');
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [viewerFile, setViewerFile] = useState(null);
  const [currentActivity, setCurrentActivity] = useState('');
  const [pipelineActive, setPipelineActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [brainState, setBrainState] = useState({});

  const wsRef = useRef(null);
  const msgEndRef = useRef(null);
  const displayName = (user.name || 'there').trim();

  useEffect(() => {
    let active = true;
    setMessages([]);
    setGeneratedFiles([]);
    setViewerFile(null);
    setProgress(0);
    setStageStatus('');
    setStatusText('Initializing');
    setInput('');
    setCurrentActivity('');
    setElapsedSeconds(0);

    async function loadProjectEvents() {
      if (!projectId) return;
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/events`, { credentials: 'include' });
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
        .filter((m) => m && m.text);

      if (restored.length > 0) setMessages(restored);
    }

    loadProjectEvents().catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    setTodayText(new Date().toLocaleDateString('en-US', options));
  }, []);

  useEffect(() => {
    if (!pipelineActive) {
      setElapsedSeconds(0);
      return undefined;
    }
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [pipelineActive]);

  function pushMessage(role, text) {
    setMessages((prev) => [...prev, { role, text }]);
  }

  function upsertGeneratedFile(file) {
    if (!file?.path) return;
    setGeneratedFiles((prev) => {
      const filtered = prev.filter((item) => item.path !== file.path);
      return [...filtered, file];
    });
  }

  useEffect(() => {
    if (!projectId) return undefined;

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
        case 'progress': {
          const p = Math.max(0, Math.min(1, Number(payload.progress) || 0));
          setProgress(p);
          setStatusText(payload.status || 'Working');
          if (typeof payload.stageProgress === 'number') {
            setStageStatus(`${payload.stage || 'Stage'} ${Math.round(payload.stageProgress * 100)}%`);
          } else {
            setStageStatus('');
          }
          if (p > 0 && p < 1) setPipelineActive(true);
          else if (p >= 1) setPipelineActive(false);
          break;
        }
        case 'stream':
          pushMessage('assistant', payload.token || '');
          break;
        case 'AGENT_THINKING':
          setCurrentActivity(payload.message || 'Agent thinking...');
          pushMessage('system', payload.message || 'Agent thinking...');
          break;
        case 'FILE_WRITTEN':
          if (payload.payload?.file) upsertGeneratedFile(payload.payload.file);
          if (payload.payload?.path && payload.payload?.content) {
            upsertGeneratedFile({ path: payload.payload.path, content: payload.payload.content });
          }
          if (payload.filePath) setCurrentActivity(`Writing ${payload.filePath}...`);
          pushMessage(
            'system',
            payload.filePath
              ? `Wrote ${payload.filePath}${payload.payload?.content ? ` (${countLines(payload.payload.content)} lines)` : ''}`
              : (payload.message || 'File written.')
          );
          break;
        case 'BUILD_LOG_STREAM':
          pushMessage('assistant', payload.token || payload.message || '');
          break;
        case 'clarification':
          pushMessage('assistant', payload.question || 'Please clarify your request.');
          break;
        case 'confirmation':
          pushMessage('assistant', payload.message || 'Please confirm to proceed.');
          break;
        case 'brainState':
          setBrainState(payload.brainState || {});
          break;
        case 'done':
          setProgress(1);
          setStatusText('Complete');
          setPipelineActive(false);
          setCurrentActivity('');
          pushMessage('system', payload.message || 'Flow finished.');
          if (payload.frontend_url) pushMessage('system', `🔗 Your deployed app: ${payload.frontend_url}`);
          if (payload.backend_url) pushMessage('system', `🛠 Backend URL: ${payload.backend_url}`);
          if (payload.vercel_inspect_url) pushMessage('system', `🔍 Inspect deployment: ${payload.vercel_inspect_url}`);
          if (payload.frontend_access_warning) pushMessage('details', `Warning: ${payload.frontend_access_warning}`);
          break;
        case 'error':
          pushMessage('details', payload.message || 'Unknown error.');
          break;
        default:
          pushMessage('system', 'Received an unrecognized event from the server.');
          pushMessage('details', JSON.stringify(payload, null, 2));
      }
    };

    return () => { ws.close(); };
  }, [projectId]);

  useEffect(() => {
    if (msgEndRef.current) {
      msgEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  function sendText(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushMessage('error', 'Socket is not connected.');
      return;
    }
    ws.send(trimmed);
    pushMessage('user', trimmed);
    setInput('');
  }

  async function onCopyLogs() {
    try {
      const payload = buildDetailedLogPayload({ user, projectId, connection, statusText, progress, stageStatus, messages });
      await copyTextToClipboard(payload);
      setCopyState('Copied');
      window.setTimeout(() => setCopyState('Copy logs'), 1600);
    } catch {
      setCopyState('Copy failed');
      window.setTimeout(() => setCopyState('Copy logs'), 1600);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    sendText(input);
  }

  const fileCountText = useMemo(() => `${generatedFiles.length} generated files`, [generatedFiles.length]);

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
                <button className="iconActionBtn" type="button" onClick={onNewProject} aria-label="Start a new project" title="New Project">
                  +
                </button>
                <button className="iconActionBtn ghost" type="button" onClick={onOpenHistory} aria-label="Open project history" title="History">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                    <path
                      d="M12 3a9 9 0 0 0-8.485 6H2a1 1 0 1 0 0 2h2.4a1 1 0 0 0 1-1 6.6 6.6 0 1 1 1.912 4.668 1 1 0 1 0-1.414 1.414A8.6 8.6 0 1 0 3.4 10h.115A9 9 0 0 0 12 3zm0 4a1 1 0 0 0-1 1v4.2a1 1 0 0 0 .4.8l2.8 2.1a1 1 0 1 0 1.2-1.6L13 11.8V8a1 1 0 0 0-1-1z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <button className="iconActionBtn ghost" type="button" onClick={onLogout} aria-label="Log out" title="Logout">
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
            <span className="socketText" title={statusText}>{statusText}</span>
            <span className="socketPct">{Math.round(progress * 100)}%{pipelineActive && elapsedSeconds > 0 ? ` • ${elapsedSeconds}s` : ''}</span>
          </div>
          {stageStatus ? <div className="socketSubStatus" title={stageStatus}>{stageStatus}</div> : null}
          {currentActivity ? <div className="currentActivityRow">Currently: {currentActivity}</div> : null}

          <div className="brainStateDebugPanel" style={{ margin: '14px 0 18px', padding: '12px', borderRadius: '12px', border: '1px solid rgba(148, 163, 184, 0.35)', background: '#111827' }}>
            <div style={{ marginBottom: '8px', fontSize: '0.92rem', fontWeight: 600, color: '#f8fafc' }}>Debug: brainState payload</div>
            <pre style={{ margin: 0, maxHeight: '210px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0', fontSize: '0.82rem' }}>
              {Object.keys(brainState).length ? JSON.stringify(brainState, null, 2) : 'No brainState received yet.'}
            </pre>
          </div>

          <div className="buildHint">Describe what to build and follow live progress below.</div>

          <div className="generatedSummaryRow">
            <span className="generatedSummaryPill">{fileCountText}</span>
            <span className="generatedSummaryHint">Click the eye button beside any file to inspect the generated code.</span>
          </div>

          <div className="logsHeader">
            <button className="copyLogsBtn" type="button" onClick={onCopyLogs}>
              {copyState}
            </button>
          </div>

          <div className="generatedFilesPanel">
            {generatedFiles.length === 0 ? (
              <div className="generatedFilesEmpty">Generated files will appear here as code is written.</div>
            ) : (
              generatedFiles.map((file) => (
                <div className="generatedFileRow" key={file.path}>
                  <div className="generatedFileMeta">
                    <div className="generatedFilePath">{file.path}</div>
                    <div className="generatedFileLines">{countLines(file.content)} lines</div>
                  </div>
                  <button className="eyeBtn" type="button" onClick={() => setViewerFile(file)} aria-label={`View ${file.path}`}>
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                      <path
                        d="M12 5c5.5 0 9.7 4 11 7-1.3 3-5.5 7-11 7S2.3 15 1 12c1.3-3 5.5-7 11-7zm0 2C8 7 4.8 9.8 3.3 12 4.8 14.2 8 17 12 17s7.2-2.8 8.7-5C19.2 9.8 16 7 12 7zm0 1.8A3.2 3.2 0 1 1 12 15.2a3.2 3.2 0 0 1 0-6.4zm0 2A1.2 1.2 0 1 0 12 13.2a1.2 1.2 0 0 0 0-2.4z"
                        fill="currentColor"
                      />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="activityBox">
            {messages.map((m, idx) => {
              const isDetails = m.role === 'details';
              return (
                <div key={`${m.role}-${idx}`} className={`msg ${m.role}`}>
                  {isDetails ? (
                    <details className="msgDetails">
                      <summary>{m.text.length > 120 ? 'Show details' : 'Show message details'}</summary>
                      <pre>{m.text}</pre>
                    </details>
                  ) : (
                    <MessageText text={m.text} />
                  )}
                </div>
              );
            })}
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

      <FileCodeDialog file={viewerFile} onClose={() => setViewerFile(null)} />
    </div>
  );
}
