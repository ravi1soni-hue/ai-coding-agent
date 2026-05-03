export function makeSocketUrl(projectId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return `${proto}://${window.location.host}/${suffix}`;
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
