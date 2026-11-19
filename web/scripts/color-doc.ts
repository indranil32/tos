// Generates docs/color-coding.md from src/theme/colors.ts (the single source of truth).
// Run: npm run colors:doc   (CI fails if the committed document differs from the generated one)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_DOMAINS, contrast, DWELL_RAMP, FLAGS, LINE_PALETTE, STATUS_DOMAINS, textOn, TONES,
} from '../src/theme/colors.ts';

const out: string[] = [];
const p = (s = '') => out.push(s);
const ratio = (a: string, b: string) => `${contrast(a, b).toFixed(1)}:1`;

p('# Data colour coding');
p();
p('> Generated from `web/src/theme/colors.ts` by `npm run colors:doc`. Do not edit by hand: change the source file and regenerate. CI fails if this document is out of date.');
p();
p('Every screen of the TOS colours data the same way, so a planner, a gate clerk and a billing officer read a colour identically. This document is the reference for designers, developers and trainers.');
p();
p('## The three rules');
p();
p('1. **One value, one colour, on every screen.** "In yard" is the same blue on the units list, the unit detail, the dashboard and the colour guide.');
p('2. **Shape tells you the kind of value.**');
p('   - A **filled badge with an icon** is a **status**: where something is in its life cycle (Advised, Working, Rejected).');
p('   - An **outlined chip with a colour bar** is a **category**: what something is (Import, Container, Vehicle).');
p('   - A **pill with a symbol** is a **special-handling flag**: dangerous goods, reefer, hold, missing VGM.');
p('3. **Colour is never the only signal.** Every badge carries a text label and an icon, every coloured view (yard, charts) shows a legend, and tooltips explain the meaning.');
p();
p('## Status tones');
p();
p('All statuses map onto six tones. The tone carries the meaning; the label says which state it is.');
p();
p('| Tone | Icon | Meaning | Background | Text | Border | Solid (bars, cells, row accent) | Text contrast |');
p('|---|---|---|---|---|---|---|---|');
for (const t of Object.values(TONES)) {
  p(`| **${t.label}** | ${t.icon} | ${t.meaning} | \`${t.bg}\` | \`${t.fg}\` | \`${t.border}\`${t.borderStyle === 'dashed' ? ' (dashed)' : ''} | \`${t.solid}\` | ${ratio(t.fg, t.bg)} |`);
}
p();
p('"Planned" uses a dashed border so it can be told apart from "Closed" without relying on colour.');
p();
p('## Statuses by domain');
p();
for (const d of Object.values(STATUS_DOMAINS)) {
  p(`### ${d.label}`);
  p();
  p(`Shown on: ${d.where}.`);
  p();
  p('| Value | Label | Tone | Meaning |');
  p('|---|---|---|---|');
  for (const [k, v] of Object.entries(d.values)) p(`| \`${k}\` | ${TONES[v.tone].icon} ${v.label} | ${TONES[v.tone].label} | ${v.meaning} |`);
  p();
}
p('## Categories');
p();
p('Categories are shown as outlined chips with a colour bar and an icon. Unit category uses the Okabe-Ito colour-blind-safe palette and is also the default colouring of the yard view.');
p();
for (const d of Object.values(CATEGORY_DOMAINS)) {
  p(`### ${d.label}`);
  p();
  p(`Shown on: ${d.where}.`);
  p();
  p('| Value | Icon | Label | Colour | Text on fill | Meaning |');
  p('|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(d.values)) p(`| \`${k}\` | ${v.icon} | ${v.label} | \`${v.color}\` | ${textOn(v.color) === '#FFFFFF' ? 'white' : 'black'} (${ratio(v.color, textOn(v.color))}) | ${v.meaning} |`);
  p();
}
p('## Special-handling flags');
p();
p('Flags appear next to a unit wherever it is listed, always in this order: hold, dangerous goods, reefer, missing VGM.');
p();
p('| Flag | Symbol | Background | Text | Contrast | Meaning |');
p('|---|---|---|---|---|---|');
for (const f of Object.values(FLAGS)) p(`| **${f.label}** | ${f.icon} | \`${f.bg}\` | \`${f.fg}\` | ${ratio(f.fg, f.bg)} | ${f.meaning} |`);
p();
p('## Row accents in lists');
p();
p('Every list draws a 4-pixel bar on the left of each row in the **solid** colour of the row\'s main status, so a long list can be scanned without reading the badges:');
p();
p('- **Units:** an active hold wins (Blocked red), otherwise the unit state tone.');
p('- **Vessel visits:** visit phase. **Moves:** move status. **Gate:** gate status. **EDI:** message status.');
p('- **Invoices:** ERP export status (pending exports stand out in amber). **Uninvoiced charges:** always "Needs attention".');
p();
p('## Yard colouring');
p();
p('The yard view can be coloured four ways. The choice is remembered per user and the legend always shows what the colours mean.');
p();
p('| Colour by | Rule |');
p('|---|---|');
p('| **Category** (default) | Unit category colours above. |');
p('| **Line** | Lines get stable colours from the palette below, assigned in alphabetical order of line code. |');
p('| **Dwell time** | One purple ramp, light to dark, so it never reads as a status. |');
p(`| **Holds & special cargo** | Hold = Blocked solid \`${TONES.blocked.solid}\`, then dangerous goods \`${FLAGS.DG.border}\`, then reefer \`${FLAGS.REEFER.border}\`, otherwise light grey. |`);
p();
p('Dwell-time ramp:');
p();
p('| Band | Fill | Text | Contrast |');
p('|---|---|---|---|');
for (const b of DWELL_RAMP) p(`| ${b.label} | \`${b.color}\` | \`${b.fg}\` | ${ratio(b.color, b.fg)} |`);
p();
p(`Line palette (in assignment order): ${LINE_PALETTE.map((c) => `\`${c}\``).join(', ')}.`);
p();
p('A stack in the yard shows its top container\'s colour and the stack height (for example `3/4`); a ⛔ in the corner marks a hold anywhere in that cell.');
p();
p('## Dashboard');
p();
p('Each KPI tile has a top border in the tone of what it measures: vessels and yard occupancy are "In progress" (occupancy turns "Needs attention" above 85%), units on hold are "Blocked" (or "Done" when there are none), and the gate is "Done".');
p();
p('## Accessibility');
p();
p('- Every badge, chip and pill meets WCAG 2.1 AA contrast for its text (4.5:1 or better); the ratios are in the tables above and are checked by automated tests.');
p('- Category colours come from the Okabe-Ito palette, which stays distinguishable for the common types of colour blindness.');
p('- Status and category never rely on colour alone: icons, labels, dashed borders and legends carry the same information.');
p();
p('## Changing the colours');
p();
p('1. Edit `web/src/theme/colors.ts`. Add new statuses to the right domain, and map them to one of the six tones rather than inventing a new colour.');
p('2. Run `npm test` in `web/`: the contrast and consistency tests must pass.');
p('3. Run `npm run colors:doc` and commit the regenerated `docs/color-coding.md`.');
p('4. The in-app **Colour guide** page renders from the same file, so it updates automatically.');
p();

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', '..', 'docs', 'color-coding.md');
writeFileSync(target, out.join('\n'));
console.log(`Wrote ${target}`);
