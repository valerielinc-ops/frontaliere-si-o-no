import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_CDN_ORIGIN,
  SITE_ORIGIN,
  SITE_OWNED_OG_IMAGE_ALLOWLIST,
  checkOwnedOgImage,
  checkPublishedImageUrl,
  loadPublishedImagePolicy,
} from '../scripts/lib/published-image-policy.mjs';
import {
  collectOgImageReferences,
  run as runOgImageGate,
  verifyOgImageReferences,
} from '../scripts/verify-og-images.mjs';
import { isExplicitInferredCover, loadInferredCoverDecisions } from '../scripts/lib/blog-cover-decisions.mjs';

const ROOT = path.resolve(__dirname, '..');

// A credit record taken from the synced article corpus turns this file red
// when that article is retired or its cover replaced, on whatever pull request
// runs it next. The credited cover is pinned, together with one event-library
// record, in a root the policy can load. Each path is spelled out in full so
// the related-test selector links the fixture to this file.
const CREDIT_FIXTURE = 'tests/__fixtures__/published-image-policy/blog-credit.json';
const EVENT_LIBRARY_FIXTURE = 'tests/__fixtures__/license-audit/event-image-library.json';

function withPinnedRoot<T>(run: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-image-policy-'));
  try {
    fs.mkdirSync(path.join(root, 'content/image-credits/blog'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, CREDIT_FIXTURE), path.join(root, 'content/image-credits/blog/credited-cover.json'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, EVENT_LIBRARY_FIXTURE), path.join(root, 'data/event-image-library.json'));
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('published image policy', () => {
  it('accepts a generated event CDN URL only with its valid registry record', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/event-image-library.json'), 'utf8'));
    const policy = loadPublishedImagePolicy({ root: ROOT });
    const record = registry.assets[0];
    const url = `${IMAGE_CDN_ORIGIN}${record.imageUrl}`;

    expect(policy.check(url, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'generated-registry',
      path: record.imageUrl,
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/events/library/not-registered.webp`, { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
  });

  it('accepts a verified licensed photo record through the same CDN gate', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/event-image-library.json'), 'utf8'));
    const policy = loadPublishedImagePolicy({ root: ROOT });
    const record = registry.assets.find((asset) => asset.kind === 'photo');

    expect(record).toBeDefined();
    expect(policy.check(`${IMAGE_CDN_ORIGIN}${record.imageUrl}`, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'licensed-photo-registry',
      path: record.imageUrl,
    });
  });

  it('accepts a credited blog cover with status ok and rejects a missing one', () => {
    withPinnedRoot((root) => {
      const policy = loadPublishedImagePolicy({ root });
      expect(
        policy.check(`${IMAGE_CDN_ORIGIN}/images/blog/credited-cover.webp`, { requireCdn: true }),
      ).toMatchObject({ valid: true, source: 'image-credits' });
      expect(
        policy.check(`${IMAGE_CDN_ORIGIN}/images/blog/not-in-ledger.webp`, { requireCdn: true }),
      ).toMatchObject({ valid: false, reason: 'missing-or-unpublishable-image-credit' });
    });
  });

  // ── Historical covers kept without a credit (issue 12347) ─────────────────
  // The owner keeps the covers whose source the audit could not prove. The
  // ledger gate accepts them when ledger and index both record the decision;
  // the og:image gate used to ask the credit reader alone and rejected them,
  // 4975 of the 6769 published covers on 2026-10-08.
  const LEDGER_DECISION = { proofLevel: 6, evidence: 'inferred', verifiedAt: '2026-10-07', status: 'no-credit' };
  const INDEX_DECISION = { evidence: 'inferred', provider: null, verifiedAt: '2026-10-07', status: 'no-credit' };

  function withInferredCovers<T>(run: (root: string) => T): T {
    return withPinnedRoot((root) => {
      fs.writeFileSync(path.join(root, 'data/blog-cover-ledger.json'), JSON.stringify({
        covers: {
          'kept-cover': LEDGER_DECISION,
          'ledger-only': LEDGER_DECISION,
          'other-date': LEDGER_DECISION,
          'proven-elsewhere': { ...LEDGER_DECISION, proofLevel: 2 },
        },
      }));
      fs.writeFileSync(path.join(root, 'data/image-credits-blog.json'), JSON.stringify({
        covers: {
          'kept-cover': INDEX_DECISION,
          'index-only': INDEX_DECISION,
          'other-date': { ...INDEX_DECISION, verifiedAt: '2026-10-06' },
          'proven-elsewhere': INDEX_DECISION,
        },
      }));
      return run(root);
    });
  }

  it('lets og:image name a cover kept without credit only when ledger and index agree', () => {
    withInferredCovers((root) => {
      const policy = loadPublishedImagePolicy({ root });
      const cover = (key: string) => `${IMAGE_CDN_ORIGIN}/images/blog/${key}.webp`;
      expect(policy.checkOg(cover('kept-cover'))).toMatchObject({ valid: true, source: 'inferred-no-credit' });
      expect(policy.checkOg(`${SITE_ORIGIN}/images/blog/kept-cover.webp`)).toMatchObject({ valid: true });
      expect(policy.checkOg(cover('credited-cover'))).toMatchObject({ valid: true, source: 'image-credits' });
      for (const key of ['ledger-only', 'index-only', 'other-date', 'proven-elsewhere', 'never-recorded']) {
        expect(policy.checkOg(cover(key)), key).toMatchObject({
          valid: false,
          reason: 'missing-or-unpublishable-image-credit',
        });
      }
    });
  });

  it('keeps a cover without credit away from every uploader', () => {
    withInferredCovers((root) => {
      const policy = loadPublishedImagePolicy({ root });
      const kept = `${IMAGE_CDN_ORIGIN}/images/blog/kept-cover.webp`;
      const rejected = { valid: false, reason: 'missing-or-unpublishable-image-credit' };
      expect(policy.check(kept, { requireCdn: true })).toMatchObject(rejected);
      expect(policy.check(kept)).toMatchObject(rejected);
      // Not even when a caller hands the decisions over itself.
      expect(policy.check(kept, { inferredCovers: { has: () => true } })).toMatchObject(rejected);
    });
  });

  it('reads the decision the same way for the ledger gate and the og gate', () => {
    expect(isExplicitInferredCover(LEDGER_DECISION, INDEX_DECISION)).toBe(true);
    expect(isExplicitInferredCover(LEDGER_DECISION, undefined)).toBe(false);
    expect(isExplicitInferredCover(undefined, INDEX_DECISION)).toBe(false);
    expect(isExplicitInferredCover({ ...LEDGER_DECISION, status: 'ok' }, INDEX_DECISION)).toBe(false);
    expect(isExplicitInferredCover(LEDGER_DECISION, { ...INDEX_DECISION, provider: 'wikimedia' })).toBe(false);
    // The ledger gate imports the predicate instead of spelling it out again.
    const ledgerGate = fs.readFileSync(path.join(ROOT, 'scripts/ci/verify-blog-cover-ledger.mjs'), 'utf8');
    expect(ledgerGate).toContain('isExplicitInferredCover(inventoryItem, imageCreditsIndex.covers?.[key])');
    expect(ledgerGate).not.toContain("indexEntry?.status === 'no-credit'");
    // No file, no decision.
    withPinnedRoot((root) => {
      expect(loadInferredCoverDecisions({ root }).has('kept-cover')).toBe(false);
    });
  });

  it('blocks every third-party image before an uploader can fetch it', () => {
    expect(checkPublishedImageUrl('https://images.example/hero.webp', { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'not-our-cdn',
    });
  });

  it('keeps the OG-only site-owned exception explicit and narrow', () => {
    const policy = loadPublishedImagePolicy({ root: ROOT });
    expect(SITE_OWNED_OG_IMAGE_ALLOWLIST).toContain(`${SITE_ORIGIN}/og-image.png`);
    expect(checkOwnedOgImage(`${SITE_ORIGIN}/og-image.png`)).toMatchObject({
      valid: true,
      source: 'site-owned-og-allowlist',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/places/lugano-view.webp`)).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    for (const pathName of [
      '/og/jobs/infermiere-eoc.webp',
      '/og/seo/faq-hub/permesso-g-2026-it.webp',
      '/og/border-wait/brogeda.jpg',
    ]) {
      expect(checkOwnedOgImage(`${SITE_ORIGIN}${pathName}`), pathName).toMatchObject({
        valid: true,
        source: 'site-owned-og-allowlist',
      });
    }
    expect(checkOwnedOgImage(`${IMAGE_CDN_ORIGIN}/og/jobs/infermiere-eoc.webp`)).toMatchObject({
      valid: true,
      source: 'site-owned-og-allowlist',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/authors/redazione.webp`)).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.webp`, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/samuele-valente.webp`, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'private-grant-registry',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/authors/redazione.jpg`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/places/not-registered.webp`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.jpg`, { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(checkOwnedOgImage(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.jpg`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(checkOwnedOgImage(`${SITE_ORIGIN}/images/brands/unknown.png`)).toMatchObject({
      valid: false,
      reason: 'unsupported-image-prefix',
    });
  });

  it('checks one representative event, article and static OG family', () => {
    withPinnedRoot((root) => {
      const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/event-image-library.json'), 'utf8'));
      const policy = loadPublishedImagePolicy({ root });
      const result = verifyOgImageReferences([
        { file: 'events/e/index.html', url: `${IMAGE_CDN_ORIGIN}${registry.assets[0].imageUrl}` },
        { file: 'articles/a/index.html', url: `${IMAGE_CDN_ORIGIN}/images/blog/credited-cover.webp` },
        { file: 'static/index.html', url: `${SITE_ORIGIN}/og-image.png` },
      ], { policy, sampleSize: 3 });

      expect(result.valid).toBe(true);
      expect(result.counts).toEqual({ events: 1, articles: 1, static: 1 });
      expect(result.errors).toEqual([]);
    });
  });

  it('keeps one row per distinct OG image however many pages share it', () => {
    // The full dist has millions of pages sharing a handful of cards: a row
    // per page exhausted the heap (run 37571743923, validate:og-images rc=134).
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-collect-'));
    try {
      const shared = `${SITE_ORIGIN}/og-image.png`;
      for (let i = 0; i < 40; i += 1) {
        const dir = path.join(dist, 'jobs', `job-${String(i).padStart(2, '0')}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), `<meta property="og:image" content="${shared}">`, 'utf8');
      }
      fs.mkdirSync(path.join(dist, 'articles', 'a'), { recursive: true });
      fs.writeFileSync(
        path.join(dist, 'articles', 'a', 'index.html'),
        `<meta property="og:image" content="${IMAGE_CDN_ORIGIN}/images/blog/a.webp">`,
        'utf8',
      );
      fs.writeFileSync(path.join(dist, 'notes.txt'), `<meta property="og:image" content="${SITE_ORIGIN}/ignored.png">`, 'utf8');

      const { references, total, counts } = collectOgImageReferences(dist);

      expect(total).toBe(41);
      expect(counts).toEqual({ events: 0, articles: 1, static: 1 });
      expect(references).toEqual([
        { file: 'articles/a/index.html', url: `${IMAGE_CDN_ORIGIN}/images/blog/a.webp` },
        { file: 'jobs/job-00/index.html', url: shared },
      ]);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('bounds the retained rows when every OG image is distinct', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-distinct-'));
    try {
      const metas = Array.from({ length: 5000 }, (_, i) => `<meta property="og:image" content="${SITE_ORIGIN}/cards/${i}.png">`);
      fs.writeFileSync(path.join(dist, 'index.html'), metas.join('\n'), 'utf8');

      const { references, total, counts } = collectOgImageReferences(dist);

      expect(total).toBe(5000);
      expect(counts).toEqual({ events: 0, articles: 0, static: 5000 });
      expect(references).toHaveLength(3);
      expect(references[0].url).toBe(`${SITE_ORIGIN}/cards/0.png`);
      expect(references[2].url).toBe(`${SITE_ORIGIN}/cards/4999.png`);
      // Past the per-family buffer the middle pick is the retained row at or
      // just before the true middle (ordinal 2499), never further than a stride.
      const middle = Number(references[1].url.match(/cards\/(\d+)\.png$/)?.[1]);
      expect(middle).toBeLessThanOrEqual(2499);
      expect(middle).toBeGreaterThan(2499 - 16);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('keeps de-duplication exact however many distinct URLs came before', () => {
    // A capped string set was tried and was wrong: past the cap a repeated URL
    // counted as new, so in `…, A, B, A` the last distinct row became A and
    // the invalid B escaped the sample.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-exact-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      const meta = (url: string) => `<meta property="og:image" content="${url}">`;
      const valid = Array.from({ length: 100_050 }, (_, i) => meta(`${SITE_ORIGIN}/og-image.png?v=${i}`));
      const a = meta(`${SITE_ORIGIN}/og-image.png?v=A`);
      const b = meta('https://images.example.com/not-ours.png');
      fs.writeFileSync(path.join(root, 'dist', 'index.html'), [...valid, a, b, a].join('\n'), 'utf8');

      const { references, total, counts } = collectOgImageReferences(path.join(root, 'dist'));
      expect(total).toBe(100_053);
      expect(counts.static).toBe(100_052);
      expect(references.at(-1)?.url).toBe('https://images.example.com/not-ours.png');

      expect(runOgImageGate(['--dist', 'dist', '--allow-missing-families'], { root })).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('not-ours.png');
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('walks the dist in the order of a global path sort', () => {
    // `a.html` sorts before `a/z.html` in a sort over full paths; a naive
    // per-directory name sort visits the directory first and would let a bad
    // first sample slip past `--sample-size 1`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-order-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(root, 'dist', 'a'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'dist', 'a', 'z.html'),
        `<meta property="og:image" content="${SITE_ORIGIN}/og-image.png">`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(root, 'dist', 'a.html'),
        '<meta property="og:image" content="https://images.example.com/not-ours.png">',
        'utf8',
      );

      expect(collectOgImageReferences(path.join(root, 'dist')).references.map((row) => row.file))
        .toEqual(['a.html', 'a/z.html']);
      expect(runOgImageGate(['--dist', 'dist', '--sample-size', '1', '--allow-missing-families'], { root })).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('a.html');
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a local registry is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-gate-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'generated-image-registry.json'), '{"assets": [}', 'utf8');
      fs.writeFileSync(
        path.join(root, 'dist', 'index.html'),
        '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">',
        'utf8',
      );

      expect(runOgImageGate(['--dist', 'dist', '--allow-missing-families'], { root })).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('registry:');
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps article heroes on the governed engine and retires the dead backfill', () => {
    const createArticle = fs.readFileSync(path.join(ROOT, 'scripts', 'create-article.mjs'), 'utf8');
    expect(createArticle).toContain('generateImageFromSpec');
    expect(createArticle).toContain("scope: 'article-hero'");
    expect(createArticle).not.toContain('gemini-3-pro-image-preview');
    expect(createArticle).not.toContain('gemini-2.5-flash-image');
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'backfill-small-images.mjs'))).toBe(false);
  });
});
