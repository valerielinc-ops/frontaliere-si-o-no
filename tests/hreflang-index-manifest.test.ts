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
import { runHreflangIndexManifest, ownedLocalesFromEnv } from '../scripts/ci/hreflang-index-manifest.mjs';
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

  it('fails before writing a complete manifest when a dist directory cannot be read', async () => {
    const dist = path.join(tmp, 'missing-dist');
    const manifestDir = path.join(tmp, 'm');
    await expect(runHreflangIndexManifest({ distDir: dist, manifestDir, log: quiet }))
      .rejects.toThrow(/cannot read HTML directory/);
    expect(fs.existsSync(manifestDir)).toBe(false);
  });
});
