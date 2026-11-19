#!/usr/bin/env node
// Development-only OIDC provider (NOT for production): lets you run the web app and tests without Keycloak.
// Realms are URL segments like Keycloak (/realms/<name>). Supports discovery, JWKS, authorization code + PKCE
// (auto-approves as the user in ?login_hint or DEV_IDP_USER, default "admin"), refresh tokens and password grant.
// Usage: node scripts/dev-idp.mjs [port=8099]
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { exportJWK, generateKeyPair, SignJWT } = require('jose');

const PORT = Number(process.argv[2] ?? process.env.DEV_IDP_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.DEV_IDP_PASSWORD ?? 'pw';
const USERS = {
  'platform/operator': { roles: ['platform:admin'], name: 'Platform Operator' },
  'demo/admin': { roles: ['tos:admin'], name: 'Demo Admin' },
  'demo/gate': { roles: ['tos:gate', 'tos:viewer'], name: 'Gate Clerk' },
  'demo/viewer': { roles: ['tos:viewer'], name: 'Read Only' },
};
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256', use: 'sig' };
const codes = new Map();
const refresh = new Map();

async function tokens(realm, user, clientId, nonce) {
  const iss = `${BASE}/realms/${realm}`;
  const u = USERS[`${realm}/${user}`];
  const sign = (claims, exp) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'dev' }).setIssuer(iss).setSubject(user)
    .setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const rt = randomBytes(16).toString('hex');
  refresh.set(rt, { realm, user, clientId });
  return {
    access_token: await sign({ realm_access: { roles: u.roles }, preferred_username: user, name: u.name, azp: clientId }, '10m'),
    id_token: await sign({ aud: clientId, nonce, preferred_username: user, name: u.name }, '10m'),
    refresh_token: rt, token_type: 'Bearer', expires_in: 600, scope: 'openid profile email',
  };
}

const cors = (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); };
const json = (res, body, status = 200) => { cors(res); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const m = /^\/realms\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (!m) { res.writeHead(404); return res.end(); }
  const [, realm, rest] = m;
  const iss = `${BASE}/realms/${realm}`;
  if (rest === '/.well-known/openid-configuration') {
    return json(res, {
      issuer: iss, jwks_uri: `${iss}/protocol/openid-connect/certs`, authorization_endpoint: `${iss}/protocol/openid-connect/auth`,
      token_endpoint: `${iss}/protocol/openid-connect/token`, end_session_endpoint: `${iss}/protocol/openid-connect/logout`,
      userinfo_endpoint: `${iss}/protocol/openid-connect/userinfo`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
    });
  }
  if (rest === '/protocol/openid-connect/certs') return json(res, { keys: [jwk] });
  if (rest === '/protocol/openid-connect/auth') {
    const user = url.searchParams.get('login_hint') || process.env.DEV_IDP_USER || 'admin';
    if (!USERS[`${realm}/${user}`]) { res.writeHead(400); return res.end(`unknown user ${user} in realm ${realm}`); }
    const code = randomBytes(12).toString('hex');
    codes.set(code, { realm, user, clientId: url.searchParams.get('client_id'), nonce: url.searchParams.get('nonce'),
      challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
    const to = new URL(url.searchParams.get('redirect_uri'));
    to.searchParams.set('code', code);
    to.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(302, { Location: to.toString() });
    return res.end();
  }
  if (rest === '/protocol/openid-connect/logout') {
    res.writeHead(302, { Location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
    return res.end();
  }
  if (rest === '/protocol/openid-connect/userinfo') return json(res, {});
  if (rest === '/protocol/openid-connect/token' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const verifier = p.get('code_verifier') ?? '';
      const ok = c && createHash('sha256').update(verifier).digest('base64url') === c.challenge && c.redirect === p.get('redirect_uri');
      if (!ok) return json(res, { error: 'invalid_grant' }, 400);
      return json(res, await tokens(c.realm, c.user, c.clientId, c.nonce));
    }
    if (grant === 'refresh_token') {
      const r = refresh.get(p.get('refresh_token'));
      if (!r) return json(res, { error: 'invalid_grant' }, 400);
      return json(res, await tokens(r.realm, r.user, r.clientId));
    }
    if (grant === 'password') {
      const user = p.get('username');
      if (!USERS[`${realm}/${user}`] || p.get('password') !== PASSWORD) return json(res, { error: 'invalid_grant' }, 401);
      return json(res, await tokens(realm, user, p.get('client_id')));
    }
    return json(res, { error: 'unsupported_grant_type' }, 400);
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => console.log(`dev OIDC provider on ${BASE} (password "${PASSWORD}")`));
