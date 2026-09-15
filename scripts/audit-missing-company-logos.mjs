#!/usr/bin/env node
/**
 * audit-missing-company-logos.mjs
 *
 * Audits the canonical assembled job dataset with the same resolver used by
 * the SPA and static job cards. It also probes every unique resolved asset,
 * so a non-null but dead URL is reported as broken instead of being counted
 * as coverage.
 *
 * Run with `npx tsx` because the real resolver lives in a TypeScript module:
 *
 *   npx tsx scripts/audit-missing-company-logos.mjs
 *   npx tsx scripts/audit-missing-company-logos.mjs --report-issue
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanyLogoUrl } from '../services/jobDataNormalization.ts';
import { positiveIntFromEnv } from './lib/int-from-env.mjs';
import {
  auditCompanyLogos,
  DEFAULT_ASSET_BASE_URL,
  loadCanonicalJobs,
} from './lib/company-logo-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = process.env.COMPANY_LOGO_AUDIT_OUTPUT
  ? path.resolve(ROOT, process.env.COMPANY_LOGO_AUDIT_OUTPUT)
  : path.join(ROOT, 'data', 'company-logos-missing.json');
const TOP_N_IN_ISSUE = 30;

function relativeRepoPath(file) {
  const relative = path.relative(ROOT, file);
  return relative && !relative.startsWith('..') ? relative : path.basename(file);
}

function issueSafe(value) {
  return String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatSource(report) {
  return `\`${issueSafe(report.source.path)}\` (${report.source.jobCount} annunci)`;
}

function buildIssueBody(report) {
  const top = report.affectedCompanies.slice(0, TOP_N_IN_ISSUE);
  const rows = top.map((company) => {
    const example = company.examples.broken || company.examples.missing || company.exampleUrl;
    const link = example ? `[esempio](${example})` : '—';
    return `| \`${issueSafe(company.companyKey)}\` | ${issueSafe(company.companyName)} | ${company.status} | ${company.affectedJobCount} | ${link} |`;
  }).join('\n');
  const restCount = Math.max(0, report.affectedCompanies.length - top.length);

  return `## Cosa è stato misurato

L'audit usa ${formatSource(report)} e invoca \`resolveCompanyLogoUrl()\` da \`services/jobDataNormalization.ts\`, cioè lo stesso resolver usato dai job card SPA e statici. Ogni riferimento non locale viene verificato con una richiesta HTTP; i path locali vengono verificati contro il CDN configurato.

**${report.affectedCompanies.length} aziende** hanno almeno un annuncio non coperto o non verificabile:

| stato | aziende | annunci interessati |
|---|---:|---:|
| missing | ${report.missing} | ${report.missingJobCount} |
| broken | ${report.broken} | ${report.brokenJobCount} |
| partial | ${report.partial} | ${report.partialJobCount} |
| unverified | ${report.unverified} | ${report.unverifiedJobCount} |

Il report completo è \`data/company-logos-missing.json\`; viene rigenerato dal workflow ogni domenica.

## Aziende con maggiore impatto

| companyKey | azienda | stato | annunci interessati | esempio |
|---|---|---|---:|---|
${rows}
${restCount ? `\n_...e altre ${restCount} aziende nell'elenco completo._\n` : ''}

## Come risolvere

1. Assemblare il dataset e provare l'acquisizione guidata: \`node scripts/download-missing-company-logos.mjs --from-audit --dry-run\`, poi ripetere senza \`--dry-run\` dopo aver controllato i domini proposti.
2. Sostituire ogni URL esterno con stato \`broken\` con un asset locale verificato; non usare favicon generici o Clearbit come sorgente runtime.
3. Rilanciare l'audit e controllare anche le pagine pubblicate dopo il deploy.

## Non implementato (ancora)

- **blocked: servono asset ufficiali verificati** — questa issue mantiene l'elenco corrente, mentre l'aggiunta dei loghi viene applicata per batch e verificata da una PR.
`;
}

async function reportIssue(report) {
  if (report.affectedCompanies.length === 0) {
    console.log('[audit-missing-company-logos] Nessuna anomalia logo — nessuna issue da aprire.');
    return;
  }
  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  await createGithubIssue({
    title: 'Aziende senza logo sulle pagine annuncio di lavoro',
    description: buildIssueBody(report),
    priority: 3,
    labels: ['crawler-data-quality'],
    workflow: 'audit-missing-company-logos',
  });
  console.log('[audit-missing-company-logos] Issue aperta/aggiornata.');
}

async function main() {
  const loaded = await loadCanonicalJobs({
    root: ROOT,
    file: process.env.COMPANY_LOGO_AUDIT_JOBS_FILE || undefined,
    minJobs: positiveIntFromEnv('COMPANY_LOGO_AUDIT_MIN_JOBS', 1),
  });
  const report = await auditCompanyLogos(loaded.jobs, {
    resolveLogo: resolveCompanyLogoUrl,
    assetBaseUrl: process.env.COMPANY_LOGO_AUDIT_ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL,
    timeoutMs: positiveIntFromEnv('COMPANY_LOGO_AUDIT_TIMEOUT_MS', 8_000),
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      path: relativeRepoPath(loaded.sourcePath),
      jobCount: loaded.jobs.length,
    },
    ...report,
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log([
    `[audit-missing-company-logos] ${payload.source.jobCount} annunci, ${payload.companiesTotal} aziende —`,
    `missing: ${payload.missing} (${payload.missingJobCount}),`,
    `broken: ${payload.broken} (${payload.brokenJobCount}),`,
    `partial: ${payload.partial} (${payload.partialJobCount}),`,
    `valid: ${payload.withLogo}. Scritto ${OUTPUT}`,
  ].join(' '));

  if (process.argv.includes('--report-issue')) await reportIssue(payload);
}

main().catch((error) => {
  console.error('[audit-missing-company-logos] Fatal:', error);
  process.exit(1);
});
