import { Injectable } from '@nestjs/common';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';

export interface Allocation {
  blockId: string;
  blockCode: string;
  position: string;
}

const BLOCK_FOR_KIND: Record<string, string> = {
  CONTAINER: 'CONTAINER_STACK',
  BREAKBULK: 'LAYDOWN',
  VEHICLE: 'RORO_LANE',
  LIQUID: 'TANK',
};

/**
 * Rule-based yard allocation (v1): first free slot in blocks of the right type.
 * Container slot format: <block>-<bay 2>-<row 2>-<tier 1>, e.g. A1-03-02-1.
 * Laydown/RoRo/tank areas are capacity-based: position = <block>-<sequence>.
 * This is the seam where an optimiser service plugs in later.
 */
@Injectable()
export class YardAllocator {
  async allocate(tx: Tx, facilityId: string, cargoKind: string, preferredBlock?: string): Promise<Allocation> {
    const blockType = BLOCK_FOR_KIND[cargoKind];
    const blocks = await tx.many<{ id: string; code: string; bays: number; rows_count: number; tiers: number; capacity: string | null }>(
      `SELECT b.id, b.code, b.bays, b.rows_count, b.tiers, b.capacity
         FROM yard_blocks b JOIN yards y ON y.id = b.yard_id
        WHERE y.facility_id = $1 AND b.block_type = $2 AND ($3::text IS NULL OR b.code = $3)
        ORDER BY y.code, b.code FOR UPDATE OF b`,
      [facilityId, blockType, preferredBlock ?? null],
    );
    for (const b of blocks) {
      const used = new Set(
        (await tx.many<{ yard_position: string }>(
          `SELECT yard_position FROM units WHERE yard_block_id = $1 AND state = 'IN_YARD' AND yard_position IS NOT NULL`,
          [b.id],
        )).map((r) => r.yard_position),
      );
      if (blockType === 'CONTAINER_STACK') {
        for (let bay = 1; bay <= b.bays; bay++)
          for (let row = 1; row <= b.rows_count; row++)
            for (let tier = 1; tier <= b.tiers; tier++) {
              const pos = slot(b.code, bay, row, tier);
              if (!used.has(pos)) return { blockId: b.id, blockCode: b.code, position: pos };
            }
      } else {
        const cap = b.capacity ? Number(b.capacity) : Number.MAX_SAFE_INTEGER;
        for (let i = 1; i <= cap; i++) {
          const pos = `${b.code}-${String(i).padStart(4, '0')}`;
          if (!used.has(pos)) return { blockId: b.id, blockCode: b.code, position: pos };
        }
      }
    }
    throw ApiError.conflict('yard_full', `No free ${blockType} slot${preferredBlock ? ` in block ${preferredBlock}` : ''}`);
  }

  /** Validate an explicitly requested slot. */
  async resolve(tx: Tx, facilityId: string, position: string): Promise<Allocation> {
    const blockCode = position.split('-')[0];
    const b = await tx.one<{ id: string; code: string }>(
      `SELECT b.id, b.code FROM yard_blocks b JOIN yards y ON y.id = b.yard_id
        WHERE y.facility_id = $1 AND b.code = $2`,
      [facilityId, blockCode],
    );
    if (!b) throw ApiError.invalid(`Unknown yard block in position ${position}`);
    return { blockId: b.id, blockCode: b.code, position };
  }
}

function slot(block: string, bay: number, row: number, tier: number) {
  return `${block}-${String(bay).padStart(2, '0')}-${String(row).padStart(2, '0')}-${tier}`;
}
