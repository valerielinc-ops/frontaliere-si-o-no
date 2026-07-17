import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  extractReflineDetailTitle,
  parseReflineDetail,
  parseReflineJobPostingJsonLd,
} from '../scripts/lib/refline-common.mjs';
import { stripScriptsAndStyles } from '../scripts/lib/crawler-template.mjs';
import { decodeUnicodeEscapeLeaks } from '../scripts/lib/dedicated-crawler-common.mjs';
import { parseReflineDetail as parseSpitalDetail } from '../scripts/lib/spital-limmattal-job-parser.mjs';
import { parseReflineDetail as parseCaritasDetail } from '../scripts/lib/caritas-schweiz-job-parser.mjs';
import { parseReflineDetail as parseHoheneggDetail } from '../scripts/lib/privatklinik-hohenegg-job-parser.mjs';
import { parseReflineDetail as parsePignaDetail } from '../scripts/lib/pigna-job-parser.mjs';

// Regression fixture for the \uXXXX title-corruption class: real Refline
// detail pages (Spital Limmattal 486538, Caritas 126757, ZKB 792841) ship NO
// <h1> in the body — the only <h1> in the document sits INSIDE the JSON-LD
// JobPosting's escaped `description` string. A title regex run against the
// raw html matches inside the script block and captures JSON-escaped text
// ("Arztsekretär/in für…"), which then leaks into titles, every
// translated locale, and slugified URLs ("…-f-u00fcr-…").
const JSON_LD_ONLY_PAGE = `<!DOCTYPE html>
<html><head><title>Offene Stellen</title></head>
<body>
<div class="content">
  <div class="posting">Bewerben Sie sich jetzt</div>
</div>
<script type="application/ld+json">
{"@context": "https://schema.org/", "@type": "JobPosting", "title": "Arztsekret\\u00e4r/in f\\u00fcr Chefarztsekretariat An\\u00e4sthesie 80 %", "description": "<h1>Arztsekret\\u00e4r/in f\\u00fcr Chefarztsekretariat An\\u00e4sthesie 80 %</h1>\\n<h2>nach Vereinbarung</h2>", "datePosted": "2026-07-01", "hiringOrganization": {"@type": "Organization", "name": "Spital Limmattal"}}
</script>
</body></html>`;

const BODY_H1_PAGE = `<!DOCTYPE html>
<html><head><title>Jobs</title></head>
<body>
<h1 class="posTitle">Dipl. Pflegefachperson HF/FH für Onkologie</h1>
<p>Für diese vielseitige Position suchen wir eine engagierte Fachperson mit Erfahrung.</p>
</body></html>`;

describe('extractReflineDetailTitle', () => {
  it('never captures the escaped <h1> inside the JSON-LD script block', () => {
    const title = extractReflineDetailTitle(JSON_LD_ONLY_PAGE);
    expect(title).toBe('Arztsekretär/in für Chefarztsekretariat Anästhesie 80 %');
    expect(title).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it('prefers the JSON-LD JobPosting title over a body heading', () => {
    const page = BODY_H1_PAGE.replace(
      '</body>',
      '<script type="application/ld+json">{"@type": "JobPosting", "title": "K\\u00f6chin / Koch 100 %"}</script></body>',
    );
    expect(extractReflineDetailTitle(page)).toBe('Köchin / Koch 100 %');
  });

  it('falls back to the body <h1> when no JSON-LD JobPosting exists', () => {
    expect(extractReflineDetailTitle(BODY_H1_PAGE))
      .toBe('Dipl. Pflegefachperson HF/FH für Onkologie');
  });

  it('falls back to <title> without matching headings inside scripts', () => {
    const page = `<html><head><title>Offene Stellen</title></head><body>
      <script>document.write("<h1>fake \\u00fc heading</h1>")</script>
      </body></html>`;
    expect(extractReflineDetailTitle(page)).toBe('Offene Stellen');
  });
});

describe('parseReflineDetail (factory + bespoke tenants share the fix)', () => {
  for (const [label, parse] of [
    ['refline-common', parseReflineDetail],
    ['spital-limmattal', parseSpitalDetail],
    ['caritas-schweiz', parseCaritasDetail],
    ['privatklinik-hohenegg', parseHoheneggDetail],
    ['pigna', parsePignaDetail],
  ] as const) {
    it(`${label}: returns a decoded, escape-free title`, () => {
      const { title } = parse(JSON_LD_ONLY_PAGE);
      expect(title).toBe('Arztsekretär/in für Chefarztsekretariat Anästhesie 80 %');
      expect(title).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    });
  }
});

describe('parseReflineJobPostingJsonLd', () => {
  it('finds the JobPosting even when other ld+json blocks precede it', () => {
    const page = `<html><body>
      <script type="application/ld+json">{"@type": "BreadcrumbList", "itemListElement": []}</script>
      <script type="application/ld+json">{"@type": "Organization", "name": "Spital"}</script>
      <script type="application/ld+json">{"@type": "JobPosting", "title": "K\\u00f6chin / Koch 100 %"}</script>
      </body></html>`;
    expect(parseReflineJobPostingJsonLd(page)?.title).toBe('Köchin / Koch 100 %');
  });

  it('unwraps array-form ld+json and skips malformed blocks', () => {
    const page = `<html><body>
      <script type="application/ld+json">{not json at all</script>
      <script type="application/ld+json">[{"@type": "WebSite"}, {"@type": "JobPosting", "title": "Pfleger:in 80 %"}]</script>
      </body></html>`;
    expect(parseReflineJobPostingJsonLd(page)?.title).toBe('Pfleger:in 80 %');
  });
});

describe('stripScriptsAndStyles (shared title-source guard)', () => {
  it('removes script and style blocks so heading regexes see only rendered DOM', () => {
    const html = '<script>var x = "<h1>fake</h1>";</script><style>.h1{}</style><h1>Vero titolo</h1>';
    expect(stripScriptsAndStyles(html)).toBe('<h1>Vero titolo</h1>');
  });
});

describe('decodeUnicodeEscapeLeaks (shared chokepoint guard)', () => {
  it('decodes literal \\uXXXX sequences', () => {
    expect(decodeUnicodeEscapeLeaks('Arztsekret\\u00e4r/in f\\u00fcr An\\u00e4sthesie'))
      .toBe('Arztsekretär/in für Anästhesie');
  });

  it('leaves clean text untouched', () => {
    const clean = 'Infermiera diplomata SSS/SUP per Oncologia, 80%';
    expect(decodeUnicodeEscapeLeaks(clean)).toBe(clean);
  });

  it('does not decode ASCII-range escapes (legit codes are never JSON-escape leaks)', () => {
    const doc = 'Escape-Spezialist \\u0041-Zertifikat 80%';
    expect(decodeUnicodeEscapeLeaks(doc)).toBe(doc);
  });
});

describe('committed job slices carry no escape-corrupted titles', () => {
  const ROOT = join(__dirname, '..');
  const DIRS = [
    join(ROOT, 'data', 'jobs', 'by-crawler'),
    join(ROOT, 'data', 'jobs', 'expired', 'by-crawler'),
  ];
  const LITERAL_ESCAPE = /\\u[0-9a-fA-F]{4}/;

  for (const dir of DIRS.filter(existsSync)) {
    it(`${dir.includes('expired') ? 'expired' : 'active'} slices`, () => {
      const offenders: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
        for (const job of jobs) {
          const titles = [job.title, ...Object.values(job.titleByLocale || {})];
          if (titles.some((t) => typeof t === 'string' && LITERAL_ESCAPE.test(t))) {
            offenders.push(`${file}:${job.id || job.slug}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
