import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripHtml as mcdonalds } from '../scripts/lib/mcdonalds-job-parser.mjs';
import { extractEthZurichDetailDescription } from '../scripts/lib/eth-zurich-job-parser.mjs';
import { extractEpflDetailDescription } from '../scripts/lib/epfl-job-parser.mjs';
import { extractMedactaDetailMarkdown } from '../scripts/lib/medacta-job-enrichment.mjs';
import { wpContentToMarkdown } from '../scripts/update-banca-sempione-jobs.mjs';
import { parseDetailPage as parseVolgDetailPage } from '../scripts/update-volg-jobs.mjs';
import { parseSmartRecruitersDetail } from '../scripts/lib/lastminute-job-parser.mjs';
import { parseCliniqueLeNoirmontListing } from '../scripts/lib/clinique-le-noirmont-job-parser.mjs';
import { parsePostJobDetail } from '../scripts/lib/postch-job-parser.mjs';
import { parseCsebPublication } from '../scripts/lib/cseb-job-parser.mjs';
import { parseDescriptionToMarkdown } from '../scripts/lib/pemsa-job-parser.mjs';
import { parseEngelvoelkersDetailPage } from '../scripts/lib/engelvoelkers-job-parser.mjs';
import { fetchAllMscCargoJobs } from '../scripts/lib/msc-cargo-job-parser.mjs';
import { stripHtml as wordpress } from '../scripts/lib/topic-sources/wordpressSearch.mjs';
import { encode } from 'html-entities';

afterEach(() => vi.unstubAllGlobals());

const encoded = 'Qualit&agrave; &lpar;R&amp;D&rpar; &#128640; &#x1F9EA; &lt;CAD&gt; &amp;lt;literal&amp;gt;';
const decoded = 'Qualità (R&D) 🚀 🧪 <CAD> &lt;literal&gt;';
const body = `<p>${encoded}</p><ul><li>${encoded}</li></ul>`;

describe.each([
  ['McDonalds', (html: string) => mcdonalds(html)],
  ['ETH', (html: string) => extractEthZurichDetailDescription(`<main>${html}</main>`)],
  ['EPFL', (html: string) => extractEpflDetailDescription(`<main>${html}</main>`)],
  ['Medacta', (html: string) => extractMedactaDetailMarkdown(`<div itemprop="description">${html}</div>`)],
  ['Banca Sempione', (html: string) => wpContentToMarkdown(html)],
  ['Volg', (html: string) => parseVolgDetailPage(`<div itemprop="responsibilities">${html}</div>`).text],
  ['lastminute', (html: string) => parseSmartRecruitersDetail({ jobAd: { sections: { jobDescription: { text: html } } } }).description],
] as const)('%s HTML description', (_name, parse) => {
  it('preserves full numeric code points, named accents and literal escaped text', () => {
    expect(parse(body)).toContain(decoded);
  });
});

it('preserves entities in WordPress source headlines instead of dropping accented characters', () => {
  expect(wordpress('<b>H&ocirc;pital</b> della citt&agrave; &#128640; &notarealentity;'))
    .toBe('Hôpital della città 🚀 &notarealentity;');
});

it('decodes clinic title attributes and Post title metadata as HTML text', () => {
  const clinic = parseCliniqueLeNoirmontListing(`<a href="/File/123/job.pdf" title="${encoded}">PDF</a>`);
  expect(clinic[0].titleFromAnchor).toBe(decoded);
  expect(parsePostJobDetail(`<meta property="og:title" content="${encoded}">`).title).toBe(decoded);
});

it.each([false, true])('preserves PEMSA text with an encoded HTML transport layer: %s', (escaped) => {
  const html = `<h2>Requisiti</h2><p>${encoded}</p>`;
  const result = parseDescriptionToMarkdown(escaped ? encode(html) : html);
  expect(result.text).toContain(decoded);
});

it.each([false, true])('preserves CSEB text with an encoded HTML transport layer: %s', (escaped) => {
  const html = `<p>${encoded} ${'Source task words for the actual hospital vacancy. '.repeat(10)}</p>`;
  const result = parseCsebPublication({
    JobTitle: 'Pflegefachperson', JobId: 'entity-probe', PlaceOfWorkCity: 'Scuol',
    PublicationLanguage: 'de', Tasks: escaped ? encode(html) : html,
  });
  expect(result.description).toContain(decoded);
});

it('decodes EngelVoelkers HTML payload once and leaves DOM-decoded metadata alone', () => {
  const posting = { text: 'Consultant', content: { descriptionHtml: body } };
  const html = `<meta property="og:title" content="${encoded}"><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data: { details: { posting } } } } })}</script>`;
  const result = parseEngelvoelkersDetailPage(html);
  expect(result.description).toContain(decoded);
  const metadataOnly = parseEngelvoelkersDetailPage(`<meta property="og:title" content="${encoded}">`);
  expect(metadataOnly.title).toBe(decoded);
});

it.each([false, true])('keeps MSC encoded markup transport separate from encoded text: %s', async (escaped) => {
  const html = `<ul><li>${encoded} ${'Responsibilities from the real vacancy source. '.repeat(4)}</li></ul>`;
  const listing = JSON.stringify({ eagerLoadRefineSearch: { totalHits: 1, data: { jobs: [{ title: 'Engineer', jobSeqNo: '123', country: 'Switzerland', location: 'Geneva, Switzerland' }] } } });
  const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: escaped ? encode(html) : html })}</script>`;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(listing)).mockResolvedValueOnce(new Response(detail)));
  const jobs = await fetchAllMscCargoJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].description).toContain(`- ${decoded}`);
});
