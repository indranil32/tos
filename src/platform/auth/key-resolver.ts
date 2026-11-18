import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Resolves the signing keys for an OIDC issuer.
 * Default: OpenID discovery (/.well-known/openid-configuration -> jwks_uri), cached per issuer.
 * Works with Keycloak, Entra ID, Okta, Auth0, ADFS (OIDC) and UAE PASS. SAML IdPs are federated
 * through the identity broker (e.g. Keycloak), which then issues OIDC tokens to this API.
 *
 * OIDC_URL_REWRITE (e.g. "http://localhost:8080=http://keycloak:8080") lets a container reach an
 * IdP whose public URL differs from its internal one; the issuer claim itself is never rewritten.
 */
@Injectable()
export class KeyResolver {
  private readonly cache = new Map<string, JWTVerifyGetKey>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async forIssuer(issuer: string): Promise<JWTVerifyGetKey> {
    const hit = this.cache.get(issuer);
    if (hit) return hit;
    const res = await fetch(this.rewrite(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`));
    if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${res.status}`);
    const meta = (await res.json()) as { jwks_uri?: string; issuer?: string };
    if (!meta.jwks_uri) throw new Error(`No jwks_uri for ${issuer}`);
    if (meta.issuer && meta.issuer !== issuer) throw new Error(`Issuer mismatch in discovery for ${issuer}`);
    const jwks = createRemoteJWKSet(new URL(this.rewrite(meta.jwks_uri)));
    this.cache.set(issuer, jwks);
    return jwks;
  }

  private rewrite(url: string): string {
    for (const [from, to] of this.config.oidcUrlRewrites) {
      if (url.startsWith(from)) return to + url.slice(from.length);
    }
    return url;
  }
}
