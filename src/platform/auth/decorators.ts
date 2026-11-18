import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { RequestContext } from '../context';

export const IS_PUBLIC = 'tos:isPublic';
export const REQUIRED_ROLES = 'tos:roles';
export const REQUIRES_FACILITY = 'tos:requiresFacility';

/** Endpoint needs no token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Caller needs at least one of these roles (tos:admin implies every tos:* role). */
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);
/** Endpoint acts on one facility, selected with the X-Facility header. */
export const FacilityScoped = () => SetMetadata(REQUIRES_FACILITY, true);

export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): RequestContext => {
  return host.switchToHttp().getRequest().ctx;
});
