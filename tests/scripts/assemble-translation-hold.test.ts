// @vitest-environment node
/**
 * Soglia di ammissione agenzie (decisione del proprietario 2026-10-03), sul
 * percorso vero: writeJobsCrawlerSlice → slice → assembleJobsDataset →
 * data/jobs.json + public/data/jobs.json.
 *
 *   (a) un job di agenzia NUOVO con il titolo non tradotto resta nello slice ma
 *       non è in data/jobs.json; con JOBS_INCLUDE_TRANSLATION_HELD=1 (il modo
 *       di translate-pending, la cui fase 2b legge data/jobs.json) c'è;
 *   (b) appena i titoli sono tradotti è pubblicato;
 *   (c) i job non di agenzia e quelli di agenzia già online non cambiano.
 *
 * Lo script legge e scrive sotto la propria ROOT, quindi gira in una copia
 * temporanea della sua chiusura di import (lo stesso schema di
 * assemble-jobs-cache.test.ts, limitato ai file che importa davvero), in un
 * processo figlio. Nessun file tracciato viene toccato.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSEMBLE_AUX_DATA_INPUTS, listAssembleCodeClosure } from '../../scripts/assemble-jobs-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, any>;

let tmpRoot = '';

function description(n: number) {
  const words = [
    'Für', 'unseren', 'Kunden', 'im', 'Raum', 'Zürich', 'suchen', 'wir', 'eine', 'motivierte', 'Fachperson',
    'mit', 'abgeschlossener', 'Berufslehre', 'und', 'Erfahrung', 'in', 'der', 'Fertigung', 'von', 'Präzisionsteilen',
    'Ihre', 'Aufgaben', 'umfassen', 'Programmieren', 'Einrichten', 'Bedienen', 'moderner', 'Bearbeitungszentren',
    'Qualitätskontrolle', 'gemäss', 'Zeichnung', 'sowie', 'Wartung', 'Maschinen', 'Wir', 'bieten', 'abwechslungsreiche',
    'Tätigkeit', 'attraktive', 'Anstellungsbedingungen', 'kollegiales', 'Team', 'Weiterbildung', 'Arbeitszeit',
    'Montag', 'bis', 'Freitag', 'Schichtbetrieb', 'nach', 'Absprache', 'Referenz', String(n),
  ];
  return words.join(' ');
}

function agencyJob(n: number, overrides: Job = {}): Job {
  const title = `Polymechaniker/in CNC Fertigung ${n}`;
  const desc = description(n);
  return {
    id: `sta-hold-${n}`,
    url: `https://jobs.example.invalid/job/22${n}`,
    slug: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich`,
    slugByLocale: {
      it: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich`,
      en: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich-en`,
      de: `polymechaniker-in-cnc-fertigung-${n}-zurich-sta-ch`,
      fr: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich-fr`,
    },
    company: 'STA Personal AG',
    companyKey: 'sta',
    title,
    sourceLang: 'de',
    titleByLocale: { it: title, en: title, de: title, fr: title },
    description: desc,
    descriptionByLocale: { it: desc, en: desc, de: desc, fr: desc },
    location: 'Zürich',
    addressLocality: 'Zürich',
    canton: 'ZH',
    postedDate: daysAgo(2).slice(0, 10),
    crawledAt: daysAgo(0),
    source: 'Company Careers Crawler',
    ...overrides,
  };
}

function withTranslatedTitles(job: Job): Job {
  return {
    ...job,
    titleByLocale: {
      de: job.title,
      it: `Polimeccanico/a produzione CNC ${job.id}`,
      en: `CNC production polymechanic ${job.id}`,
      fr: `Polymécanicien/ne production CNC ${job.id}`,
    },
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

function childEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'GOOGLE_APPLICATION_CREDENTIALS' || key === 'GITHUB_ACTIONS' || key === 'GITHUB_RUN_ID') continue;
    if (key === 'JOBS_INCLUDE_TRANSLATION_HELD' || key === 'CRAWLER_SLICE_ONLY') continue;
    env[key] = value;
  }
  return { ...env, JOBS_SKIP_RECONCILIATION: '1', ...extra };
}

function runNode(args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: tmpRoot,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function assemble(extraEnv: Record<string, string> = {}) {
  // A fresh cache dir per run: the include/exclude projections must each be
  // computed, never restored from the other's snapshot.
  fs.rmSync(path.join(tmpRoot, '.cache'), { recursive: true, force: true });
  const log = runNode(['scripts/assemble-jobs-dataset.mjs', '--no-summaries'], extraEnv);
  return { log, data: readJson('data/jobs.json') as Job[], pub: readJson('public/data/jobs.json') as Job[] };
}

const ids = (jobs: Job[]) => jobs.map((job) => job.id).sort();

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-translation-hold-'));
  for (const abs of listAssembleCodeClosure()) {
    if (!fs.existsSync(abs) || !abs.startsWith(REPO_ROOT + path.sep)) continue;
    const dest = path.join(tmpRoot, path.relative(REPO_ROOT, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  // The tracked reference data the assembly reads at run time. The two
  // multi-MB ledgers (canton pins, orphan slugs) are its own outputs or feed
  // only the reconciliation this test skips, so the sandbox starts without them.
  for (const rel of ASSEMBLE_AUX_DATA_INPUTS) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isFile() && stat.size > 1_000_000) continue;
    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
    fs.cpSync(src, path.join(tmpRoot, rel), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('soglia di ammissione agenzie — writer + assemblatore reali', () => {
  it('holds only the new untranslated agency arrival, and keeps it in the slice and in the translate-pending projection', () => {
    // Slice as the code BEFORE this change left it: no stamps, untranslated
    // titles, already published.
    const online = agencyJob(1);
    writeJson('data/jobs/by-crawler/sta.json', { crawlerKey: 'sta', assembledAt: daysAgo(1), jobs: [online] });
    // A non-agency crawler with the same untranslated shape.
    const coop = { ...agencyJob(9), id: 'coop-hold-9', companyKey: 'coop', company: 'Coop', url: 'https://jobs.example.invalid/job/229', slug: 'polymechaniker-in-cnc-fertigung-9-coop-zurich', slugByLocale: {} };
    writeJson('data/jobs/by-crawler/coop.json', { crawlerKey: 'coop', assembledAt: daysAgo(1), jobs: [coop] });

    // The crawler re-crawls: the online job again, plus two new arrivals.
    const fresh = [agencyJob(1), agencyJob(2), withTranslatedTitles(agencyJob(3))];
    fs.writeFileSync(path.join(tmpRoot, 'write-slice.mjs'), [
      "import fs from 'node:fs';",
      "import { writeJobsCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
      "writeJobsCrawlerSlice('sta', JSON.parse(fs.readFileSync('fresh.json', 'utf8')));",
    ].join('\n'));
    fs.writeFileSync(path.join(tmpRoot, 'fresh.json'), JSON.stringify(fresh));
    runNode(['write-slice.mjs'], { SKIP_OWNERSHIP_GUARD: '1' });

    const slice = readJson('data/jobs/by-crawler/sta.json').jobs as Job[];
    expect(ids(slice)).toEqual(['sta-hold-1', 'sta-hold-2', 'sta-hold-3']);
    const byId = new Map(slice.map((job) => [job.id, job]));
    expect(byId.get('sta-hold-1')?.translationHoldSince).toBeUndefined();
    expect(byId.get('sta-hold-2')?.translationHoldSince).toBeTruthy();
    expect(byId.get('sta-hold-3')?.translationHoldSince).toBeUndefined();

    const published = assemble();
    expect(ids(published.data)).toEqual(['coop-hold-9', 'sta-hold-1', 'sta-hold-3']);
    expect(ids(published.pub)).toEqual(ids(published.data));
    expect(published.log).toContain('1 job fuori dalla pubblicazione');
    expect(readJson('data/jobs-meta.json').totalJobs).toBe(3);

    const projection = assemble({ JOBS_INCLUDE_TRANSLATION_HELD: '1' });
    expect(ids(projection.data)).toEqual(['coop-hold-9', 'sta-hold-1', 'sta-hold-2', 'sta-hold-3']);
    // The projection is for translate-pending only: the site count is unchanged.
    expect(readJson('data/jobs-meta.json').totalJobs).toBe(3);
  });

  it('publishes the held job as soon as its titles are translated', () => {
    const slice = readJson('data/jobs/by-crawler/sta.json');
    slice.jobs = slice.jobs.map((job: Job) => (job.id === 'sta-hold-2' ? withTranslatedTitles(job) : job));
    writeJson('data/jobs/by-crawler/sta.json', slice);
    const published = assemble();
    expect(ids(published.data)).toEqual(['coop-hold-9', 'sta-hold-1', 'sta-hold-2', 'sta-hold-3']);
  });
});
