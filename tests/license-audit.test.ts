import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALARM_TITLE,
  auditEventImages,
  auditEventSourceSlices,
  auditHistoryResidue,
  auditOgImageSample,
  auditOtherImages,
  auditRemovedCdnPrefixes,
  auditTextPublication,
  applyLicenseReplacements,
  buildForcedReplacementCandidates,
  buildAlarmRequest,
  buildGenerationSpec,
  classifyEventImage,
  classifyPublishedImage,
  parseFuelBrandLogoReferences,
  parseReplacementUrls,
  planReplacements,
} from '../scripts/audit/license-audit.mjs';
import { syncCorpusBlogCovers } from '../scripts/audit/sync-corpus-blog-covers.mjs';

const ROOT = process.cwd();
const temporaryRoots: string[] = [];

function tempRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'license-audit-test-'));
  temporaryRoots.push(directory);
  return directory;
}

function generatedFixture() {
  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'data', 'event-image-library.json'),
    'utf8',
  ));
  return registry.assets[0];
}

afterEach(() => {
  while (temporaryRoots.length) {
    const directory = temporaryRoots.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('license audit A — event image sources', () => {
  it('passes a governed library image and an explicitly licensed OpenAgenda image', () => {
    const libraryRecord = generatedFixture();
    const libraryEvent = {
      id: 'fixture:library',
      sourceKey: 'myswitzerland',
      imageUrl: libraryRecord.imageUrl,
    };
    const licensedEvent = {
      id: 'fixture:openagenda',
      sourceKey: 'openagenda',
      imageUrl: 'https://example.test/openagenda.webp',
      imageLicense: 'Licence Ouverte 2.0',
    };
    expect(classifyEventImage({
      event: libraryEvent,
      eventRegistryByUrl: new Map([[libraryRecord.imageUrl, { record: libraryRecord, valid: true, errors: [] }]]),
    }).valid).toBe(true);
    expect(classifyEventImage({ event: licensedEvent }).valid).toBe(true);
  });

  it('validates the governed library before inspecting removed-source prefixes', () => {
    const libraryRecord = {
      ...generatedFixture(),
      assetId: 'audit-event-tio-agenda-old-item',
      imageUrl: '/images/events/library/audit-event-tio-agenda-old-item.webp',
    };
    const result = classifyEventImage({
      event: {
        id: 'fixture:governed-legacy-name',
        sourceKey: 'tio-agenda',
        imageUrl: libraryRecord.imageUrl,
      },
      eventRegistryByUrl: new Map([[libraryRecord.imageUrl, {
        record: libraryRecord,
        valid: true,
        errors: [],
      }]]),
    });
    expect(result).toMatchObject({ status: 'ok', valid: true });
  });

  it('fails an excluded source URL and a source slice that emits it', () => {
    const event = {
      id: 'fixture:removed',
      sourceKey: 'myswitzerland',
      imageUrl: '/images/events/myswitzerland-old.webp',
    };
    expect(classifyEventImage({ event }).valid).toBe(false);
    const audit = auditEventSourceSlices({
      root: ROOT,
      slices: [{ file: path.join(ROOT, 'data/events/by-source/myswitzerland.json'), value: { events: [event] } }],
    });
    expect(audit.control.status).toBe('fail');
    expect(audit.control.examples[0].sourceKey).toBe('myswitzerland');
  });

  it('fails the crawler control when an excluded source bypasses the gate', () => {
    const audit = auditEventImages({
      events: [],
      crawlerFindings: [{ file: 'scripts/crawl-fixture-events.mjs', sourceKey: 'fixture' }],
    });
    expect(audit.controls.find((control) => control.id === 'A.crawler-image-policy')?.status).toBe('fail');
  });
});

describe('license audit B — published image records', () => {
  it('classifies valid, inferred, missing and unlicensed records deterministically', () => {
    expect(classifyPublishedImage({
      family: 'blog',
      url: '/images/blog/ok.webp',
      record: { source: 'wikimedia-commons' },
      recordValid: true,
    }).status).toBe('ok');
    expect(classifyPublishedImage({
      family: 'blog',
      url: '/images/blog/inferred.webp',
      inferred: true,
    }).status).toBe('inferred');
    const missing = classifyPublishedImage({
      family: 'places',
      url: '/images/places/missing.webp',
    });
    expect(missing.status).toBe('senza record');
    expect(missing.autoRepairable).toBe(true);
    expect(classifyPublishedImage({
      family: 'brands',
      url: '/images/brands/unregistered.svg',
      sourceRegistered: false,
    }).status).toBe('senza record');
    expect(classifyPublishedImage({
      family: 'publisher',
      url: '/images/publisher/logo-square-512.png',
      sourceRegistered: true,
    }).status).toBe('senza record');
  });

  it('inherits a blog hero ledger record for its published thumbnail', () => {
    const key = '139-frontalieri-ticino-special-olympics';
    const audit = auditOtherImages({
      root: ROOT,
      publicFiles: [
        `public/images/blog/${key}.webp`,
        `public/images/blog/thumbnails/${key}-480w.webp`,
      ],
      registries: { shared: { assets: [] }, blog: { assets: [] } },
      ledger: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-cover-ledger.json'), 'utf8')),
      blogKeys: new Set([key]),
    });
    const thumbnail = audit.inventory.find((row) => row.url.includes('/thumbnails/'));
    expect(thumbnail?.status).toBe('inferred');
    expect(thumbnail?.status).not.toBe('orfano');
    expect(audit.candidates).toHaveLength(0);
  });

  it('keeps real-author photos out of the replacement candidate set', () => {
    const audit = auditOtherImages({
      root: ROOT,
      publicFiles: ['public/images/authors/samuele-valente.webp'],
      registries: { shared: { assets: [] }, blog: { assets: [] } },
      authorsByPath: new Map([['/images/authors/samuele-valente.webp', {
        slug: 'samuele-valente',
        kind: 'real-author',
      }]]),
    });
    expect(audit.candidates).toHaveLength(0);
    expect(audit.controls.find((control) => control.id === 'B.real-author-protection')?.counts.realAuthorFiles).toBe(1);
  });

  it('keeps the logo-source inventory separate from auto-repair', () => {
    const audit = auditOtherImages({
      root: ROOT,
      publicFiles: ['public/images/brands/unregistered.svg'],
      registries: { shared: { assets: [] }, blog: { assets: [] } },
      references: new Set(['/images/brands/unregistered.svg']),
    });
    expect(audit.controls.find((control) => control.id === 'B.logo-source-inventory')?.status).toBe('fail');
    expect(audit.candidates).toHaveLength(0);
  });

  it('teaches the logo inventory about dynamic fuel-station slugs and marks unused files as warnings', () => {
    const dynamic = parseFuelBrandLogoReferences(ROOT);
    expect(dynamic.references.size).toBe(18);
    expect(dynamic.references).toContain('/images/brands/agipeni.svg');
    expect(dynamic.references).toContain('/images/brands/cooppronto.svg');
    expect(dynamic.evidence.get('/images/brands/agipeni.svg')).toContain('data fuel brand');

    const audit = auditOtherImages({
      root: ROOT,
      publicFiles: [
        'public/images/brands/agipeni.svg',
        'public/images/brands/agip.svg',
      ],
      registries: { shared: { assets: [] }, blog: { assets: [] } },
      references: new Set(['/images/brands/agipeni.svg']),
      sourceRegisteredLogoPaths: new Set(['/images/brands/agipeni.svg']),
      sourceRegisteredLogoEvidence: new Map([
        ['/images/brands/agipeni.svg', dynamic.evidence.get('/images/brands/agipeni.svg')],
      ]),
    });
    const used = audit.inventory.find((row) => row.url === '/images/brands/agipeni.svg');
    const unused = audit.inventory.find((row) => row.url === '/images/brands/agip.svg');
    expect(used).toMatchObject({ status: 'ok', reason: expect.stringContaining('dynamic fuel-station brand reference') });
    expect(unused).toMatchObject({ status: 'inutilizzato', valid: true });
    expect(audit.controls.find((control) => control.id === 'B.logo-source-inventory')).toMatchObject({
      status: 'warn',
      counts: { used: 1, registered: 1, unused: 1, withoutRegisteredSource: 0 },
    });
  });
});

describe('license audit C — text gates', () => {
  it('passes a complete rewrite gate and fails the reused publication gate', () => {
    const pass = auditTextPublication({
      events: [{ id: 'e1', description: 'Riscrittura' }],
      rewriteCache: {
        entries: {
          e1: { rewrittenAt: '2026-10-07', description: 'Riscrittura', descriptionByLocale: { it: 'Riscrittura' } },
        },
      },
      descriptionGate: { ok: true, details: {} },
      articleCopyMetrics: { file: 'fixture', value: { ok: true, violations: 0 } },
    });
    expect(pass.controls.find((control) => control.id === 'C.event-description-publication')?.status).toBe('pass');
    const fail = auditTextPublication({
      events: [{ id: 'e1', description: 'Fonte non riscritta' }],
      rewriteCache: { entries: { e1: {} } },
      descriptionGate: { ok: false, details: { errorCount: 1 } },
    });
    expect(fail.controls.find((control) => control.id === 'C.event-description-publication')?.status).toBe('fail');
    expect(fail.controls.find((control) => control.id === 'C.description-rewrite-queue')?.status).toBe('fail');
    const metricFail = auditTextPublication({
      events: [],
      rewriteCache: { entries: {} },
      descriptionGate: { ok: true, details: {} },
      articleCopyMetrics: { file: 'fixture', value: { ok: false, violations: 1 } },
    });
    expect(metricFail.controls.find((control) => control.id === 'C.article-anti-copy-metrics')?.status).toBe('fail');
  });
});

describe('license audit D — copies and CDN', () => {
  it('passes an empty event-path inventory and fails when a legacy path remains', () => {
    const pass = auditHistoryResidue({ root: ROOT, mainRef: 'HEAD', refs: ['HEAD'], treeFiles: [] });
    expect(pass.controls.find((control) => control.id === 'D.origin-main-event-path')?.status).toBe('pass');
    const fail = auditHistoryResidue({
      root: ROOT,
      mainRef: 'HEAD',
      refs: ['HEAD'],
      treeFiles: ['public/images/events/legacy.webp'],
    });
    expect(fail.controls.find((control) => control.id === 'D.origin-main-event-path')?.status).toBe('fail');
    const markerFail = auditHistoryResidue({ root: ROOT, mainRef: 'HEAD', refs: ['HEAD'], marker: 'HEAD', treeFiles: [] });
    expect(markerFail.controls.find((control) => control.id === 'D.history-marker')?.status).toBe('fail');
  });

  it('raises an alarm when a removed CDN prefix answers with HTTP 200', async () => {
    const control = await auditRemovedCdnPrefixes({
      probe: true,
      fetchImpl: async () => ({ status: 200 }),
      r2Lister: () => ({ available: true, keys: [], failures: [] }),
    });
    expect(control.status).toBe('fail');
    expect(control.alarm).toBe(true);
    const pass = await auditRemovedCdnPrefixes({
      probe: true,
      fetchImpl: async () => ({ status: 404 }),
      r2Lister: () => ({ available: true, keys: [], failures: [] }),
    });
    expect(pass.status).toBe('pass');
  });
});

describe('license audit B — og:image sample', () => {
  it('passes a registered OG image and fails an unregistered one', () => {
    const root = tempRoot();
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<meta property="og:image" content="/images/blog/known.webp">');
    expect(auditOgImageSample({ dist, knownUrls: new Set(['/images/blog/known.webp']) }).status).toBe('pass');
    fs.writeFileSync(path.join(dist, 'index.html'), '<meta property="og:image" content="/images/blog/unknown.webp">');
    expect(auditOgImageSample({ dist, knownUrls: new Set(['/images/blog/known.webp']) }).status).toBe('fail');
  });
});

describe('license audit replacement invariants', () => {
  it('validates manual replacement paths, prioritises them, and protects real-author photos', () => {
    const validUrl = '/images/blog/old-inferred-cover.webp';
    expect(parseReplacementUrls(`${validUrl}\n/images/places/lugano-centro.webp`)).toEqual([
      validUrl,
      '/images/places/lugano-centro.webp',
    ]);
    expect(() => parseReplacementUrls('/images/publisher/logo-square-512.png')).toThrow(/invalid replacement URL/);
    expect(() => parseReplacementUrls(`${validUrl},${validUrl}`)).toThrow(/duplicate replacement URL/);
    expect(() => parseReplacementUrls(Array.from({ length: 6 }, (_, index) => `/images/blog/cover-${index + 10}.webp`))).toThrow(/at most 5/);

    const forced = buildForcedReplacementCandidates({
      replaceUrls: validUrl,
      inventory: [{
        family: 'blog',
        url: validUrl,
        referenced: true,
        status: 'inferred',
        autoRepairable: false,
        priority: 1,
      }],
      ledger: { covers: { 'old-inferred-cover': { priority: 1 } } },
    });
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ imageUrl: validUrl, forced: true, autoRepairable: true });
    expect(planReplacements([
      { ...forced[0], priority: 1 },
      { kind: 'article-hero', assetId: 'automatic', imageUrl: '/images/blog/automatic.webp', autoRepairable: true, priority: 9 },
    ], 1).selected[0].forced).toBe(true);
    expect(planReplacements([
      { ...forced[0], priority: 1 },
      { kind: 'article-hero', assetId: 'duplicate', imageUrl: validUrl, autoRepairable: true, priority: 9 },
    ], 5).selected).toHaveLength(1);

    expect(() => buildForcedReplacementCandidates({
      replaceUrls: '/images/authors/samuele-valente.webp',
      inventory: [{
        family: 'authors',
        url: '/images/authors/samuele-valente.webp',
        referenced: true,
        autoRepairable: false,
        protectedRealAuthor: true,
      }],
      authorsByPath: new Map([['/images/authors/samuele-valente.webp', { kind: 'real-author' }]]),
    })).toThrow(/real-author/);
  });

  it('copies an audited blog hero and thumbnail into the corpus with the same governed record', () => {
    const siteRoot = tempRoot();
    const corpusRoot = tempRoot();
    const key = 'sync-fixture-cover';
    const imageUrl = `/images/blog/${key}.webp`;
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-generated-image-registry.json'), 'utf8')).assets[0];
    const record = { ...base, assetId: key, imageUrl };
    fs.mkdirSync(path.join(siteRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(siteRoot, 'public/images/blog/thumbnails'), { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'data/blog-generated-image-registry.json'), JSON.stringify({ schema: 1, assets: [record] }));
    fs.writeFileSync(path.join(siteRoot, `public${imageUrl}`), 'new-hero-bytes');
    fs.writeFileSync(path.join(siteRoot, `public/images/blog/thumbnails/${key}-480w.webp`), 'new-thumbnail-bytes');
    fs.mkdirSync(path.join(corpusRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(corpusRoot, 'data/generated-image-registry.json'), JSON.stringify({
      schema: 1,
      assetCount: 0,
      assets: [],
    }));

    const result = syncCorpusBlogCovers({
      report: { actions: { generated: [{ kind: 'article-hero', assetId: key, imageUrl }] } },
      siteRoot,
      corpusRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(fs.readFileSync(path.join(corpusRoot, `public${imageUrl}`), 'utf8')).toBe('new-hero-bytes');
    expect(fs.readFileSync(path.join(corpusRoot, `public/images/blog/thumbnails/${key}-480w.webp`), 'utf8')).toBe('new-thumbnail-bytes');
    const registry = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'data/generated-image-registry.json'), 'utf8'));
    expect(registry.assetCount).toBe(1);
    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]).toMatchObject({ assetId: key, imageUrl });
  });

  it('preserves the assigned article URL and never repoints to another content item', () => {
    const candidate = {
      kind: 'article-hero',
      scope: 'article-hero',
      key: 'fixture-article',
      assetId: 'fixture-article',
      imageUrl: '/images/blog/fixture-article.webp',
      autoRepairable: true,
    };
    const spec = buildGenerationSpec(candidate);
    expect(spec.publishedImageUrl).toBe(candidate.imageUrl);
    expect(candidate.imageUrl).toBe('/images/blog/fixture-article.webp');
  });

  it('enforces the run cap and protects a real author', () => {
    const candidates = [
      { kind: 'article-hero', assetId: 'a', imageUrl: '/images/blog/a.webp', autoRepairable: true, priority: 3 },
      { kind: 'article-hero', assetId: 'b', imageUrl: '/images/blog/b.webp', autoRepairable: true, priority: 2 },
      { kind: 'editorial-profile', assetId: 'real', imageUrl: '/images/authors/real.webp', autoRepairable: true, protectedRealAuthor: true, priority: 9 },
    ];
    const plan = planReplacements(candidates, 1);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].assetId).toBe('a');
    expect(plan.deferred).toHaveLength(1);
  });

  it('uses one stable alarm request for every recurring failure', () => {
    const request = buildAlarmRequest({ alarm: { required: true } });
    expect(request?.title).toBe(ALARM_TITLE);
    expect(request?.workflow).toBe('license-audit');
    expect(buildAlarmRequest({ alarm: { required: false } })).toBeNull();
  });

  it('writes a generated article record at the same URL with an injected generator', async () => {
    const root = tempRoot();
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-generated-image-registry.json'), 'utf8')).assets[0];
    const generated = {
      ...base,
      assetId: 'fixture-article',
      imageUrl: '/images/blog/fixture-article.webp',
      variant: 'license-audit-test',
    };
    const result = await applyLicenseReplacements({
      root,
      candidates: [{
        kind: 'article-hero',
        scope: 'article-hero',
        key: 'fixture-article',
        assetId: 'fixture-article',
        imageUrl: '/images/blog/fixture-article.webp',
        autoRepairable: true,
      }],
      limit: 1,
      outputDir: path.join(root, '.cache/license-audit'),
      generator: async (_spec, options) => {
        const filePath = path.join(options.outputDir, 'fixture-article.webp');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'fixture');
        return { filePath, record: generated };
      },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.generated[0].imageUrl).toBe('/images/blog/fixture-article.webp');
    const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-replacements.json'), 'utf8'));
    expect(queue.items['fixture-article'].fromCover).toBe(queue.items['fixture-article'].toCover);
  });

  it('routes a removed event source to a unique governed event-library record and reuses it', async () => {
    const root = tempRoot();
    const oldEvent = {
      id: 'tio:agenda:old-item',
      sourceKey: 'tio-agenda',
      title: 'Fixture event',
      category: 'sport',
      canton: 'TI',
      startDate: '2026-01-10',
      imageUrl: '/images/events/tio-agenda-old.webp',
    };
    fs.mkdirSync(path.join(root, 'data', 'events', 'by-source'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'events.json'), JSON.stringify({ events: [oldEvent] }));
    fs.writeFileSync(
      path.join(root, 'data', 'events', 'by-source', 'tio-agenda.json'),
      JSON.stringify({ events: [oldEvent] }),
    );
    fs.copyFileSync(
      path.join(ROOT, 'data', 'event-image-library.json'),
      path.join(root, 'data', 'event-image-library.json'),
    );

    const initial = auditEventImages({ events: [oldEvent], eventRegistry: { assets: [] } });
    const candidate = initial.candidates[0];
    expect(candidate.imageUrl).toMatch(/^\/images\/events\/library\/audit-event-tio-agenda-old-item-[a-z0-9]+\.webp$/);
    expect(candidate.imageUrl).not.toBe(oldEvent.imageUrl);

    const base = generatedFixture();
    const generated = {
      ...base,
      assetId: candidate.assetId,
      imageUrl: candidate.imageUrl,
      sha256: 'f'.repeat(64),
      category: candidate.category,
      area: candidate.area,
      season: candidate.season,
      variant: 'license-audit-test',
    };
    const result = await applyLicenseReplacements({
      root,
      candidates: [candidate],
      limit: 1,
      outputDir: path.join(root, '.cache/license-audit'),
      generator: async (_spec, options) => {
        const filePath = path.join(options.outputDir, candidate.assetId + '.webp');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'fixture');
        return { filePath, record: generated };
      },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.generated[0].imageUrl).toBe(candidate.imageUrl);

    const updatedDataset = JSON.parse(fs.readFileSync(path.join(root, 'data', 'events.json'), 'utf8'));
    const updatedSlice = JSON.parse(fs.readFileSync(
      path.join(root, 'data', 'events', 'by-source', 'tio-agenda.json'),
      'utf8',
    ));
    expect(updatedDataset.events[0].imageUrl).toBe(candidate.imageUrl);
    expect(updatedSlice.events[0].imageUrl).toBe(candidate.imageUrl);
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'data', 'event-image-library.json'), 'utf8'));
    const reAudit = auditEventImages({ events: updatedDataset.events, eventRegistry: registry });
    expect(reAudit.controls.find((control) => control.id === 'A.events-published-images')?.status).toBe('pass');
    expect(auditEventSourceSlices({
      root,
      slices: [{ file: 'tio-agenda.json', value: updatedSlice }],
      eventRegistry: registry,
    }).control.status).toBe('pass');

    let generatorCalls = 0;
    const reused = await applyLicenseReplacements({
      root,
      candidates: [{ ...candidate, existingRecord: generated }],
      limit: 1,
      generator: async () => {
        generatorCalls += 1;
        throw new Error('existing governed record should be reused');
      },
    });
    expect(generatorCalls).toBe(0);
    expect(reused.reused[0].imageUrl).toBe(candidate.imageUrl);
  });
});
