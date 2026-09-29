import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildArtificialyLocalizedContent,
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

  it('does not treat unrelated Cloudflare prose as a denial page', () => {
    const html = `
      <html><head><title>Artificialy careers</title></head><body>
        <script>const helpText = 'Cloudflare documents 403 Forbidden responses';</script>
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'Platform Engineer',
          jobLocation: { address: { addressLocality: 'Zurich', addressRegion: 'ZH' } },
          description: 'Build reliable platform services.',
          url: 'https://www.artificialy.com/careers/platform-engineer',
        })}</script>
      </body></html>`;

    expect(isArtificialyCloudflareBlockedPage(html)).toBe(false);
    expect(parseArtificialyCareerPage(html)).toMatchObject({
      blocked: false,
      items: [expect.objectContaining({ title: 'Platform Engineer', location: 'Zurich' })],
    });
  });
});

// Issue 5253: the builder copied the posting text into all four slots (so
// translation never replaced them) and, without a text, wrote "Artificialy
// cerca <title> con sede a <place>. Azienda svizzera specializzata in
// intelligenza artificiale…" in all four.
describe('buildArtificialyLocalizedContent — the posting text only, in its own slot', () => {
  // The careers page answers with a Cloudflare challenge (see above): the text
  // is the one of the JSON-LD fixture of this file.
  const TEXT = 'Build reliable platform services.';

  it('writes the text only in the slot of its language', () => {
    const content = buildArtificialyLocalizedContent({ title: 'Platform Engineer', location: 'Zurich', description: TEXT, sourceLang: 'en' });
    expect(content.description).toBe(TEXT);
    expect(content.descriptionByLocale).toEqual({ en: TEXT });
  });

  it('gives a posting without text no description', () => {
    const content = buildArtificialyLocalizedContent({ title: 'Platform Engineer', location: 'Zurich', description: '', sourceLang: 'en' });
    expect(content.description).toBe('');
    expect(content.descriptionByLocale).toEqual({});
  });
});
