import { describe, expect, it } from 'vitest';
import { stripHtml as alpiq, parseAlpiqDetailHtml } from '../scripts/lib/alpiq-job-parser.mjs';
import { parseBaronieDetailHtml } from '../scripts/lib/baronie-job-parser.mjs';
import { stripHtml as cedes } from '../scripts/lib/cedes-job-parser.mjs';
import { stripHtml as bellinzona, parseBellinzonaListingHtml } from '../scripts/lib/citta-di-bellinzona-job-parser.mjs';
import { stripHtml as locarno, parseLocarnoListingHtml } from '../scripts/lib/citta-di-locarno-job-parser.mjs';
import { stripHtml as davos, richTextToLines } from '../scripts/lib/davos-klosters-bergbahnen-job-parser.mjs';
import { stripHtml as ems } from '../scripts/lib/ems-chemie-job-parser.mjs';
import { stripHtml as hilcona } from '../scripts/lib/hilcona-job-parser.mjs';
import { stripHtml as laderach } from '../scripts/lib/laderach-job-parser.mjs';
import { stripHtml as lis } from '../scripts/lib/lis-lugano-istituti-sociali-job-parser.mjs';
import { parseLombardiDetailHtml } from '../scripts/lib/lombardi-job-parser.mjs';
import { stripHtml as otis } from '../scripts/lib/otis-job-parser.mjs';
import { stripHtml as pkb } from '../scripts/lib/pkb-private-bank-job-parser.mjs';
import { stripHtml as prada } from '../scripts/lib/prada-job-parser.mjs';
import { stripHtml as rapelli } from '../scripts/lib/rapelli-job-parser.mjs';
import { stripHtml as template } from '../scripts/lib/crawler-template.mjs';
import { decodeNumericEntities, decodeHtmlEntities } from '../scripts/lib/dedicated-crawler-common.mjs';

const encodedTitle = 'Qualit&agrave; f&uuml;r l&rsquo;&eacute;quipe &lpar;R&amp;D&rpar; &#128640; &#x1F9EA;';
const decodedTitle = 'Qualità für l’équipe (R&D) 🚀 🧪';

describe.each(Object.entries({ alpiq, cedes, bellinzona, locarno, davos, ems, hilcona, laderach, lis, otis, pkb, prada, rapelli, template }))('%s job text entities', (_name, stripHtml) => {
  it('decodes named entities and full Unicode code points after removing markup', () => {
    expect(stripHtml(`<strong>${encodedTitle}</strong>`)).toBe(decodedTitle);
  });

  it('preserves escaped angle brackets, unknown entities and a literal encoded entity', () => {
    expect(stripHtml('<p>A &lt;CAD&gt; &amp;lt;B&amp;gt; &notarealentity; &copycat</p>'))
      .toBe('A <CAD> &lt;B&gt; &notarealentity; &copycat');
  });
});

it('decodes Alpiq details once after stripping markup', () => {
  const result = parseAlpiqDetailHtml(`<h1>${encodedTitle} &amp;lt;CAD&amp;gt;</h1><main><p>Progetti &lt;CAD&gt; e qualit&agrave;.</p></main>`);
  expect(result.title).toBe(`${decodedTitle} &lt;CAD&gt;`);
});

it('keeps the numeric decoder numeric-only and consumes one encoding layer', () => {
  expect(decodeNumericEntities('&#128640; &#x1F9EA; &#X1F680; &uuml; &amp; &#38;#x1F680;'))
    .toBe('🚀 🧪 🚀 &uuml; &amp; &#x1F680;');
  expect(decodeNumericEntities('&#0; &#55296; &#xDFFF; &#1114112; &#9999999999999999999999;'))
    .toBe('� � � � �');
  expect(decodeNumericEntities('&#1114111;')).toBe(String.fromCodePoint(0x10ffff));
});

it('decodes all complete named entities in common cleanup while retaining numeric references', () => {
  expect(decodeHtmlEntities('&eacute; &lpar;A&rpar; &NotEqualTilde; &#128640; &notarealentity; &copycat'))
    .toBe('é (A) ≂̸ &#128640; &notarealentity; &copycat');
});

it('preserves Davos description line boundaries while decoding entities', () => {
  expect(richTextToLines(`<ul><li>${encodedTitle}</li><li>Qualit&agrave;&nbsp;garantita</li></ul>`))
    .toBe(`• ${decodedTitle}\n• Qualità garantita`);
});

it('decodes Baronie title and source description without reinterpreting escaped tags', () => {
  const result = parseBaronieDetailHtml(`<article class="s-entry__content"><h1 class="s-text-medium-large">${encodedTitle}</h1><p class="s-text-medium">Progetti &lt;CAD&gt; e qualit&agrave;.</p><div class="s-text-markup"><h3>Responsibilities</h3><ul><li>${encodedTitle}</li></ul></div></article>`);
  expect(result.detailTitle).toBe(decodedTitle);
  expect(result.introText).toBe('Progetti <CAD> e qualità.');
  expect(result.markdown).toContain(decodedTitle);
});

it('decodes Lombardi fields once and preserves encoded text beside real markup', () => {
  const result = parseLombardiDetailHtml(`<main><h2 class="intro__subtitle">${encodedTitle} &lt;CAD&gt; &amp;lt;B&amp;gt;</h2><h3>80%&ndash;100% | Z&uuml;rich</h3><div class="intro__rich-text"><p>Progetti &lt;CAD&gt; e qualit&agrave;.</p></div><h3>Requirements</h3><ul><li>${encodedTitle}</li></ul></main>`);
  expect(result.detailTitle).toBe(`${decodedTitle} <CAD> &lt;B&gt;`);
  expect(result.introText).toBe('Progetti <CAD> e qualità.');
  expect(result.city).toBe('Zürich');
  expect(result.occupancy).toBe('80%–100%');
  expect(result.markdown).toContain(decodedTitle);
});

it.each([
  '80&#37;–100&#37; &#124; Giubiasco',
  '80&percnt;&ndash;100&percnt; &vert; Giubiasco',
  '80&#x25;&#x2013;100&#x25; &#x7c; Giubiasco',
])('recognizes Lombardi location after decoding its separators: %s', (location) => {
  const result = parseLombardiDetailHtml(`<main><p>Benefits &lpar;80%&rpar; | Switzerland</p><p>${location}</p><p>Next section</p></main>`);
  expect(result.occupancy).toBe('80%–100%');
  expect(result.city).toBe('Giubiasco');
});

it('does not decode municipal titles twice after stripping their tags', () => {
  const title = `${encodedTitle} &amp;lt;CAD&amp;gt;`;
  const bellinzonaJobs = parseBellinzonaListingHtml(`<h3>${title}</h3><p>Pubbl. 01.10.26</p><p>Termine 30.10.2026</p><a href="/docs/job.pdf">Bando di concorso</a>`);
  const locarnoJobs = parseLocarnoListingHtml(`<li><p>01.10.2026</p><p><a href="/files/documenti/job.pdf">${title}</a></p></li>`);
  expect(bellinzonaJobs).toHaveLength(1);
  expect(locarnoJobs).toHaveLength(1);
  expect(bellinzonaJobs[0].rawTitle).toBe(`${decodedTitle} &lt;CAD&gt;`);
  expect(locarnoJobs[0].rawTitle).toBe(`${decodedTitle} &lt;CAD&gt;`);
});
