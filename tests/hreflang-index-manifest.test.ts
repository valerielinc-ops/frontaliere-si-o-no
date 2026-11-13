import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyHreflangDecision,
  classifyHreflangPage,
  decideHreflangBlock,
  parseHreflangManifest,
  serializeHreflangManifest,
} from '../scripts/lib/hreflang-index-manifest.mjs';
import {
  benchmarkHreflangStaging,
  runHreflangIndexManifest,
  ownedLocalesFromEnv,
} from '../scripts/ci/hreflang-index-manifest.mjs';
import { extractHreflangAlternates } from '../scripts/lib/hreflang-alternates.mjs';
import { findHreflangReciprocityFailures } from '../scripts/lib/hreflang-reciprocity.mjs';
import { buildCanonicalBridgePage } from '../build-plugins/constants';

/**
 * Hreflang only between URLs in the per-locale index manifest: indexable,
 * canonical on themselves, reciprocal, with x-default. The observer at the
 * bottom (`assertHreflangGraphIsClean`) is deliberately independent of the
 * module under test: it re-reads `dist/` with the validators' own parsers
 * (`extractHreflangAlternates`, `findHreflangReciprocityFailures`).
 */

const BASE = 'https://frontaliereticino.ch';
const LOCALE_PREFIX: Record<string, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

type Cluster = Record<string, string>; // locale -> path with trailing slash

function hreflangBlock(cluster: Cluster, { xDefault = true } = {}): string {
  const tags = Object.entries(cluster).map(
    ([l, p]) => `<link rel="alternate" hreflang="${l}" href="${BASE}${p}">`,
  );
  if (xDefault && cluster.it) tags.push(`<link rel="alternate" hreflang="x-default" href="${BASE}${cluster.it}">`);
  return tags.join('\n');
}

function page(
  urlPath: string,
  cluster: Cluster | null,
  { robots = 'index,follow', canonical = urlPath, xDefault = true }: { robots?: string; canonical?: string | null; xDefault?: boolean } = {},
): string {
  return [
    '<!DOCTYPE html><html><head>',
    '<meta charset="utf-8">',
    `<meta name="robots" content="${robots}">`,
    canonical === null ? '' : `<link rel="canonical" href="${BASE}${canonical}">`,
    cluster ? hreflangBlock(cluster, { xDefault }) : '',
    '<script>var s = \'<link rel="canonical" href="https://frontaliereticino.ch/elsewhere/">\';</script>',
    '</head><body><h1>x</h1></body></html>',
  ].join('\n');
}

function clusterFor(slugs: Record<string, string>): Cluster {
  const out: Cluster = {};
  for (const [l, slug] of Object.entries(slugs)) out[l] = `${LOCALE_PREFIX[l]}/${slug}/`;
  return out;
}

function write(distDir: string, urlPath: string, html: string): void {
  const file = urlPath === '/' ? path.join(distDir, 'index.html') : path.join(distDir, urlPath, 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function read(distDir: string, urlPath: string): string {
  return fs.readFileSync(path.join(distDir, urlPath, 'index.html'), 'utf-8');
}

function* walk(dir: string): Iterable<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.html')) yield p;
  }
}

const NOINDEX_RE = /<meta\b[^>]*name=["']?(?:robots|googlebot)["']?[^>]*content=["'][^"']*noindex/i;
const CANONICAL_RE = /<link\b[^>]*rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i;

function headOf(html: string): string {
  const i = html.indexOf('</head>');
  return (i === -1 ? html : html.slice(0, i)).replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

/**
 * The observer: no hreflang towards a missing URL, a noindex URL or a URL
 * whose canonical points elsewhere; no hreflang ON such a page; every
 * cluster reciprocal; x-default present and equal to the IT member.
 */
function assertHreflangGraphIsClean(distDir: string): void {
  const pages = new Map<string, { relPath: string; html: string; alternates: Map<string, string> }>();
  for (const file of walk(distDir)) {
    const rel = path.relative(distDir, file).split(path.sep).join('/');
    const url = `${BASE}/${rel.replace(/index\.html$/, '')}`;
    const html = headOf(fs.readFileSync(file, 'utf-8'));
    pages.set(url, { relPath: rel, html, alternates: extractHreflangAlternates(html) });
  }
  const eligible = (url: string) => {
    const p = pages.get(url);
    if (!p) return false;
    if (NOINDEX_RE.test(p.html)) return false;
    const canonical = CANONICAL_RE.exec(p.html)?.[1];
    return canonical === undefined || canonical === url;
  };
  const problems: string[] = [];
  for (const [url, p] of pages) {
    if (p.alternates.size === 0) continue;
    if (!eligible(url)) problems.push(`${p.relPath}: hreflang on a non-indexable page`);
    for (const [hl, href] of p.alternates) {
      if (!eligible(href)) problems.push(`${p.relPath}: ${hl} -> ${href} is missing/noindex/canonical-elsewhere`);
    }
    const it = p.alternates.get('it');
    if (it && p.alternates.get('x-default') !== it) problems.push(`${p.relPath}: x-default != it`);
  }
  const records = [...pages].filter(([, p]) => p.alternates.size > 0).map(([url, p]) => ({ url, relPath: p.relPath, alternates: p.alternates }));
  for (const f of findHreflangReciprocityFailures(records, { baseUrl: BASE })) {
    problems.push(`${f.sourcePath}: ${f.hreflang} -> ${f.target} has no return link`);
  }
  expect(problems).toEqual([]);
}

describe('classifyHreflangPage', () => {
  it('reads noindex from robots and googlebot, canonical elsewhere, and ignores markup inside scripts', () => {
    const c = clusterFor({ it: 'a', en: 'a-en' });
    expect(classifyHreflangPage(page('/a/', c), '/a').reason).toBe('eligible');
    expect(classifyHreflangPage(page('/a/', c, { robots: 'noindex,follow' }), '/a').reason).toBe('page-noindex');
    expect(classifyHreflangPage(page('/a/', c, { canonical: '/b/' }), '/a').reason).toBe('page-canonical-elsewhere');
    expect(classifyHreflangPage(page('/a/', c, { canonical: null }), '/a').reason).toBe('eligible');
    const googlebot = page('/a/', c).replace('<meta charset="utf-8">', '<meta name="googlebot" content="noindex">');
    expect(classifyHreflangPage(googlebot, '/a').reason).toBe('page-noindex');
  });

  it('parses minified, unquoted attributes', () => {
    const html = '<html><head><meta name=robots content=noindex><link rel=canonical href=https://frontaliereticino.ch/a/>'
      + '<link rel=alternate hreflang=it href=https://frontaliereticino.ch/a/></head>';
    const p = classifyHreflangPage(html, '/a');
    expect(p.reason).toBe('page-noindex');
    expect(p.members).toEqual([{ hreflang: 'it', href: `${BASE}/a/`, path: '/a' }]);
  });

  it('gives reciprocal members the same cluster key whatever the tag order', () => {
    const c = clusterFor({ it: 'a', en: 'a-en', de: 'a-de', fr: 'a-fr' });
    const reversed = Object.fromEntries(Object.entries(c).reverse());
    expect(classifyHreflangPage(page('/a/', c), '/a').clusterKey)
      .toBe(classifyHreflangPage(page('/en/a-en/', reversed), '/en/a-en').clusterKey);
  });
});

describe('decideHreflangBlock', () => {
  const c = clusterFor({ it: 'a', en: 'a-en', de: 'a-de', fr: 'a-fr' });
  const self = classifyHreflangPage(page('/a/', c), '/a');
  const eligibleAll = () => ({ status: 'eligible' as const, key: self.clusterKey });

  it('keeps a reciprocal cluster of indexable members', () => {
    expect(decideHreflangBlock(self, eligibleAll).action).toBe('keep');
  });

  it('strips the whole block when one member is absent or not indexable', () => {
    const d = decideHreflangBlock(self, (_l, p) => (p === '/fr/a-fr' ? { status: 'absent' as const } : eligibleAll()));
    expect(d).toMatchObject({ action: 'strip', reason: 'member-not-indexable' });
  });

  it('strips the whole block when a member declares a different cluster', () => {
    const d = decideHreflangBlock(self, (_l, p) => (p === '/de/a-de' ? { status: 'eligible' as const, key: 'other' } : eligibleAll()));
    expect(d).toMatchObject({ action: 'strip', reason: 'member-not-reciprocal' });
  });

  it('strips a reciprocal block that does not contain exactly the four supported locales', () => {
    const partial = classifyHreflangPage(page('/a/', clusterFor({ it: 'a', en: 'a-en', de: 'a-de' })), '/a');
    expect(decideHreflangBlock(partial, eligibleAll)).toMatchObject({ action: 'strip', reason: 'incomplete-locale-set' });
  });

  it('strips a block whose four links contain an unknown locale instead of fr', () => {
    const foreign = classifyHreflangPage(page('/a/', clusterFor({ it: 'a', en: 'a-en', de: 'a-de', es: 'a-es' })), '/a');
    expect(decideHreflangBlock(foreign, eligibleAll)).toMatchObject({ action: 'strip', reason: 'incomplete-locale-set' });
  });

  it('does not judge members without a manifest or served outside this build', () => {
    const d = decideHreflangBlock(self, (l) => (l === 'it' ? eligibleAll() : { status: 'unknown' as const, reason: `no-manifest-${l}` }));
    expect(d.action).toBe('keep');
    expect(d.unknown.sort()).toEqual(['no-manifest-de', 'no-manifest-en', 'no-manifest-fr']);
    const article = clusterFor({ it: 'a', en: 'a-en', de: 'a-de', fr: 'a-fr' });
    article.it = '/articoli-frontaliere/a/';
    const bridge = classifyHreflangPage(page('/en/a-en/', article), '/en/a-en');
    expect(decideHreflangBlock(bridge, () => ({ status: 'absent' as const })).unknown).toEqual(['externally-served']);
  });

  it('strips a page that is not a member of its own block', () => {
    const other = classifyHreflangPage(page('/zzz/', c), '/zzz');
    expect(decideHreflangBlock(other, eligibleAll)).toMatchObject({ action: 'strip', reason: 'page-not-member' });
  });

  it('adds or realigns x-default on the IT member', () => {
    const noX = classifyHreflangPage(page('/a/', c, { xDefault: false }), '/a');
    const d = decideHreflangBlock(noX, () => ({ status: 'eligible', key: noX.clusterKey }));
    expect(d.xDefault).toEqual({ op: 'insert', href: `${BASE}/a/` });
    const html = applyHreflangDecision(page('/a/', c, { xDefault: false }), d)!;
    expect(extractHreflangAlternates(html).get('x-default')).toBe(`${BASE}/a/`);
  });
});

describe('manifest serialisation', () => {
  it('round-trips and rejects incomplete or foreign manifests', () => {
    const text = serializeHreflangManifest({ locale: 'en', entries: new Map([['/en/a', 'k1']]), runId: '42' });
    const parsed = parseHreflangManifest(text, 'en');
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) expect(parsed.entries.get('/en/a')).toBe('k1');
    expect(parseHreflangManifest(text, 'de')).toHaveProperty('error');
    const broken = JSON.parse(text);
    broken.complete = false;
    expect(parseHreflangManifest(JSON.stringify(broken), 'en')).toHaveProperty('error');
    broken.complete = true;
    broken.entryCount = 7;
    expect(parseHreflangManifest(JSON.stringify(broken), 'en')).toHaveProperty('error');
  });

  it('reads the leg locales from BUILD_LOCALE', () => {
    expect(ownedLocalesFromEnv('it')).toEqual(['it']);
    expect(ownedLocalesFromEnv('')).toEqual(['it', 'en', 'de', 'fr']);
    expect(ownedLocalesFromEnv('xx')).toEqual(['it', 'en', 'de', 'fr']);
  });
});

describe('runHreflangIndexManifest on a dist', () => {
  let tmp: string;
  const quiet = () => {};
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-manifest-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const good = clusterFor({ it: 'good', en: 'good-en', de: 'good-de', fr: 'good-fr' });
  const noindexFr = clusterFor({ it: 'ni', en: 'ni-en', de: 'ni-de', fr: 'ni-fr' });
  const canonFr = clusterFor({ it: 'cf', en: 'cf-en', de: 'cf-de', fr: 'cf-fr' });
  const missingDe = clusterFor({ it: 'md', en: 'md-en', de: 'md-de', fr: 'md-fr' });
  const oneWay = clusterFor({ it: 'ow', en: 'ow-en', de: 'ow-de', fr: 'ow-fr' });

  function emitCorpus(distDir: string): void {
    for (const p of Object.values(good)) write(distDir, p, page(p, good));
    for (const [l, p] of Object.entries(noindexFr)) write(distDir, p, page(p, noindexFr, { robots: l === 'fr' ? 'noindex,follow' : 'index,follow' }));
    for (const [l, p] of Object.entries(canonFr)) write(distDir, p, page(p, canonFr, { canonical: l === 'fr' ? '/fr/elsewhere/' : p }));
    for (const [l, p] of Object.entries(missingDe)) if (l !== 'de') write(distDir, p, page(p, missingDe));
    // ow-en declares a cluster without the IT page: not reciprocal.
    for (const [l, p] of Object.entries(oneWay)) {
      write(distDir, p, page(p, l === 'en' ? { en: oneWay.en, de: oneWay.de, fr: oneWay.fr } : oneWay));
    }
    // A canonical bridge (constants.ts): noindex, canonical on the target, the
    // target's cluster copied in.
    write(distDir, '/old-good/', buildCanonicalBridgePage({
      canonicalUrl: `${BASE}${good.it}`,
      pathLabel: good.it,
      noindex: true,
      hreflangEntries: [
        ...Object.entries(good).map(([hreflang, p]) => ({ hreflang, href: `${BASE}${p}` })),
        { hreflang: 'x-default', href: `${BASE}${good.it}` },
      ],
    }));
  }

  it('the observer is not vacuous: the corpus as emitted violates it', () => {
    const dist = path.join(tmp, 'dist');
    emitCorpus(dist);
    expect(() => assertHreflangGraphIsClean(dist)).toThrow();
  });

  it('full build: keeps only indexable, self-canonical, reciprocal clusters', async () => {
    const dist = path.join(tmp, 'dist');
    emitCorpus(dist);
    const summary = await runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), log: quiet });

    expect(extractHreflangAlternates(read(dist, '/good/')).size).toBe(5);
    expect(extractHreflangAlternates(read(dist, '/fr/good-fr/')).size).toBe(5);
    for (const p of [...Object.values(noindexFr), ...Object.values(canonFr), missingDe.it, missingDe.en, ...Object.values(oneWay), '/old-good/']) {
      expect(extractHreflangAlternates(read(dist, p)).size, p).toBe(0);
    }
    expect(summary.blocksByDecision).toMatchObject({
      'keep:kept': 4,
      'strip:page-noindex': 2,
      'strip:page-canonical-elsewhere': 1,
    });
    assertHreflangGraphIsClean(dist);
  });

  it('locale shards: cross-locale members are judged against the other legs\' manifests', async () => {
    const shared = path.join(tmp, 'cache');
    // One deploy run: each leg's dist holds only its own locale, as after
    // prune-locale-shard, and the legs finish one after the other.
    async function runLegs(round: number) {
      const dists: Record<string, string> = {};
      const summaries: Record<string, Awaited<ReturnType<typeof runHreflangIndexManifest>>> = {};
      for (const leg of ['en', 'de', 'fr', 'it']) {
        const full = path.join(tmp, `full-${round}-${leg}`);
        emitCorpus(full);
        dists[leg] = path.join(tmp, `dist-${round}-${leg}`);
        fs.mkdirSync(dists[leg], { recursive: true });
        for (const name of fs.readdirSync(full)) {
          const owned = leg === 'it' ? !['en', 'de', 'fr'].includes(name) : name === leg;
          if (owned) fs.renameSync(path.join(full, name), path.join(dists[leg], name));
        }
        summaries[leg] = await runHreflangIndexManifest({ distDir: dists[leg], manifestDir: shared, ownedLocales: [leg], log: quiet });
      }
      return { dists, summaries };
    }

    const first = await runLegs(1);
    // Very first run: the en leg has nobody's manifest and judges only en.
    expect(first.summaries.en.manifestSources).toMatchObject({ de: 'missing', fr: 'missing', it: 'missing' });
    // The IT leg, last, has all three.
    expect(Object.values(first.summaries.it.manifestSources).every((s) => s === 'this-run' || s.startsWith('run '))).toBe(true);
    expect(extractHreflangAlternates(read(first.dists.it, '/good/')).size).toBe(5);
    for (const p of ['/ni/', '/cf/', '/md/', '/ow/']) {
      expect(extractHreflangAlternates(read(first.dists.it, p)).size, p).toBe(0);
    }

    // From the next run on every leg sees every other manifest: the
    // reassembled site is clean, reciprocal, with x-default.
    const second = await runLegs(2);
    const site = path.join(tmp, 'site');
    fs.mkdirSync(site, { recursive: true });
    for (const [leg, dist] of Object.entries(second.dists)) {
      for (const name of fs.readdirSync(dist)) fs.renameSync(path.join(dist, name), path.join(site, name));
      expect(Object.values(second.summaries[leg].unknownMembers)).toEqual([]);
    }
    expect(extractHreflangAlternates(read(site, '/en/good-en/')).size).toBe(5);
    assertHreflangGraphIsClean(site);
  });

  it('dry run writes the manifest but leaves dist untouched', async () => {
    const dist = path.join(tmp, 'dist');
    emitCorpus(dist);
    const before = read(dist, '/ni/');
    const summary = await runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), dryRun: true, log: quiet });
    expect(read(dist, '/ni/')).toBe(before);
    expect(summary.filesToRewrite).toBeGreaterThan(0);
    expect(summary.filesRewritten).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'm', 'it.json'))).toBe(true);
  });

  it('fails closed after the barrier when a foreign manifest is missing', async () => {
    const dist = path.join(tmp, 'dist');
    emitCorpus(dist);
    const before = read(dist, '/good/');
    await expect(runHreflangIndexManifest({
      distDir: dist,
      manifestDir: path.join(tmp, 'missing-manifests'),
      ownedLocales: ['it'],
      requireForeignManifests: true,
      log: quiet,
    })).rejects.toThrow(/required foreign hreflang manifests/);
    expect(read(dist, '/good/')).toBe(before);
    expect(fs.existsSync(path.join(tmp, 'missing-manifests', 'it.json'))).toBe(false);
  });

  it('rolls back every HTML file when a transaction rename fails', async () => {
    const dist = path.join(tmp, 'dist');
    const cluster = clusterFor({ it: 'rollback', en: 'rollback-en' });
    write(dist, '/rollback/', page('/rollback/', cluster, { robots: 'noindex,follow' }));
    write(dist, '/en/rollback-en/', page('/en/rollback-en/', cluster, { robots: 'noindex,follow' }));
    const before = new Map([
      ['/rollback/', read(dist, '/rollback/')],
      ['/en/rollback-en/', read(dist, '/en/rollback-en/')],
    ]);

    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      renameCalls += 1;
      if (renameCalls === 4) throw new Error('forced hreflang rename failure');
      return originalRename(...args);
    });
    try {
      await expect(runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), log: quiet }))
        .rejects.toThrow('forced hreflang rename failure');
    } finally {
      rename.mockRestore();
    }

    expect(read(dist, '/rollback/')).toBe(before.get('/rollback/'));
    expect(read(dist, '/en/rollback-en/')).toBe(before.get('/en/rollback-en/'));
    expect(fs.readdirSync(path.join(dist, 'rollback')).some((name) => name.endsWith('.bak'))).toBe(false);
    expect(fs.readdirSync(path.join(dist, 'en', 'rollback-en')).some((name) => name.endsWith('.bak'))).toBe(false);
  });

  it('bounds staged HTML and fails before writing the manifest when a later batch fails', async () => {
    const dist = path.join(tmp, 'dist');
    const manifestDir = path.join(tmp, 'm');
    const paths = Array.from({ length: 65 }, (_, index) => `/batch-${String(index).padStart(3, '0')}/`);
    for (const [index, urlPath] of paths.entries()) {
      const slug = `batch-${String(index).padStart(3, '0')}`;
      const cluster = clusterFor({ it: slug, en: `${slug}-en` });
      write(dist, urlPath, page(urlPath, cluster, { robots: 'noindex,follow' }));
    }

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    let stagedWrites = 0;
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes('.hreflang-index-')) {
        stagedWrites += 1;
        if (stagedWrites === 65) throw new Error('forced hreflang staging failure');
      }
      return originalWriteFile(...args);
    });
    try {
      await expect(runHreflangIndexManifest({ distDir: dist, manifestDir, log: quiet }))
        .rejects.toThrow('forced hreflang staging failure');
    } finally {
      writeFile.mockRestore();
    }

    const rewritten = paths.filter((urlPath) => extractHreflangAlternates(read(dist, urlPath)).size === 0);
    expect(rewritten).toHaveLength(64);
    expect(fs.existsSync(path.join(manifestDir, 'it.json'))).toBe(false);
    expect(fs.readdirSync(dist).some((name) => name.startsWith('.hreflang-index-'))).toBe(false);

    const retry = await runHreflangIndexManifest({ distDir: dist, manifestDir, log: quiet });
    expect(retry.filesRewritten).toBe(1);
    expect(fs.existsSync(path.join(manifestDir, 'it.json'))).toBe(true);
    expect(fs.readdirSync(dist).some((name) => name.startsWith('.hreflang-index-'))).toBe(false);
    assertHreflangGraphIsClean(dist);
  });

  it('reports a lower bounded staging-byte peak than the same input staged all at once', async () => {
    const dist = path.join(tmp, 'dist');
    const paths = Array.from({ length: 65 }, (_, index) => `/measure-${String(index).padStart(3, '0')}/`);
    for (const [index, urlPath] of paths.entries()) {
      const slug = `measure-${String(index).padStart(3, '0')}`;
      const cluster = clusterFor({ it: slug, en: `${slug}-en` });
      write(dist, urlPath, page(urlPath, cluster, { robots: 'noindex,follow' }));
    }

    const summary = await runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), log: quiet });

    expect(summary.filesRewritten).toBe(65);
    expect(summary.stagingBytes.allAtOnceEquivalent).toBeGreaterThan(summary.stagingBytes.boundedBatchPeak);
    expect(summary.stagingBytes.boundedBatchPeak).toBeGreaterThan(0);
    expect(summary.stagingBenchmark).toMatchObject({
      phase: 'build-locale:hreflang-index-manifest',
      inputFiles: 65,
      batchSize: 64,
    });
    expect(summary.stagingBenchmark.peakStagingBytes).toBeLessThan(summary.stagingBenchmark.preBatchPeakBytes);
  });

  it('keeps fractional positive batch sizes from rounding down to a zero-sized batch', () => {
    const summary = benchmarkHreflangStaging([
      { originalBytes: 10, stagedBytes: 2 },
      { originalBytes: 20, stagedBytes: 3 },
    ], 0.5);

    expect(summary).toMatchObject({
      batchSize: 1,
      preBatchPeakBytes: 35,
      peakStagingBytes: 23,
      reductionBytes: 12,
    });
  });

  it('fails before writing a complete manifest when a dist directory cannot be read', async () => {
    const dist = path.join(tmp, 'missing-dist');
    const manifestDir = path.join(tmp, 'm');
    await expect(runHreflangIndexManifest({ distDir: dist, manifestDir, log: quiet }))
      .rejects.toThrow(/cannot read HTML directory/);
    expect(fs.existsSync(manifestDir)).toBe(false);
  });
});

/**
 * Equivalence with the two-pass algorithm that main ran before the deferred
 * publish step was made single-read (pass 1 now decides every block that does
 * not need this run's own manifest; the walk is concurrent).
 *
 * `referenceTwoPass` is that algorithm written out plainly on top of the same
 * pure module: a serial walk, a `foo/index.html`-wins Map over every page, a
 * classification pass, then a SECOND read of every page carrying hreflang that
 * is decided against the complete manifests, then the rewrite. The CLI must
 * leave byte-identical HTML and byte-identical manifests (bar `generatedAt`).
 */
describe('runHreflangIndexManifest is byte-identical to the two-pass reference', () => {
  let tmp: string;
  const quiet = () => {};
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-equivalence-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const LOCALES = ['it', 'en', 'de', 'fr'] as const;
  const SKIP = new Set(['assets', 'data', 'images']);

  function referenceWalk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) referenceWalk(p, out);
      } else if (entry.isFile() && entry.name.endsWith('.html')) out.push(p);
    }
    return out;
  }

  function urlPathOf(file: string, distDir: string): string {
    let p = path.relative(distDir, file).split(path.sep).join('/');
    if (p === 'index.html') p = '';
    else if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length);
    else p = p.slice(0, -'.html'.length);
    return p === '' ? '/' : `/${p}`;
  }

  const localeOf = (p: string) => /^\/(en|de|fr)(?:\/|$)/.exec(p)?.[1] ?? 'it';

  function referenceTwoPass(distDir: string, manifestDir: string, owned: string[]): void {
    const ownedSet = new Set(owned);
    const files = referenceWalk(distDir)
      .map((file) => ({ file, urlPath: urlPathOf(file, distDir) }))
      .filter((item) => ownedSet.has(localeOf(item.urlPath)));
    const isIndex = (file: string) => path.basename(file) === 'index.html';
    const primary = new Map<string, { file: string }>();
    for (const item of files) {
      const seen = primary.get(item.urlPath);
      if (seen === undefined || (!isIndex(seen.file) && isIndex(item.file))) primary.set(item.urlPath, item);
    }
    const current = new Map(LOCALES.map((l) => [l as string, new Map<string, string>()]));
    const withHreflang: typeof files = [];
    for (const item of files) {
      const page = classifyHreflangPage(fs.readFileSync(item.file, 'utf-8'), item.urlPath, { baseUrl: BASE });
      if (page.eligible && primary.get(item.urlPath) === item) current.get(localeOf(page.path))!.set(item.urlPath, page.clusterKey);
      if (page.hasHreflang) withHreflang.push(item);
    }
    const foreign = new Map<string, Map<string, string>>();
    for (const l of LOCALES) {
      if (ownedSet.has(l)) continue;
      const file = path.join(manifestDir, `${l}.json`);
      if (!fs.existsSync(file)) continue;
      const parsed = parseHreflangManifest(fs.readFileSync(file, 'utf-8'), l);
      if (!('error' in parsed)) foreign.set(l, parsed.entries);
    }
    const lookup = (l: string, p: string) => {
      const entries = ownedSet.has(l) ? current.get(l) : foreign.get(l);
      if (!entries) return { status: 'unknown' as const, reason: `no-manifest-${l}` };
      const key = entries.get(p);
      return key === undefined ? { status: 'absent' as const } : { status: 'eligible' as const, key };
    };
    const changes: Array<{ file: string; decision: ReturnType<typeof decideHreflangBlock> }> = [];
    for (const item of withHreflang) {
      const page = classifyHreflangPage(fs.readFileSync(item.file, 'utf-8'), item.urlPath, { baseUrl: BASE });
      const decision = decideHreflangBlock(page, lookup);
      if (decision.action === 'strip' || decision.xDefault !== null) changes.push({ file: item.file, decision });
    }
    for (const { file, decision } of changes) {
      const next = applyHreflangDecision(fs.readFileSync(file, 'utf-8'), decision);
      if (next !== null) fs.writeFileSync(file, next);
    }
    fs.mkdirSync(manifestDir, { recursive: true });
    for (const l of owned) {
      fs.writeFileSync(path.join(manifestDir, `${l}.json`), serializeHreflangManifest({ locale: l, entries: current.get(l)!, runId: 'eq' }));
    }
  }

  /** Multi-locale corpus: missing alternates, x-default variants, partial locale sets, flat/index twins. */
  function emitEquivalenceCorpus(distDir: string): void {
    const full = (slug: string) => clusterFor({ it: slug, en: `${slug}-en`, de: `${slug}-de`, fr: `${slug}-fr` });
    const emit = (cluster: Cluster, opts: (l: string) => Parameters<typeof page>[2] = () => ({}), skip: string[] = []) => {
      for (const [l, p] of Object.entries(cluster)) if (!skip.includes(l)) write(distDir, p, page(p, cluster, opts(l)));
    };
    emit(full('ok'));
    emit(full('nox'), () => ({ xDefault: false })); // x-default missing -> insert
    const wrongX = full('wx');
    for (const [, p] of Object.entries(wrongX)) {
      write(distDir, p, page(p, wrongX, { xDefault: false }).replace('</head>',
        `<link rel="alternate" hreflang="x-default" href="${BASE}${wrongX.en}">\n</head>`)); // x-default != it -> rewrite
    }
    emit(full('miss'), () => ({}), ['de']); // alternate towards a missing page
    emit(clusterFor({ it: 'two', en: 'two-en' })); // page only in some languages
    emit(full('ni'), (l) => ({ robots: l === 'en' ? 'noindex,follow' : 'index,follow' }));
    emit(full('cf'), (l) => ({ canonical: l === 'fr' ? '/fr/elsewhere/' : undefined }));
    const art = full('art');
    art.it = '/articoli-frontaliere/art/';
    emit(art, () => ({}), ['it']); // IT member served outside this build
    for (let i = 0; i < 40; i++) emit(full(`bulk-${i}`), (l) => ({ robots: i % 3 === 0 && l === 'de' ? 'noindex' : 'index,follow' }));
    // A DE page listing another DE path under the `en` code: deciding it
    // needs the DE manifest of this very run, so a DE-only leg defers it.
    const cross = { it: '/cross/', en: '/de/cross-other/', de: '/de/cross/', fr: '/fr/cross-fr/' };
    for (const p of Object.values(cross)) write(distDir, p, page(p, cross));
    // Flat/index twins: the directory index is the primary document of /twin.
    const twin = full('twin');
    emit(twin);
    fs.writeFileSync(path.join(distDir, 'twin.html'), page(twin.it, twin, { canonical: '/twin-flat/' }));
    fs.writeFileSync(path.join(distDir, 'de', 'flat-only.html'), page('/de/flat-only/', null));
    fs.mkdirSync(path.join(distDir, 'de', 'flat-dir'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'de', 'flat-dir.html'), page('/de/flat-dir', null, { canonical: '/de/flat-dir' }));
    fs.writeFileSync(path.join(distDir, 'de', 'flat-dir', 'other.html'), page('/de/flat-dir/other', null, { canonical: '/de/flat-dir/other' }));
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'assets', 'ignored.html'), page('/assets/ignored/', full('ok')));
  }

  function snapshot(distDir: string): Map<string, string> {
    const out = new Map<string, string>();
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(p);
        else out.set(path.relative(distDir, p), fs.readFileSync(p, 'utf-8'));
      }
    };
    visit(distDir);
    return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
  }

  const manifestBody = (file: string) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete data.generatedAt;
    return JSON.stringify(data);
  };

  function splitByLocale(source: string, target: string, locale: string): void {
    fs.cpSync(source, target, { recursive: true });
    for (const name of fs.readdirSync(target)) {
      const isLocaleDir = ['en', 'de', 'fr'].includes(name);
      const keep = locale === 'it' ? !isLocaleDir : name === locale;
      if (!keep && name !== 'assets') fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }

  it('the corpus exercises every decision path the publish leg takes', async () => {
    const dist = path.join(tmp, 'dist');
    emitEquivalenceCorpus(dist);
    const summary = await runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), runId: 'eq', log: quiet });
    expect(Object.keys(summary.blocksByDecision)).toEqual(expect.arrayContaining([
      'keep:kept', 'keep:x-default-insert', 'keep:x-default-rewrite', 'strip:member-not-indexable',
      'strip:incomplete-locale-set', 'strip:page-noindex', 'strip:page-canonical-elsewhere',
    ]));
    expect(summary.unknownMembers).toMatchObject({ 'externally-served': expect.any(Number) });
  });

  it('full four-locale run (blocks needing an owned member deferred to pass 2) matches the reference', async () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    emitEquivalenceCorpus(a);
    fs.cpSync(a, b, { recursive: true });
    referenceTwoPass(a, path.join(tmp, 'ma'), [...LOCALES]);
    const summary = await runHreflangIndexManifest({ distDir: b, manifestDir: path.join(tmp, 'mb'), runId: 'eq', log: quiet });
    // Owning every locale, only blocks that fail before any member lookup
    // (noindex page, partial locale set, ...) are decided in pass 1.
    expect(summary.pagesDeferred).toBeGreaterThan(0);
    expect(summary.pagesDeferred).toBeLessThan(summary.pagesWithHreflang);
    expect(snapshot(b)).toEqual(snapshot(a));
    for (const l of LOCALES) expect(manifestBody(path.join(tmp, 'mb', `${l}.json`)), l).toBe(manifestBody(path.join(tmp, 'ma', `${l}.json`)));
  });

  it.each(['de', 'fr', 'en', 'it'])('deferred publish leg %s (single read, foreign manifests) matches the reference', async (leg) => {
    const source = path.join(tmp, 'source');
    emitEquivalenceCorpus(source);
    // The other legs' manifests, as the barrier downloads them.
    const foreignDir = path.join(tmp, 'foreign');
    await runHreflangIndexManifest({ distDir: source, manifestDir: foreignDir, runId: 'eq', dryRun: true, manifestOnly: true, log: quiet });
    fs.rmSync(path.join(foreignDir, `${leg}.json`));

    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    splitByLocale(source, a, leg);
    fs.cpSync(a, b, { recursive: true });
    fs.cpSync(foreignDir, path.join(tmp, 'ma'), { recursive: true });
    fs.cpSync(foreignDir, path.join(tmp, 'mb'), { recursive: true });

    referenceTwoPass(a, path.join(tmp, 'ma'), [leg]);
    const summary = await runHreflangIndexManifest({
      distDir: b, manifestDir: path.join(tmp, 'mb'), ownedLocales: [leg], runId: 'eq', requireForeignManifests: true, log: quiet,
    });
    expect(summary.filesRewritten).toBeGreaterThan(0);
    // Only blocks that ask this leg's own manifest are read a second time:
    // the two DE pages of the `cross` cluster list each other.
    expect(summary.pagesDeferred).toBe(leg === 'de' ? 2 : 0);
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(manifestBody(path.join(tmp, 'mb', `${leg}.json`))).toBe(manifestBody(path.join(tmp, 'ma', `${leg}.json`)));
  });

  it('records the directory index, not its flat twin, and keeps a flat page without a twin', async () => {
    const dist = path.join(tmp, 'dist');
    emitEquivalenceCorpus(dist);
    await runHreflangIndexManifest({ distDir: dist, manifestDir: path.join(tmp, 'm'), runId: 'eq', dryRun: true, manifestOnly: true, log: quiet });
    const it = JSON.parse(fs.readFileSync(path.join(tmp, 'm', 'it.json'), 'utf-8')).entries;
    const de = JSON.parse(fs.readFileSync(path.join(tmp, 'm', 'de.json'), 'utf-8')).entries;
    // twin.html declares a canonical elsewhere; twin/index.html is eligible.
    expect(it['/twin']).toBeTruthy();
    expect(de['/de/flat-dir']).toBe('');
    expect(Object.keys(it).some((p) => p.startsWith('/assets'))).toBe(false);
  });
});

/**
 * Memory observer: the 2026-11 attempt to skip the second read kept every
 * classification and member set in heap and died at ~4 GB on 2.5M pages
 * (deploy 43131340812). The pass must stay a thin
 * per-page footprint: this runs it in a child Node with a deliberately small
 * old space on a medium four-locale dist and bounds the live heap per page.
 */
describe('runHreflangIndexManifest heap guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-heap-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  it('decides a 4 x 1500-page dist under --max-old-space-size=48 with a bounded per-page live heap', async () => {
    const { spawnSync } = await import('node:child_process');
    const dist = path.join(tmp, 'dist');
    const filler = `<style>${'.c{margin:0 auto;padding:4px}'.repeat(60)}</style>`;
    const PER_LOCALE = 1500;
    for (let i = 0; i < PER_LOCALE; i++) {
      const cluster = clusterFor({ it: `p/${i}`, en: `p-en/${i}`, de: `p-de/${i}`, fr: `p-fr/${i}` });
      const kind = i % 4; // eligible cluster, noindex cluster, noindex without hreflang, partial cluster
      for (const [l, p] of Object.entries(cluster)) {
        const c = kind === 2 ? null : kind === 3 ? { it: cluster.it, en: cluster.en } : cluster;
        write(dist, p, page(p, c, { robots: kind === 0 || kind === 3 ? 'index,follow' : 'noindex,follow' }).replace('</head>', `${filler}</head>`));
      }
    }
    const script = path.resolve('scripts/ci/hreflang-index-manifest.mjs');
    const harness = `
      import { pathToFileURL } from 'node:url';
      const { runHreflangIndexManifest } = await import(pathToFileURL(${JSON.stringify(script)}).href);
      globalThis.gc(); const base = process.memoryUsage().heapUsed; let peak = 0;
      const t = setInterval(() => { globalThis.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - base); }, 50);
      const s = await runHreflangIndexManifest({ distDir: ${JSON.stringify(dist)}, manifestDir: ${JSON.stringify(path.join(tmp, 'm'))}, runId: 'heap', log: () => {} });
      clearInterval(t); globalThis.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      console.log(JSON.stringify({ pagesScanned: s.pagesScanned, filesRewritten: s.filesRewritten, peakLiveHeapBytes: peak }));
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--expose-gc', '--input-type=module', '-e', harness], {
      encoding: 'utf-8',
      timeout: 150_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim().split('\n').pop()!);
    expect(result.pagesScanned).toBe(4 * PER_LOCALE);
    expect(result.filesRewritten).toBeGreaterThan(0);
    console.log(`[hreflang-heap-guard] ${JSON.stringify({ ...result, bytesPerPage: Math.round(result.peakLiveHeapBytes / result.pagesScanned) })}`);
    // Calibrated on this exact dist (live heap after forced GC, per scanned
    // page): two-pass main ~430 B, this single-read pass ~355 B, the reverted
    // in-heap prepass cache of #18210 ~1170 B. 700 B separates them.
    expect(result.peakLiveHeapBytes / result.pagesScanned).toBeLessThan(700);
  }, 180_000);
});
