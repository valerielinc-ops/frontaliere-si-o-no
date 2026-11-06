import { describe, expect, it } from 'vitest';
import {
  extractAltamirawebListingCandidates,
  extractApplytojobListingCandidates,
  platformFamilyDetailTemplateFor,
  platformFamilyVersionFor,
  platformListingExtractorFor,
} from '../scripts/lib/prospector/platform-extractors.mjs';
import { productionRuntimeOptionsFor } from '../scripts/lib/prospector/source-adapters.mjs';
import { crawlerKeyFor } from '../scripts/lib/prospector/synthesize.mjs';

describe('prospector hosted-platform listing extractors', () => {
  it('extracts only explicit same-tenant Applytojob vacancy links', () => {
    const html = `
      <a href="/apply/ux3bgeq4hG/Optometrist">Optometrist</a>
      <a href="/apply/ux3bgeq4hG/Optometrist">duplicate</a>
      <a href="/apply/short/Too-short-id">too short</a>
      <a href="/apply">board</a>
      <a href="https://other.applytojob.com/apply/abc123456/Other">other tenant</a>
      <a href="https://example.test/apply/abc123456/External">external</a>
    `;

    expect(extractApplytojobListingCandidates(
      html,
      'https://2020onsite.applytojob.com/apply',
    )).toEqual([{
      title: 'Optometrist',
      url: 'https://2020onsite.applytojob.com/apply/ux3bgeq4hG/Optometrist',
      sourceUrl: 'https://2020onsite.applytojob.com/apply/ux3bgeq4hG/Optometrist',
      urlExplicit: true,
      via: 'known-template',
    }]);
  });

  it('extracts numeric JobID links from Altamira query-only detail URLs', () => {
    const html = `
      <a href="/annunci-lavoro/job-details?JobID=278458360">AI Software Engineer</a>
      <a href="/annunci-lavoro/job-details?JobID=278458360&amp;lang=it">duplicate id</a>
      <a href="/annunci-lavoro/Operativo-Trasporti-Terra-Trasporti-Chiasso-693485366.htm">Operativo Trasporti Terra</a>
      <a href="/annunci-lavoro/job-details?JobID=abc">not a job</a>
      <a href="/annunci-lavoro/job-details">listing page</a>
      <a href="https://other.altamiraweb.com/annunci-lavoro/job-details?JobID=278458361">other tenant</a>
    `;

    expect(extractAltamirawebListingCandidates(
      html,
      'https://euris.altamiraweb.com/',
    )).toEqual([
      {
        title: 'AI Software Engineer',
        url: 'https://euris.altamiraweb.com/annunci-lavoro/job-details?JobID=278458360',
        sourceUrl: 'https://euris.altamiraweb.com/annunci-lavoro/job-details?JobID=278458360',
        urlExplicit: true,
        via: 'known-template',
      },
      {
        title: 'Operativo Trasporti Terra',
        url: 'https://euris.altamiraweb.com/annunci-lavoro/Operativo-Trasporti-Terra-Trasporti-Chiasso-693485366.htm',
        sourceUrl: 'https://euris.altamiraweb.com/annunci-lavoro/Operativo-Trasporti-Terra-Trasporti-Chiasso-693485366.htm',
        urlExplicit: true,
        via: 'known-template',
      },
    ]);
  });

  it('routes family extractors by platform and keeps versions stable', () => {
    expect(platformFamilyVersionFor('applytojob.com')).toBe('applytojob-family-v1');
    expect(platformFamilyVersionFor('euris.altamiraweb.com')).toBe('altamiraweb-family-v1');
    expect(platformFamilyDetailTemplateFor('applytojob.com')).toBe('/apply/*/*');
    expect(platformFamilyDetailTemplateFor('altamiraweb.com')).toBe('/annunci-lavoro/*');
    expect(platformListingExtractorFor('unrelated.example')).toBeNull();
    expect(productionRuntimeOptionsFor({ platform: 'applytojob.com' })?.listingExtractor)
      .toBe(extractApplytojobListingCandidates);
    expect(productionRuntimeOptionsFor({ platform: 'altamiraweb.com' })?.listingExtractor)
      .toBe(extractAltamirawebListingCandidates);
    expect(crawlerKeyFor({
      name: 'Acme SA',
      domain: 'acme.ch',
      tenantHost: 'vendor-label.applytojob.com',
    })).toBe('acme-sa');
  });
});
