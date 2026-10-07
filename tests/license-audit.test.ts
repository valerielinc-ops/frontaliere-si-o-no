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
  buildAlarmRequest,
  buildGenerationSpec,
  classifyEventImage,
  classifyPublishedImage,
  planReplacements,
} from '../scripts/audit/license-audit.mjs';

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
    });
    expect(audit.controls.find((control) => control.id === 'B.logo-source-inventory')?.status).toBe('fail');
    expect(audit.candidates).toHaveLength(0);
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
});
