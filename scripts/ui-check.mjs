// Browser walkthrough of the web app (Playwright + local Chrome): signs in, opens every screen, exercises the grid,
// saves screenshots and fails on console errors. Needs a running stack with demo data (see README, "Web app").
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.SHOTS ?? '/tmp/shots';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
await page.goto(BASE + '/');
await page.waitForURL('**/login');
await shot('01-login');
await page.click('button[type=submit]');
await page.waitForURL(BASE + '/', { timeout: 15000 });
await page.waitForSelector('.tile');
await shot('02-dashboard');
for (const [path, name, sel] of [['/visits', '03-visits', 'table.grid tbody tr'], ['/units', '04-units', 'table.grid tbody tr'], ['/yard', '05-yard', '.block'], ['/gate', '06-gate', 'table.grid tbody tr'], ['/invoices', '07-invoices', 'table.grid tbody tr'], ['/edi', '08-edi', 'table.grid tbody tr'], ['/events', '09-events', 'table.grid tbody tr'], ['/colors', '10-colors', '.card']]) {
  await page.click(`nav a[href="${path}"]`);
  await page.waitForSelector(sel, { timeout: 10000 });
  await shot(name);
}
// grid features on units
await page.click('nav a[href="/units"]');
await page.waitForSelector('table.grid tbody tr');
const count = async () => (await page.textContent('.grid-footer span')).trim();
console.log('units all:', await count());
await page.fill('input.search', 'msc');
console.log('search msc:', await count());
await page.fill('input.search', '');
await page.click('.quick-chip:has-text("In yard")');
console.log('chip in yard:', await count());
await page.click('button:has-text("Filters")');
await page.click('button:has-text("+ Condition")');
await page.selectOption('.rule select[aria-label=Column]', { label: 'Dwell (days)' });
await page.selectOption('.rule select[aria-label=Operator]', { label: '≥' });
await page.fill('.rule input[aria-label=Value]', '8');
console.log('in yard & dwell>=8:', await count());
await shot('11-units-advanced-filter');
await page.click('button:has-text("Sort")');
await page.click('button:has-text("+ Sort level")');
await shot('12-units-sort');
await page.click('button:has-text("Columns")');
await page.click('.column-editor label:has-text("Line") input');
await shot('13-units-columns');
await page.click('th button:has-text("Dwell")');
await page.click('th button:has-text("Unit")', { modifiers: ['Shift'] });
await shot('14-units-header-sort');
// persistence
await page.reload();
await page.waitForSelector('table.grid tbody tr');
console.log('after reload (filters kept):', await count());
// visit detail and unit detail
await page.click('nav a[href="/visits"]');
await page.waitForSelector('table.grid tbody tr');
await page.click('table.grid tbody tr >> nth=0');
await page.waitForSelector('.detail-head');
await shot('15-visit-detail');
await page.click('nav a[href="/units"]');
await page.click('button:has-text("Clear filters")');
await page.waitForSelector('table.grid tbody tr');
await page.click('table.grid tbody tr >> nth=0');
await page.waitForSelector('.facts');
await shot('16-unit-detail');
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
process.exitCode = errors.length ? 1 : 0;
