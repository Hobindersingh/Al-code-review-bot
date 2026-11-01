const KEY = 'aicr_api_key';
export class AuthError extends Error {}

export const getKey = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const setKey = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export async function api(path, { method = 'GET', body, signal } = {}) {
  const key = getKey();
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('This dashboard needs an API key.');
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}
