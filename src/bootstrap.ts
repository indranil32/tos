import { INestApplication } from '@nestjs/common';
import express from 'express';

/** Shared HTTP setup for the server and the tests. */
export function configureApp(app: INestApplication) {
  app.use(express.json({ limit: '10mb' }));
  // EDIFACT interchanges arrive as text.
  app.use(express.text({ type: ['text/plain', 'application/edifact', 'application/EDIFACT'], limit: '20mb' }));
  app.enableShutdownHooks();
}
