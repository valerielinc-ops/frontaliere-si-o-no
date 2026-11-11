import { describe, expect, it } from 'vitest';
import {
  EXPIRED_JOB_EDGE_SCHEMA_VERSION,
  EXPIRED_JOB_EDGE_SHARD_COUNT,
  EXPIRED_JOB_EDGE_DATASET_PREFIX,
  expiredJobEdgeShardId,
  isExpiredJobEdgeManifestUsable,
  isExpiredJobEdgeShardUsable,
  normalizeExpiredJobEdgePath,
  parseExpiredJobEdgeSections,
  renderExpiredJobEdgeHtml,
} from '../scripts/lib/expired-job-edge-dataset.mjs';

const template = `<!doctype html><html lang="en"><head>
<title>__FT_EDGE_TITLE__</title>
<meta property="og:title" content="__FT_EDGE_SOCIAL_TITLE__">
<meta name="description" content="__FT_EDGE_DESCRIPTION__">
<meta property="og:description" content="__FT_EDGE_SOCIAL_DESCRIPTION__">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="https://frontaliereticino.ch/__FT_EDGE_CANONICAL_PATH__">
__FT_EDGE_HREFLANG__
__FT_EDGE_JSONLD__
<script>window.__EXPIRED_JOB_DATA__=__FT_EDGE_DATA__;</script>
__FT_EDGE_AD_SNIPPET__
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
</head><body>__FT_EDGE_BODY__</body></html>`;

describe('expired job edge dataset contracts', () => {
  it('normalizes tracked paths to trailing slash and stable bounded shard IDs', () => {
    expect(normalizeExpiredJobEdgePath('https://frontaliereticino.ch/en/find-jobs-zurich/job?ref=mail'))
      .toBe('/en/find-jobs-zurich/job/');
    expect(expiredJobEdgeShardId('/en/find-jobs-zurich/job')).toMatch(/^[0-9a-f]{2}$/);
    expect(expiredJobEdgeShardId('/en/find-jobs-zurich/job/'))
      .toBe(expiredJobEdgeShardId('/en/find-jobs-zurich/job/'));
    expect(EXPIRED_JOB_EDGE_SHARD_COUNT).toBe(128);
  });

  it('parses section rollout values as a safe exact-match allowlist', () => {
    expect(parseExpiredJobEdgeSections('zurigo, BERNA, zurigo, bad/value, ,')).toEqual(['zurigo', 'berna']);
    expect(parseExpiredJobEdgeSections(undefined as unknown as string)).toEqual([]);
  });

  it('rejects incomplete or mismatched manifest and shard data', () => {
    const shardId = expiredJobEdgeShardId('/en/find-jobs-zurich/job/');
    const manifest = {
      version: EXPIRED_JOB_EDGE_SCHEMA_VERSION,
      datasetPrefix: EXPIRED_JOB_EDGE_DATASET_PREFIX,
      locale: 'en',
      generation: 'build-123',
      activeSections: ['zurigo'],
      shardCount: EXPIRED_JOB_EDGE_SHARD_COUNT,
      shardIds: [shardId],
      coverage: { complete: true },
      template,
      adSnippetHtml: '<script>adsbygoogle</script>',
    };
    expect(isExpiredJobEdgeManifestUsable(manifest, 'en')).toBe(true);
    expect(isExpiredJobEdgeManifestUsable({ ...manifest, coverage: { complete: false } }, 'en')).toBe(false);
    expect(isExpiredJobEdgeManifestUsable({ ...manifest, shardIds: [shardId, shardId] }, 'en')).toBe(false);
    expect(isExpiredJobEdgeManifestUsable({ ...manifest, datasetPrefix: '/other-prefix' }, 'en')).toBe(false);
    expect(isExpiredJobEdgeManifestUsable(manifest, 'de')).toBe(false);

    const shard = {
      version: EXPIRED_JOB_EDGE_SCHEMA_VERSION,
      locale: 'en',
      generation: 'build-123',
      shardId,
      coverage: { complete: true },
      pages: {},
    };
    expect(isExpiredJobEdgeShardUsable(shard, { locale: 'en', generation: 'build-123', shardId })).toBe(true);
    expect(isExpiredJobEdgeShardUsable({ ...shard, coverage: { complete: false } }, { locale: 'en', generation: 'build-123', shardId })).toBe(false);
  });

  it('renders a noindex soft landing with active-job links, alternates and no JobPosting', () => {
    const html = renderExpiredJobEdgeHtml(template, {
      slug: 'job',
      canonicalPath: '/en/find-jobs-zurich/job',
      title: 'Engineer <Research>',
      pageTitle: 'Engineer at Example & Co',
      socialTitle: 'Engineer at Example & Co',
      metaDescription: 'Expired listing',
      socialDescription: 'Archived listing',
      employer: 'Example & Co',
      place: 'Zürich',
      canton: 'ZH',
      expiredAt: '2026-10-01',
      expiredMessage: 'This listing has expired.',
      similarHeading: 'Other active positions',
      hasTrafficAdSnippet: true,
      boardUrl: 'https://frontaliereticino.ch/en/find-jobs-zurich/',
      similarActiveJobs: [{
        href: '/en/find-jobs-zurich/active-role',
        title: 'Active <Engineer>',
        employer: 'Live GmbH',
        place: 'Zürich',
      }],
      alternates: [
        { locale: 'en', href: '/en/find-jobs-zurich/job/' },
        { locale: 'it', href: '/cerca-lavoro-zurigo/job/' },
        { locale: 'fr', href: 'https://example.com/offsite/' },
      ],
      breadcrumbs: [{ name: 'Home', href: '/' }, { name: 'Jobs in Zurich', href: '/en/find-jobs-zurich/' }],
      titleByLocale: { en: 'Engineer <Research>' },
      slugByLocale: { en: 'job' },
    }, 'en', '<script>adsbygoogle</script>');

    expect(html).toContain('<meta name="robots" content="noindex, follow">');
    expect(html).toContain('<title>Engineer at Example &amp; Co</title>');
    expect(html).toContain('content="Engineer at Example &amp; Co"');
    expect(html).toContain('content="Archived listing"');
    expect(html).toContain('href="https://frontaliereticino.ch/en/find-jobs-zurich/job/"');
    expect(html).toContain('hreflang="it"');
    expect(html).not.toContain('example.com/offsite');
    expect(html).toContain('https://frontaliereticino.ch/en/find-jobs-zurich/active-role/');
    expect(html).toContain('Other active positions');
    expect(html).toContain('adsbygoogle</script>');
    expect(html).toContain('adsbygoogle.js');
    expect(html).toContain('googletagmanager.com/gtag/js');
    expect(html).not.toContain('JobPosting');
    expect(html).not.toContain('__FT_EDGE_');
  });
});
