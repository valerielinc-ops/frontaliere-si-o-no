// @vitest-environment node
/**
 * L3 Job Quality: la summary del crawler conta new/updated/unchanged su un
 * insieme diverso da total.
 *
 * OSSERVATORE della partizione (issue 8407, causa #2). Una summary dichiara
 * `total`/`written` e `newCount + updatedCount + unchangedCount` della STESSA
 * slice attiva; L3 (`scripts/ci/loop-l3-job-quality.mjs`) controlla
 * l'uguaglianza. I crawler calcolavano il diff sulle righe fuse PRIMA di
 * localizzazione/validazione e `total` sull'array consegnato al writer DOPO:
 * quando quei passi tolgono o aggiungono righe la summary si rompe
 * (anker-swiss 223 vs 269, agie-charmilles 29 vs 26 sul main del 2026-10-04).
 *
 * Gira sul percorso vero: writeJobsCrawlerSlice → writeSummaryCrawlerSlice →
 * file della summary → validateJobSummaries di L3, in una copia temporanea
 * della chiusura di import dell'assemblatore (schema di
 * assemble-translation-hold.test.ts), in un processo figlio. Nessun file
 * tracciato viene toccato.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSEMBLE_AUX_DATA_INPUTS, listAssembleCodeClosure } from '../../scripts/assemble-jobs-dataset.mjs';
import { validateJobSummaries } from '../../scripts/ci/loop-l3-job-quality.mjs';
import { computeSlicePartition } from '../../scripts/lib/crawler-summary-partition.mjs';
import { snapshotJobSlugs, computeCrawlDiff } from '../../scripts/jobs-url-helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, any>;

let tmpRoot = '';

function description(n: number) {
  return [
    'Per il nostro reparto di produzione a Lugano cerchiamo una persona motivata',
    'con formazione tecnica e alcuni anni di esperienza nella lavorazione di',
    'componenti di precisione. Le mansioni comprendono la programmazione e la',
    'messa in funzione dei centri di lavoro, il controllo qualità secondo disegno,',
    'la manutenzione ordinaria delle macchine e la collaborazione con il reparto',
    `logistica. Offriamo un ambiente dinamico e formazione continua. Riferimento ${n}.`,
  ].join(' ');
}

function job(key: string, n: number, overrides: Job = {}): Job {
  const title = `Polimeccanico CNC ${n}`;
  const desc = description(n);
  const slug = `polimeccanico-cnc-${n}-${key}-lugano`;
  return {
    id: `${key}-${n}`,
    url: `https://jobs.example.invalid/${key}/${n}`,
    applyUrl: `https://jobs.example.invalid/${key}/${n}/apply`,
    slug,
    slugByLocale: { it: slug, en: `${slug}-en`, de: `${slug}-de`, fr: `${slug}-fr` },
    company: 'Acme SA',
    companyKey: key,
    title,
    sourceLang: 'it',
    titleByLocale: { it: title, en: `CNC polymechanic ${n}`, de: `Polymechaniker CNC ${n}`, fr: `Polymécanicien CNC ${n}` },
    description: desc,
    descriptionByLocale: { it: desc, en: desc, de: desc, fr: desc },
    location: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    country: 'CH',
    postedDate: daysAgo(3).slice(0, 10),
    crawledAt: daysAgo(0),
    source: 'Acme Dedicated Parser',
    ...overrides,
  };
}

function writeJson(rel: string, value: unknown) {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(value, null, 2));
}

function readJson(rel: string) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, rel), 'utf8'));
}

function runNode(args: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'GITHUB_ACTIONS' || key === 'GITHUB_RUN_ID') continue;
    env[key] = value;
  }
  const result = spawnSync(process.execPath, args, {
    cwd: tmpRoot,
    env: { ...env, SKIP_OWNERSHIP_GUARD: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * What a crawler does: diff on `clean`, slice write of `sliceJobs`, summary
 * with total = sliceJobs.length and the counts of the diff on `clean`.
 */
function runCrawler(key: string, clean: Job[], sliceJobs: Job[]) {
  const prior = readJson(`data/jobs/by-crawler/${key}.json`).jobs as Job[];
  const diff = computeCrawlDiff(snapshotJobSlugs(prior), snapshotJobSlugs(clean));
  writeJson('crawler-input.json', {
    key,
    sliceJobs,
    summary: {
      key,
      label: 'Acme SA',
      generatedAt: new Date().toISOString(),
      total: sliceJobs.length,
      written: sliceJobs.length,
      newCount: diff.newJobs.length,
      updatedCount: diff.updatedJobs.length,
      removedCount: diff.removedJobs.length,
      unchangedCount: diff.unchangedCount,
      newJobs: diff.newJobs,
      updatedJobs: diff.updatedJobs,
      removedJobs: diff.removedJobs,
      unchangedJobs: diff.unchangedJobs,
    },
  });
  fs.writeFileSync(path.join(tmpRoot, 'run-crawler.mjs'), [
    "import fs from 'node:fs';",
    "import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
    "const input = JSON.parse(fs.readFileSync('crawler-input.json', 'utf8'));",
    'writeJobsCrawlerSlice(input.key, input.sliceJobs);',
    'writeSummaryCrawlerSlice(input.summary);',
  ].join('\n'));
  runNode(['run-crawler.mjs']);
}

function partitionIssues(file: string, summary: Job) {
  const verdict = validateJobSummaries([{ file, data: summary }], { now: new Date() });
  return verdict.issues.filter((issue) => issue.startsWith(`${file}.`));
}

const ids = (jobs: Job[]) => jobs.map((entry) => entry.id).sort();

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-summary-partition-'));
  for (const abs of listAssembleCodeClosure()) {
    if (!fs.existsSync(abs) || !abs.startsWith(REPO_ROOT + path.sep)) continue;
    const dest = path.join(tmpRoot, path.relative(REPO_ROOT, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  // The tracked reference data the writers read at import time (same rule as
  // assemble-translation-hold.test.ts: the multi-MB ledgers are not needed).
  for (const rel of ASSEMBLE_AUX_DATA_INPUTS) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isFile() && fs.statSync(src).size > 1_000_000) continue;
    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
    fs.cpSync(src, path.join(tmpRoot, rel), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('summary del crawler: una sola slice per total e partizione', () => {
  it.each([
    {
      label: 'localizzazione/validazione TOLGONO righe dopo il diff',
      clean: (key: string) => [job(key, 1, { title: 'Polimeccanico CNC 1 (rev.)' }), job(key, 2), job(key, 3), job(key, 10)],
      slice: (key: string) => [job(key, 1, { title: 'Polimeccanico CNC 1 (rev.)' }), job(key, 10)],
    },
    {
      label: 'localizzazione/validazione AGGIUNGONO righe dopo il diff',
      clean: (key: string) => [job(key, 1), job(key, 2)],
      slice: (key: string) => [job(key, 1), job(key, 2), job(key, 11), job(key, 12)],
    },
  ])('$label: total, written e new+updated+unchanged descrivono la slice pubblicata', ({ label, clean, slice }) => {
    const key = `l3-partition-${label.includes('TOLGONO') ? 'drop' : 'add'}`;
    writeJson(`data/jobs/by-crawler/${key}.json`, {
      crawlerKey: key,
      assembledAt: daysAgo(1),
      jobs: [job(key, 1), job(key, 2), job(key, 3), job(key, 4)],
    });

    runCrawler(key, clean(key), slice(key));

    const published = readJson(`data/jobs/by-crawler/${key}.json`).jobs as Job[];
    const file = `data/jobs-crawler-summaries/by-crawler/${key}.json`;
    const summary = readJson(file);
    // The observer the loop itself runs: no count/partition finding.
    expect(partitionIssues(file, summary)).toEqual([]);
    expect(summary.total).toBe(published.length);
    expect(summary.written).toBe(published.length);
    expect(summary.newCount + summary.updatedCount + summary.unchangedCount).toBe(published.length);
    expect(ids([...summary.newJobs, ...summary.updatedJobs, ...summary.unchangedJobs])).toEqual(ids(published));
    // Rows of the prior slice that are not published are the removed ones.
    const publishedIds = new Set(published.map((entry) => entry.id));
    const priorIds = [1, 2, 3, 4].map((n) => `${key}-${n}`);
    expect(ids(summary.removedJobs)).toEqual(priorIds.filter((id) => !publishedIds.has(id)).sort());
    expect(summary.removedCount).toBe(summary.removedJobs.length);
  });

  it('una summary aggregata (swatchgroup) descrive le slice che nomina, anche quelle non riscritte', () => {
    for (const key of ['l3-agg-a', 'l3-agg-b']) {
      writeJson(`data/jobs/by-crawler/${key}.json`, { crawlerKey: key, assembledAt: daysAgo(1), jobs: [job(key, 1), job(key, 2)] });
    }
    // One brand is rewritten with a new row, the other keeps its slice (write
    // guard refused, or nothing to write); the shared diff covers both.
    const sharedDiffJobs = [job('l3-agg-a', 1), job('l3-agg-a', 2), job('l3-agg-a', 3)];
    writeJson('aggregate-input.json', { rewritten: sharedDiffJobs });
    fs.writeFileSync(path.join(tmpRoot, 'run-aggregate.mjs'), [
      "import fs from 'node:fs';",
      "import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
      "const input = JSON.parse(fs.readFileSync('aggregate-input.json', 'utf8'));",
      "writeJobsCrawlerSlice('l3-agg-a', input.rewritten);",
      'const declared = { generatedAt: new Date().toISOString(), newCount: 0, updatedCount: 0, removedCount: 0, unchangedCount: 0, newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: [] };',
      "writeSummaryCrawlerSlice({ ...declared, key: 'l3-agg', label: 'Aggregate', total: 99 }, { publishedSliceKeys: ['l3-agg-a', 'l3-agg-b'] });",
      "writeSummaryCrawlerSlice({ ...declared, key: 'l3-agg-b', label: 'Brand B', total: 99 }, { publishedSliceKeys: ['l3-agg-b'] });",
    ].join('\n'));
    runNode(['run-aggregate.mjs']);

    const a = readJson('data/jobs/by-crawler/l3-agg-a.json').jobs as Job[];
    const b = readJson('data/jobs/by-crawler/l3-agg-b.json').jobs as Job[];
    for (const [key, expected] of [['l3-agg', [...a, ...b]], ['l3-agg-b', b]] as const) {
      const file = `data/jobs-crawler-summaries/by-crawler/${key}.json`;
      const summary = readJson(file);
      expect(partitionIssues(file, summary)).toEqual([]);
      expect(summary.total).toBe(expected.length);
      expect(ids([...summary.newJobs, ...summary.updatedJobs, ...summary.unchangedJobs])).toEqual(ids(expected));
    }
    // The untouched brand is reported as unchanged, not as new.
    expect(readJson('data/jobs-crawler-summaries/by-crawler/l3-agg-b.json').unchangedCount).toBe(b.length);
  });

  it('senza una scrittura della slice nello stesso processo la summary resta quella dichiarata', () => {
    fs.writeFileSync(path.join(tmpRoot, 'run-guard.mjs'), [
      "import { writeSummaryCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
      "writeSummaryCrawlerSlice({ key: 'l3-guard', label: 'Guard', generatedAt: new Date().toISOString(), total: 0, newCount: 0, updatedCount: 0, removedCount: 0, unchangedCount: 0, newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: [], abortKind: 'fetch' });",
    ].join('\n'));
    runNode(['run-guard.mjs']);
    expect(readJson('data/jobs-crawler-summaries/by-crawler/l3-guard.json')).toMatchObject({ key: 'l3-guard', total: 0, abortKind: 'fetch' });
  });
});

describe('computeSlicePartition', () => {
  it('partiziona l array pubblicato: la somma è sempre la sua lunghezza, duplicati compresi', () => {
    const before = [job('p', 1), job('p', 2), job('p', 3)];
    const after = [job('p', 1), job('p', 2, { title: 'Altro titolo' }), job('p', 5), job('p', 5)];
    const partition = computeSlicePartition(before, after);
    expect(partition.total).toBe(after.length);
    expect(partition.newJobs.length + partition.updatedJobs.length + partition.unchangedJobs.length).toBe(after.length);
    expect(ids(partition.unchangedJobs)).toEqual(['p-1']);
    expect(ids(partition.updatedJobs)).toEqual(['p-2']);
    expect(ids(partition.newJobs)).toEqual(['p-5', 'p-5']);
    expect(ids(partition.removedJobs)).toEqual(['p-3']);
  });
});
