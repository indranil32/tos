import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/** Domain error rendered as RFC 9457 problem+json. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  static notFound(what: string) {
    return new ApiError(404, 'not_found', `${what} not found`);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new ApiError(409, code, message, details);
  }
  static invalid(message: string, details?: unknown) {
    return new ApiError(422, 'validation_failed', message, details);
  }
  static forbidden(message = 'Forbidden') {
    return new ApiError(403, 'forbidden', message);
  }
  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, 'unauthorized', message);
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let body: Record<string, unknown> = { type: 'about:blank', title: 'internal_error', detail: 'Unexpected error' };

    if (err instanceof ApiError) {
      status = err.status;
      body = { type: 'about:blank', title: err.code, detail: err.message, ...(err.details ? { errors: err.details } : {}) };
    } else if (err instanceof ZodError) {
      status = 422;
      body = {
        type: 'about:blank',
        title: 'validation_failed',
        detail: 'Request body is invalid',
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      body = { type: 'about:blank', title: 'http_error', detail: err.message };
    } else if (isPgError(err)) {
      const mapped = mapPgError(err);
      status = mapped.status;
      body = { type: 'about:blank', title: mapped.code, detail: mapped.message };
    } else {
      // eslint-disable-next-line no-console
      console.error(err);
    }
    res.status(status).type('application/problem+json').send(JSON.stringify({ status, ...body }));
  }
}

interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
}
function isPgError(e: unknown): e is PgError {
  return typeof e === 'object' && e !== null && typeof (e as PgError).code === 'string' && /^[0-9A-Z]{5}$/.test((e as PgError).code);
}
function mapPgError(e: PgError): { status: number; code: string; message: string } {
  switch (e.code) {
    case '23505':
      return { status: 409, code: 'duplicate', message: `Already exists (${e.constraint ?? 'unique'})` };
    case '23503':
      return { status: 422, code: 'invalid_reference', message: `Referenced record does not exist (${e.constraint ?? 'fk'})` };
    case '23514':
      return { status: 422, code: 'validation_failed', message: `Value rejected (${e.constraint ?? 'check'})` };
    case '42501':
      return { status: 403, code: 'forbidden', message: 'Row-level security rejected the write' };
    default:
      return { status: 500, code: 'database_error', message: 'Database error' };
  }
}
