#!/usr/bin/env node
// Creates or updates the public "tos-web" OIDC client (authorization code + PKCE) in a Keycloak realm.
// Realm imports only run once, so existing installations get new clients through the admin API.
// Env: KC_URL, KC_ADMIN_PASSWORD, APP_URL (the web app origin), REALM (default demo), KC_ADMIN_USER (default admin)
const KC = process.env.KC_URL?.replace(/\/$/, '');
const APP = process.env.APP_URL?.replace(/\/$/, '');
const REALM = process.env.REALM ?? 'demo';
if (!KC || !APP || !process.env.KC_ADMIN_PASSWORD) {
  console.error('KC_URL, APP_URL and KC_ADMIN_PASSWORD are required');
  process.exit(2);
}
const tokenRes = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_ADMIN_USER ?? 'admin', password: process.env.KC_ADMIN_PASSWORD }),
});
if (!tokenRes.ok) throw new Error(`admin login failed: ${tokenRes.status}`);
const { access_token } = await tokenRes.json();
const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

const client = {
  clientId: 'tos-web',
  name: 'TOS web app',
  publicClient: true,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: false,
  implicitFlowEnabled: false,
  redirectUris: [`${APP}/*`],
  webOrigins: [APP],
  attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${APP}/*` },
};
const existing = await (await fetch(`${KC}/admin/realms/${REALM}/clients?clientId=tos-web`, { headers })).json();
if (existing.length) {
  const merged = {
    ...existing[0], ...client,
    redirectUris: [...new Set([...(existing[0].redirectUris ?? []), ...client.redirectUris])],
    webOrigins: [...new Set([...(existing[0].webOrigins ?? []), ...client.webOrigins])],
    attributes: { ...(existing[0].attributes ?? {}), ...client.attributes },
  };
  const r = await fetch(`${KC}/admin/realms/${REALM}/clients/${existing[0].id}`, { method: 'PUT', headers, body: JSON.stringify(merged) });
  if (!r.ok) throw new Error(`update failed: ${r.status} ${await r.text()}`);
  console.log(`tos-web client updated in realm ${REALM} for ${APP}`);
} else {
  const r = await fetch(`${KC}/admin/realms/${REALM}/clients`, { method: 'POST', headers, body: JSON.stringify(client) });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  console.log(`tos-web client created in realm ${REALM} for ${APP}`);
}
