/**
 * Tests for the Città di Locarno crawler parser.
 *
 * Tests parseLocarnoListingHtml(), normalizeJobTitle(),
 * isTitleTooGeneric(), parseLocarnoDate(), slugify()
 */
import { describe, it, expect } from 'vitest';
import {
  parseLocarnoListingHtml,
  normalizeJobTitle,
  isTitleTooGeneric,
  parseLocarnoDate,
  slugify,
  stripHtml,
  decodeHtmlEntities,
} from '@/scripts/lib/citta-di-locarno-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<ul class="job-list">
  <li>
    <p>13.03.2026</p>
    <p>
      <a href="/docs/concorso-direttrice-30.pdf">
        Concorso per l'assunzione di un/a direttrice/direttore (30%)
      </a>
      <br/>
      &#8627; <a href="https://locarno-apply.example.com/apply/101">Candidatura online</a>
    </p>
    <p>
      <a href="/docs/concorso-direttrice-30.pdf">
        <img src="icon_download_2x.png"/>
        0.2 MB
      </a>
    </p>
  </li>
  <li>
    <p>13.03.2026</p>
    <p>
      <a href="/docs/concorso-maestro-musica.pdf">
        Concorso per l'assunzione di un/a Maestro/a della Musica
      </a>
      <br/>
      &#8627; <a href="https://locarno-apply.example.com/apply/102">Candidatura online</a>
    </p>
    <p>
      <a href="/docs/concorso-maestro-musica.pdf">
        <img src="icon_download_2x.png"/>
        0.2 MB
      </a>
    </p>
  </li>
  <li>
    <p>10.03.2026</p>
    <p>
      <a href="/docs/concorso-giardiniere.pdf">
        3 giardinieri/e per il servizio parchi e giardini
      </a>
    </p>
    <p>
      <a href="/docs/concorso-giardiniere.pdf">
        <img src="icon_download_2x.png"/>
        0.3 MB
      </a>
    </p>
  </li>
  <li>
    <p>05.03.2026</p>
    <p>
      <a href="/docs/concorso-apprendista.pdf">
        1 apprendista AFC impiegato/a di commercio
      </a>
    </p>
    <p>
      <a href="/docs/concorso-apprendista.pdf">
        <img src="icon_download_2x.png"/>
        0.1 MB
      </a>
    </p>
  </li>
</ul>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Locarno crawler — title normalization', () => {
  it('strips "Concorso per l\'assunzione di un/a" prefix', () => {
    expect(normalizeJobTitle("Concorso per l'assunzione di un/a direttrice/direttore (30%)"))
      .toBe('Direttrice/direttore (30%)');
  });

  it('strips leading number prefix', () => {
    expect(normalizeJobTitle('3 giardinieri/e per il servizio parchi e giardini'))
      .toBe('Giardinieri/e per il servizio parchi e giardini');
  });

  it('strips "1 " prefix', () => {
    expect(normalizeJobTitle('1 apprendista AFC impiegato/a di commercio'))
      .toBe('Apprendista AFC impiegato/a di commercio');
  });

  it('capitalizes first letter', () => {
    expect(normalizeJobTitle('un/a segretario/a')).toBe('Segretario/a');
  });

  it('handles empty input', () => {
    expect(normalizeJobTitle('')).toBe('');
  });
});

describe('Locarno crawler — generic title guard', () => {
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
    expect(isTitleTooGeneric('Maestro/a della Musica')).toBe(false);
  });
});

describe('Locarno crawler — date parsing', () => {
  it('parses dd.mm.yyyy format', () => {
    expect(parseLocarnoDate('13.03.2026')).toBe('2026-03-13');
  });

  it('parses date with single-digit day', () => {
    expect(parseLocarnoDate('5.03.2026')).toBe('2026-03-05');
  });

  it('returns today for empty input', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(parseLocarnoDate('')).toBe(today);
  });
});

describe('Locarno crawler — listing HTML parsing', () => {
  it('extracts jobs from fixture', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it('normalizes director title — strips concorso prefix', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    const director = jobs.find((j) => j.title.includes('irettrice'));
    expect(director).toBeDefined();
    expect(director!.title).not.toContain('Concorso');
  });

  it('normalizes gardener title — strips leading number', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    const gardener = jobs.find((j) => j.title.includes('iardinieri'));
    expect(gardener).toBeDefined();
    expect(gardener!.title).not.toMatch(/^\d/);
  });

  it('extracts PDF URLs', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    const director = jobs.find((j) => j.title.includes('irettrice'));
    expect(director!.pdfUrl).toContain('concorso-direttrice-30.pdf');
  });

  it('extracts application URLs (Candidatura online)', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    const director = jobs.find((j) => j.title.includes('irettrice'));
    expect(director!.applyUrl).toContain('locarno-apply.example.com');
  });

  it('handles jobs without application URL', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    const gardener = jobs.find((j) => j.title.includes('iardinieri'));
    expect(gardener!.applyUrl).toBeNull();
  });

  it('sets location to Locarno', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.location).toBe('Locarno'));
  });

  it('sets canton to TI', () => {
    const jobs = parseLocarnoListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });

  it('returns empty for empty input', () => {
    expect(parseLocarnoListingHtml('')).toHaveLength(0);
    expect(parseLocarnoListingHtml(null as any)).toHaveLength(0);
  });
});

describe('Locarno crawler — slug generation', () => {
  it('generates correct slug with suffix', () => {
    const s = slugify('Maestro/a della Musica', 'locarno');
    expect(s).toBe('maestro-a-della-musica-locarno');
  });

  it('truncates long slugs to 90 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long, 'locarno').length).toBeLessThanOrEqual(90);
  });
});
