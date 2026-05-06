function getBackendOrigin() {
  const viteBackendUrl = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_BACKEND_URL : '';
  if (viteBackendUrl) return viteBackendUrl.replace(/\/$/, '');

  const { protocol, hostname, port } = window.location;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const viteBackendPort = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_BACKEND_PORT
    ? String(import.meta.env.VITE_BACKEND_PORT)
    : '';

  // In dev the frontend usually runs on Vite (5173) while the backend may run on a separate port.
  // Use VITE_BACKEND_URL or VITE_BACKEND_PORT when provided, otherwise fall back to the default 3000 backend port.
  if (isLocalhost && viteBackendPort) {
    return `${protocol}//${hostname}:${viteBackendPort}`;
  }

  if (isLocalhost && port && port !== '3000') {
    const backendPort = viteBackendPort || '3000';
    return `${protocol}//${hostname}:${backendPort}`;
  }

  return `${protocol}//${window.location.host}`;
}

export function makeSocketUrl(projectId) {
  const baseUrl = getBackendOrigin();
  const wsProtocol = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
  const url = new URL(baseUrl);
  url.protocol = wsProtocol;
  url.pathname = '/';
  url.search = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return url.toString();
}

export async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function buildDetailedLogPayload({ user, projectId, connection, statusText, progress, stageStatus, messages }) {
  return JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      user: user ? { name: user.name || '', email: user.email || '', id: user.id || '' } : null,
      projectId,
      connection,
      statusText,
      progress,
      stageStatus,
      messageCount: messages.length,
      messages,
    },
    null,
    2,
  );
}

export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
