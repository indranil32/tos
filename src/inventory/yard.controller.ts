import { Controller, Get } from '@nestjs/common';
import { Ctx, FacilityScoped } from '../platform/auth/decorators';
import { RequestContext } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { currentFacility } from '../platform/facility';

/** Yard picture for the yard view: every block with its occupied slots. */
@Controller('v1/yard')
@FacilityScoped()
export class YardController {
  constructor(private readonly db: DatabaseService) {}

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
      };
    });
  }
}
