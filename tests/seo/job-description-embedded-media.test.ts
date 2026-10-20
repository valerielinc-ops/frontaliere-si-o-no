/**
 * Le description ATS non portano media incorporati nelle pagine job statiche.
 *
 * Caso reale: validate-dist run 36922718485 (build f64b396c, 2026-10-01),
 * unico offender di `audit:all/page-weight` (classe B dal 2026-10-02):
 * `/en/find-jobs-ticino/data-ingenieur-microsoft-fabric-w-m-80-100-de-benu-koniz/`,
 * con due `<figure><img>` Teamtailor senza width/height/loading e con spazi
 * letterali nel `src`. Il testo dell'annuncio deve restare identico.
 */
import { describe, expect, it } from 'vitest';
import {
  inlineTextToHtml,
  jobDescriptionTextToHtml,
  stripEmbeddedMedia,
} from '../../build-plugins/shared/jobDescription/toHtml';

const TEAMTAILOR_FIGURE =
  '<figure data-alignment="left" class="relative" style="width:fit-content;margin-left:0px;margin-right:auto;">'
  + '<img src="https://images.teamtailor-cdn.com/images/s3/teamtailor-production/gallery picture-v6/image uploads/eac9df3c/original.jpeg" alt="Team">'
  + '</figure>';

describe('stripEmbeddedMedia', () => {
  it('toglie <img> e scarta il wrapper <figure> della description Teamtailor', () => {
    const html = `<p>Data Engineer – Microsoft Fabric</p>${TEAMTAILOR_FIGURE}<p>Let your heart beat for health!</p>`;
    const out = jobDescriptionTextToHtml(html);
    expect(out).not.toMatch(/<img\b/i);
    expect(out).not.toMatch(/<\/?figure\b/i);
    expect(out).not.toContain('teamtailor-cdn');
    expect(out).toContain('<p>Data Engineer – Microsoft Fabric</p>');
    expect(out).toContain('<p>Let your heart beat for health!</p>');
  });

  it('una description fatta solo di media e testo non diventa testo visibile `<img …>`', () => {
    // Senza tag strutturali il renderer prende il ramo AST, che fa escape:
    // il tag sarebbe finito in pagina come testo letterale.
    const out = jobDescriptionTextToHtml(`Ruolo di esempio ${TEAMTAILOR_FIGURE} Candidati ora`);
    expect(out).not.toMatch(/&lt;img|&lt;figure/i);
    expect(out).toContain('Ruolo di esempio');
    expect(out).toContain('Candidati ora');
  });

  it('copre anche il ramo inline (bullet e sezioni)', () => {
    const out = inlineTextToHtml(`<strong>Team</strong> ${TEAMTAILOR_FIGURE}`);
    expect(out).toBe('<strong>Team</strong> ');
  });

  it('rimuove con il contenuto i blocchi eseguibili o non testuali', () => {
    const html = '<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://example.invalid/x"></iframe>'
      + '<svg><path d="M0 0"/></svg><video src="v.mp4"><source src="v.webm"></video><picture><source srcset="x.webp"><img src="x.jpg"></picture><p>b</p>';
    expect(stripEmbeddedMedia(html)).toBe('<p>a</p><p>b</p>');
  });

  it('conserva la didascalia come testo', () => {
    expect(stripEmbeddedMedia('<figure><img src="x.jpg"><figcaption>Il team di Lugano</figcaption></figure>'))
      .toBe('Il team di Lugano');
  });

  it('non tocca la formattazione testuale ammessa', () => {
    const html = '<p><strong>Ruolo</strong> <em>80-100%</em> <a href="https://example.invalid/">link</a><br>riga</p><ul><li>uno</li></ul>';
    expect(stripEmbeddedMedia(html)).toBe(html);
  });

  it('è idempotente', () => {
    const once = stripEmbeddedMedia(`<p>x</p>${TEAMTAILOR_FIGURE}`);
    expect(stripEmbeddedMedia(once)).toBe(once);
  });
});
