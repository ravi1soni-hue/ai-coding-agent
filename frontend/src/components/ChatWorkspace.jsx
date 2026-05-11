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

function FileCodeDialog({ file, projectId, onClose }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setContent('');
    fetch(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(file.path)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load file content.');
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        setContent(typeof json.content === 'string' ? json.content : '');
      })
      .catch(() => {
        if (!cancelled) setError('Could not load file content.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [file, projectId]);

  if (!file) return null;
  const lineCount = file.lines ?? countLines(content);
  return (
    <div className="historyOverlay fileDialogOverlay" role="dialog" aria-modal="true">
      <div className="historyPanel fileDialogPanel">
        <div className="historyHeader">
          <div>
            <h3>Generated file</h3>
            <div className="historyMeta fileDialogMeta">
              {file.path} · {lineCount} lines
            </div>
          </div>
          <button className="topActionBtn ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="fileDialogBody">
          <pre className="fileDialogCode">
            {loading ? 'Loading…' : error || content || '(empty file)'}
          </pre>
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

  const wsRef = useRef(null);
  const msgEndRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const pingTimerRef = useRef(null);
  const shouldReconnectRef = useRef(true);
  const connectRef = useRef(() => {});
  const lastReplayedAtRef = useRef('');
  const [reconnectInSec, setReconnectInSec] = useState(0);
  const displayName = (user.name || 'there').trim();

  useEffect(() => {
    setMessages([]);
    setGeneratedFiles([]);
    setViewerFile(null);
    setProgress(0);
    setStageStatus('');
    setStatusText('Initializing');
    setInput('');
    setCurrentActivity('');
    setElapsedSeconds(0);
    lastReplayedAtRef.current = '';

    replayProjectEvents().catch(() => undefined);
  }, [projectId]);

  function mapEventToMessage(e) {
    if (e.role === 'user') return { role: 'user', text: e.message || '' };
    switch (e.event_type) {
      case 'clarification_request': {
        const qs = e.payload?.questions;
        if (Array.isArray(qs) && qs.length > 0) return { role: 'assistant', text: qs.join('\n') };
        return { role: 'assistant', text: e.message || 'Clarification requested.' };
      }
      case 'confirmation_request':
        return { role: 'assistant', text: 'Confirmation requested.' };
      case 'stage_start':
        return { role: 'system', text: e.message || `Starting ${e.payload?.stage || ''}...` };
      case 'stage_complete':
        return { role: 'system', text: `✓ ${e.payload?.stage || 'stage'} complete` };
      case 'file_generated': {
        const p = e.payload?.path || e.payload?.filePath;
        return p ? { role: 'system', text: `Wrote ${p}` } : null;
      }
      case 'info':
        return { role: 'system', text: e.message || 'Info received.' };
      case 'stage_error':
        return { role: 'error', text: e.message || 'Stage error' };
      case 'failed':
        return { role: 'error', text: e.message || 'Pipeline failed.' };
      case 'done':
        return { role: 'system', text: 'Project complete.' };
      default:
        return null;
    }
  }

  async function replayProjectEvents() {
    if (!projectId) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/events`);
    const json = await readJson(res);
    if (!res.ok || !Array.isArray(json.events)) return;

    const since = lastReplayedAtRef.current;
    const fresh = since
      ? json.events.filter((e) => (e.created_at || '') > since)
      : json.events;

    const restored = fresh.map(mapEventToMessage).filter((m) => m && m.text);
    if (fresh.length > 0) {
      lastReplayedAtRef.current = fresh[fresh.length - 1].created_at || lastReplayedAtRef.current;
    }

    for (const e of fresh) {
      if (e.event_type !== 'file_generated') continue;
      const path = e.payload?.path || e.payload?.filePath;
      if (!path) continue;
      upsertGeneratedFile({
        path,
        lines: typeof e.payload?.lines === 'number' ? e.payload.lines : undefined,
        bytes: typeof e.payload?.bytes === 'number' ? e.payload.bytes : undefined,
      });
    }

    if (restored.length === 0) return;
    setMessages((prev) => {
      const existing = new Set(prev.map((message) => `${message.role}\u0000${message.text}`));
      const unique = restored.filter((message) => {
        const key = `${message.role}\u0000${message.text}`;
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      return unique.length === 0 ? prev : [...prev, ...unique];
    });
  }

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

    const MAX_BACKOFF_MS = 15_000;
    const PING_INTERVAL_MS = 25_000;

    function clearTimers() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (!shouldReconnectRef.current) return;
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
      setReconnectInSec(Math.ceil(delay / 1000));
      setConnection('reconnecting');
      pushMessage('system', `Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${attempt})…`);

      const startedAt = Date.now();
      const tick = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((delay - (Date.now() - startedAt)) / 1000));
        setReconnectInSec(remaining);
        if (remaining <= 0) clearInterval(tick);
      }, 500);
      reconnectTimerRef.current = setTimeout(() => {
        clearInterval(tick);
        connect();
      }, delay);
    }

    function connect() {
      clearTimers();
      setConnection('connecting');
      setReconnectInSec(0);

      const ws = new WebSocket(makeSocketUrl(projectId));
      wsRef.current = ws;

      ws.onopen = () => {
        const wasReconnect = reconnectAttemptsRef.current > 0;
        reconnectAttemptsRef.current = 0;
        setConnection('connected');
        if (wasReconnect) {
          pushMessage('system', 'Reconnected. Restoring session…');
          // Replay any events the server persisted while we were disconnected.
          replayProjectEvents().catch(() => undefined);
        } else {
          pushMessage('system', `Connected to live build assistant for project ${projectId}.`);
        }
        // Application-level heartbeat so proxies don't kill idle connections
        // during long LLM stages.
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
          }
        }, PING_INTERVAL_MS);
      };

      ws.onclose = () => {
        clearTimers();
        if (shouldReconnectRef.current) {
          pushMessage('error', 'Socket disconnected. Attempting to reconnect…');
          scheduleReconnect();
        } else {
          setConnection('disconnected');
        }
      };

      ws.onerror = () => {
        // onclose will fire right after and handle reconnection
        setConnection('disconnected');
      };

      ws.onmessage = (event) => {
      let payload = event.data;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        // Server-side protocol events are always JSON. A parse failure here
        // means the frame was truncated/fragmented in transit — surfacing the
        // raw payload to the chat used to dump entire stage_complete frames
        // (with the full generated codebase inside) as an "assistant" message.
        // Log for debugging and show a discreet notice instead.
        // eslint-disable-next-line no-console
        console.warn('WS: dropped non-JSON frame', { size: typeof event.data === 'string' ? event.data.length : undefined, error: err });
        pushMessage('details', 'Dropped a malformed event from the server (see browser console).');
        return;
      }

      switch (payload.type) {
        case 'info':
          if (payload.stage === 'resume') {
            setPipelineActive(true);
            setCurrentActivity(payload.message || 'Resuming…');
          }
          pushMessage('system', payload.message || 'Info received.');
          break;
        case 'progress': {
          const pct = typeof payload.percent === 'number' ? payload.percent : 0;
          const p = Math.max(0, Math.min(1, pct / 100));
          setProgress(p);
          setStatusText(payload.message || payload.stage || 'Working');
          setStageStatus(payload.stage ? String(payload.stage) : '');
          setPipelineActive(p > 0 && p < 1);
          break;
        }
        case 'stage_start':
          setCurrentActivity(`Starting ${payload.stage}...`);
          setPipelineActive(true);
          pushMessage('system', payload.message || `Starting ${payload.stage}...`);
          break;
        case 'stage_complete':
          setCurrentActivity('');
          pushMessage('system', `✓ ${payload.stage} complete`);
          break;
        case 'stage_error':
          pushMessage('details', `[${payload.stage}] ${payload.issue?.message || 'Stage error'}`);
          break;
        case 'stream':
          pushMessage('assistant', payload.token || '');
          break;
        case 'file_generated':
          if (payload.filePath) {
            setCurrentActivity(`Writing ${payload.filePath}...`);
            upsertGeneratedFile({
              path: payload.filePath,
              lines: typeof payload.lines === 'number' ? payload.lines : undefined,
              bytes: typeof payload.bytes === 'number' ? payload.bytes : undefined,
            });
            pushMessage('system', `Wrote ${payload.filePath}`);
          }
          break;
        case 'clarification_request': {
          const questions = Array.isArray(payload.questions) ? payload.questions : [];
          if (questions.length === 0) {
            pushMessage('assistant', 'Please clarify your request.');
          } else {
            questions.forEach((q) => pushMessage('assistant', q));
          }
          break;
        }
        case 'confirmation_request': {
          let summaryText = 'Ready to proceed?';
          if (payload.summary && typeof payload.summary === 'object') {
            try { summaryText = `Ready to proceed?\n\n${JSON.stringify(payload.summary, null, 2)}`; } catch { /* ignore */ }
          }
          pushMessage('assistant', `${summaryText}\n\nReply "yes" to confirm or "no" to cancel.`);
          break;
        }
        case 'done':
          setProgress(1);
          setStatusText('Complete');
          setPipelineActive(false);
          setCurrentActivity('');
          pushMessage('system', 'Project complete!');
          if (payload.frontendUrl) pushMessage('system', `🔗 Your deployed app: ${payload.frontendUrl}`);
          if (payload.backendUrl) pushMessage('system', `🛠 Backend URL: ${payload.backendUrl}`);
          break;
        case 'failed':
          setPipelineActive(false);
          setCurrentActivity('');
          {
            const issues = Array.isArray(payload.issues) ? payload.issues : [];
            const msg = issues.map((i) => i?.message).filter(Boolean).join('\n') || 'Pipeline failed.';
            pushMessage('error', msg);
          }
          break;
        case 'error':
          pushMessage('details', payload.message || 'Unknown error.');
          break;
        case 'pong':
          // heartbeat ack; nothing to do
          break;
        default:
          pushMessage('system', 'Received an unrecognized event from the server.');
          pushMessage('details', JSON.stringify(payload, null, 2));
      }
      };
    }

    connectRef.current = connect;
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    connect();

    return () => {
      shouldReconnectRef.current = false;
      clearTimers();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try { ws.close(); } catch { /* ignore */ }
      }
    };
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
            {(connection === 'disconnected' || connection === 'reconnecting') ? (
              <button
                className="topActionBtn ghost"
                type="button"
                onClick={() => {
                  reconnectAttemptsRef.current = 0;
                  connectRef.current?.();
                }}
                title="Reconnect now"
              >
                {connection === 'reconnecting' && reconnectInSec > 0
                  ? `Reconnect now (${reconnectInSec}s)`
                  : 'Reconnect now'}
              </button>
            ) : null}
          </div>
          {stageStatus ? <div className="socketSubStatus" title={stageStatus}>{stageStatus}</div> : null}
          {currentActivity ? <div className="currentActivityRow">Currently: {currentActivity}</div> : null}

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
                    <div className="generatedFileLines">{typeof file.lines === 'number' ? file.lines : 0} lines</div>
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

      <FileCodeDialog file={viewerFile} projectId={projectId} onClose={() => setViewerFile(null)} />
    </div>
  );
}
