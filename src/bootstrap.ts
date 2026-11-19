import { INestApplication } from '@nestjs/common';
import express, { NextFunction, Request, Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './platform/config';
import { keycloakBase } from './platform/web-config.controller';

/** Where the built web app lives: WEB_DIST, or ./public next to dist/ in the image. */
export function webDir(): string | null {
  const candidates = [process.env.WEB_DIST, join(__dirname, '..', 'public'), join(__dirname, '..', 'web', 'dist')].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, 'index.html'))) ?? null;
}

/** Shared HTTP setup for the server and the tests. */
export function configureApp(app: INestApplication) {
  app.use(express.json({ limit: '10mb' }));
  // EDIFACT interchanges arrive as text.
  app.use(express.text({ type: ['text/plain', 'application/edifact', 'application/EDIFACT'], limit: '20mb' }));
  app.use(securityHeaders);
  serveWeb(app);
  app.enableShutdownHooks();
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

/** Single-page app: static assets, and index.html for every non-API GET so client-side routes work. */
function serveWeb(app: INestApplication) {
  const dir = webDir();
  if (!dir) return;
  let kc = '';
  try {
    kc = keycloakBase(loadConfig()) ?? '';
  } catch {
    kc = '';
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${kc}`.trim(),
    `form-action 'self' ${kc}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; ');
  app.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '365d', index: false }));
  app.use(express.static(dir, { index: false, maxAge: '1h' }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/v1/') || req.path === '/health' || !req.accepts('html')) return next();
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(dir, 'index.html'));
  });
}
