import { describe, expect, it } from 'vitest';
import { CATEGORY_DOMAINS, contrast, DWELL_RAMP, FLAGS, lineColors, STATUS_DOMAINS, textOn, TONES } from './colors';

describe('colour coding', () => {
  it('every tone has AA contrast for its label text (4.5:1)', () => {
    for (const t of Object.values(TONES)) expect(contrast(t.fg, t.bg), t.key).toBeGreaterThanOrEqual(4.5);
  });
  it('every flag pill has AA contrast', () => {
    for (const [k, f] of Object.entries(FLAGS)) expect(contrast(f.fg, f.bg), k).toBeGreaterThanOrEqual(4.5);
  });
  it('category colours work as chip bars and as yard fills with readable text', () => {
    for (const d of Object.values(CATEGORY_DOMAINS)) {
      for (const [k, v] of Object.entries(d.values)) {
        expect(contrast(v.color, '#FFFFFF'), `${k} vs white`).toBeGreaterThanOrEqual(2.2);
        expect(contrast(v.color, textOn(v.color)), `${k} text`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('dwell ramp text is readable and the ramp gets darker', () => {
    for (const b of DWELL_RAMP) expect(contrast(b.color, b.fg), b.label).toBeGreaterThanOrEqual(4.5);
    const darkness = DWELL_RAMP.map((b) => contrast(b.color, '#FFFFFF'));
    expect([...darkness].sort((a, b) => a - b)).toEqual(darkness);
  });
  it('every status value maps to a defined tone', () => {
    for (const d of Object.values(STATUS_DOMAINS)) for (const v of Object.values(d.values)) expect(TONES[v.tone]).toBeDefined();
  });
  it('blocked and done never share a colour; tones are all distinct', () => {
    const solids = Object.values(TONES).map((t) => t.solid);
    expect(new Set(solids).size).toBe(solids.length);
  });
  it('line colours are stable regardless of input order', () => {
    expect(lineColors(['MSC', 'CMA', 'HLC'])).toEqual(lineColors(['HLC', 'MSC', 'CMA', 'MSC']));
  });
});
