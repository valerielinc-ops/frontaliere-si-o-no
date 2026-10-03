import fs from 'node:fs';
import {
  dropArtificialyFabricatedText,
  filterArtificialyListingsWithIndexableSourceBody,
} from '../scripts/update-artificialy-jobs.mjs';
import { describe, expect, it } from 'vitest';
import {
  buildArtificialyLocalizedContent,
  isArtificialyCloudflareBlockedPage,
  parseArtificialyLinkedInJobPage,
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

  it('extracts a publishable source body from the LinkedIn detail container', () => {
    const body = Array.from({ length: 6 }, () =>
      'Build reliable machine learning systems for Swiss clients across research deployment monitoring and continuous improvement.',
    ).join(' ');
    const result = parseArtificialyLinkedInJobPage(`
      <html><body>
        <nav>Recommended jobs and account navigation</nav>
        <div class="description__text description__text--rich">
          <section class="show-more-less-html">
            <div class="show-more-less-html__markup"><p>${body}</p><ul><li>Work with product teams.</li></ul></div>
          </section>
        </div>
      </body></html>`);

    expect(result).toMatchObject({ blocked: false, description: expect.stringContaining('Build reliable') });
    expect(result.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
  });

  it('does not turn a LinkedIn summary below the source floor into a job body', () => {
    const result = parseArtificialyLinkedInJobPage(`
      <div class="show-more-less-html__markup"><p>Short listing summary only.</p></div>`);

    expect(result).toEqual({ description: '', blocked: false });
  });

  it('does not pass listing-only metadata into the crawler pipeline', () => {
    const shortBody = Array.from({ length: 49 }, () => 'source').join(' ');
    const indexableBody = Array.from({ length: 50 }, () => 'source').join(' ');

    expect(filterArtificialyListingsWithIndexableSourceBody([
      { title: 'Metadata only', description: '' },
      { title: 'Short summary', description: shortBody },
      { title: 'Full source body', description: indexableBody },
    ])).toEqual([
      { title: 'Full source body', description: indexableBody },
    ]);
  });
});

// Issue 5253: the builder copied the posting text into all four slots (so
// translation never replaced them) and, without a text, wrote "Artificialy
// cerca <title> con sede a <place>. Azienda svizzera specializzata in
// intelligenza artificiale…" in all four.
describe('buildArtificialyLocalizedContent — the posting text only, in its own slot', () => {
  // The careers page answers with a Cloudflare challenge (see above), so no
  // live posting text exists: TEXT is the one of the JSON-LD fixture of this
  // file, LONG_TEXT a synthetic posting of 50+ words for the floor.
  const TEXT = 'Build reliable platform services.';
  const LONG_TEXT = Array.from({ length: 6 }, () => 'Build reliable platform services for our machine learning products in Lugano and Zurich.').join(' ');

  it('writes a text from 50 words up only in the slot of its language', () => {
    const content = buildArtificialyLocalizedContent({ title: 'Platform Engineer', location: 'Zurich', description: LONG_TEXT, sourceLang: 'en' });
    expect(content.description).toBe(LONG_TEXT);
    expect(content.descriptionByLocale).toEqual({ en: LONG_TEXT });
  });

  it('gives a text under 50 words no indexable text (thin-source path)', () => {
    const content = buildArtificialyLocalizedContent({ title: 'Platform Engineer', location: 'Zurich', description: TEXT, sourceLang: 'en' });
    expect(content.description).toBe('');
    expect(content.descriptionByLocale).toEqual({});
  });

  it('gives a posting without text no description', () => {
    const content = buildArtificialyLocalizedContent({ title: 'Platform Engineer', location: 'Zurich', description: '', sourceLang: 'en' });
    expect(content.description).toBe('');
    expect(content.descriptionByLocale).toEqual({});
  });
});

// Stored records of the former fallback: before the merge the runner drops
// the invented slots, the translations made from them and the flat
// description, so the merge cannot keep them (issue 5253).
describe('dropArtificialyFabricatedText', () => {
  const INVENTED = 'Artificialy cerca Platform Engineer con sede a Zurich. Azienda svizzera specializzata in intelligenza artificiale con sedi a Lugano e Zurigo. Candidati online su artificialy.com.';

  it('leaves no invented entry in a stored job', () => {
    const job: any = {
      sourceLang: 'it',
      description: INVENTED,
      descriptionByLocale: { it: INVENTED, en: INVENTED, de: INVENTED, fr: INVENTED },
    };
    expect(dropArtificialyFabricatedText(job)).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a stored job with the posting text alone', () => {
    const job: any = { sourceLang: 'en', description: 'Build reliable platform services.', descriptionByLocale: { en: 'Build reliable platform services.', it: 'Traduzione.' } };
    expect(dropArtificialyFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('Traduzione.');
  });
});
