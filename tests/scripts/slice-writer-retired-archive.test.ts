// @vitest-environment node
/**
 * Invariant: a posting that a slice write retires lands in the expired archive
 * with its title, so the build emits the expired soft-landing and not the
 * noindex «Offerta non verificata» stub (build-plugins/shared/jobArchiveEvidence.ts).
 *
 * Measured on 2026-11-12: Città di Locarno (b56ac5328bf0, 2026-11-07), Guess
 * (2cef9bb5b374, 2026-11-05) and Sintetica (d2f9db568bf6, 2026-11-10) dropped
 * postings with GSC clicks through bespoke runners that call
 * writeJobsCrawlerSlice directly; none of them reached
 * data/jobs/expired/by-crawler, and the live pages became stubs. The writer is
 * the common funnel of ~119 runners, so the archive step lives there.
 *
 * The writer runs in a child process on a temporary copy of its import closure
 * (same scheme as slice-writer-observation-heartbeat.test.ts): no tracked file
 * is read or written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSEMBLE_AUX_DATA_INPUTS,
  listAssembleCodeClosure,
  retiredSliceRows,
} from '../../scripts/assemble-jobs-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const KEY = 'comune-ritirato';

type Job = Record<string, any>;

let tmpRoot = '';

function description(n: number) {
  return [
    'Il', 'Municipio', 'apre', 'un', 'concorso', 'per', 'la', 'cancelleria', 'comunale', 'La', 'persona',
    'si', 'occupera', 'della', 'gestione', 'degli', 'atti', 'dello', 'sportello', 'al', 'pubblico', 'e',
    'della', 'corrispondenza', 'con', 'gli', 'uffici', 'cantonali', 'Requisiti', 'attestato', 'federale',
    'di', 'capacita', 'esperienza', 'in', 'amministrazione', 'pubblica', 'buona', 'conoscenza', 'del',
    'tedesco', 'Entrata', 'in', 'servizio', 'da', 'convenire', 'Riferimento', String(n),
  ].join(' ');
}

function posting(n: number, overrides: Job = {}): Job {
  const title = `Impiegata amministrativa ${n}`;
  const slug = `impiegata-amministrativa-${n}-comune-ritirato-locarno`;
  return {
    id: `${KEY}-${n}`,
    url: `https://www.comune-ritirato.invalid/concorsi/${n}`,
    slug,
    slugByLocale: { it: slug },
    company: 'Comune Ritirato',
    companyKey: KEY,
    title,
    sourceLang: 'it',
    titleByLocale: { it: title, de: `Verwaltungsangestellte ${n}`, en: `Administrative clerk ${n}`, fr: `Employée administrative ${n}` },
    description: description(n),
    descriptionByLocale: { it: description(n) },
    location: 'Locarno',
    addressLocality: 'Locarno',
    canton: 'TI',
    postedDate: daysAgo(3).slice(0, 10),
    firstSeenAt: daysAgo(20),
    crawledAt: daysAgo(1),
    source: 'Dedicated Parser',
    ...overrides,
  };
}

function findFiles(name: string, under: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name === name) found.push(abs);
    }
  };
  walk(under);
  return found;
}

/** The expired slice the writer persisted, found under the temporary root. */
function expiredSlice(): Job[] {
  const files = findFiles(`${KEY}.json`, tmpRoot).filter((file) => file.includes(`${path.sep}expired${path.sep}`));
  if (files.length === 0) return [];
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}

function runWriter(fresh: Job[]) {
  fs.writeFileSync(path.join(tmpRoot, 'fresh.json'), JSON.stringify(fresh));
  fs.writeFileSync(path.join(tmpRoot, 'write-slice.mjs'), [
    "import fs from 'node:fs';",
    "import { writeJobsCrawlerSlice } from './scripts/assemble-jobs-dataset.mjs';",
    "const fresh = JSON.parse(fs.readFileSync('fresh.json', 'utf8'));",
    `writeJobsCrawlerSlice('${KEY}', fresh);`,
  ].join('\n'));
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

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-writer-retired-'));
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

describe('writeJobsCrawlerSlice archives the rows it retires', () => {
  it('an ordinary drop by a bespoke runner (Locarno shape) leaves a titled archive record', () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => posting(n));
    runWriter(all);
    expect(expiredSlice()).toEqual([]);

    // One bando of six closes at the source: 6 -> 5 is below the shrink
    // guard, so before the fix nothing archived it.
    const log = runWriter(all.filter((job) => job.id !== `${KEY}-3`));
    expect(log).toContain('Retired 1 row(s)');

    const archived = expiredSlice();
    expect(archived.map((entry) => entry.slug)).toEqual([posting(3).slug]);
    expect(archived[0].title).toBe(posting(3).title);
    expect(archived[0].titleByLocale?.de).toBe(posting(3).titleByLocale.de);
    expect(typeof archived[0].expiredAt).toBe('string');
  });

  it('is idempotent: a repeated write does not rewrite the archive record', () => {
    const before = expiredSlice();
    runWriter([1, 2, 4, 5, 6].map((n) => posting(n)));
    expect(expiredSlice()).toEqual(before);
  });

  it('a renamed posting (same id, old slug in its history) is not retired', () => {
    const renamedSlug = 'impiegata-amministrativa-al-50-2-comune-ritirato-locarno';
    const renamed = posting(2, {
      title: 'Impiegata amministrativa al 50% 2',
      slug: renamedSlug,
      slugByLocale: { it: renamedSlug },
      previousSlugs: [posting(2).slug],
    });
    runWriter([posting(1), renamed, posting(4), posting(5), posting(6)]);
    expect(expiredSlice().map((entry) => entry.slug)).not.toContain(posting(2).slug);
  });
});

describe('retiredSliceRows()', () => {
  it('returns rows absent from the write by identity and by route', () => {
    const prior = [posting(1), posting(2), posting(3)];
    expect(retiredSliceRows(prior, [posting(1), posting(2)]).map((job) => job.id)).toEqual([`${KEY}-3`]);
  });

  it('keeps a row whose slug survives on another written row (collapsed duplicate)', () => {
    const survivor = posting(1, { previousSlugs: [posting(3).slug] });
    expect(retiredSliceRows([posting(1), posting(3)], [survivor])).toEqual([]);
  });

  it('keeps a row handed to another crawler key by the ownership guard', () => {
    expect(retiredSliceRows([posting(1), posting(2)], [posting(1)], [posting(2)])).toEqual([]);
  });

  it('has nothing to retire without a previous slice', () => {
    expect(retiredSliceRows(null, [posting(1)])).toEqual([]);
    expect(retiredSliceRows([], [posting(1)])).toEqual([]);
  });
});
