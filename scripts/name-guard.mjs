#!/usr/bin/env node
// Fails when third-party product or company names appear in tracked files (code, UI, docs, config).
// The product is designed independently and must not reference other terminal systems or employers.
// Usage: node scripts/name-guard.mjs   (run from the repository root; CI runs it on every push)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SELF = 'scripts/name-guard.mjs';
const SKIP = [/(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip)$/i];

// Case-insensitive names, matched as whole words.
const WORDS_ANY_CASE = ['catos', 'navis', 'sparcs', 'tsb', 'adports', 'adpft', 'adpg', 'cyberlogitec', 'tideworks', 'opus terminal'];
// Names that are ordinary words in lower case, so they are matched only in their product spelling.
const WORDS_EXACT = ['N4', 'MOST', 'AD Ports', 'AD Port', 'Abu Dhabi Ports', 'Khalifa Port Container Terminal'];

const anyCase = new RegExp(`\\b(${WORDS_ANY_CASE.map(esc).join('|')})\\b`, 'i');
const exact = new RegExp(`\\b(${WORDS_EXACT.map(esc).join('|')})\\b`);

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && f !== SELF && !SKIP.some((re) => re.test(f)));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  text.split('\n').forEach((line, i) => {
    const m = line.match(anyCase) ?? line.match(exact);
    if (m) hits.push(`${file}:${i + 1}: "${m[0]}"`);
  });
}

if (hits.length) {
  console.error(`Forbidden product or company names found (${hits.length}):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`Name guard: ${files.length} files clean.`);
