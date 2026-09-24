import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isArtificialyCloudflareBlockedPage,
  parseArtificialyCareerPage,
} from '../scripts/lib/artificialy-job-parser.mjs';

const CLOUDFLARE_CHALLENGE = fs.readFileSync(
  new URL('./fixtures/artificialy-cloudflare-challenge.html', import.meta.url),
  'utf8',
);

describe('Artificialy career parser', () => {
  it('reproduces and classifies the Cloudflare 403 page as blocked', () => {
    expect(isArtificialyCloudflareBlockedPage(CLOUDFLARE_CHALLENGE)).toBe(true);
    expect(parseArtificialyCareerPage(CLOUDFLARE_CHALLENGE)).toEqual({
      items: [],
      blocked: true,
    });
  });

  it('classifies a short Cloudflare denial before the empty-page guard', () => {
    expect(parseArtificialyCareerPage('<title>403 | Cloudflare</title>')).toEqual({
      items: [],
      blocked: true,
    });
  });

  it('keeps a real JSON-LD career page healthy', () => {
    const html = `
      <html><head><title>Artificialy careers</title></head><body>
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'AI Scientist',
          jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI' } },
          description: 'Build useful AI systems.',
          url: 'https://www.artificialy.com/careers/ai-scientist',
        })}</script>
        <p>Artificialy careers and open positions in Switzerland.</p>
      </body></html>`;

    expect(parseArtificialyCareerPage(html)).toMatchObject({
      blocked: false,
      items: [expect.objectContaining({ title: 'AI Scientist', location: 'Lugano' })],
    });
  });
});
