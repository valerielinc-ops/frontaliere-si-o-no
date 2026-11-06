/**
 * The JobPosting `responsibilities`/`qualifications` of a PEMSA vacancy must
 * come from that vacancy (offer id), never from the "Lavori correlati" grid of
 * other offers or the site-wide benefits footer that follow it on the page.
 *
 * Regression: /cerca-lavoro-ticino/macchinista-m1-m2-pemsa-lugano/ (offer
 * 2700968) published "Promozione di iniziative a tutela della salute e del
 * benessere e consulenza sociale" — a PEMSA footer benefit — as its
 * responsibilities.
 */
import { describe, expect, it } from 'vitest';
import { cutPemsaRelatedOffers, parsePemsaDetailHtml } from '../scripts/lib/pemsa-job-parser.mjs';
import { buildFallbackCanonicalContent } from '../services/jobs/canonicalFallback';

const OWN_URL = 'https://www.pemsa.ch/it/job/macchinista-m1-m2m3-2700968/';
const OWN_ID = '2700968';
const RELATED = [
  ['https://www.pemsa.ch/it/job/muratore-tradizionale-2702099/', 'Muratore tradizionale'],
  ['https://www.pemsa.ch/it/job/muratore-ingegneria-civile-2702106/', 'Muratore &#8211; Ingegneria civile'],
] as const;

const relatedCard = ([href, title]: readonly [string, string]) => `
  <div class="wpgb-card">
    <h3><a href="${href}">${title}</a></h3>
    <p>A tempo pieno , Interinale</p>
    <p>Vuoi la libertà del lavoro temporaneo e la sicurezza di un impiego fisso? Da 30 anni affianchiamo centinaia di aziende.</p>
    <a class="btn" href="${href}">Candidarsi per questo lavoro</a>
  </div>`;

const PAGE = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Macchinista M1, M2,M3',
  datePosted: '2026-10-16T15:58:56+02:00',
  validThrough: '2026-10-31',
  jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900', addressCountry: 'CH' } },
  hiringOrganization: { name: 'PEMSA' },
})}</script></head><body>
<nav><a href="https://www.pemsa.ch/job/conducteur-de-train-m1-m2-2700971/">FR</a>
<a href="https://www.pemsa.ch/de/job/lokfuhrer-m1-m2-2700972/">DE</a></nav>
<main>
<h1>Macchinista M1, M2,M3</h1>
<p><a href="#popup_apply">Candidarsi per questo lavoro</a></p>
<p>Vuoi la libertà di un lavoro temporaneo e la sicurezza di uno permanente? Da 30 anni assistiamo centinaia di aziende nei settori tecnici dell'edilizia in tutta la Svizzera.</p>
<h2>Missione :</h2>
<ul><li>Utilizzo di escavatori cingolati, gommati e pale gommate in cantiere</li>
<li>Scavi trincee per fognature, drenaggi e canalizzazioni d'acqua</li>
<li>Lavori di demolizione e smontaggi con macchine munite di pinze e martelli</li></ul>
<h2>Profilo :</h2>
<ul><li>Patente M1, M2 e comprovata esperienza su macchine da cantiere</li>
<li>Automunito e disponibile a lavorare su diversi cantieri del Luganese</li></ul>
<p><a href="#popup_apply">Candidarsi per questo lavoro</a></p>
<h3>Lavori correlati</h3>
${RELATED.map(relatedCard).join('\n')}
<h3>CONDIZIONI ECCEZIONALI</h3>
<ul><li>Fornitura di dispositivi di protezione</li>
<li>Promozione di iniziative a tutela della salute e del benessere e consulenza sociale</li></ul>
</main></body></html>`;

describe('PEMSA detail body — only the vacancy of this offer id', () => {
  it('cuts the rendered body at the first offer with another id', () => {
    const parsed = parsePemsaDetailHtml(PAGE, OWN_URL);
    expect(parsed).not.toBeNull();
    const description = String(parsed?.description || '');
    expect(description).toContain('escavatori cingolati');
    expect(description).toContain('Patente M1, M2');
    expect(description).not.toContain('Muratore');
    expect(description).not.toContain('Lavori correlati');
    expect(description).not.toContain('consulenza sociale');
  });

  it('keeps language variants of the same vacancy and its own apply button out of the cut', () => {
    const text = ['Macchinista M1, M2,M3', 'Candidarsi per questo lavoro', 'Missione :', '- Scavi trincee'].join('\n');
    expect(cutPemsaRelatedOffers(text, PAGE, OWN_URL)).toBe(text);
  });

  it('leaves the body untouched when the page links no other offer', () => {
    const html = PAGE.replace(/<h3>Lavori correlati<\/h3>[\s\S]*?(?=<h3>CONDIZIONI)/, '');
    const text = 'Missione :\n- Scavi trincee\nCONDIZIONI ECCEZIONALI';
    expect(cutPemsaRelatedOffers(text, html, OWN_URL)).toBe(text);
  });

  it('responsibilities and qualifications come from this offer', () => {
    const parsed = parsePemsaDetailHtml(PAGE, OWN_URL);
    const canonical = buildFallbackCanonicalContent(String(parsed?.description || ''), [], 'it');
    const extracted = [
      ...(canonical.responsibilities || []),
      ...(canonical.requirements || []),
    ].join('\n');
    expect(extracted).not.toMatch(/consulenza sociale|Muratore|dispositivi di protezione/);
    // Every extracted line is text of offer 2700968's own body.
    const ownBody = PAGE.slice(PAGE.indexOf('<h1>'), PAGE.indexOf('<h3>Lavori correlati</h3>'))
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const line of extracted.split('\n').filter(Boolean)) {
      expect(ownBody, `"${line}" is not text of offer ${OWN_ID}`).toContain(line.replace(/^[-•]\s*/, '').slice(0, 30));
    }
  });
});
