import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';

export interface WebConfig {
  keycloakUrl: string;
  defaultTenant: string;
  clientId: string;
}

let config: WebConfig | null = null;
let manager: UserManager | null = null;

export async function loadConfig(): Promise<WebConfig> {
  if (config) return config;
  const res = await fetch('/v1/config');
  if (!res.ok) throw new Error('Cannot load configuration');
  config = (await res.json()) as WebConfig;
  return config;
}

/** One identity-provider realm per tenant: realm name = tenant code. */
export function currentTenant(): string | null {
  return localStorage.getItem('tos.tenant');
}

export async function userManager(tenant = currentTenant()): Promise<UserManager> {
  const cfg = await loadConfig();
  if (!tenant) throw new Error('No tenant selected');
  if (manager && manager.settings.authority.endsWith(`/realms/${tenant}`)) return manager;
  manager = new UserManager({
    authority: `${cfg.keycloakUrl}/realms/${tenant}`,
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/callback`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true, // uses the refresh token, no iframe
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
  return manager;
}

export async function login(tenant: string) {
  localStorage.setItem('tos.tenant', tenant);
  const um = await userManager(tenant);
  await um.signinRedirect({ state: { returnTo: window.location.pathname === '/login' ? '/' : window.location.pathname } });
}

let completing: Promise<string> | null = null;
/** Idempotent: the callback code can be exchanged only once. */
export function completeLogin(): Promise<string> {
  completing ??= (async () => {
    const um = await userManager();
    const user = await um.signinRedirectCallback();
    return ((user.state as { returnTo?: string } | undefined)?.returnTo) ?? '/';
  })();
  return completing;
}

export async function currentUser(): Promise<User | null> {
  if (!currentTenant()) return null;
  const um = await userManager();
  const u = await um.getUser();
  return u && !u.expired ? u : null;
}

export async function logout() {
  const um = await userManager();
  await um.signoutRedirect();
}

/** Realm roles from the access token (tos:admin implies all tos:* roles, as on the server). */
export function rolesOf(user: User): string[] {
  try {
    const payload = JSON.parse(atob(user.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return [...new Set([...(payload.roles ?? []), ...(payload.realm_access?.roles ?? [])])];
  } catch {
    return [];
  }
}

export function can(roles: string[], ...needed: string[]): boolean {
  return roles.includes('tos:admin') || needed.some((r) => roles.includes(r));
}
