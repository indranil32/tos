import { Controller, Get, Headers, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, Roles } from '../auth/decorators';
import { RequestContext, ROLES } from '../context';
import { ApiError } from '../errors';
import { EventStreamService } from './event-stream.service';

/**
 * GET /v1/stream: live domain events as Server-Sent Events.
 * Query: facility=CODE[,CODE] to narrow, types=a.b,c.d to filter, after=<event id> to replay (Last-Event-ID also works).
 * Clients send the bearer token in the Authorization header (fetch-based SSE), never in the URL.
 */
@Controller('v1/stream')
export class StreamController {
  constructor(private readonly stream: EventStreamService) {}

  @Get()
  @Roles(ROLES.viewer, ROLES.edi, ROLES.operator, ROLES.planner, ROLES.billing, ROLES.gate)
  async open(
    @Ctx() ctx: RequestContext,
    @Req() req: Request,
    @Res() res: Response,
    @Query('facility') facility?: string,
    @Query('types') types?: string,
    @Query('after') after?: string,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    if (!ctx.tenantId) throw ApiError.forbidden('Token is not bound to a tenant');
    const facilities = facility ? facility.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    if (facilities && ctx.allowedFacilities && facilities.some((f) => !ctx.allowedFacilities!.includes(f))) {
      throw ApiError.forbidden('Facility not in token scope');
    }
    const from = lastEventId ?? after;
    const afterId = from !== undefined && /^[0-9]+$/.test(from) ? Number(from) : undefined;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const unsubscribe = await this.stream.subscribe({
      ctx,
      facilities,
      types: types ? types.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      after: afterId,
      write: (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      },
    });
    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  }
}
