#!/usr/bin/env node
/**
 * audit-job-content-plausibility.mjs — filtro deterministico che produce la
 * LISTA CORTA dei record `data/jobs/by-crawler/*.json` che non sembrano
 * annunci di lavoro.
 *
 * E' la meta' economica dello split gia' in uso in `scripts/audit-ai-crawlers.mjs`:
 *   script deterministico (qui) → lista corta → giudizio LLM sulla lista corta
 *   (`.github/workflows/crawler-content-plausibility-audit.yml`).
 * La logica di riconoscimento e la sua calibrazione stanno in
 * `scripts/lib/job-content-plausibility.mjs` — leggi l'intestazione di quel
 * file prima di toccare il lessico: contiene le tre misure sul corpus reale che
 * spiegano perche' due segnali "ovvi" (titolo ripetuto, divergenza
 * titolo↔descrizione) sono stati scartati come trigger.
 *
 * Uso:
 *   node scripts/audit-job-content-plausibility.mjs                  # report leggibile
 *   node scripts/audit-job-content-plausibility.mjs --json           # shortlist JSON su stdout
 *   node scripts/audit-job-content-plausibility.mjs --out=report.json
 *   node scripts/audit-job-content-plausibility.mjs --crawler=schindler
 *   node scripts/audit-job-content-plausibility.mjs --max-findings=200
 *   node scripts/audit-job-content-plausibility.mjs --fail-on-findings   # exit 1 se trova
 *
 * Exit code: 0 di default ANCHE con findings — questo script non e' un gate,
 * e' un produttore di evidenza per il passo LLM che decide. `--fail-on-findings`
 * esiste per l'uso manuale/debug, non per la CI: promuoverlo a gate bloccante
 * senza un baseline renderebbe rosso ogni branch al primo crawler difettoso che
 * atterra, esattamente il fallimento descritto in AGENTS.md → «main rosso blocca
 * a cascata».
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSlice } from './lib/job-content-plausibility.mjs';
import { isSliceFile } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

/** Tetto di sicurezza sulla lista corta passata al modello. Misurato sul corpus
 * del 2026-08-24: 19 findings su 30.320 job / 573 crawler. Un numero
 * enormemente piu' alto significa lessico rotto o dataset corrotto, non 500
 * difetti veri — meglio troncare e dirlo che riversare tutto in un prompt. */
const DEFAULT_MAX_FINDINGS = 200;

function parseArgs(argv) {
  const get = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  return {
    json: argv.includes('--json'),
    failOnFindings: argv.includes('--fail-on-findings'),
    crawler: get('crawler', undefined),
    out: get('out', undefined),
    maxFindings: Number(get('max-findings', DEFAULT_MAX_FINDINGS)),
    dir: get('dir', SLICES_DIR),
  };
}

/**
 * @param {{dir?: string, crawler?: string, maxFindings?: number}} [opts]
 * @returns {{generatedAt: string, scannedCrawlers: number, scannedJobs: number,
 *   flaggedCrawlers: number, findings: Array<object>, truncated: boolean,
 *   crawlerVerdicts: Array<object>}}
 */
export function runAudit(opts = {}) {
  const dir = opts.dir || SLICES_DIR;
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;

  let files = [];
  try {
    files = fs.readdirSync(dir).filter(isSliceFile).sort();
  } catch (err) {
    // Worktree sparse: `data/` puo' non essere materializzato. Non e' la prova
    // che i dati non esistano (memoria «Un fixture in worktree sparse mente») —
    // dillo esplicitamente invece di riportare "0 difetti", che sarebbe un
    // verde fabbricato.
    throw new Error(
      `${dir} non leggibile (${err.code}). In un worktree sparse: ` +
        `git sparse-checkout add data/jobs/by-crawler`
    );
  }
  if (opts.crawler) files = files.filter((f) => f === `${opts.crawler}.json`);

  const findings = [];
  const crawlerVerdicts = [];
  let scannedJobs = 0;
  let scannedCrawlers = 0;

  for (const file of files) {
    let slice;
    try {
      slice = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // JSON illeggibile e' gia' coperto da audit-parser-quality.mjs
    }
    const jobs = Array.isArray(slice?.jobs) ? slice.jobs : [];
    if (!jobs.length) continue; // vuoto = dominio di crawler-health-monitor
    scannedCrawlers++;
    scannedJobs += jobs.length;

    const key = slice.crawlerKey || path.basename(file, '.json');
    const result = scanSlice({ ...slice, crawlerKey: key });
    if (!result.level) continue;

    crawlerVerdicts.push({
      crawlerKey: key,
      level: result.level,
      flagged: result.flagged,
      totalJobs: result.totalJobs,
      ratio: Number(result.ratio.toFixed(3)),
      codes: [...new Set(result.findings.flatMap((f) => f.codes))],
    });
    findings.push(...result.findings);
  }

  const truncated = findings.length > maxFindings;
  return {
    generatedAt: new Date().toISOString(),
    scannedCrawlers,
    scannedJobs,
    flaggedCrawlers: crawlerVerdicts.length,
    truncated,
    crawlerVerdicts: crawlerVerdicts.sort((a, b) =>
      a.level === b.level ? b.ratio - a.ratio : a.level === 'crawler' ? -1 : 1
    ),
    findings: truncated ? findings.slice(0, maxFindings) : findings,
  };
}

function renderHuman(report) {
  const lines = [];
  lines.push(
    `Scansionati ${report.scannedJobs} job su ${report.scannedCrawlers} crawler — ` +
      `${report.flaggedCrawlers} crawler con record sospetti, ${report.findings.length} findings.`
  );
  if (report.truncated) lines.push('ATTENZIONE: lista troncata (--max-findings).');
  if (!report.findings.length) {
    lines.push('Nessun record sospetto. Nessuna issue da aprire.');
    return lines.join('\n');
  }
  for (const v of report.crawlerVerdicts) {
    const scope = v.level === 'crawler' ? 'CRAWLER INTERO' : 'record singoli';
    lines.push(`\n▸ ${v.crawlerKey} — ${scope}: ${v.flagged}/${v.totalJobs} (${v.codes.join(', ')})`);
    for (const f of report.findings.filter((x) => x.crawlerKey === v.crawlerKey).slice(0, 6)) {
      lines.push(`    [${f.codes.join('+')}] ${JSON.stringify(f.title).slice(0, 120)}`);
      if (f.url) lines.push(`      url: ${f.url}`);
      if (f.titleDescriptionOverlap !== null) {
        lines.push(`      overlap titolo→descrizione: ${f.titleDescriptionOverlap.toFixed(2)} (corroborazione, non prova)`);
      }
      if (f.descriptionHead) lines.push(`      desc: ${f.descriptionHead}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('audit-job-content-plausibility.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  let report;
  try {
    report = runAudit(args);
  } catch (err) {
    console.error(`[job-content-plausibility] ${err.message}`);
    process.exit(2);
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2));
  else console.log(renderHuman(report));
  process.exit(args.failOnFindings && report.findings.length ? 1 : 0);
}
