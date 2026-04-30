import React, { useEffect, useRef, useState } from 'react';

function makeSocketUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

export default function App() {
  const [connection, setConnection] = useState('connecting');
  const [statusText, setStatusText] = useState('Initializing');
  const [progress, setProgress] = useState(0);
  const [input, setInput] = useState('');
  const [todayText, setTodayText] = useState('');
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: 'Connected UI. Ask me to build your project and I will start the flow.',
    },
  ]);

  const wsRef = useRef(null);
  const msgEndRef = useRef(null);

  useEffect(() => {
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    setTodayText(new Date().toLocaleDateString('en-US', options));
  }, []);

  function pushMessage(role, text) {
    setMessages((prev) => [...prev, { role, text }]);
  }

  useEffect(() => {
    const ws = new WebSocket(makeSocketUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnection('connected');
      pushMessage('system', 'Connected to live build assistant.');
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
  }, []);

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
        <section className="assistantLeft">
          <div className="assistantDate">{todayText}</div>
          <h1 className="assistantTitle">
            Hello, I am <span className="highlight">Courtney</span>
            <br />
            your personal assistant
          </h1>
          <p className="assistantDesc">I hope you have a cosy afternoon,</p>
          <div className="assistantQuestion">How can I help you today?</div>

          <div className="socketStatus">
            <span className={`socketChip socket-${connection}`}>{connection}</span>
            <span className="socketText" title={statusText}>
              {statusText}
            </span>
            <span className="socketPct">{Math.round(progress * 100)}%</span>
          </div>

          <div className="buildHint">Describe what to build and follow live progress below.</div>

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

          <div className="activityBox">
            {messages.slice(-6).map((m, idx) => (
              <div key={`${m.role}-${idx}`} className={`msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            <div ref={msgEndRef} />
          </div>
        </section>

        <section className="assistantRight">
          <div className="assistantImgBg">
            <img
              className="assistantImg"
              src="https://images.unsplash.com/photo-1511367461989-f85a21fda167?auto=format&fit=facearea&w=400&h=400&q=80"
              alt="Assistant"
            />
            <div className="assistantCircles">
              <div className="circle circle1"></div>
              <div className="circle circle2"></div>
              <div className="circle circle3"></div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
