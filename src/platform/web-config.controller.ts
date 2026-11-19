import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from './auth/decorators';
import { APP_CONFIG, AppConfig } from './config';

/** Public settings the web app needs before sign-in. */
@Controller('v1/config')
export class WebConfigController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  get() {
    return {
      keycloakUrl: keycloakBase(this.config),
      defaultTenant: process.env.WEB_DEFAULT_TENANT ?? 'demo',
      clientId: process.env.WEB_OIDC_CLIENT_ID ?? 'tos-web',
    };
  }
}

/** Keycloak base URL: WEB_KEYCLOAK_URL, or derived from the platform issuer (https://kc/realms/platform -> https://kc). */
export function keycloakBase(config: AppConfig): string | null {
  if (process.env.WEB_KEYCLOAK_URL) return process.env.WEB_KEYCLOAK_URL.replace(/\/$/, '');
  const m = config.platformIssuer && /^(.*)\/realms\/[^/]+\/?$/.exec(config.platformIssuer);
  return m ? m[1] : null;
}
