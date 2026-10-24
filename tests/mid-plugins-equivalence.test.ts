import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Le riduzioni di lavoro dei plugin medi (MID_PLUGINS_FAST) devono dare, per
 * ogni input, lo stesso verdetto del percorso storico. I moduli leggono il
 * flag al caricamento, quindi ogni lato si carica con un proprio ambiente.
 */

async function loadWithFlag<T>(flag: '1' | '0', loader: () => Promise<T>): Promise<T> {
  vi.resetModules();
  process.env.MID_PLUGINS_FAST = flag;
  try {
    return await loader();
  } finally {
    delete process.env.MID_PLUGINS_FAST;
  }
}

afterEach(() => {
  delete process.env.MID_PLUGINS_FAST;
  vi.resetModules();
});

// Generatore pseudo-casuale deterministico (nessuna dipendenza, nessun flake).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const HTML_FRAGMENTS = [
  '<!DOCTYPE html>', '<html lang="it">', '<head>', '</head>', '<body>', '</body>',
  '<meta name="robots" content="noindex,follow">', '<META NAME=robots CONTENT="index, follow">',
  '<meta http-equiv="refresh" content="0; url=/x/">', '<link rel="canonical" href="https://x.test/a/">',
  '<link rel="alternate" hreflang="it" href="https://x.test/it/">',
  '<!-- <meta name="robots" content="noindex"> -->', '<!-- unterminated',
  '<script>var a = "<meta name=robots content=noindex>";</script>', '<SCRIPT type="x">if (a<b) {}</SCRIPT >',
  '<script', '<script src="x.js"></script', '<style>.a{content:"<link rel=canonical href=/z/>"}</style>',
  '<style>', '</style>', '<a title="a > b" href="/x/">t</a>', "<a title='it's' href=/y/>", '<', '<>', '< script>',
  'testo', ' ', '\n', 'è', '😀', '<p class="x"', '">', "'", '<scripty>', '<styled>', '<!---->', '<!-->',
];

function randomHtml(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 14);
  let out = '';
  for (let i = 0; i < n; i++) out += HTML_FRAGMENTS[Math.floor(rand() * HTML_FRAGMENTS.length)];
  return out;
}

describe('html-attr scrub: fast == legacy', () => {
  it('scanMarkupStartTags and scanMarkupStartTagGroups agree on fuzzed documents', async () => {
    const fast = await loadWithFlag('1', () => import('../scripts/lib/html-attr.mjs'));
    const legacy = await loadWithFlag('0', () => import('../scripts/lib/html-attr.mjs'));
    const rand = rng(20261024);
    for (let i = 0; i < 4000; i++) {
      const html = randomHtml(rand);
      for (const tag of ['meta', 'link', 'a', '']) {
        expect(fast.scanMarkupStartTags(html, tag), JSON.stringify(html)).toEqual(legacy.scanMarkupStartTags(html, tag));
      }
      const groups = fast.scanMarkupStartTagGroups(html, ['meta', 'link']);
      expect(groups.meta).toEqual(legacy.scanMarkupStartTags(html, 'meta'));
      expect(groups.link).toEqual(legacy.scanMarkupStartTags(html, 'link'));
    }
  });
});

describe('compat-path-safety: fast == legacy', () => {
  const ALPHABET = ['a', 'b', 'Z', '0', '9', '-', '_', '.', '~', '/', '/', '%', '2', '7', 'f', 'c', '3', '<', '>',
    '(', ')', "'", '"', ' ', '+', '*', ':', 'select', 'union', 'xmltype', 'sleep', 'é', '😀', '\u0000', '..', '%2e', '%zz'];

  it('agrees on fuzzed paths for every predicate', async () => {
    const fast = await loadWithFlag('1', () => import('../scripts/lib/compat-path-safety.mjs'));
    const legacy = await loadWithFlag('0', () => import('../scripts/lib/compat-path-safety.mjs'));
    const rand = rng(424242);
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(rand() * 40);
      let p = rand() < 0.8 ? '/' : '';
      for (let k = 0; k < len; k++) p += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      if (rand() < 0.05) p += 'x'.repeat(Math.floor(rand() * 400));
      expect(fast.isSafeCompatPath(p), p).toBe(legacy.isSafeCompatPath(p));
      expect(fast.hasCompatAttackPayload(p), p).toBe(legacy.hasCompatAttackPayload(p));
      expect(fast.isDistPathOverFilesystemLimits(p), p).toBe(legacy.isDistPathOverFilesystemLimits(p));
    }
    for (const p of ['/', '', '/a/select/b', '/union-select/x', '/a/b/' + 'é'.repeat(100), '/a/' + 'x'.repeat(255), '/a/' + 'x'.repeat(256)]) {
      expect(fast.isSafeCompatPath(p), p).toBe(legacy.isSafeCompatPath(p));
      expect(fast.isDistPathOverFilesystemLimits(p), p).toBe(legacy.isDistPathOverFilesystemLimits(p));
    }
  });
});

describe('seo-hubs hasEmittedJobDetailPage: fast == legacy, memo only inside its window', () => {
  it('same verdict for plain and non-plain hrefs; memo does not leak outside the window', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobdetail-'));
    const dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(dist, 'cerca-lavoro-ticino', 'job-a'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'cerca-lavoro-ticino', 'job-a', 'index.html'), 'x');
    const hrefs = [
      '/cerca-lavoro-ticino/job-a/', '/cerca-lavoro-ticino/job-a', '/cerca-lavoro-ticino/job-b/',
      '/cerca-lavoro-ticino/../cerca-lavoro-ticino/job-a/', '/cerca-lavoro-ticino/./job-a/',
      '/cerca-lavoro-ticino/job%2Da/', '/cerca-lavoro-ticino/job-a/?x=1', 'https://evil.test/a/', '/', '',
      '//cerca-lavoro-ticino/job-a/', '/en/find-jobs-ticino/job-a/', '/de/jobs-im-tessin/x/',
    ];
    try {
      for (const buildLocale of [undefined, 'it', 'de']) {
        if (buildLocale === undefined) delete process.env.BUILD_LOCALE; else process.env.BUILD_LOCALE = buildLocale;
        const fast = await loadWithFlag('1', () => import('../build-plugins/seoHubsPlugin'));
        const legacy = await loadWithFlag('0', () => import('../build-plugins/seoHubsPlugin'));
        const np = path;
        for (const href of hrefs) {
          expect(fast.hasEmittedJobDetailPage(fs, np, dist, href), `${buildLocale}:${href}`)
            .toBe(legacy.hasEmittedJobDetailPage(fs, np, dist, href));
        }
        const foreign = buildLocale === 'de';
        fast.beginJobDetailExistenceMemo();
        expect(fast.hasEmittedJobDetailPage(fs, np, dist, '/cerca-lavoro-ticino/job-b/')).toBe(foreign);
        fs.mkdirSync(path.join(dist, 'cerca-lavoro-ticino', 'job-b'), { recursive: true });
        fs.writeFileSync(path.join(dist, 'cerca-lavoro-ticino', 'job-b', 'index.html'), 'x');
        expect(fast.hasEmittedJobDetailPage(fs, np, dist, '/cerca-lavoro-ticino/job-b/')).toBe(foreign);
        fast.endJobDetailExistenceMemo();
        expect(fast.hasEmittedJobDetailPage(fs, np, dist, '/cerca-lavoro-ticino/job-b/')).toBe(true);
        fs.rmSync(path.join(dist, 'cerca-lavoro-ticino', 'job-b'), { recursive: true, force: true });
      }
    } finally {
      delete process.env.BUILD_LOCALE;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dropUrlBlocksByLoc: fast normalisation + cached drop set == legacy', () => {
  it('drops exactly the same blocks for fuzzed loc shapes', async () => {
    const fast = await loadWithFlag('1', () => import('../build-plugins/relatedSearchClustersPlugin'));
    const legacy = await loadWithFlag('0', () => import('../build-plugins/relatedSearchClustersPlugin'));
    const O = 'https://frontaliereticino.ch';
    const shapes = [
      (n: number) => `${O}/a-${n}/`, (n: number) => `${O}/a-${n}`, (n: number) => `${O}/a-${n}/b/`,
      (n: number) => `${O}`, (n: number) => `${O}/`, (n: number) => `${O}//a-${n}/`,
      (n: number) => `${O}/a-${n}/./b/`, (n: number) => `${O}/a-${n}/../b/`, (n: number) => `${O}/a b-${n}/`,
      (n: number) => `${O}/è-${n}/`, (n: number) => `${O}/a-${n}/?q=1`, (n: number) => `${O}/a-${n}/#x`,
      (n: number) => `HTTPS://FRONTALIERETICINO.CH/a-${n}/`, (n: number) => `${O}:443/a-${n}/`,
      (n: number) => `${O}.evil.test/a-${n}/`, (n: number) => `http://frontaliereticino.ch/a-${n}/`,
      (n: number) => `/a-${n}/`, (n: number) => `${O}/a%20b-${n}/`, (n: number) => `${O}/..${n}/`,
    ];
    const rand = rng(7);
    const locs: string[] = [];
    for (let i = 0; i < 400; i++) locs.push(shapes[Math.floor(rand() * shapes.length)](Math.floor(rand() * 30)));
    const xml = locs.map((l) => `  <url>\n    <loc>${l}</loc>\n  </url>\n`).join('');
    for (let round = 0; round < 6; round++) {
      const drop: string[] = [];
      for (let i = 0; i < 120; i++) drop.push(shapes[Math.floor(rand() * shapes.length)](Math.floor(rand() * 30)));
      const a = fast.dropUrlBlocksByLoc(xml, drop);
      const b = legacy.dropUrlBlocksByLoc(xml, drop);
      expect(a.dropped).toBe(b.dropped);
      expect(a.xml).toBe(b.xml);
      // seconda chiamata con lo STESSO array (cache) e con l'array mutato
      expect(fast.dropUrlBlocksByLoc(xml, drop).xml).toBe(b.xml);
      drop.push(`${O}/a-1/`);
      expect(fast.dropUrlBlocksByLoc(xml, drop).xml).toBe(legacy.dropUrlBlocksByLoc(xml, drop).xml);
    }
  });
});
