/**
 * Minimal UN/EDIFACT syntax layer (ISO 9735): tokenizer and writer.
 * Handles the UNA service string advice and the release character.
 * A segment is an array of elements; an element is an array of components.
 */
export type Element = string[];
export type Segment = { tag: string; elements: Element[] };

export interface Separators {
  component: string;
  element: string;
  decimal: string;
  release: string;
  segment: string;
}

export const DEFAULT_SEPARATORS: Separators = { component: ':', element: '+', decimal: '.', release: '?', segment: "'" };

export class EdifactError extends Error {}

export function parseEdifact(raw: string): Segment[] {
  let text = raw.replace(/^﻿/, '');
  let sep = DEFAULT_SEPARATORS;
  if (text.startsWith('UNA')) {
    const s = text.slice(3, 9);
    if (s.length < 6) throw new EdifactError('Truncated UNA segment');
    sep = { component: s[0], element: s[1], decimal: s[2], release: s[3], segment: s[5] };
    text = text.slice(9);
  }
  const segments: Segment[] = [];
  let elements: Element[] = [];
  let components: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === sep.release) {
      i++;
      if (i < text.length) cur += text[i];
      continue;
    }
    if (ch === sep.component) {
      components.push(cur);
      cur = '';
    } else if (ch === sep.element) {
      components.push(cur);
      elements.push(components);
      components = [];
      cur = '';
    } else if (ch === sep.segment) {
      components.push(cur);
      elements.push(components);
      const [tagEl, ...rest] = elements;
      const tag = tagEl[0].replace(/[\r\n\s]+/g, '');
      if (tag) segments.push({ tag, elements: rest });
      elements = [];
      components = [];
      cur = '';
    } else if (!(cur === '' && components.length === 0 && elements.length === 0 && /[\r\n]/.test(ch))) {
      cur += ch;
    }
  }
  if (cur.trim() || elements.length) throw new EdifactError('Message does not end with a segment terminator');
  return segments;
}

/** Component value helper: el(seg, 1, 0) = first component of the first data element. */
export function el(seg: Segment | undefined, element: number, component = 0): string | undefined {
  const v = seg?.elements[element - 1]?.[component];
  return v === undefined || v === '' ? undefined : v;
}

export function escapeValue(v: string, sep: Separators = DEFAULT_SEPARATORS): string {
  const specials = [sep.release, sep.component, sep.element, sep.segment];
  return [...v].map((c) => (specials.includes(c) ? sep.release + c : c)).join('');
}

/** Write segments; values are escaped, trailing empty elements/components trimmed. */
export function writeEdifact(segments: (string | (string | string[] | undefined)[])[][], sep: Separators = DEFAULT_SEPARATORS): string {
  return segments
    .map(([tag, ...els]) => {
      const elements = els.map((e) => {
        const comps = (Array.isArray(e) ? e : [e]).map((c) => escapeValue(c === undefined || c === null ? '' : String(c), sep));
        while (comps.length > 1 && comps[comps.length - 1] === '') comps.pop();
        return comps.join(sep.component);
      });
      while (elements.length && elements[elements.length - 1] === '') elements.pop();
      return [tag as string, ...elements].join(sep.element) + sep.segment;
    })
    .join('\n');
}

export function edifactDateTime(d: Date): { date6: string; time4: string; ccyymmddhhmm: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const date8 = `${y}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time4 = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return { date6: date8.slice(2), time4, ccyymmddhhmm: date8 + time4 };
}
