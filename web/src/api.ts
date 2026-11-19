import { currentUser, login, currentTenant } from './auth';

export class ApiError extends Error {
  constructor(public status: number, public title: string, message: string, public errors?: { path?: string; message: string; unitRef?: string }[]) {
    super(message);
  }
}

export function currentFacility(): string | null {
  return localStorage.getItem('tos.facility');
}
export function setFacility(code: string) {
  localStorage.setItem('tos.facility', code);
}

async function request<T>(method: string, path: string, body?: unknown, opts: { text?: boolean; facility?: boolean } = {}): Promise<T> {
  const user = await currentUser();
  if (!user) {
    const tenant = currentTenant();
    if (tenant) await login(tenant);
    throw new ApiError(401, 'unauthorized', 'Signing in…');
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${user.access_token}` };
  const facility = currentFacility();
  if (opts.facility !== false && facility) headers['X-Facility'] = facility;
  const raw = typeof body === 'string' && opts.text;
  if (body !== undefined) headers['Content-Type'] = raw ? 'application/edifact' : 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body) });
  if (!res.ok && !(opts.text && method === 'POST' && res.status === 422)) {
    let problem: { title?: string; detail?: string; error?: string; errors?: ApiError['errors'] } = {};
    try {
      problem = await res.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, problem.title ?? 'error', problem.detail ?? problem.error ?? res.statusText, problem.errors);
  }
  if (opts.text && method === 'GET') return (await res.text()) as T;
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string, opts?: { text?: boolean; facility?: boolean }) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  /** Raw EDIFACT upload; returns the APERAK-style JSON answer even when the message is rejected. */
  postEdi: <T>(path: string, text: string) => request<T>('POST', path, text, { text: true }),
};
