import { RequestContext } from './context';
import { Tx } from './db/database.service';
import { ApiError } from './errors';

export interface FacilityRow {
  id: string;
  code: string;
  name: string;
  unlocode: string | null;
  smdg_code: string | null;
  currency: string;
  timezone: string;
}

/** Resolve the facility selected by the X-Facility header (already scope-checked by the guard). */
export async function currentFacility(tx: Tx, ctx: RequestContext): Promise<FacilityRow> {
  if (!ctx.facilityCode) throw ApiError.invalid('X-Facility header is required');
  const f = await tx.one<FacilityRow>(
    'SELECT id, code, name, unlocode, smdg_code, currency, timezone FROM facilities WHERE code = $1',
    [ctx.facilityCode],
  );
  if (!f) throw ApiError.notFound(`Facility ${ctx.facilityCode}`);
  return f;
}
