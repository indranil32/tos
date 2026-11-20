import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService, Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { currentFacility } from '../platform/facility';
import { code, parse } from '../platform/validation';
import { YardAllocator } from './yard-allocator';

const RangeBody = z.object({
  name: z.string().min(1).max(60),
  block: code,
  bayFrom: z.number().int().min(1),
  bayTo: z.number().int().min(1),
  rowFrom: z.number().int().min(1).default(1),
  rowTo: z.number().int().min(1).optional(),
  purpose: z.enum(['ANY', 'EXPORT', 'IMPORT', 'EMPTY', 'TRANSSHIP']).default('ANY'),
  visitId: z.string().uuid().optional(),
  pod: z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/, 'UN/LOCODE').optional(),
  line: code.optional(),
  size: z.enum(['20', '40', '45']).optional(),
  weightClass: z.enum(['L', 'M', 'H']).optional(),
  reefer: z.boolean().optional(),
  priority: z.number().int().min(1).max(100).default(50),
});
const PreviewBody = z.object({ unitRef: z.string().trim().toUpperCase(), block: code.optional() });

const RANGE_COLS = `r.id, r.name, b.code AS block, r.bay_from AS "bayFrom", r.bay_to AS "bayTo", r.row_from AS "rowFrom", r.row_to AS "rowTo",
  r.purpose, v.visit_ref AS "visitRef", r.visit_id AS "visitId", r.pod, r.line_code AS line, r.size, r.weight_class AS "weightClass",
  r.reefer, r.priority, r.active, r.created_at AS "createdAt",
  (SELECT count(*)::int FROM units u WHERE u.yard_block_id = r.block_id AND u.state = 'IN_YARD'
      AND split_part(u.yard_position, '-', 2)::int BETWEEN r.bay_from AND r.bay_to
      AND split_part(u.yard_position, '-', 3)::int BETWEEN r.row_from AND r.row_to) AS occupied,
  (r.bay_to - r.bay_from + 1) * (r.row_to - r.row_from + 1) * b.tiers AS slots`;

/** Yard picture for the yard view: every block with its occupied slots. */
@Controller('v1/yard')
@FacilityScoped()
export class YardController {
  constructor(
    private readonly db: DatabaseService,
    private readonly yard: YardAllocator,
    private readonly events: EventsService,
  ) {}

  /** Planner ranges: parts of blocks reserved for a group of cargo (exports for a vessel and POD, empties of a line ...). */
  @Get('ranges')
  ranges(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return this.rangeList(tx, f.id);
    });
  }

  @Post('ranges')
  @Roles(ROLES.planner)
  createRange(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(RangeBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const block = await tx.must<{ id: string; bays: number; rows_count: number; block_type: string }>(
        `SELECT b.id, b.bays, b.rows_count, b.block_type FROM yard_blocks b JOIN yards y ON y.id = b.yard_id WHERE y.facility_id = $1 AND b.code = $2`,
        [f.id, b.block],
        `Block ${b.block}`,
      );
      if (block.block_type !== 'CONTAINER_STACK') throw ApiError.invalid('Ranges apply to container stacks');
      const rowTo = b.rowTo ?? block.rows_count;
      if (b.bayTo < b.bayFrom || rowTo < b.rowFrom) throw ApiError.invalid('bayTo/rowTo must not be before bayFrom/rowFrom');
      if (b.bayTo > block.bays || rowTo > block.rows_count) {
        throw ApiError.invalid(`${b.block} has ${block.bays} bays and ${block.rows_count} rows`);
      }
      if (b.visitId) await tx.must('SELECT 1 FROM vessel_visits WHERE id = $1 AND facility_id = $2', [b.visitId, f.id], 'Vessel visit');
      // Two active ranges may not claim the same stacks: the yard would not know whose they are.
      const overlap = await tx.one<{ name: string }>(
        `SELECT name FROM yard_ranges WHERE block_id = $1 AND active AND bay_from <= $3 AND bay_to >= $2 AND row_from <= $5 AND row_to >= $4`,
        [block.id, b.bayFrom, b.bayTo, b.rowFrom, rowTo],
      );
      if (overlap) throw ApiError.conflict('range_overlap', `Overlaps range ${overlap.name}`);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO yard_ranges (tenant_id, facility_id, block_id, name, bay_from, bay_to, row_from, row_to, purpose, visit_id, pod,
                                  line_code, size, weight_class, reefer, priority)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [f.id, block.id, b.name, b.bayFrom, b.bayTo, b.rowFrom, rowTo, b.purpose, b.visitId ?? null, b.pod ?? null, b.line ?? null,
         b.size ?? null, b.weightClass ?? null, b.reefer ?? null, b.priority],
      );
      await this.events.emit(tx, ctx, {
        type: 'yard_range.created', aggregateType: 'yard_range', aggregateId: row!.id, facilityId: f.id,
        payload: { name: b.name, block: b.block, bays: [b.bayFrom, b.bayTo], purpose: b.purpose },
      });
      return (await this.rangeList(tx, f.id)).find((r) => r.id === row!.id);
    });
  }

  /** Release a range: its stacks go back to general space. Units already there stay. */
  @Post('ranges/:id/release')
  @Roles(ROLES.planner)
  release(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const r = await tx.must<{ name: string }>('UPDATE yard_ranges SET active = false WHERE id = $1 AND facility_id = $2 RETURNING name', [id, f.id], 'Yard range');
      await this.events.emit(tx, ctx, { type: 'yard_range.released', aggregateType: 'yard_range', aggregateId: id, facilityId: f.id, payload: { name: r.name } });
      return { id, released: true };
    });
  }

  /** Where would this unit go now, and why? Nothing is written. */
  @Post('allocate-preview')
  @Roles(ROLES.planner, ROLES.gate, ROLES.operator)
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(PreviewBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const u = await tx.one<{ id: string }>(
        `SELECT id FROM units WHERE facility_id = $1 AND unit_ref = $2 AND state <> 'DEPARTED'`, [f.id, b.unitRef],
      );
      if (!u) throw ApiError.notFound(`Unit ${b.unitRef}`);
      const a = await this.yard.allocate(tx, f.id, u.id, b.block);
      return { unitRef: b.unitRef, position: a.position, block: a.blockCode, reason: a.reason };
    });
  }

  private rangeList(tx: Tx, facilityId: string) {
    return tx.many<{ id: string }>(
      `SELECT ${RANGE_COLS} FROM yard_ranges r JOIN yard_blocks b ON b.id = r.block_id LEFT JOIN vessel_visits v ON v.id = r.visit_id
        WHERE r.facility_id = $1 AND r.active ORDER BY b.code, r.bay_from, r.row_from`,
      [facilityId],
    );
  }

  @Get()
  get(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const blocks = await tx.many(
        `SELECT b.id, b.code, y.code AS yard, b.block_type AS "blockType", b.bays, b.rows_count AS rows, b.tiers, b.capacity
           FROM yard_blocks b JOIN yards y ON y.id = b.yard_id WHERE y.facility_id = $1 ORDER BY y.code, b.code`,
        [f.id],
      );
      const units = await tx.many(
        `SELECT u.id, u.yard_block_id AS "blockId", u.yard_position AS position, u.unit_ref AS "unitRef", u.cargo_kind AS "cargoKind",
                u.category, u.freight_kind AS "freightKind", u.iso_type AS "isoType", u.is_reefer AS "isReefer", u.dg_class AS "dgClass",
                u.time_in AS "timeIn", (SELECT p.code FROM partners p WHERE p.id = u.line_operator_id) AS "lineOperator",
                (SELECT count(*)::int FROM unit_holds h WHERE h.unit_id = u.id AND h.released_at IS NULL) AS "activeHolds"
           FROM units u WHERE u.facility_id = $1 AND u.state = 'IN_YARD'`,
        [f.id],
      );
      return {
        facility: f.code,
        blocks: blocks.map((b) => {
          const inBlock = units.filter((u) => u.blockId === b.id);
          const slots = b.blockType === 'CONTAINER_STACK' ? b.bays * b.rows * b.tiers : Number(b.capacity ?? 0);
          return { ...b, slots, occupied: inBlock.length, units: inBlock.map(({ blockId, ...u }) => u) };
        }),
        ranges: await this.rangeList(tx, f.id),
      };
    });
  }
}
