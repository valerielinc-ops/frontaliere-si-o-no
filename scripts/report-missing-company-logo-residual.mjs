#!/usr/bin/env node
/**
 * Rebuilds the canonical issue from the acquisition result. The issue is the
 * residual only: verified assets are removed before the report is published.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditIssueReason, buildResidualReport } from './lib/company-logo-acquisition.mjs';
import { reportIssue } from './audit-missing-company-logos.mjs';

const ROOT = path.resolve(process.cwd());

function parseArgs(argv) {
  const options = {
    report: process.env.COMPANY_LOGO_AUDIT_REPORT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_AUDIT_REPORT)
      : path.join(ROOT, 'data', 'company-logos-missing.json'),
    acquisition: process.env.COMPANY_LOGO_ACQUISITION_VERIFIED_RESULT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_ACQUISITION_VERIFIED_RESULT)
      : null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--report' && argv[index + 1]) options.report = path.resolve(ROOT, argv[++index]);
    else if (argv[index] === '--acquisition' && argv[index + 1]) options.acquisition = path.resolve(ROOT, argv[++index]);
  }
  if (!options.acquisition) throw new Error('Verified acquisition result required: use --acquisition <file>.');
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await readJson(options.report);
  const acquisition = existsSync(options.acquisition)
    ? await readJson(options.acquisition)
    : { targets: [], acquired: 0, failed: 1, qualityRejected: 0 };
  const residual = buildResidualReport(report, acquisition);
  await reportIssue(residual);
  const reasons = residual.affectedCompanies
    .map((company) => `${company.companyKey}: ${auditIssueReason(company)}`)
    .join('; ');
  console.log(
    `[report-missing-company-logo-residual] Residuo: ${residual.affectedCompanies.length} aziende, `
      + `${residual.missingJobCount} missing, ${residual.pendingDeployJobCount || 0} pending-deploy annunci.`,
  );
  if (reasons) console.log(`[report-missing-company-logo-residual] ${reasons}`);
}

main().catch((error) => {
  console.error('[report-missing-company-logo-residual] Fatal:', error);
  process.exit(1);
});
