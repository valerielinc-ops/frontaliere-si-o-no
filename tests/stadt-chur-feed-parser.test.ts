import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseAtomEntries,
  parseRssItems,
  parseFeed,
  decodeHtmlEntities,
} from '@/scripts/lib/stadt-chur-feed-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Real morss (open-source proxy) passthrough of jobs.chur.ch, captured 2026-07-12.
const MORSS_RSS = readFileSync(
  path.join(__dirname, '__fixtures__', 'stadt-chur-morss-rss.xml'),
  'utf-8',
);

// Minimal Atom sample matching the shape the direct fetch would return.
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Dipl. Pflegefachfrau</title>
    <link href="https://jobs.chur.ch/Dipl-Pflegefachfrau-de-j1701.html"/>
    <id>j1701</id>
    <summary>Beschreibung der Stelle.</summary>
    <updated>2026-07-10T08:00:00Z</updated>
    <category term="healthcare"/>
  </entry>
</feed>`;

describe('stadt-chur feed parser', () => {
  describe('parseRssItems (live morss RSS 2.0)', () => {
    const items = parseRssItems(MORSS_RSS);

    it('extracts every real job item from the RSS 2.0 feed', () => {
      expect(items.length).toBe(7);
    });

    it('reads the textual <link> and a real job title', () => {
      const geometer = items.find((e) => e.title.startsWith('Stadtgeometer'));
      expect(geometer).toBeTruthy();
      expect(geometer.link).toBe(
        'https://jobs.chur.ch/Stadtgeometer-in-und-Verantwortliche-r-Landerwerb-80-de-j1679.html',
      );
    });

    it('carries a description into summary for every item', () => {
      expect(items.every((e) => e.summary.length > 20)).toBe(true);
    });

    it('every kept link is a real Rexx job-detail URL (-jNNNN.html)', () => {
      expect(items.every((e) => /j\d+\.html/i.test(e.link))).toBe(true);
    });

    it('skips channel/self rows without a job-detail link', () => {
      const withChannel = `<rss><channel><title>Jobportal</title>
        <item><title>Not a job</title><link>https://jobs.chur.ch/about.html</link><description>x</description></item>
        <item><title>Real</title><link>https://jobs.chur.ch/Real-de-j999.html</link><description>a real description here</description></item>
      </channel></rss>`;
      const parsed = parseRssItems(withChannel);
      expect(parsed.length).toBe(1);
      expect(parsed[0].title).toBe('Real');
    });

    it('rejects an off-domain link even if it matches the job-detail pattern (untrusted proxy safety)', () => {
      const withForeignLink = `<rss><channel><title>Jobportal</title>
        <item><title>Spoofed</title><link>https://evil.example.com/Spoofed-de-j123.html</link><description>a real description here</description></item>
        <item><title>Real</title><link>https://jobs.chur.ch/Real-de-j999.html</link><description>a real description here</description></item>
      </channel></rss>`;
      const parsed = parseRssItems(withForeignLink);
      expect(parsed.length).toBe(1);
      expect(parsed[0].title).toBe('Real');
    });

    it('leaves content empty for the raw `:proxy` passthrough (no full-text expansion)', () => {
      expect(items.every((e) => e.content === '')).toBe(true);
    });

    it('extracts <content:encoded> when the feed came back in morss full-text mode', () => {
      const fullText = `<rss><channel><title>Jobportal</title>
        <item><title>Real</title><link>https://jobs.chur.ch/Real-de-j999.html</link>
        <description>Short intro only.</description>
        <ns0:encoded xmlns:ns0="http://purl.org/rss/1.0/modules/content/">&lt;h2&gt;Ihre Aufgaben&lt;/h2&gt;&lt;p&gt;Volle Beschreibung.&lt;/p&gt;</ns0:encoded>
        </item>
      </channel></rss>`;
      const parsed = parseRssItems(fullText);
      expect(parsed.length).toBe(1);
      expect(parsed[0].content).toBe('<h2>Ihre Aufgaben</h2><p>Volle Beschreibung.</p>');
    });
  });

  describe('parseAtomEntries (direct-fetch dialect)', () => {
    const entries = parseAtomEntries(ATOM);

    it('reads link from the href attribute', () => {
      expect(entries.length).toBe(1);
      expect(entries[0].link).toBe('https://jobs.chur.ch/Dipl-Pflegefachfrau-de-j1701.html');
      expect(entries[0].summary).toBe('Beschreibung der Stelle.');
      expect(entries[0].category).toBe('healthcare');
    });
  });

  describe('parseFeed (dialect dispatch)', () => {
    it('parses Atom when <entry> is present', () => {
      const out = parseFeed(ATOM);
      expect(out.length).toBe(1);
      expect(out[0].title).toBe('Dipl. Pflegefachfrau');
    });

    it('parses RSS 2.0 when there are no <entry> elements', () => {
      const out = parseFeed(MORSS_RSS);
      expect(out.length).toBe(7);
    });
  });

  describe('decodeHtmlEntities', () => {
    it('decodes the common entity set', () => {
      expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
        'a & b <c> "d" \'e\'',
      );
    });
  });
});
