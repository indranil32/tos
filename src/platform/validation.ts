import { z } from 'zod';

export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  return schema.parse(body ?? {});
}

export const code = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ - only');
export const unlocode = z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/, 'UN/LOCODE, e.g. AEKHL');
export const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
export const isoDateTime = z.string().datetime({ offset: true });
