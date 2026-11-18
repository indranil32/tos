export interface AppConfig {
  port: number;
  /** Connection used by the running app. Must be a non-superuser role so row-level security applies. */
  appDatabaseUrl: string;
  /** Owner connection used only for migrations. */
  ownerDatabaseUrl?: string;
  /** Role that receives table grants after migrations (the role in appDatabaseUrl). */
  appDbRole: string;
  /** Issuer of the platform-operator realm (tenant provisioning). */
  platformIssuer?: string;
  /** Expected audience in access tokens; unset = not checked. */
  oidcAudience?: string;
  /** Allowed issuer prefixes, e.g. https://id.example.com/realms/ — protects against arbitrary issuers. */
  trustedIssuerPrefixes: string[];
  /** Internal URL rewrites for OIDC discovery/JWKS fetches: [publicPrefix, internalPrefix]. */
  oidcUrlRewrites: [string, string][];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appDatabaseUrl = env.APP_DATABASE_URL ?? env.DATABASE_URL;
  if (!appDatabaseUrl) throw new Error('APP_DATABASE_URL (or DATABASE_URL) must be set');
  return {
    port: Number(env.PORT ?? 3000),
    appDatabaseUrl,
    ownerDatabaseUrl: env.OWNER_DATABASE_URL,
    appDbRole: env.APP_DB_ROLE ?? 'tos_app',
    platformIssuer: env.PLATFORM_OIDC_ISSUER,
    oidcAudience: env.OIDC_AUDIENCE || undefined,
    trustedIssuerPrefixes: (env.TRUSTED_ISSUER_PREFIXES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    oidcUrlRewrites: (env.OIDC_URL_REWRITE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.includes('='))
      .map((s) => s.split('=', 2) as [string, string]),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
