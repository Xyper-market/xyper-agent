export function getApiBase() {
  const apiBase = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
  if (!apiBase) throw new Error('XYPER_API_BASE required');
  return apiBase;
}

export function getAgentToken() {
  const token = (process.env.XYPER_AGENT_TOKEN || '').trim();
  if (!token) throw new Error('XYPER_AGENT_TOKEN required');
  return token;
}

export async function apiPost(path, body = {}, { auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${getAgentToken()}`;
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

export async function apiGet(path, { auth = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${getAgentToken()}`;
  const res = await fetch(`${getApiBase()}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}
