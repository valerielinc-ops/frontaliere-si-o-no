import { describe, expect, it } from 'vitest';
import {
  isMticDetailPublishable,
  isMticTrustedUrl,
  parseMticDetailPage,
  parseMticListingPage,
} from '../scripts/lib/mtic-job-parser.mjs';

describe('MTIC listing URL boundary', () => {
  it('keeps MTIC-owned detail links and drops external ATS redirects', () => {
    const html = `
      <section class="fce-2-col">
        <h3>SPS InterCert S.A. | Lugano Paradiso - Switzerland</h3>
        <ul>
          <li><a href="/it/opportunita-di-lavoro/open-position-quality-assurance-manager/">Official</a></li>
          <li><a href="https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/">Subdomain</a></li>
          <li><a href="http://central.st12.consulting1x1.info/it/opportunita-di-lavoro/open-position-quality-assurance-manager/">External redirect</a></li>
        </ul>
      </section>`;

    expect(parseMticListingPage(html).map((item) => item.detailUrl)).toEqual([
      'https://www.mtic-group.org/it/opportunita-di-lavoro/open-position-quality-assurance-manager/',
      'https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/',
    ]);
  });

  it('rejects invalid protocols and lookalike hosts', () => {
    expect(isMticTrustedUrl('https://www.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(true);
    expect(isMticTrustedUrl('https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(true);
    expect(isMticTrustedUrl('http://central.st12.consulting1x1.info/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
    expect(isMticTrustedUrl('https://not-mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
    expect(isMticTrustedUrl('javascript://www.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
  });
});

describe('MTIC detail body boundary', () => {
  it('rejects an empty detail response instead of treating it as a parsed job', () => {
    const detail = parseMticDetailPage(
      '<main class="content_main"><h2>Stale posting</h2></main>',
      'Stale posting',
    );

    expect(detail.description).toBe('');
    expect(isMticDetailPublishable(detail)).toBe(false);
  });

  it('accepts a detail response with a source body at the shared floor', () => {
    const body = Array.from({ length: 50 }, (_, index) => `source-word-${index}`).join(' ');
    const detail = parseMticDetailPage(
      `<main class="content_main"><h2>Quality manager</h2><div class="frame-type-text">${body}</div></main>`,
      'Quality manager',
    );

    expect(isMticDetailPublishable(detail)).toBe(true);
  });
});
