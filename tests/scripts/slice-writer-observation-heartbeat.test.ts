// @vitest-environment node
/**
 * Observer: a crawler cannot persist an active vacancy without a crawledAt
 * heartbeat.
 *
 * Measured on main on 2026-11-10: 1.535 active slice records in 39 slices had
 * no crawledAt (Galenica 324, PEMSA 301, confederazione-ticino 237, AXA 166,
 * ...). Their runners call writeJobsCrawlerSlice / writeJobsCrawlerSliceVerified
 * without `observedJobs`, and the writer only stamped declared observations,
 * so cleanup-jobs never aged them and a vacancy closed at the source stayed
 * active. The fix lives in the common point, the writer, so every crawler is
 * covered; this test drives the REAL writer the way those runners do.
 *
 * The writer runs in a child process on a temporary copy of its import closure
 * (same scheme as slice-writer-sibling-slices.test.ts); no tracked file is
 * touched.
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
const SLICES = path.join('data', 'jobs', 'by-crawler');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, any>;

let tmpRoot = '';

function description(n: number) {
  return [
    'Per', 'la', 'nostra', 'farmacia', 'cerchiamo', 'una', 'persona', 'motivata', 'con', 'esperienza', 'nella',
    'consulenza', 'alla', 'clientela', 'e', 'nella', 'gestione', 'delle', 'ordinazioni', 'Le', 'mansioni',
    'comprendono', 'la', 'preparazione', 'dei', 'medicamenti', 'il', 'controllo', 'delle', 'scorte', 'e', 'il',
    'servizio', 'alla', 'cassa', 'Offriamo', 'un', 'team', 'collegiale', 'orari', 'regolari', 'e', 'una',
    'formazione', 'accurata', 'Riferimento', String(n),
  ].join(' ');
}

/** A posting as the uncovered runners hand it to the writer: no crawledAt. */
function posting(n: number, overrides: Job = {}): Job {
  const title = `Assistente di farmacia ${n}`;
  const slug = `assistente-di-farmacia-${n}-farmacia-osservata-lugano`;
  return {
    id: `farmacia-osservata-${n}`,
    url: `https://jobs.farmacia-osservata.invalid/job/81${n}`,
    slug,
    slugByLocale: { it: slug },
    company: 'Farmacia Osservata',
    companyKey: 'farmacia-osservata',
    title,
    sourceLang: 'it',
    titleByLocale: { it: title, de: `Pharmaassistent/in ${n}`, en: `Pharmacy assistant ${n}`, fr: `Assistant(e) en pharmacie ${n}` },
    description: description(n),
    descriptionByLocale: { it: description(n) },
    location: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    postedDate: daysAgo(2).slice(0, 10),
    firstSeenAt: daysAgo(120),
    source: 'Dedicated Parser',
    ...overrides,
  };
}

const sliceFile = (key: string) => path.join(tmpRoot, SLICES, `${key}.json`);
const readSlice = (key: string) => JSON.parse(fs.readFileSync(sliceFile(key), 'utf8')).jobs as Job[];

function runWriter(script: string[], fresh: Job[]) {
  fs.rmSync(sliceFile('farmacia-osservata'), { force: true });
  fs.writeFileSync(path.join(tmpRoot, 'fresh.json'), JSON.stringify(fresh));
  fs.writeFileSync(path.join(tmpRoot, 'write-slice.mjs'), script.join('\n'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'GOOGLE_APPLICATION_CREDENTIALS' || key === 'GITHUB_ACTIONS' || key === 'GITHUB_RUN_ID') continue;
    env[key] = value;
  }
  const result = spawnSync(process.execPath, ['write-slice.mjs'], {
    cwd: tmpRoot,
    env: { ...env, SKIP_OWNERSHIP_GUARD: '1', CRAWLER_SLICE_ONLY: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`write-slice.mjs exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const writeWith = (call: string) => [
  "import fs from 'node:fs';",
  "import { writeJobsCrawlerSlice, writeJobsCrawlerSliceVerified } from './scripts/assemble-jobs-dataset.mjs';",
  "const fresh = JSON.parse(fs.readFileSync('fresh.json', 'utf8'));",
  call,
];

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-writer-heartbeat-'));
  for (const abs of listAssembleCodeClosure()) {
    if (!fs.existsSync(abs) || !abs.startsWith(REPO_ROOT + path.sep)) continue;
    const dest = path.join(tmpRoot, path.relative(REPO_ROOT, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  for (const rel of ASSEMBLE_AUX_DATA_INPUTS) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isFile() && stat.size > 1_000_000) continue;
    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
    fs.cpSync(src, path.join(tmpRoot, rel), { recursive: true });
  }
  fs.mkdirSync(path.join(tmpRoot, SLICES), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function expectFreshHeartbeat(job: Job | undefined, before: number) {
  expect(job, 'persisted row').toBeDefined();
  const stamped = Date.parse(String(job?.crawledAt));
  expect(Number.isFinite(stamped), `crawledAt of ${job?.id}`).toBe(true);
  expect(stamped).toBeGreaterThanOrEqual(before);
}

describe('slice writer: every observed active row leaves with a crawledAt heartbeat', () => {
  it('writeJobsCrawlerSlice without observedJobs (PEMSA / confederazione / AXA call shape)', () => {
    const before = Date.now();
    runWriter(writeWith("writeJobsCrawlerSlice('farmacia-osservata', fresh);"), [posting(1), posting(2)]);

    const persisted = readSlice('farmacia-osservata');
    expect(persisted).toHaveLength(2);
    for (const job of persisted) expectFreshHeartbeat(job, before);
  });

  it('writeJobsCrawlerSliceVerified without observedJobs (Galenica call shape)', () => {
    const before = Date.now();
    runWriter(
      writeWith("await writeJobsCrawlerSliceVerified('farmacia-osservata', fresh, { isTargetJob: () => true });"),
      [posting(1), posting(2)],
    );

    for (const job of readSlice('farmacia-osservata')) expectFreshHeartbeat(job, before);
  });

  it('does not stamp a row the crawler kept without seeing it, nor a heartbeat the crawler owns', () => {
    const crawlerHeartbeat = daysAgo(10);
    runWriter(writeWith("writeJobsCrawlerSlice('farmacia-osservata', fresh);"), [
      posting(1),
      posting(2, { crawlerMissStreak: 1 }),
      posting(3, { crawledAt: crawlerHeartbeat }),
    ]);

    const byId = new Map(readSlice('farmacia-osservata').map((job) => [job.id, job]));
    expect(byId.get('farmacia-osservata-2')?.crawledAt).toBeUndefined();
    expect(byId.get('farmacia-osservata-3')?.crawledAt).toBe(crawlerHeartbeat);
  });

  it('honours a declared observation: only the rows the fetch returned are stamped', () => {
    const before = Date.now();
    runWriter(
      writeWith("writeJobsCrawlerSlice('farmacia-osservata', fresh, { observedJobs: [fresh[0]] });"),
      [posting(1), posting(2)],
    );

    const byId = new Map(readSlice('farmacia-osservata').map((job) => [job.id, job]));
    expectFreshHeartbeat(byId.get('farmacia-osservata-1'), before);
    expect(byId.get('farmacia-osservata-2')?.crawledAt).toBeUndefined();
  });
});
