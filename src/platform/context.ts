/** Identity and scope of the caller, derived from the verified access token. */
export interface RequestContext {
  subject: string;
  tenantId?: string;
  tenantCode?: string;
  roles: string[];
  /** Facility codes the caller may act on; undefined = every facility of the tenant. */
  allowedFacilities?: string[];
  /** Facility selected for this request (X-Facility header). */
  facilityCode?: string;
  isPlatformAdmin: boolean;
}

export const ROLES = {
  platformAdmin: 'platform:admin',
  admin: 'tos:admin',
  planner: 'tos:planner',
  operator: 'tos:operator',
  gate: 'tos:gate',
  billing: 'tos:billing',
  edi: 'tos:edi',
  viewer: 'tos:viewer',
} as const;
