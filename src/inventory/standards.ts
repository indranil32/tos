/**
 * Identifier validation per maritime standards.
 *  - ISO 6346: container number (owner code + category + serial + check digit) and size/type code
 *  - ISO 3779: vehicle identification number (VIN)
 */

const LETTER_VALUES: Record<string, number> = (() => {
  const values: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++; // ISO 6346 skips multiples of 11
    values[ch] = v++;
  }
  return values;
})();

export function iso6346CheckDigit(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const val = /[0-9]/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValidContainerNumber(no: string): boolean {
  if (!/^[A-Z]{3}[UJZR][0-9]{7}$/.test(no)) return false;
  return iso6346CheckDigit(no.slice(0, 10)) === Number(no[10]);
}

/** ISO 6346 size/type code, e.g. 22G1, 45G1, 42R1. */
export function isValidIsoType(t: string): boolean {
  return /^[1-9ABCDEFGHKLMNP][0-9A-Z][A-Z][0-9A-Z]$/.test(t);
}

/** TEU equivalent from the ISO 6346 length code (first character). */
export function teuFromIsoType(t: string | null | undefined): number {
  if (!t) return 1;
  const len = t[0];
  if (len === '1') return 0.5; // 10 ft
  if (len === '2' || len === '3') return 1; // 20 ft, 30 ft counted as 1
  return 2; // 40 ft, 45 ft (L, M, ...)
}

/** ISO 3779: 17 characters, letters I, O and Q not allowed. */
export function isValidVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}
