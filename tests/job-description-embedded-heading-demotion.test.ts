/**
 * Il markup ATS incorporato non porta mai un `<h1>` nella pagina annuncio (#5845 item 1).
 *
 * La causa e' accertata in produzione, non dedotta. Su
 * `/en/find-jobs-graubunden/client-support-officer-efg-st-moritz/` l'HTML
 * servito conteneva 10 `<h1>`: uno e' l'hero title emesso da
 * `jobsSeoPagesPlugin.ts` (`<h1 class="hero-title">`), gli altri nove erano le
 * intestazioni del datore di lavoro ("Our Company", "Job Description", "Main
 * Responsibilities", "Skills and experience", "Our Values", "Application", …),
 * tutte dentro `<section class="section"><h4>Role overview</h4>`, cioe' dentro
 * il `summaryHtml` costruito da `jobDescriptionTextToHtml`.
 *
 * Il ramo di passthrough di `computeJobDescriptionTextToHtml` matcha `h[1-6]`
 * e restituisce l'HTML sorgente sostanzialmente verbatim: qualunque ATS che
 * spedisca il proprio outline (export Workday/SmartRecruiters, e qualunque
 * cosa incollata da MS Word) atterrava cosi' nella pagina statica.
 *
 * La regola della famiglia: il gate ha ragione, sono le pagine ad avere torto.
 * `tests/dist-single-h1-per-page.test.ts` misura il sintomo su `dist/` dopo una
 * build; questo file pinna la CAUSA sulla funzione che la produce, cosi' la
 * regressione si vede senza aspettare un post-deploy.
 */
import { describe, expect, it } from 'vitest';
import {
  demoteEmbeddedH1,
  jobDescriptionTextToHtml,
} from '@/build-plugins/shared/jobDescription/toHtml';

/** Conta i `<h1>` con la stessa permissivita' del gate su dist/. */
function countH1(html: string): number {
  return (html.match(/<h1[\s>]/gi) || []).length;
}

/**
 * Estratto ridotto ma fedele della job description EFG realmente pubblicata:
 * stesse intestazioni, stessi `<span lang=...>`/`<span style=...>` da paste
 * MS Word, stessa alternanza `<ul>`/`<p>` fra un `<h1>` e il successivo.
 */
const EFG_ATS_HTML = [
  '<p><span style="color:#8C3F3E;"><span lang="DE">General Info</span></span></p>',
  '<ul style="list-style-type:square;"><li><p class="Bulletlist">Work time Percentage: 100%</p></li></ul>',
  '<h1><span lang="IT-CH">Our Company</span></h1>',
  '<p><span lang="EN-GB">EFG International is a global private banking group.</span></p>',
  '<h1><span lang="EN-GB">Job Description</span></h1>',
  '<p style="text-align:justify;">To support our growing activities in St. Moritz…</p>',
  '<h1><span style="color:#333C40;"><strong>Main Responsibilities</strong></span></h1>',
  '<h1><span style="color:#333C40;"><strong>1. Client and CRO Support</strong></span></h1>',
  '<ul><li><p>Support the CROs in day-to-day client servicing.</p></li></ul>',
  '<h1><span lang="EN-GB">Skills and experience</span></h1>',
  '<ol><li><p class="Bulletlist">Education: banking apprenticeship or equivalent.</p></li></ol>',
  '<h1><span lang="IT-CH">Our Values</span></h1>',
  '<h1><span lang="EN-GB">Application</span></h1>',
].join('');

describe('jobDescriptionTextToHtml — heading incorporati dal markup ATS', () => {
  it('non emette alcun <h1> per la description EFG che ha causato #5845 item 1', () => {
    const html = jobDescriptionTextToHtml(EFG_ATS_HTML);
    expect(countH1(EFG_ATS_HTML)).toBe(7); // il difetto in ingresso, misurato
    expect(countH1(html)).toBe(0); // e assente in uscita
  });

  it('declassa ogni <h1> incorporato a <h2>, aperture e chiusure in pari numero', () => {
    const html = jobDescriptionTextToHtml(EFG_ATS_HTML);
    const opens = (html.match(/<h2[\s>]/gi) || []).length;
    const closes = (html.match(/<\/h2\s*>/gi) || []).length;
    expect(opens).toBe(7);
    // Un rewrite che tocca solo l'apertura lascia `<h2>…</h1>`: tag spaiati che
    // il minifier ribilancia in modo imprevedibile e che rimetterebbero un
    // `</h1>` orfano nel documento.
    expect(closes).toBe(opens);
    expect(html).not.toMatch(/<\/h1\s*>/i);
  });

  it('conserva il testo visibile delle intestazioni declassate', () => {
    const html = jobDescriptionTextToHtml(EFG_ATS_HTML);
    for (const heading of ['Our Company', 'Job Description', 'Skills and experience', 'Our Values']) {
      expect(html).toContain(heading);
    }
  });

  it('non tocca i livelli h2-h6, che non violano nessuna invariante di pagina', () => {
    const src = '<h2>Ruolo</h2><h3>Requisiti</h3><h4>Benefit</h4><h6>Note</h6><p>Testo.</p>';
    const html = jobDescriptionTextToHtml(src);
    expect(html).toContain('<h2>Ruolo</h2>');
    expect(html).toContain('<h3>Requisiti</h3>');
    expect(html).toContain('<h4>Benefit</h4>');
    expect(html).toContain('<h6>Note</h6>');
  });

  it('conserva gli attributi dell intestazione declassata', () => {
    // Solo il nome del tag cambia: una riscrittura che azzera gli attributi
    // spegnerebbe in silenzio il CSS del datore di lavoro e i marker di lingua.
    expect(demoteEmbeddedH1('<h1 class="ats-title" lang="de">Über uns</h1>'))
      .toBe('<h2 class="ats-title" lang="de">Über uns</h2>');
  });

  it('non introduce <h1> sul ramo AST (description senza tag strutturali)', () => {
    // Il ramo non-HTML passa da `parseJobDescription` + `blocksToHtml`, che
    // mappano un heading di livello 2 su `<h2>` nello stesso contenitore: e' la
    // ragione per cui il declassamento sceglie `<h2>` e non `<h3>`, cosi' i due
    // percorsi di render producono lo stesso outline per lo stesso input.
    const html = jobDescriptionTextToHtml('## Our Company\n\nEFG International is a global private banking group.');
    expect(countH1(html)).toBe(0);
  });

  it('e idempotente: una seconda passata non declassa oltre', () => {
    const once = demoteEmbeddedH1(EFG_ATS_HTML);
    expect(demoteEmbeddedH1(once)).toBe(once);
  });

  it('non altera un testo che nomina h1 senza essere un tag', () => {
    // `<h10>` non esiste e `&lt;h1&gt;` e' testo: nessuno dei due deve muoversi,
    // o la guardia starebbe riscrivendo contenuto invece di markup.
    expect(demoteEmbeddedH1('<p>usa &lt;h1&gt; una volta sola</p>')).toBe('<p>usa &lt;h1&gt; una volta sola</p>');
    expect(demoteEmbeddedH1('<h10>non un tag</h10>')).toBe('<h10>non un tag</h10>');
  });
});
