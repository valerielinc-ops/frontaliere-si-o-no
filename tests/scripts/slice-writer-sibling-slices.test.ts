// @vitest-environment node
/**
 * Issue 12467 — the slice writer of one crawler must not revert the slice of a
 * group sibling.
 *
 * Crawlers of a group run four at a time in one checkout. A dedicated crawler
 * first overwrites its own slice with the freshly merged working set
 * (`seedCrawlerSlicesFromDataJobs`): raw parser slugs as master, the same raw
 * slug still in the history. It stays like that until the crawler writes its
 * final slice. Every other writer scans the fleet in the meantime. From
 * 2026-10-07 16:22Z that scan rewrote any slice with a self-canonical entry
 * in its history, i.e. every sibling in its seed state, with what it had read.
 * Measured on main: master slugs differing from the Italian slug went from
 * 465 (1,4%) to 3.662 (11,3%) in two crawl rounds, and 61 of 68 distinct
 * postings of one slice ended up on shared slugs.
 *
 * The real writer runs here, in a child process, on a temporary copy of its
 * import closure (same scheme as assemble-translation-hold.test.ts). No
 * tracked file is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSEMBLE_AUX_DATA_INPUTS, listAssembleCodeClosure } from '../../scripts/assemble-jobs-dataset.mjs';
import { stableSlugHash } from '../../scripts/lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SLICES = path.join('data', 'jobs', 'by-crawler');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, any>;

let tmpRoot = '';

function description(n: number) {
  return [
    'Für', 'unsere', 'Filiale', 'suchen', 'wir', 'eine', 'motivierte', 'Person', 'mit', 'Freude', 'am', 'Verkauf',
    'und', 'an', 'der', 'Beratung', 'unserer', 'Kundschaft', 'Ihre', 'Aufgaben', 'umfassen', 'die', 'Warenpräsentation',
    'das', 'Auffüllen', 'der', 'Regale', 'sowie', 'die', 'Arbeit', 'an', 'der', 'Kasse', 'Wir', 'bieten', 'ein',
    'kollegiales', 'Team', 'geregelte', 'Arbeitszeiten', 'und', 'eine', 'sorgfältige', 'Einarbeitung', 'Referenz', String(n),
  ].join(' ');
}

/** A sibling posting as its crawler publishes it: Italian master slug with the town. */
function siblingJob(n: number, town: string): Job {
  const title = 'Mitarbeiter Verkauf (m/w/d)';
  const raw = 'mitarbeiter-verkauf-m-w-d-bottega-sorella';
  const it = `addetto-alle-vendite-m-w-d-bottega-sorella-${town}`;
  return {
    id: `bottega-sorella-${n}`,
    url: `https://jobs.bottega-sorella.invalid/job/51${n}`,
    slug: it,
    slugByLocale: { it, de: `${raw}-${town}`, en: `sales-assistant-m-f-d-bottega-sorella-${town}`, fr: `vendeur-h-f-d-bottega-sorella-${town}` },
    previousSlugs: [raw],
    previousSlugsByLocale: { it: [raw] },
    company: 'Bottega Sorella',
    companyKey: 'bottega-sorella',
    title,
    sourceLang: 'de',
    titleByLocale: { de: title, it: 'Addetto alle vendite (m/f/d)', en: 'Sales assistant (m/f/d)', fr: 'Vendeur (h/f/d)' },
    description: description(n),
    descriptionByLocale: { de: description(n) },
    location: town,
    addressLocality: town,
    canton: 'ZH',
    postedDate: daysAgo(3).slice(0, 10),
    crawledAt: daysAgo(0),
    baseSalary: { '@type': 'MonetaryAmount', currency: 'CHF' },
    source: 'Dedicated Parser',
  };
}

/** The same posting while its crawler is between the seed and the final write. */
function seeded(job: Job): Job {
  const raw = 'mitarbeiter-verkauf-m-w-d-bottega-sorella';
  const { baseSalary: _dropped, ...rest } = job;
  return { ...rest, slug: raw, previousSlugs: [raw, job.slug], previousSlugsByLocale: { it: [raw, job.slug] } };
}

function actorJob(n: number, overrides: Job = {}): Job {
  const title = `Fachperson Logistik ${n}`;
  const slug = `specialista-logistica-${n}-officina-attore-chur`;
  return {
    id: `officina-attore-${n}`,
    url: `https://jobs.officina-attore.invalid/job/72${n}`,
    slug,
    slugByLocale: { it: slug, de: `fachperson-logistik-${n}-officina-attore-chur` },
    company: 'Officina Attore',
    companyKey: 'officina-attore',
    title,
    sourceLang: 'de',
    titleByLocale: { de: title, it: `Specialista logistica ${n}`, en: `Logistics specialist ${n}`, fr: `Spécialiste logistique ${n}` },
    description: description(100 + n),
    descriptionByLocale: { de: description(100 + n) },
    location: 'Chur',
    addressLocality: 'Chur',
    canton: 'GR',
    postedDate: daysAgo(2).slice(0, 10),
    crawledAt: daysAgo(0),
    source: 'Dedicated Parser',
    ...overrides,
  };
}

const sliceFile = (key: string) => path.join(tmpRoot, SLICES, `${key}.json`);

function writeSliceFile(key: string, jobs: Job[]) {
  fs.mkdirSync(path.dirname(sliceFile(key)), { recursive: true });
  const tmp = `${sliceFile(key)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ jobs }, null, 2));
  fs.renameSync(tmp, sliceFile(key));
}

const readSlice = (key: string) => JSON.parse(fs.readFileSync(sliceFile(key), 'utf8')).jobs as Job[];

function runWriter(script: string[], fresh: Job[]) {
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

const WRITE_ACTOR = [
  "import fs from 'node:fs';",
  "import { writeJobsCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
  "writeJobsCrawlerSlice('officina-attore', JSON.parse(fs.readFileSync('fresh.json', 'utf8')));",
];

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-writer-siblings-'));
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
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a crawler slice writer next to a sibling that is still running', () => {
  it('leaves the sibling slice in its seed state byte for byte', () => {
    const published = [siblingJob(1, 'uster'), siblingJob(2, 'baden'), siblingJob(3, 'thun')];
    writeSliceFile('bottega-sorella', published.map(seeded));
    const before = fs.readFileSync(sliceFile('bottega-sorella'));

    runWriter(WRITE_ACTOR, [actorJob(1), actorJob(2)]);

    expect(readSlice('officina-attore').map((job) => job.id).sort()).toEqual(['officina-attore-1', 'officina-attore-2']);
    expect(fs.readFileSync(sliceFile('bottega-sorella')).equals(before)).toBe(true);
  });

  it('does not put the seed back when the sibling publishes while the fleet is being scanned', () => {
    const published = [siblingJob(1, 'uster'), siblingJob(2, 'baden'), siblingJob(3, 'thun')];
    writeSliceFile('bottega-sorella', published.map(seeded));
    fs.writeFileSync(path.join(tmpRoot, 'sibling-final.json'), JSON.stringify({ jobs: published }, null, 2));

    // A route the actor still carries but that belongs to a sibling posting:
    // the one redirect that does make this writer touch the sibling file.
    const owner = published[0];
    const ownerRoute = `vecchia-rotta-sorella-${stableSlugHash(owner)}`;
    const fresh = [actorJob(1, { previousSlugs: [ownerRoute] }), actorJob(2)];

    const log = runWriter([
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const sibling = path.resolve('data', 'jobs', 'by-crawler', 'bottega-sorella.json');",
      'const read = fs.readFileSync;',
      'let published = false;',
      'fs.readFileSync = function patched(file, ...rest) {',
      '  const value = read.call(fs, file, ...rest);',
      "  if (!published && typeof file === 'string' && path.resolve(file) === sibling) {",
      '    published = true;',
      "    fs.copyFileSync('sibling-final.json', `${sibling}.next`);",
      '    fs.renameSync(`${sibling}.next`, sibling);',
      "    console.log('SIBLING_PUBLISHED_DURING_SCAN');",
      '  }',
      '  return value;',
      '};',
      "const { writeJobsCrawlerSlice } = await import('./scripts/assemble-jobs-dataset.mjs');",
      "writeJobsCrawlerSlice('officina-attore', JSON.parse(read.call(fs, 'fresh.json', 'utf8')));",
    ], fresh);

    // The race was really staged: the writer read the seed, then the sibling published.
    expect(log).toContain('SIBLING_PUBLISHED_DURING_SCAN');

    const sibling = readSlice('bottega-sorella');
    expect(sibling.map((job) => job.slug)).toEqual(published.map((job) => job.slug));
    expect(sibling.every((job) => job.baseSalary)).toBe(true);
    expect(new Set(sibling.map((job) => job.slug)).size).toBe(3);
    expect(log).toContain('left 1 sibling slice(s) untouched');

    // The route was not delivered, so the actor still holds it for the next pass.
    const actor = readSlice('officina-attore').find((job) => job.id === 'officina-attore-1');
    expect(actor?.previousSlugs).toContain(ownerRoute);
  });

  it('delivers a route to a sibling that did not change', () => {
    const published = [siblingJob(1, 'uster'), siblingJob(2, 'baden')];
    writeSliceFile('bottega-sorella', published);
    const owner = published[0];
    const ownerRoute = `vecchia-rotta-sorella-${stableSlugHash(owner)}`;

    runWriter(WRITE_ACTOR, [actorJob(1, { previousSlugs: [ownerRoute] }), actorJob(2)]);

    const sibling = readSlice('bottega-sorella').find((job) => job.id === owner.id);
    expect(sibling?.previousSlugs).toContain(ownerRoute);
    expect(sibling?.slug).toBe(owner.slug);
    const actor = readSlice('officina-attore').find((job) => job.id === 'officina-attore-1');
    expect(actor?.previousSlugs ?? []).not.toContain(ownerRoute);
  });
});
