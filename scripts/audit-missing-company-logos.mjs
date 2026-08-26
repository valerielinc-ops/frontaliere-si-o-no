#!/usr/bin/env node
/**
 * audit-missing-company-logos.mjs
 *
 * Purpose:
 *   Trova le aziende che sulle pagine annuncio NON mostrano un logo reale —
 *   cioe' per cui `resolveCompanyLogoUrl()` (services/jobDataNormalization.ts,
 *   la stessa funzione che usa il runtime SPA e le pagine statiche) ritorna
 *   `null` per OGNI job di quell'azienda, quindi la pagina cade sul badge
 *   iniziali colorato invece del logo vero (vedi
 *   services/logoService.ts::generateInitialsLogo). E' un problema distinto
 *   da data/company-logos-broken.json (scripts/verify-company-logos.mjs),
 *   che verifica URL di logo GIA' assegnati ma rotti — qui invece nessun
 *   logo e' mai stato assegnato.
 *
 *   Importa la funzione vera invece di riprodurne la logica: dopo l'overlay
 *   del manifest, jobDataNormalization.ts rimuove dal registro le entry
 *   `cLogo()`/`gFavicon()` mai mirrorate localmente (guard "broken-logo"),
 *   quindi una riproduzione a mano rischierebbe di disallinearsi da quel
 *   guard. Va eseguito con `npx tsx` (non `node` semplice), perche' importa
 *   un modulo .ts.
 *
 * Inputs:
 *   - data/jobs/by-crawler/*.json   (per-crawler snapshots, committati — include publisher-submitted.json)
 *
 * Output:
 *   - data/company-logos-missing.json   { generatedAt, companiesTotal, withLogo, missing, companies: [...] }
 *
 * Usage:
 *   npx tsx scripts/audit-missing-company-logos.mjs
 *   npx tsx scripts/audit-missing-company-logos.mjs --report-issue   # apre/aggiorna una issue se missing > 0
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanyLogoUrl } from '../services/jobDataNormalization.ts';
import { isSliceFile } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CRAWLERS_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const OUTPUT = path.join(ROOT, 'data', 'company-logos-missing.json');

const TOP_N_IN_ISSUE = 30;

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** @returns {Promise<Array<Record<string, any>>>} every job across every by-crawler slice, tagged with its source crawler key. */
async function loadCrawlerSliceJobs() {
  if (!existsSync(CRAWLERS_DIR)) {
    console.warn(`[audit-missing-company-logos] ${CRAWLERS_DIR} non trovato — nessun job da controllare.`);
    return [];
  }
  const files = (await readdir(CRAWLERS_DIR)).filter(isSliceFile);
  const out = [];
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(await readFile(path.join(CRAWLERS_DIR, f), 'utf8'));
    } catch (err) {
      console.warn(`[audit-missing-company-logos] Impossibile leggere ${f}: ${err.message}`);
      continue;
    }
    const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
    const crawlerKey = data?.crawlerKey || path.basename(f, '.json');
    for (const job of jobs) out.push({ ...job, __crawlerKey: crawlerKey });
  }
  return out;
}

/**
 * Raggruppa i job per identita' azienda (companyKey, o slug del nome se
 * manca) e, per ogni gruppo, verifica se TUTTI i job risolvono a `null` —
 * cioe' l'azienda non ha copertura logo neanche parziale.
 */
function groupByCompany(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.companyKey || slugify(job.company || job.employer || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return groups;
}

function mostCommonCompanyName(jobs) {
  const counts = new Map();
  for (const j of jobs) {
    const name = j.company || j.employer || '';
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let mostFrequentName = '';
  let mostFrequentTally = 0;
  for (const [name, count] of counts) {
    if (count > mostFrequentTally) { mostFrequentName = name; mostFrequentTally = count; }
  }
  return mostFrequentName;
}

function computeMissingCompanies(jobs) {
  const groups = groupByCompany(jobs);
  let withLogo = 0;
  const missing = [];
  for (const [companyKey, jobsForCompany] of groups) {
    const hasLogo = jobsForCompany.some((job) => resolveCompanyLogoUrl(job) !== null);
    if (hasLogo) {
      withLogo++;
      continue;
    }
    const sourceCrawlers = Array.from(new Set(jobsForCompany.map((j) => j.__crawlerKey))).sort();
    missing.push({
      companyKey,
      companyName: mostCommonCompanyName(jobsForCompany) || companyKey,
      jobCount: jobsForCompany.length,
      exampleUrl: jobsForCompany[0]?.url || null,
      sourceCrawlers,
    });
  }
  missing.sort((a, b) => b.jobCount - a.jobCount || a.companyKey.localeCompare(b.companyKey));
  return { companiesTotal: groups.size, withLogo, missing };
}

function buildMissingLogosIssueBody(report) {
  const top = report.companies.slice(0, TOP_N_IN_ISSUE);
  const rows = top
    .map((c) => `| \`${c.companyKey}\` | ${c.companyName} | ${c.jobCount} | ${c.exampleUrl ? `[esempio](${c.exampleUrl})` : '—'} |`)
    .join('\n');
  const restCount = report.companies.length - top.length;

  return `## Cosa e' stato misurato

\`npx tsx scripts/audit-missing-company-logos.mjs\` — generato ${report.generatedAt} — trova le aziende per cui \`resolveCompanyLogoUrl()\` (\`services/jobDataNormalization.ts\`) ritorna \`null\` per TUTTI i loro annunci: quelle pagine mostrano il badge iniziali colorato (\`generateInitialsLogo\` in \`services/logoService.ts\`) invece di un logo aziendale reale, a differenza di una pagina come [pianificatore-finanziario-finanzplaner-raiffeisen-lugano](https://frontaliereticino.ch/cerca-lavoro-ticino/pianificatore-finanziario-finanzplaner-raiffeisen-lugano/) che un logo vero ce l'ha.

**${report.missing} aziende su ${report.companiesTotal}** (${Math.round((report.missing / Math.max(1, report.companiesTotal)) * 100)}%) sono senza logo, per un totale di **${report.missingJobCount} annunci** interessati. Report completo: \`data/company-logos-missing.json\` (rigenerato ogni domenica da \`.github/workflows/audit-missing-company-logos.yml\`).

## Le ${top.length} aziende con piu' impatto (per numero di annunci)

| companyKey | azienda | annunci | esempio |
|---|---|---:|---|
${rows}
${restCount > 0 ? `\n_...e altre ${restCount} aziende, elenco completo in \`data/company-logos-missing.json\`._\n` : ''}

## Come risolvere

1. Rigenera il report per avere i numeri aggiornati: \`npx tsx scripts/audit-missing-company-logos.mjs\`
2. Per le aziende con un dominio riconoscibile, prova il download automatico: \`node scripts/download-missing-company-logos.mjs\`. Guarda per prima cosa se la chiave \`companyKey\` e' presente in \`data/known-company-slugs.json\` — se manca, lo script la salta: aggiungila prima.
3. Per le aziende dove il download automatico non trova nulla (nessun dominio indovinabile, o solo la grey-globe di Google), aggiungi una entry esplicita in \`CRAWLED_COMPANY_LOGOS\` dentro \`services/jobDataNormalization.ts\` — \`'company-key': cLogo('dominio-vero.ch')\` se conosci il dominio corretto, oppure un path locale \`/images/logos/...\` se il file va caricato a mano in \`public/images/logos/\`. Poi mirrora con \`node scripts/download-company-logos.mjs --slug <key> --domain <domain>\`.
4. Rilancia l'audit e conferma che \`missing\` sia sceso rispetto a questa issue.

## Non implementato (ancora)

- **blocked: serve intervento sui dati** — questa issue e' un report, non un fix: il numero di aziende (${report.missing}) scende solo aggiungendo loghi reali punto per punto, non con una modifica di codice unica.
`;
}

async function reportIssue(report) {
  if (report.missing === 0) {
    console.log('[audit-missing-company-logos] Nessuna azienda senza logo — nessuna issue da aprire.');
    return;
  }
  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  await createGithubIssue({
    title: 'Aziende senza logo sulle pagine annuncio di lavoro',
    description: buildMissingLogosIssueBody(report),
    priority: 3,
    // Label gia' esistente nel repo ("Weekly Claude audit: semantic
    // data-quality finding in data/jobs/by-crawler") — stesso genere di
    // problema, nessuna label nuova da creare.
    labels: ['crawler-data-quality'],
    workflow: 'audit-missing-company-logos',
  });
  console.log('[audit-missing-company-logos] Issue aperta/aggiornata.');
}

async function main() {
  const reportIssueFlag = process.argv.includes('--report-issue');

  const jobs = await loadCrawlerSliceJobs();
  console.log(`[audit-missing-company-logos] Job caricati: ${jobs.length} (${CRAWLERS_DIR}).`);

  const { companiesTotal, withLogo, missing } = computeMissingCompanies(jobs);
  const missingJobCount = missing.reduce((a, c) => a + c.jobCount, 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    companiesTotal,
    withLogo,
    missing: missing.length,
    missingJobCount,
    companies: missing,
  };

  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[audit-missing-company-logos] Aziende totali: ${companiesTotal} — con logo: ${withLogo} — senza logo: ${missing.length} (${missingJobCount} annunci). Scritto ${OUTPUT}`,
  );

  if (reportIssueFlag) await reportIssue(payload);
}

main().catch((err) => {
  console.error('[audit-missing-company-logos] Fatal:', err);
  process.exit(1);
});
