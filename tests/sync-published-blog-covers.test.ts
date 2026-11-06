import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPublishedBlogCoverBytes } from '../scripts/lib/published-blog-cover-bytes.mjs';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/audit/sync-published-blog-covers.mjs');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts/ci/verify-blog-cover-ledger.mjs');
const roots: string[] = [];
const SOURCE_COMMIT = 'a'.repeat(40);
const IMAGE = '/images/blog/new-cover.webp';
const IMAGE_BYTES = Buffer.from('cover-bytes');
const CANTON_ARTICLES_PATH = 'public/canton-articles.json';
const REAL_KEY = 'bollettino-frontaliere-2026-08-10';
const REAL_IMAGE = `/images/blog/${REAL_KEY}.webp`;

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function generatedRecord(
  sha = sha256(IMAGE_BYTES),
  { assetId = 'new-cover', imageUrl = IMAGE, bytes = IMAGE_BYTES.length } = {},
) {
  return {
    schema: 1,
    assetId,
    kind: 'generated',
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: 'frontaliereticino.generated-image-policy.v1',
    promptHash: 'b'.repeat(64),
    license: 'generated-provider',
    licenseUrl: 'https://openai.com/policies/terms-of-use/',
    credit: 'frontaliereticino.ch',
    sha256: sha,
    bytes,
    width: 1200,
    height: 675,
    format: 'webp',
    generatedAt: '2026-10-07T10:00:00.000Z',
    verifiedAt: '2026-10-07T10:05:00.000Z',
    restrictions: [
      'illustrative-only',
      'no-real-recognizable-foreground-person',
      'no-public-figure-face',
      'no-logo-brand-or-text',
      'no-specific-real-event-photojournalism',
    ],
    scope: 'article-hero',
    imageUrl,
    category: 'blog',
    area: 'Ticino and the Swiss Italian border region',
    season: 'all seasons',
    variant: 'generated-cover-sync-test',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      notes: 'Safe generic editorial illustration for the sync regression test.',
    },
  };
}

function placeFallbackRecord() {
  return {
    schema: 1,
    assetId: 'lugano-view',
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: 'frontaliereticino.generated-image-policy.v1',
    promptHash: 'a552b810810cf3e04267e7c17af799c7a182a0cda5732e97212ee0b1d9e0cecb',
    license: 'generated-provider',
    licenseUrl: 'https://openai.com/policies/terms-of-use/',
    credit: 'frontaliereticino.ch',
    sha256: 'feb0ec2c59872a3d1ccb23dba22a436ca1d747d5e909b142cd4a593c550b6a96',
    bytes: 169332,
    width: 1200,
    height: 675,
    format: 'webp',
    generatedAt: '2026-10-06T19:26:04.084Z',
    verifiedAt: '2026-10-06T19:26:14.671Z',
    restrictions: [
      'illustrative-only',
      'no-real-recognizable-foreground-person',
      'no-public-figure-face',
      'no-logo-brand-or-text',
      'no-specific-real-event-photojournalism',
    ],
    scope: 'place',
    imageUrl: '/images/places/lugano-view.webp',
    area: 'Canton Ticino e regione di confine',
    season: 'luce diurna equilibrata',
    variant: 'place-hero',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      notes: 'Original generic illustrated landscape; no readable text, logos, signatures, recognizable faces, or specific real event.',
    },
  };
}

function validPrivateGrantEvidence() {
  const record: Record<string, unknown> = {
    ...generatedRecord(),
    assetId: 'private-grant-cover',
    provider: 'site-owned',
    note: 'Site-owned cover with documented publication rights.',
    license: 'private-grant',
    imageUrl: '/images/blog/private-grant-cover.webp',
  };
  for (const field of [
    'model', 'executorModel', 'promptVersion', 'promptHash', 'licenseUrl', 'generatedAt',
    'verifiedAt', 'restrictions', 'vision',
  ]) delete record[field];
  return record;
}

function deterministicCardEvidence(
  sha = sha256(IMAGE_BYTES),
  bytes = IMAGE_BYTES.length,
  { assetId = 'new-cover', imageUrl = IMAGE } = {},
) {
  return {
    schema: 1,
    assetId,
    source: 'deterministic-card',
    provider: 'site-owned',
    note: 'Deterministic SVG card rendered by the repository; no external image provider is used.',
    credit: 'frontaliereticino.ch',
    producer: 'generator/scripts/lib/daily-brief-image.mjs',
    templateVersion: 'frontaliereticino.daily-brief-card.v1',
    license: 'private-grant',
    sha256: sha,
    bytes,
    width: 1200,
    height: 675,
    format: 'webp',
    scope: 'article-hero',
    imageUrl,
  };
}

function validPexelsEvidence() {
  return {
    schema: 1,
    assetId: 'pexels-cover',
    kind: 'photo',
    provider: 'pexels',
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    sourcePageUrl: 'https://www.pexels.com/photo/test-photo-1234567/',
    author: { name: 'Test Photographer', url: 'https://www.pexels.com/@test-photographer' },
    credit: 'Test Photographer / Pexels',
    copyrightNotice: 'Photograph by Test Photographer via Pexels',
    acquireLicensePage: 'https://www.pexels.com/license/',
    sourceWidth: 1920,
    sourceHeight: 1080,
    generatedAt: '2026-10-07T10:00:00.000Z',
    verifiedAt: '2026-10-07T10:05:00.000Z',
    restrictions: ['licensed-source', 'no-recognizable-foreground-person', 'no-logo-brand-or-trademark'],
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: true,
      is_topic_relevant: true,
      notes: 'Safe generic licensed editorial photo for the ledger regression test.',
    },
    sha256: 'd'.repeat(64),
    bytes: 64,
    width: 1200,
    height: 675,
    format: 'webp',
    scope: 'article-hero',
    imageUrl: '/images/blog/pexels-cover.webp',
  };
}

function generatedCreditRecord(generated: ReturnType<typeof generatedRecord>) {
  return {
    schema: 1,
    cover: generated.imageUrl,
    source: 'generated-provider',
    commons: {
      title: 'Generated editorial illustration',
      pageUrl: generated.licenseUrl,
      width: generated.width,
      height: generated.height,
      revision: generated.generatedAt,
    },
    author: { text: generated.credit, name: generated.credit, url: null, type: 'Organization' },
    attribution: null,
    licence: {
      name: 'Generated media — provider terms apply',
      url: generated.licenseUrl,
      family: 'other-attribution',
      attributionRequired: true,
    },
    restrictions: generated.restrictions,
    modified: 'resized',
    fetchedAt: generated.generatedAt.slice(0, 10),
    status: 'ok',
    curation: null,
    generated,
  };
}

function addGeneratedEvidence(
  root: string,
  sha?: string,
  options: { assetId?: string; imageUrl?: string; bytes?: number; writeCredit?: boolean } = {},
) {
  const { writeCredit = true, assetId, imageUrl, bytes } = options;
  const generated = generatedRecord(sha, { assetId, imageUrl, bytes });
  fs.writeFileSync(path.join(root, 'data/published-blog-generated-image-evidence.json'), `${JSON.stringify({
    schema: 1,
    commit: SOURCE_COMMIT,
    generated: { [generated.imageUrl]: generated },
  }, null, 2)}\n`);
  if (!writeCredit) return;
  const recordPath = path.join(root, `packages/articles/content/image-credits/blog/${generated.assetId}.json`);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(generatedCreditRecord(generated), null, 2)}\n`);
}

function addRetiredLedgerCover(root: string, key: string, image: string, hash: string) {
  const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.covers[key] = {
    cover: image,
    hash,
    published: false,
    historicalPublished: false,
    references: [],
    proofLevel: 6,
    evidence: 'inferred',
    recordFile: null,
    action: 'retire-unpublished',
    reason: 'Blob non più referenziato da un registro pubblicato.',
    priority: 0,
  };
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function fixture({ withImage = true, key = 'new-cover', image = IMAGE, imageBytes = IMAGE_BYTES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-blog-covers-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'packages/articles/content'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/images/blog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/articles/content/blog-articles-data.ts'), `export const ARTICLES = [
  {
    id: '${key}',
    category: 'news',
    date: '2026-10-07T10:00:00.000Z',
    updatedAt: null,
    image: '${image}',
    authorSlug: 'redazione',
  },
];\n`);
  fs.writeFileSync(path.join(root, 'packages/articles/content/swiss-articles-data.ts'), 'export const ARTICLES = [];\n');
  fs.writeFileSync(path.join(root, 'public/canton-articles.json'), '[]\n');
  fs.writeFileSync(path.join(root, 'data/blog-cover-ledger.json'), `${JSON.stringify({
    schema: 1,
    generatedAt: '2026-10-06',
    counts: {},
    covers: {
      existing: { proofLevel: 6, evidence: 'inferred', published: true, action: 'record-inferred' },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'data/image-credits-blog.json'), `${JSON.stringify({
    schema: 1,
    files: {},
    covers: { existing: { evidence: 'inferred', provider: null, verifiedAt: '2026-10-06', status: 'no-credit' } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'data/published-blog-generated-image-evidence.json'), `${JSON.stringify({
    schema: 1,
    commit: SOURCE_COMMIT,
    generated: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'data/blog-cover-corpus-baseline.json'), `${JSON.stringify({
    schema: 1,
    sourceCommit: SOURCE_COMMIT,
    generatedAt: '2026-10-06',
    registries: {
      'packages/articles/content/blog-articles-data.ts': { corpusPath: 'content/blog-articles-data.ts', articles: 0, distinctImages: 0 },
      'packages/articles/content/swiss-articles-data.ts': { corpusPath: 'content/swiss-articles-data.ts', articles: 0, distinctImages: 0 },
    },
  }, null, 2)}\n`);
  if (withImage) fs.writeFileSync(path.join(root, `public${image}`), imageBytes);
  return root;
}

function clearPublishedArticleCovers(root: string) {
  fs.writeFileSync(path.join(root, 'packages/articles/content/blog-articles-data.ts'), 'export const ARTICLES = [];\n');
}

function declareCantonArtifact(
  root: string,
  { sha = sha256(fs.readFileSync(path.join(root, CANTON_ARTICLES_PATH))), articleCount = 0 } = {},
) {
  const baselinePath = path.join(root, 'data/blog-cover-corpus-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  baseline.publishedArtifacts = {
    ...(baseline.publishedArtifacts || {}),
    cantonArticles: {
      path: CANTON_ARTICLES_PATH,
      present: true,
      sha256: sha,
      articleCount,
    },
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitFixture(root: string, { omitImage = false } = {}) {
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture Test']);
  git(root, ['add', '--all']);
  if (omitImage) {
    git(root, ['rm', '--cached', '--quiet', '--', `public${IMAGE}`]);
    fs.rmSync(path.join(root, `public${IMAGE}`));
    git(root, ['add', '--all']);
  }
  git(root, ['commit', '--quiet', '-m', 'fixture']);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync-published-blog-covers', () => {
  it('keeps sync fail-closed but allows verifier pre-bootstrap when the canton registry is absent', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    const cantonArticlesPath = path.join(root, CANTON_ARTICLES_PATH);
    fs.rmSync(cantonArticlesPath);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 0,
      assets: [],
    })}\n`);

    const sync = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    const verify = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(sync.status).toBe(1);
    expect(`${sync.stdout}\n${sync.stderr}`).toContain(cantonArticlesPath);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('canton-articles.json: not yet declared by the baseline (pre-bootstrap)');
    expect(verify.stdout).toContain('"errors": 0');
  });

  it('rejects a declared canton registry when the file is missing', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    declareCantonArtifact(root);
    fs.rmSync(path.join(root, CANTON_ARTICLES_PATH));

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'public/canton-articles.json: baseline declares the artifact, but the file is missing',
    );
  });

  it('rejects a declared canton registry when its sha256 differs', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    declareCantonArtifact(root, { sha: 'f'.repeat(64) });

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'public/canton-articles.json: sha256 differs from the baseline',
    );
  });

  it('rejects removal of a canton declaration already present on origin/main', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    declareCantonArtifact(root);
    commitFixture(root);
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const baselinePath = path.join(root, 'data/blog-cover-corpus-baseline.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    delete baseline.publishedArtifacts.cantonArticles;
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'declaration for public/canton-articles.json cannot be removed',
    );
  });

  it('uses the immutable comparison ref when origin/main advances during a run', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    commitFixture(root);
    const preBootstrapSha = git(root, ['rev-parse', 'HEAD']).trim();

    declareCantonArtifact(root);
    git(root, ['add', '--', 'data/blog-cover-corpus-baseline.json']);
    git(root, ['commit', '--quiet', '-m', 'future artifact declaration']);
    const advancedMainSha = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['update-ref', 'refs/remotes/origin/main', advancedMainSha]);
    git(root, ['reset', '--hard', '--quiet', preBootstrapSha]);

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BLOG_COVER_LEDGER_BASE_REF: preBootstrapSha },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: 0 });
    expect(result.stderr).not.toContain('declaration for public/canton-articles.json cannot be removed');
  });

  it('fails closed when the immutable comparison ref cannot be resolved', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    commitFixture(root);

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BLOG_COVER_LEDGER_BASE_REF: 'refs/heads/missing-baseline-ref' },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('comparison baseline ref "refs/heads/missing-baseline-ref" is not resolvable');
    expect(output).not.toContain('not yet declared by the baseline (pre-bootstrap)');
  });

  it.each([
    ['private-grant', validPrivateGrantEvidence],
    ['licensed Pexels photo', validPexelsEvidence],
  ])('verifies schema-valid published %s evidence', (_label, makeRecord) => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const record = makeRecord();
    evidence.generated[record.imageUrl] = record;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const output = execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(JSON.parse(output)).toMatchObject({ errors: 0 });
  });

  it('accepts the governed place fallback without treating it as an article-hero registry entry', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const record = placeFallbackRecord();
    evidence.generated[record.imageUrl] = record;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const output = execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(JSON.parse(output)).toMatchObject({ generated: 0, errors: 0 });
  });

  it('still rejects schema-valid published evidence outside the published blog scopes', () => {
    const root = fixture();
    clearPublishedArticleCovers(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const record = validPrivateGrantEvidence();
    record.scope = 'event-library';
    record.imageUrl = '/images/events/library/private-grant-cover.webp';
    evidence.generated[record.imageUrl] = record;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid published generated-image evidence');
    expect(result.stdout).toContain('"errors": 1');
  });

  it('adds only missing published covers to the paired ledger and index, idempotently', () => {
    const root = fixture();
    execFileSync(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT } });
    const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
    const indexPath = path.join(root, 'data/image-credits-blog.json');
    const firstLedger = fs.readFileSync(ledgerPath, 'utf8');
    const firstIndex = fs.readFileSync(indexPath, 'utf8');
    const ledger = JSON.parse(firstLedger);
    const index = JSON.parse(firstIndex);
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-corpus-baseline.json'), 'utf8'));

    expect(ledger.covers.existing).toEqual({ proofLevel: 6, evidence: 'inferred', published: true, action: 'record-inferred' });
    expect(ledger.covers['new-cover']).toMatchObject({
      cover: '/images/blog/new-cover.webp',
      published: true,
      proofLevel: 6,
      evidence: 'inferred',
      status: 'no-credit',
    });
    expect(ledger.covers['new-cover'].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(index.covers['new-cover']).toMatchObject({ evidence: 'inferred', provider: null, status: 'no-credit' });
    expect(baseline).toMatchObject({
      sourceCommit: 'a'.repeat(40),
      publishedArtifacts: {
        cantonArticles: {
          path: CANTON_ARTICLES_PATH,
          present: true,
          sha256: sha256(Buffer.from('[]\n')),
          articleCount: 0,
        },
      },
      registries: {
        'packages/articles/content/blog-articles-data.ts': { articles: 1, distinctImages: 1 },
        'packages/articles/content/swiss-articles-data.ts': { articles: 0, distinctImages: 0 },
      },
    });

    const output = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(output).added).toBe(0);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(firstLedger);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(firstIndex);

    const withoutNewIndex = JSON.parse(firstIndex);
    delete withoutNewIndex.covers['new-cover'];
    fs.writeFileSync(indexPath, `${JSON.stringify(withoutNewIndex, null, 2)}\n`);
    const repairOutput = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(repairOutput)).toMatchObject({ added: 0, repairedIndexKeys: ['new-cover'] });
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).covers['new-cover']).toMatchObject({
      evidence: 'inferred',
      status: 'no-credit',
    });
  });

  it('ingests a newly published canton article generated cover from the HTTP registry', () => {
    const root = fixture({
      key: 'article-disoccupazione-berna-settembre-2026-stabile',
      image: '/images/blog/article-disoccupazione-berna-settembre-2026-stabile.webp',
    });
    const key = 'article-disoccupazione-berna-settembre-2026-stabile';
    const image = `/images/blog/${key}.webp`;
    clearPublishedArticleCovers(root);
    addRetiredLedgerCover(root, key, image, sha256(IMAGE_BYTES));
    fs.writeFileSync(path.join(root, 'public/canton-articles.json'), `${JSON.stringify([{
      id: 'disoccupazione-berna-settembre-2026-stabile',
      category: 'pratico',
      date: '2026-10-07T19:58:52.255Z',
      image,
      authorSlug: 'redazione',
      commit: SOURCE_COMMIT,
      section: 'canton-be',
    }])}\n`);
    addGeneratedEvidence(root, sha256(IMAGE_BYTES), {
      assetId: key,
      imageUrl: image,
      bytes: IMAGE_BYTES.length,
      writeCredit: false,
    });
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({
      schema: 1,
      items: {},
    })}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 0,
      assets: [],
    })}\n`);

    const beforeSync = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(beforeSync.status).toBe(1);
    expect(`${beforeSync.stdout}\n${beforeSync.stderr}`).toContain(
      `${key}: published cover has no image-credit record`,
    );

    const result = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    }));
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(root, 'data/image-credits-blog.json'), 'utf8'));

    expect(result).toMatchObject({ generatedAddedKeys: [key], generatedEvidenceMismatches: [] });
    const credit = JSON.parse(fs.readFileSync(
      path.join(root, `packages/articles/content/image-credits/blog/${key}.json`),
      'utf8',
    ));
    expect(ledger.covers[key]).toMatchObject({
      cover: image,
      published: true,
      references: [{ section: 'canton-be', id: 'disoccupazione-berna-settembre-2026-stabile' }],
      proofLevel: 5,
      evidence: 'generated-engine-record',
      status: 'generated',
    });
    expect(index.covers[key]).toEqual({ file: `generated:${key}`, modified: 'resized' });
    expect(credit).toMatchObject({
      source: 'generated-provider',
      generated: { assetId: key, imageUrl: image, sha256: sha256(IMAGE_BYTES), bytes: IMAGE_BYTES.length },
    });
    expect(JSON.parse(execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root }))).toMatchObject({
      currentUnique: 1,
      generated: 1,
      errors: 0,
    });
  });

  it('records a newly published cover as generated only when the HTTP evidence and bytes agree', () => {
    const root = fixture();
    addGeneratedEvidence(root);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    delete evidence.generated[IMAGE].kind;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const output = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    const result = JSON.parse(output);
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(root, 'data/image-credits-blog.json'), 'utf8'));

    expect(result).toMatchObject({ generatedAddedKeys: ['new-cover'], generatedEvidenceMismatches: [] });
    expect(ledger.covers['new-cover']).toMatchObject({
      proofLevel: 5,
      evidence: 'generated-engine-record',
      action: 'generated',
      status: 'generated',
      recordFile: 'packages/articles/content/image-credits/blog/new-cover.json',
      hash: sha256(IMAGE_BYTES),
      generated: { assetId: 'new-cover', imageUrl: IMAGE, provider: 'openai-codex' },
    });
    expect(ledger.counts).toMatchObject({ inferredRecords: 1, allCoversByProofLevel: { '5': 1, '6': 1 } });
    expect(index.covers['new-cover']).toEqual({ file: 'generated:new-cover', modified: 'resized' });
    expect(index.files['generated:new-cover']).toMatchObject({
      source: 'generated-provider',
      generated: { assetId: 'new-cover', sha256: sha256(IMAGE_BYTES) },
    });

    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 0,
      assets: [],
    })}\n`);
    const verifyOutput = execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(verifyOutput)).toMatchObject({ generated: 1, errors: 0 });
  });

  it('reconciles a declared deterministic-card replacement only after its bytes agree', () => {
    const root = fixture();
    addGeneratedEvidence(root);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.generated = { [IMAGE]: deterministicCardEvidence() };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 1,
      assets: [generatedRecord()],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({
      schema: 1,
      items: {
        'new-cover': { mode: 'generated', status: 'generated', fromCover: IMAGE, toCover: IMAGE },
      },
    }, null, 2)}\n`);

    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    }));
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(root, 'data/image-credits-blog.json'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-generated-image-registry.json'), 'utf8'));
    const replacements = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-replacements.json'), 'utf8'));

    expect(output.deterministicCardInferredKeys).toEqual(['new-cover']);
    expect(ledger.covers['new-cover']).toMatchObject({
      proofLevel: 6,
      evidence: 'inferred',
      action: 'record-inferred',
      status: 'no-credit',
      hash: sha256(IMAGE_BYTES),
    });
    expect(index.covers['new-cover']).toMatchObject({ evidence: 'inferred', status: 'no-credit' });
    expect(index.files).not.toHaveProperty('generated:new-cover');
    expect(registry.assets).toEqual([]);
    expect(replacements.items).not.toHaveProperty('new-cover');
    expect(fs.existsSync(path.join(root, 'packages/articles/content/image-credits/blog/new-cover.json'))).toBe(false);

    const verifyOutput = execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(verifyOutput)).toMatchObject({ inferred: 1, errors: 0 });
  });

  it('reconciles the real daily-brief cover URL against the served replacement bytes', () => {
    const servedBytes = readPublishedBlogCoverBytes(ROOT, REAL_IMAGE, { rejectInvalidPath: true });
    if (!servedBytes) throw new Error(`published cover bytes unavailable for ${REAL_IMAGE}`);
    const staleBytes = Buffer.from('stale-provider-cover');
    const root = fixture({ key: REAL_KEY, image: REAL_IMAGE, imageBytes: servedBytes });
    addGeneratedEvidence(root, sha256(staleBytes), {
      assetId: REAL_KEY,
      imageUrl: REAL_IMAGE,
      bytes: staleBytes.length,
    });
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.generated = {
      [REAL_IMAGE]: deterministicCardEvidence(sha256(servedBytes), servedBytes.length, {
        assetId: REAL_KEY,
        imageUrl: REAL_IMAGE,
      }),
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 1,
      assets: [generatedRecord(sha256(staleBytes), {
        assetId: REAL_KEY,
        imageUrl: REAL_IMAGE,
        bytes: staleBytes.length,
      })],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);

    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    }));
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-generated-image-registry.json'), 'utf8'));

    expect(output.deterministicCardInferredKeys).toEqual([REAL_KEY]);
    expect(ledger.covers[REAL_KEY]).toMatchObject({
      hash: sha256(servedBytes),
      proofLevel: 6,
      evidence: 'inferred',
      status: 'no-credit',
    });
    expect(registry.assets).toEqual([]);
    expect(fs.existsSync(path.join(root, `packages/articles/content/image-credits/blog/${REAL_KEY}.json`))).toBe(false);
    expect(JSON.parse(execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' })))
      .toMatchObject({ inferred: 1, errors: 0 });
  });

  it('reconciles a declared generated-provider replacement against the served bytes', () => {
    const root = fixture();
    addGeneratedEvidence(root);
    const replacementBytes = Buffer.from('replacement-cover-bytes');
    fs.writeFileSync(path.join(root, 'public/images/blog/new-cover.webp'), replacementBytes);
    const replacement = generatedRecord(sha256(replacementBytes));
    replacement.bytes = replacementBytes.length;
    replacement.promptHash = 'c'.repeat(64);
    replacement.generatedAt = '2026-10-08T10:00:00.000Z';
    replacement.verifiedAt = '2026-10-08T10:05:00.000Z';
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.generated = { [IMAGE]: replacement };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 1,
      assets: [generatedRecord()],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);

    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    }));
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-generated-image-registry.json'), 'utf8'));
    const credit = JSON.parse(fs.readFileSync(path.join(root, 'packages/articles/content/image-credits/blog/new-cover.json'), 'utf8'));

    expect(output.generatedAddedKeys).toEqual(['new-cover']);
    expect(ledger.covers['new-cover']).toMatchObject({
      proofLevel: 5,
      evidence: 'generated-engine-record',
      hash: sha256(replacementBytes),
    });
    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]).toMatchObject({ assetId: 'new-cover', sha256: sha256(replacementBytes), bytes: replacementBytes.length });
    expect(credit.generated).toMatchObject({ sha256: sha256(replacementBytes), bytes: replacementBytes.length });

    const verifyOutput = execFileSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(verifyOutput)).toMatchObject({ generated: 1, errors: 0 });
  });

  it('reads committed cover bytes when sparse checkout omits the working-tree file', () => {
    const root = fixture();
    addGeneratedEvidence(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    commitFixture(root);
    git(root, ['sparse-checkout', 'init', '--no-cone']);
    git(root, ['sparse-checkout', 'set', '--no-cone', '/data/', '/packages/', '/public/canton-articles.json']);

    expect(fs.existsSync(path.join(root, `public${IMAGE}`))).toBe(false);
    const output = JSON.parse(execFileSync(process.execPath, [VERIFY_SCRIPT], {
      cwd: root,
      encoding: 'utf8',
    }));

    expect(output).toMatchObject({ generated: 1, errors: 0 });
  });

  it('keeps an absent untracked cover as a verifier error', () => {
    const root = fixture();
    addGeneratedEvidence(root);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);
    execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    commitFixture(root, { omitImage: true });

    expect(fs.existsSync(path.join(root, `public${IMAGE}`))).toBe(false);
    expect(spawnSync('git', ['ls-files', '--error-unmatch', '--', `public${IMAGE}`], {
      cwd: root,
      encoding: 'utf8',
    }).status).toBe(1);
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('generated record has no corresponding site cover bytes');
    expect(JSON.parse(result.stdout)).toMatchObject({ generated: 1 });
    expect(JSON.parse(result.stdout).errors).toBeGreaterThan(0);
  });

  it.each([
    ['undeclared', {}, Buffer.from('new-cover-bytes')],
    ['declared with a non-matching sha256', { [IMAGE]: deterministicCardEvidence('f'.repeat(64)) }, IMAGE_BYTES],
  ])('does not accept a deterministic-card sha when it is %s', (_label, generated, bytes) => {
    const root = fixture();
    addGeneratedEvidence(root);
    fs.writeFileSync(path.join(root, 'public/images/blog/new-cover.webp'), bytes);
    const evidencePath = path.join(root, 'data/published-blog-generated-image-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.generated = generated;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-generated-image-registry.json'), `${JSON.stringify({
      schema: 1,
      cdnPrefix: '/images/blog/',
      assetCount: 1,
      assets: [generatedRecord()],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'data/blog-cover-replacements.json'), `${JSON.stringify({ schema: 1, items: {} })}\n`);

    execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/generated record sha256\/bytes do not match|published registry sha256\/bytes do not match/);
  });

  it('backfills inferred covers and leaves a sha256 mismatch explicitly inferred', () => {
    const root = fixture();
    addGeneratedEvidence(root, 'f'.repeat(64));
    const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.covers['new-cover'] = {
      cover: IMAGE,
      hash: sha256(IMAGE_BYTES),
      published: true,
      historicalPublished: true,
      references: [],
      proofLevel: 6,
      evidence: 'inferred',
      recordFile: null,
      action: 'record-inferred',
      reason: 'Copertina senza prova certa.',
      verifiedAt: '2026-10-06',
      provider: null,
      currentlyPublished: true,
      status: 'no-credit',
    };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const indexPath = path.join(root, 'data/image-credits-blog.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.covers['new-cover'] = { evidence: 'inferred', provider: null, verifiedAt: '2026-10-06', status: 'no-credit' };
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    const output = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
    });
    const result = JSON.parse(output);
    const updatedLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

    expect(result.generatedEvidenceMismatches).toContainEqual(expect.objectContaining({
      key: 'new-cover',
      expectedSha256: 'f'.repeat(64),
      actualSha256: sha256(IMAGE_BYTES),
    }));
    expect(result.generatedBackfilledKeys).toEqual([]);
    expect(updatedLedger.covers['new-cover']).toMatchObject({
      proofLevel: 6,
      evidence: 'inferred',
      action: 'record-inferred',
      status: 'no-credit',
    });
  });

  it.each(['missing', 'rejected', 'mismatch'] as const)(
    'demotes an existing generated cover when pinned evidence is %s',
    (failure) => {
      const root = fixture();
      addGeneratedEvidence(root);
      const firstRun = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
      }));
      expect(firstRun.generatedAddedKeys).toEqual(['new-cover']);

      const snapshotPath = path.join(root, 'data/published-blog-generated-image-evidence.json');
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (failure === 'missing') {
        snapshot.generated = {};
      } else if (failure === 'rejected') {
        snapshot.generated[IMAGE].assetId = 'different-cover';
      } else {
        const mismatchedSha = 'f'.repeat(64);
        snapshot.generated[IMAGE].sha256 = mismatchedSha;
        const creditPath = path.join(root, 'packages/articles/content/image-credits/blog/new-cover.json');
        const credit = JSON.parse(fs.readFileSync(creditPath, 'utf8'));
        credit.generated.sha256 = mismatchedSha;
        fs.writeFileSync(creditPath, `${JSON.stringify(credit, null, 2)}\n`);
      }
      fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

      const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ARTICLES_SYNC_COMMIT: SOURCE_COMMIT },
      }));
      const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-ledger.json'), 'utf8'));
      const index = JSON.parse(fs.readFileSync(path.join(root, 'data/image-credits-blog.json'), 'utf8'));

      expect(output.demotedGeneratedKeys).toEqual(['new-cover']);
      expect(ledger.covers['new-cover']).toMatchObject({
        proofLevel: 6,
        evidence: 'inferred',
        recordFile: null,
        action: 'record-inferred',
        status: 'no-credit',
      });
      expect(ledger.covers['new-cover'].generated).toBeUndefined();
      expect(index.covers['new-cover']).toMatchObject({ evidence: 'inferred', status: 'no-credit' });
      expect(index.covers['new-cover'].file).toBeUndefined();
      expect(index.files).not.toHaveProperty('generated:new-cover');

      if (failure === 'missing') expect(output.generatedEvidenceMissing).toEqual([{ key: 'new-cover' }]);
      if (failure === 'rejected') expect(output.generatedEvidenceRejected).toEqual([expect.objectContaining({ key: 'new-cover' })]);
      if (failure === 'mismatch') expect(output.generatedEvidenceMismatches).toEqual([expect.objectContaining({ key: 'new-cover' })]);
    },
  );

  it('fails closed without changing either file when a published cover blob is unavailable', () => {
    const root = fixture({ withImage: false });
    const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
    const indexPath = path.join(root, 'data/image-credits-blog.json');
    const beforeLedger = fs.readFileSync(ledgerPath, 'utf8');
    const beforeIndex = fs.readFileSync(indexPath, 'utf8');
    const baselinePath = path.join(root, 'data/blog-cover-corpus-baseline.json');
    const beforeBaseline = fs.readFileSync(baselinePath, 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Published cover blob is unavailable');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(beforeLedger);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
    expect(fs.readFileSync(baselinePath, 'utf8')).toBe(beforeBaseline);
  });
});
