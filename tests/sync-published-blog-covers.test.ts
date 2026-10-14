import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/audit/sync-published-blog-covers.mjs');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts/ci/verify-blog-cover-ledger.mjs');
const roots: string[] = [];
const SOURCE_COMMIT = 'a'.repeat(40);
const IMAGE = '/images/blog/new-cover.webp';
const IMAGE_BYTES = Buffer.from('cover-bytes');

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function generatedRecord(sha = sha256(IMAGE_BYTES)) {
  return {
    schema: 1,
    assetId: 'new-cover',
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
    bytes: IMAGE_BYTES.length,
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
    imageUrl: IMAGE,
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

function addGeneratedEvidence(root: string, sha?: string) {
  const generated = generatedRecord(sha);
  fs.writeFileSync(path.join(root, 'data/published-blog-generated-image-evidence.json'), `${JSON.stringify({
    schema: 1,
    commit: SOURCE_COMMIT,
    generated: { [generated.imageUrl]: generated },
  }, null, 2)}\n`);
  const recordPath = path.join(root, 'packages/articles/content/image-credits/blog/new-cover.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(generatedCreditRecord(generated), null, 2)}\n`);
}

function fixture({ withImage = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-blog-covers-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'packages/articles/content'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/images/blog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/articles/content/blog-articles-data.ts'), `export const ARTICLES = [
  {
    id: 'new-cover',
    category: 'news',
    date: '2026-10-07T10:00:00.000Z',
    updatedAt: null,
    image: '/images/blog/new-cover.webp',
    authorSlug: 'redazione',
  },
];\n`);
  fs.writeFileSync(path.join(root, 'packages/articles/content/swiss-articles-data.ts'), 'export const ARTICLES = [];\n');
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
  if (withImage) fs.writeFileSync(path.join(root, 'public/images/blog/new-cover.webp'), IMAGE_BYTES);
  return root;
}

function clearPublishedArticleCovers(root: string) {
  fs.writeFileSync(path.join(root, 'packages/articles/content/blog-articles-data.ts'), 'export const ARTICLES = [];\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync-published-blog-covers', () => {
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
