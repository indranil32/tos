#!/usr/bin/env node
// Turns a Trivy JSON report into GitHub annotations and fails when HIGH/CRITICAL findings remain.
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const findings = [];
for (const r of report.Results ?? []) {
  for (const v of r.Vulnerabilities ?? []) {
    if (['HIGH', 'CRITICAL'].includes(v.Severity)) {
      findings.push(`${v.Severity} ${v.VulnerabilityID} in ${v.PkgName} ${v.InstalledVersion} (fixed: ${v.FixedVersion || 'n/a'}) [${r.Target}]`);
    }
  }
}
for (const f of findings) console.log(`::error title=Image vulnerability::${f}`);
console.log(findings.length ? `${findings.length} HIGH/CRITICAL findings` : 'No HIGH/CRITICAL findings');
process.exit(findings.length ? 1 : 0);
