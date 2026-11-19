import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService, Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { currentFacility, FacilityRow } from '../platform/facility';
import { code, parse } from '../platform/validation';
import { EquipmentService } from '../equipment/equipment.service';
import { INSTRUCTION_SELECT, WorkService, YARD_MOVES } from './work.service';

const QueueBody = z.object({
  code,
  name: z.string().min(1),
  powKind: z.enum(['VESSEL', 'YARD', 'RAIL', 'GATE', 'HOUSEKEEPING', 'CFS', 'DEPOT']),
  visitId: z.string().uuid().optional(),
  equipment: code.optional(),
  pool: code.optional(),
  priority: z.number().int().min(1).max(100).default(50),
});
const QueueStatusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) });
const AddBody = z.union([
  z.object({
    /** Plan new yard moves (housekeeping, shifts) for units in the yard. */
    moves: z.array(z.object({
      unitRef: z.string().trim().toUpperCase(),
      moveKind: z.enum(['YARD_SHIFT', 'HOUSEKEEPING']).default('HOUSEKEEPING'),
      toPosition: z.string().max(40).optional(),
    })).min(1).max(500),
  }),
  z.object({
    /** Put existing planned instructions (vessel discharge/load lists) into this queue, in this order. */
    instructionIds: z.array(z.string().uuid()).min(1).max(2000),
  }),
]);
const SequenceBody = z.object({ instructionIds: z.array(z.string().uuid()).min(1) });
const DeviceBody = z.object({ equipment: code, version: z.number().int().optional() });
const CompleteBody = DeviceBody.extend({
  toPosition: z.string().max(40).optional(),
  stowPosition: z.string().regex(/^[0-9]{6,7}$/, 'bay-row-tier, e.g. 0120682').optional(),
});
const RejectBody = DeviceBody.extend({ reason: z.string().min(1).max(200) });

const QUEUE_SELECT = `
  SELECT q.id, q.code, q.name, q.pow_kind AS "powKind", q.priority, q.status, v.visit_ref AS "visitRef",
         e.code AS equipment, p.code AS pool, q.created_at AS "createdAt",
         count(w.id) FILTER (WHERE w.status = 'PLANNED')::int AS planned,
         count(w.id) FILTER (WHERE w.status IN ('DISPATCHED','IN_PROGRESS'))::int AS active,
         count(w.id) FILTER (WHERE w.status = 'COMPLETED')::int AS completed
    FROM work_queues q
    LEFT JOIN vessel_visits v ON v.id = q.visit_id
    LEFT JOIN equipment e ON e.id = q.equipment_id
    LEFT JOIN equipment_pools p ON p.id = q.pool_id
    LEFT JOIN work_instructions w ON w.work_queue_id = q.id`;
const QUEUE_GROUP = ' GROUP BY q.id, v.visit_ref, e.code, p.code';

/** Work queues (planning side) and the job API used by machines and their apps (execution side). */
@Controller('v1')
@FacilityScoped()
export class WorkController {
  constructor(
    private readonly db: DatabaseService,
    private readonly work: WorkService,
    private readonly equipment: EquipmentService,
    private readonly events: EventsService,
  ) {}

  @Post('work-queues')
  @Roles(ROLES.planner)
  createQueue(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(QueueBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      if (b.powKind === 'VESSEL' && !b.visitId) throw ApiError.invalid('A VESSEL queue needs visitId');
      if (!b.equipment && !b.pool) throw ApiError.invalid('Give the queue a dedicated machine (equipment) or a pool');
      const visit = b.visitId
        ? await tx.must<{ id: string }>('SELECT id FROM vessel_visits WHERE facility_id = $1 AND id = $2', [f.id, b.visitId], 'Visit')
        : null;
      const eq = b.equipment ? await this.equipment.byCode(tx, f.id, b.equipment) : null;
      const pool = b.pool
        ? await tx.must<{ id: string }>('SELECT id FROM equipment_pools WHERE facility_id = $1 AND code = $2', [f.id, b.pool], `Pool ${b.pool}`)
        : null;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO work_queues (tenant_id, facility_id, code, name, pow_kind, visit_id, equipment_id, pool_id, priority)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [f.id, b.code, b.name, b.powKind, visit?.id ?? null, eq?.id ?? null, pool?.id ?? null, b.priority],
      );
      await this.events.emit(tx, ctx, {
        type: 'work_queue.created', aggregateType: 'work_queue', aggregateId: row!.id, facilityId: f.id,
        payload: { code: b.code, powKind: b.powKind, equipment: b.equipment ?? null, pool: b.pool ?? null },
      });
      return this.queue(tx, f.id, b.code);
    });
  }

  @Get('work-queues')
  listQueues(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(`${QUEUE_SELECT} WHERE q.facility_id = $1 ${QUEUE_GROUP} ORDER BY q.status, q.priority, q.code`, [f.id]);
    });
  }

  @Get('work-queues/:code')
  getQueue(@Ctx() ctx: RequestContext, @Param('code') qCode: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const q = await this.queue(tx, f.id, qCode);
      const instructions = await tx.many(
        `${INSTRUCTION_SELECT} WHERE w.work_queue_id = $1
          ORDER BY CASE w.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'DISPATCHED' THEN 1 WHEN 'PLANNED' THEN 2 ELSE 3 END,
                   w.sequence NULLS LAST, w.completed_at DESC NULLS LAST`,
        [q.id],
      );
      return { ...q, instructions };
    });
  }

  @Post('work-queues/:code/status')
  @Roles(ROLES.planner, ROLES.operator)
  setQueueStatus(@Ctx() ctx: RequestContext, @Param('code') qCode: string, @Body() body: unknown) {
    const b = parse(QueueStatusBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const q = await this.queue(tx, f.id, qCode);
      if (b.status === 'CLOSED' && q.active > 0) throw ApiError.conflict('queue_busy', `${qCode} has ${q.active} job(s) in progress`);
      await tx.exec('UPDATE work_queues SET status = $2 WHERE id = $1', [q.id, b.status]);
      if (b.status === 'CLOSED') {
        await tx.exec(`UPDATE work_instructions SET work_queue_id = NULL, sequence = NULL WHERE work_queue_id = $1 AND status = 'PLANNED'`, [q.id]);
      }
      await this.events.emit(tx, ctx, {
        type: 'work_queue.status_changed', aggregateType: 'work_queue', aggregateId: q.id, facilityId: f.id,
        payload: { code: qCode, from: q.status, to: b.status },
      });
      return this.queue(tx, f.id, qCode);
    });
  }

  @Post('work-queues/:code/instructions')
  @Roles(ROLES.planner)
  add(@Ctx() ctx: RequestContext, @Param('code') qCode: string, @Body() body: unknown) {
    const b = parse(AddBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const q = await this.queue(tx, f.id, qCode, true);
      if (q.status === 'CLOSED') throw ApiError.conflict('queue_closed', `${qCode} is closed`);
      let seq = (await tx.one<{ n: number }>('SELECT coalesce(max(sequence), 0)::int AS n FROM work_instructions WHERE work_queue_id = $1', [q.id]))!.n;
      const ids: string[] = [];
      if ('moves' in b) {
        for (const m of b.moves) {
          const unit = await tx.one<{ id: string; state: string }>(
            `SELECT id, state FROM units WHERE facility_id = $1 AND unit_ref = $2 AND state <> 'DEPARTED'`,
            [f.id, m.unitRef],
          );
          if (!unit) throw ApiError.notFound(`Unit ${m.unitRef}`);
          if (unit.state !== 'IN_YARD') throw ApiError.conflict('not_in_yard', `${m.unitRef} is ${unit.state}`);
          const open = await tx.one(
            `SELECT 1 FROM work_instructions WHERE unit_id = $1 AND move_kind = ANY($2) AND status IN ('PLANNED','DISPATCHED','IN_PROGRESS')`,
            [unit.id, YARD_MOVES],
          );
          if (open) throw ApiError.conflict('move_exists', `${m.unitRef} already has an open yard move`);
          if (m.toPosition) await this.workYardCheck(tx, f, m.toPosition);
          const row = await tx.one<{ id: string }>(
            `INSERT INTO work_instructions (tenant_id, facility_id, unit_id, move_kind, planned_position, work_queue_id, sequence)
             VALUES (current_tenant(), $1,$2,$3,$4,$5,$6) RETURNING id`,
            [f.id, unit.id, m.moveKind, m.toPosition ?? null, q.id, ++seq],
          );
          ids.push(row!.id);
        }
      } else {
        for (const id of b.instructionIds) {
          const wi = await tx.one<{ status: string; visit_id: string | null; work_queue_id: string | null }>(
            'SELECT status, visit_id, work_queue_id FROM work_instructions WHERE facility_id = $1 AND id = $2 FOR UPDATE',
            [f.id, id],
          );
          if (!wi) throw ApiError.notFound(`Work instruction ${id}`);
          if (wi.status !== 'PLANNED') throw ApiError.conflict('not_planned', `Instruction ${id} is ${wi.status}`);
          if (q.visitId && wi.visit_id !== q.visitId) throw ApiError.invalid(`Instruction ${id} belongs to another visit`);
          await tx.exec('UPDATE work_instructions SET work_queue_id = $2, sequence = $3, version = version + 1 WHERE id = $1', [id, q.id, ++seq]);
          ids.push(id);
        }
      }
      await this.events.emit(tx, ctx, {
        type: 'work_queue.planned', aggregateType: 'work_queue', aggregateId: q.id, facilityId: f.id,
        payload: { code: qCode, added: ids.length },
      });
      return { queue: qCode, added: ids.length, instructionIds: ids };
    });
  }

  /** Re-order the planned moves of a queue. Moves already with a machine keep their place. */
  @Put('work-queues/:code/sequence')
  @Roles(ROLES.planner)
  resequence(@Ctx() ctx: RequestContext, @Param('code') qCode: string, @Body() body: unknown) {
    const b = parse(SequenceBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const q = await this.queue(tx, f.id, qCode, true);
      const planned = (await tx.many<{ id: string }>(
        `SELECT id FROM work_instructions WHERE work_queue_id = $1 AND status = 'PLANNED' FOR UPDATE`, [q.id],
      )).map((r) => r.id);
      const given = new Set(b.instructionIds);
      if (given.size !== b.instructionIds.length || planned.length !== given.size || planned.some((id) => !given.has(id))) {
        throw ApiError.invalid('instructionIds must list every PLANNED instruction of the queue exactly once');
      }
      const base = (await tx.one<{ n: number }>(
        `SELECT coalesce(max(sequence), 0)::int AS n FROM work_instructions WHERE work_queue_id = $1 AND status <> 'PLANNED'`, [q.id],
      ))!.n;
      for (const [i, id] of b.instructionIds.entries()) {
        await tx.exec('UPDATE work_instructions SET sequence = $2, version = version + 1 WHERE id = $1', [id, base + i + 1]);
      }
      return this.getQueueIn(tx, f.id, qCode);
    });
  }

  @Get('work-instructions')
  listInstructions(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('equipment') eq?: string,
    @Query('unassigned') unassigned?: string,
  ) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `${INSTRUCTION_SELECT}
          WHERE w.facility_id = $1 AND ($2::text IS NULL OR w.status = $2) AND ($3::text IS NULL OR e.code = $3)
            AND ($4::boolean IS NOT TRUE OR w.work_queue_id IS NULL)
          ORDER BY w.created_at DESC LIMIT 2000`,
        [f.id, status ?? null, eq ?? null, unassigned === 'true' ? true : null],
      );
    });
  }

  /** A machine asks for work: returns its current job, or dispatches the next one (null when there is none). */
  @Post('dispatch/next')
  @Roles(ROLES.operator)
  next(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(DeviceBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const eq = await this.equipment.byCode(tx, f.id, b.equipment, true);
      return { job: await this.work.next(tx, ctx, f, eq) };
    });
  }

  @Post('work-instructions/:id/start')
  @Roles(ROLES.operator)
  start(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(DeviceBody, body);
    return this.device(ctx, b.equipment, (tx, f, eq) => this.work.start(tx, ctx, f, id, eq, b.version));
  }

  @Post('work-instructions/:id/complete')
  @Roles(ROLES.operator)
  complete(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(CompleteBody, body);
    return this.device(ctx, b.equipment, (tx, f, eq) => this.work.complete(tx, ctx, f, id, eq, b));
  }

  @Post('work-instructions/:id/reject')
  @Roles(ROLES.operator)
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(RejectBody, body);
    return this.device(ctx, b.equipment, (tx, f, eq) => this.work.reject(tx, ctx, f, id, eq, b.reason, b.version));
  }

  private device<T>(ctx: RequestContext, eqCode: string, fn: (tx: Tx, f: FacilityRow, eq: Awaited<ReturnType<EquipmentService['byCode']>>) => Promise<T>) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const eq = await this.equipment.byCode(tx, f.id, eqCode, true);
      return fn(tx, f, eq);
    });
  }

  private async queue(tx: Tx, facilityId: string, qCode: string, lock = false) {
    if (lock) await tx.must('SELECT id FROM work_queues WHERE facility_id = $1 AND code = $2 FOR UPDATE', [facilityId, qCode], `Work queue ${qCode}`);
    const q = await tx.must<{ id: string; status: string; active: number; visitId?: string }>(
      `${QUEUE_SELECT} WHERE q.facility_id = $1 AND q.code = $2 ${QUEUE_GROUP}`,
      [facilityId, qCode],
      `Work queue ${qCode}`,
    );
    const v = await tx.one<{ visit_id: string | null }>('SELECT visit_id FROM work_queues WHERE id = $1', [q.id]);
    return { ...q, visitId: v?.visit_id ?? undefined };
  }

  private async getQueueIn(tx: Tx, facilityId: string, qCode: string) {
    const q = await this.queue(tx, facilityId, qCode);
    const instructions = await tx.many(`${INSTRUCTION_SELECT} WHERE w.work_queue_id = $1 AND w.status = 'PLANNED' ORDER BY w.sequence`, [q.id]);
    return { ...q, instructions };
  }

  private async workYardCheck(tx: Tx, f: FacilityRow, position: string) {
    const block = position.split('-')[0];
    await tx.must(
      'SELECT 1 FROM yard_blocks b JOIN yards y ON y.id = b.yard_id WHERE y.facility_id = $1 AND b.code = $2',
      [f.id, block],
      `Yard block in ${position}`,
    );
  }
}
