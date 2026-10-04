/**
 * Tests for the Città di Bellinzona crawler parser.
 *
 * Tests parseBellinzonaListingHtml(), normalizeJobTitle(),
 * isTitleTooGeneric(), parseBellinzonaDate(), slugify()
 */
import { describe, it, expect } from 'vitest';
import {
  parseBellinzonaListingHtml,
  normalizeJobTitle,
  isTitleTooGeneric,
  parseBellinzonaDate,
  slugify,
  stripHtml,
  decodeHtmlEntities,
} from '@/scripts/lib/citta-di-bellinzona-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="jobs-list">
  <table>
    <tr>
      <td>
        <h3>un/a Vicedirettore/trice di zona</h3>
        <p>Pubbl. 06.03.26</p>
        <p>Termine 27.03.2026 23:59</p>
        <div>Bando di concorso</div>
        <a href="/docs/bando-vicedirettore.pdf">Scarica il documento</a>
        <a href="https://bellinz.pi-asp.de/bewerber-web/?company=*-FIRMA-ID&id=100&pId=100">Modulo di candidatura online</a>
      </td>
    </tr>
    <tr>
      <td>
        <h3>Concorso per l'assunzione di un/a tecnico/a della geomatica</h3>
        <p>Pubbl. 10.03.26</p>
        <p>Termine 31.03.2026 23:59</p>
        <a href="/docs/bando-geomatica.pdf">Scarica il documento</a>
        <a href="https://bellinz.pi-asp.de/bewerber-web/?company=*-FIRMA-ID&id=200&pId=200">Modulo di candidatura online</a>
      </td>
    </tr>
    <tr>
      <td>
        <h3>1 operatore/trice della centrale di comando</h3>
        <p>Pubbl. 12.03.26</p>
        <p>Termine 05.04.2026 23:59</p>
        <a href="/docs/bando-operatore.pdf">Scarica il documento</a>
      </td>
    </tr>
  </table>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Bellinzona crawler — title normalization', () => {
  it('strips "un/a" prefix', () => {
    expect(normalizeJobTitle('un/a Vicedirettore/trice di zona')).toBe('Vicedirettore/trice di zona');
  });

  it('strips "Concorso per l\'assunzione di" prefix', () => {
    expect(normalizeJobTitle("Concorso per l'assunzione di un/a tecnico/a della geomatica"))
      .toBe('Tecnico/a della geomatica');
  });

  it('strips leading number prefix', () => {
    expect(normalizeJobTitle('1 operatore/trice della centrale di comando'))
      .toBe('Operatore/trice della centrale di comando');
  });

  it('capitalizes first letter', () => {
    expect(normalizeJobTitle('un/a segretario/a')).toBe('Segretario/a');
  });

  it('handles empty input', () => {
    expect(normalizeJobTitle('')).toBe('');
    expect(normalizeJobTitle('   ')).toBe('');
  });
});

describe('Bellinzona crawler — generic title guard', () => {
  it('rejects bare "Concorso"', () => {
    expect(isTitleTooGeneric('Concorso')).toBe(true);
  });

  it('rejects bare "Bando"', () => {
    expect(isTitleTooGeneric('Bando')).toBe(true);
  });

  it('rejects very short titles', () => {
    expect(isTitleTooGeneric('Job')).toBe(true);
  });

  it('accepts specific titles', () => {
    expect(isTitleTooGeneric('Vicedirettore/trice di zona')).toBe(false);
  });

  it('accepts technical titles', () => {
    expect(isTitleTooGeneric('Tecnico/a della geomatica')).toBe(false);
  });
});

describe('Bellinzona crawler — date parsing', () => {
  it('rejects invalid calendar dates and partial date strings', () => {
    for (const raw of ['30.02.2025', '31.13.2025', '01.01.2025junk', 'prefix01.01.2025', '01.01.202']) {
      expect(parseBellinzonaDate(raw)).toBe('');
    }
  });

  it('keeps a valid future deadline without treating it as publication evidence', () => {
    const deadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const [year, month, day] = deadline.split('-');
    expect(parseBellinzonaDate(`${day}.${month}.${year}`)).toBe(deadline);
  });

  it('parses short year format (dd.mm.yy)', () => {
    expect(parseBellinzonaDate('06.03.26')).toBe('2026-03-06');
  });

  it('parses full year format (dd.mm.yyyy)', () => {
    expect(parseBellinzonaDate('27.03.2026')).toBe('2026-03-27');
  });

  it('leaves an empty source date unknown', () => {
    expect(parseBellinzonaDate('')).toBe('');
  });

  it('leaves an invalid source date unknown', () => {
    expect(parseBellinzonaDate('not-a-date')).toBe('');
  });
});

describe('Bellinzona crawler — listing HTML parsing', () => {
  it('extracts all 3 jobs from fixture', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('normalizes first job title correctly', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].title).toBe('Vicedirettore/trice di zona');
  });

  it('normalizes second job title — strips concorso prefix', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    const geo = jobs.find((j) => j.title.includes('geomatica'));
    expect(geo).toBeDefined();
    expect(geo!.title).not.toContain('Concorso');
  });

  it('normalizes third job title — strips leading number', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    const op = jobs.find((j) => j.title.toLowerCase().includes('operatore'));
    expect(op).toBeDefined();
    expect(op!.title).not.toMatch(/^\d/);
  });

  it('extracts PDF URLs', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].pdfUrl).toContain('bando-vicedirettore.pdf');
  });

  it('extracts the extension-less bando document link (bellinzona.ch, 2026-09-29)', () => {
    // Minimized from the live listing: the bando is served from
    // "<titolo>-<id>" (Content-Disposition …pdf), linked as "Scarica il
    // documento" under the "Bando di concorso" label, before the pi-asp form.
    const html = `<table class="ListOpenClose"><tr valign="top"><td><div class="ListBtApri"><table><tr><td><h3>un/a Agente di polizia, presso la Polizia comunale</h3></td></tr></table></div></td></tr>
      <tr valign="top"><td><div class="ListContChiuso"><table class="AssunzioniTab"><tr><td><p>Pubbl.</p></td><td>18.09.26</td></tr>
      <tr><td><p>Termine</p></td><td>05.10.2026 23:59</td></tr>
      <tr><td colspan="2"><table><tr><td><div class="">Bando di concorso</div></td></tr>
      <tr><td><table><tr><td class=""><div class=""><a href="una-Agente-di-polizia-presso-la-Polizia-comunale-47a46100" class="" target="_"></a></div></td>
      <td class=""><div class=""><a href="una-Agente-di-polizia-presso-la-Polizia-comunale-47a46100" class="" target="_">Scarica il documento</a></div></td></tr></table></td></tr></table></td></tr>
      <tr><td><div class="ObjListBtRosso"><a href="https://bellinz.pi-asp.de/bewerber-web/?company=*-FIRMA-ID&tenant=&lang=IS#position,id=64ce8328-085b-4978-8175-2d7c37391d5e,jobportalid=7d51b858-e466-400d-8696-5e01d3b26140">Modulo di candidatura online</a></div></td><td></td></tr></table></div></td></tr></table>`;
    const jobs = parseBellinzonaListingHtml(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pdfUrl).toBe('https://www.bellinzona.ch/una-Agente-di-polizia-presso-la-Polizia-comunale-47a46100');
    expect(jobs[0].applyUrl).toContain('bellinz.pi-asp.de');
  });

  it('extracts apply URLs from pi-asp.de', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].applyUrl).toContain('bellinz.pi-asp.de');
  });

  it('sets location to Bellinzona', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.location).toBe('Bellinzona'));
  });

  it('sets canton to TI', () => {
    const jobs = parseBellinzonaListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });

  it('returns empty for empty input', () => {
    expect(parseBellinzonaListingHtml('')).toHaveLength(0);
    expect(parseBellinzonaListingHtml(null as any)).toHaveLength(0);
  });
});

describe('Bellinzona crawler — slug generation', () => {
  it('generates correct slug with suffix', () => {
    const s = slugify('Vicedirettore/trice di zona', 'bellinzona');
    expect(s).toBe('vicedirettore-trice-di-zona-bellinzona');
  });

  it('truncates long slugs to 90 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long, 'bellinzona').length).toBeLessThanOrEqual(90);
  });
});
