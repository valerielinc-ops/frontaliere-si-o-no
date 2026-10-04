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
 *
 * With --report-issue the canonical issue is opened/updated while anomalies
 * remain and closed (resolveGithubIssue) when the audit measures 0.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanyLogoUrl } from '../services/jobDataNormalization.ts';
import { positiveIntFromEnv } from './lib/int-from-env.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  auditCompanyLogos,
  DEFAULT_ASSET_BASE_URL,
  loadCanonicalJobs,
  MIN_LOGO_QUALITY_DIMENSION_PX,
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
    const example = company.examples.broken
      || company.examples.missing
      || company.examples.lowQuality
      || company.examples.qualityUnverified
      || company.exampleUrl;
    const link = example ? `[esempio](${example})` : '—';
    return `| \`${issueSafe(company.companyKey)}\` | ${issueSafe(company.companyName)} | ${company.status} | ${company.affectedJobCount} | ${link} |`;
  }).join('\n');
  const restCount = Math.max(0, report.affectedCompanies.length - top.length);

  return `## Cosa è stato misurato

L'audit usa ${formatSource(report)} e invoca \`resolveCompanyLogoUrl()\` da \`services/jobDataNormalization.ts\`, cioè lo stesso resolver usato dai job card SPA e statici. Ogni riferimento non locale viene verificato con una richiesta HTTP; i path locali vengono verificati contro il CDN configurato.

**${report.affectedCompanies.length} aziende** hanno almeno un annuncio non coperto, non verificabile o di qualità insufficiente:

| stato | aziende | annunci interessati |
|---|---:|---:|
| missing | ${report.missing} | ${report.missingJobCount} |
| broken | ${report.broken} | ${report.brokenJobCount} |
| partial | ${report.partial} | ${report.partialJobCount} |
| low-quality | ${report.lowQuality} | ${report.lowQualityJobCount} |
| quality-unverified | ${report.qualityUnverified} | ${report.qualityUnverifiedJobCount} |
| unverified | ${report.unverified} | ${report.unverifiedJobCount} |

Il report completo è \`data/company-logos-missing.json\`; viene rigenerato dal workflow ogni domenica.

## Aziende con maggiore impatto

| companyKey | azienda | stato | annunci interessati | esempio |
|---|---|---|---:|---|
${rows}
${restCount ? `\n_...e altre ${restCount} aziende nell'elenco completo._\n` : ''}

## Come risolvere

1. Assemblare il dataset e provare l'acquisizione guidata: \`node scripts/download-missing-company-logos.mjs --from-audit --dry-run\`, poi ripetere senza \`--dry-run\` dopo aver controllato i domini proposti.
2. Sostituire ogni URL esterno con stato \`broken\` con un asset locale verificato e ogni raster \`low-quality\` con una sorgente di almeno ${MIN_LOGO_QUALITY_DIMENSION_PX} px sul lato maggiore; non usare favicon generici o Clearbit come sorgente runtime.
3. Rilanciare l'audit e controllare anche le pagine pubblicate dopo il deploy.

## Non implementato (ancora)

- **blocked: servono asset ufficiali verificati** — questa issue mantiene l'elenco corrente, mentre l'aggiunta dei loghi viene applicata per batch e verificata da una PR.
`;
}

export const MISSING_LOGOS_ISSUE_TITLE = 'Aziende senza logo sulle pagine annuncio di lavoro';
const ISSUE_WORKFLOW = 'audit-missing-company-logos';

function currentRunUrl() {
  return process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
}

/**
 * Opens/updates the canonical issue while anomalies remain and CLOSES it when
 * the audit measures 0 affected companies. Without the resolve branch the
 * issue stayed open after the last logo landed (issue 6504): the open path had
 * no mirror. A 0 here is a complete measurement — every resolved reference was
 * probed (an unreachable one counts as `unverified`, i.e. affected) and the
 * dataset passed the COMPANY_LOGO_AUDIT_MIN_JOBS guard in loadCanonicalJobs.
 * A close that GitHub refuses throws, so the run fails instead of reporting a
 * green that did not persist.
 *
 * `createIssue` / `resolveIssue` default to github-issue-creator.mjs and are
 * injectable for tests.
 */
export async function reportIssue(report, { createIssue, resolveIssue, runUrl = currentRunUrl() } = {}) {
  if (report.affectedCompanies.length === 0) {
    const resolve = resolveIssue
      || (await import('./lib/github-issue-creator.mjs')).resolveGithubIssue;
    await resolve(MISSING_LOGOS_ISSUE_TITLE, { workflow: ISSUE_WORKFLOW, runUrl });
    console.log('[audit-missing-company-logos] Nessuna anomalia logo — issue canonica chiusa se aperta.');
    return 'resolved';
  }
  const create = createIssue
    || (await import('./lib/github-issue-creator.mjs')).createGithubIssue;
  await create({
    title: MISSING_LOGOS_ISSUE_TITLE,
    description: buildIssueBody(report),
    priority: 3,
    labels: ['crawler-data-quality'],
    workflow: ISSUE_WORKFLOW,
  });
  console.log('[audit-missing-company-logos] Issue aperta/aggiornata.');
  return 'reported';
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
    `low-quality: ${payload.lowQuality} (${payload.lowQualityJobCount}),`,
    `valid: ${payload.withLogo}. Scritto ${OUTPUT}`,
  ].join(' '));

  if (process.argv.includes('--report-issue')) await reportIssue(payload);
}

// Only run when invoked directly, so tests can import reportIssue.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error('[audit-missing-company-logos] Fatal:', error);
    process.exit(1);
  });
}
