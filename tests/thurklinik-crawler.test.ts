import { describe, it, expect } from 'vitest';
import {
  THURKLINIK_KEY,
  THURKLINIK_COMPANY_NAME,
  THURKLINIK_CAREERS_URL,
  isThurklinikJob,
  isTrustedDomain,
  parseListing,
  parseDetailPage,
  cleanThurklinikTitle,
  buildThurklinikDescription,
  THURKLINIK_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/thurklinik-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { buildPdfBackedDescription } from '../scripts/lib/pdf-job-content.mjs';

const FIXTURE_HTML = `
<div class="content">
  <h2>STELLEN</h2>
  <a href="https://thurklinik.ch/wp-content/uploads/2025/11/Dipl.-Anaesthesiepflegerin-oder-Anaesthesiepfleger-60-%E2%80%93-80.pdf">Dipl. Anästhesiepflegerin oder Anästhesiepfleger 60 – 80%</a>
  <a href="https://thurklinik.ch/wp-content/uploads/2025/01/Stellenbeschreibung-GYN.pdf">Facharzt*ärztin Gynäkologie</a>
  <a href="https://thurklinik.ch/wp-content/uploads/2026/03/Lagerungspflege-Springer-m_w_d-20-80_Thurklinik.pdf">Lagerungspflege &amp; Springer (m/w/d) 20-80%</a>
  <a href="https://thurklinik.ch/wp-content/uploads/2025/09/Spontanbewerbung-dipl.pdf">Spontanbewerbung: Dipl. Pflegefachperson HF (40 % – 80 %) / MO – FR</a>
</div>
`;

const CURRENT_FIXTURE_HTML = `
<main>
  <a href="/stellen/">Stellen</a>
  <a href="/stellen/belegaerztinnen-belegaerzte/">Belegärztinnen und Belegärzte gesucht</a>
  <a href="https://thurklinik.ch/stellen/leitung-op-fachperson-operationstechnik/">Leitung OP: Dipl. Fachperson Operationstechnik HF oder TOA 60–100 %</a>
  <a href="/stellen/spontanbewerbung-pflegefachperson-hf/">Dipl. Pflegefachperson HF, Montag bis Freitag 40–80 %</a>
  <a href="https://other.example/stellen/unrelated/">Unrelated job</a>
</main>
`;

const DETAIL_FIXTURE_HTML = `
<html>
  <body>
    <header>Site header</header>
    <main>
      <nav class="breadcrumbs">Home / Stellen</nav>
      <h1>Fachperson Operationstechnik HF oder TOA (20–80 %)</h1>
      <div class="job-meta">20–80 % Niederuzwil SG Operationsbereich</div>
      <div class="entry-content">
        <p>Zur Verstärkung unseres OP-Teams suchen wir eine engagierte Fachperson mit Freude an interdisziplinärer Zusammenarbeit.</p>
        <h2>Ihre Aufgaben</h2>
        <ul><li>Instrumentation und Zudienung bei operativen Eingriffen</li><li>Umsetzung von Hygiene- und Qualitätsstandards</li></ul>
      </div>
      <a href="/stellen/">← Zurück zu allen Stellen</a>
    </main>
    <footer>Site footer</footer>
  </body>
</html>
`;

describe('Thurklinik crawler parser', () => {
  it('exports valid constants', () => {
    expect(THURKLINIK_KEY).toBe('thurklinik');
    expect(THURKLINIK_COMPANY_NAME).toBe('Thurklinik');
    expect(THURKLINIK_CAREERS_URL).toMatch(/^https:\/\/thurklinik\.ch\/stellen\//);
  });

  describe('isThurklinikJob', () => {
    it('matches by companyKey', () => {
      expect(isThurklinikJob({ companyKey: 'thurklinik' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isThurklinikJob({ url: 'https://thurklinik.ch/wp/x.pdf' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isThurklinikJob(null)).toBe(false);
      expect(isThurklinikJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts thurklinik.ch', () => {
      expect(isTrustedDomain('https://thurklinik.ch/x')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://other.ch')).toBe(false);
    });
  });

  describe('cleanThurklinikTitle', () => {
    it('strips "Spontanbewerbung:" prefix', () => {
      expect(cleanThurklinikTitle('Spontanbewerbung: Dipl. Pflegefachperson HF (40 – 80%)')).toBe(
        'Dipl. Pflegefachperson HF (40 – 80%)'
      );
    });
    it('strips (m/w/d) variant suffix', () => {
      expect(cleanThurklinikTitle('Lagerungspflege (m/w/d) 20-80%')).toBe(
        'Lagerungspflege 20-80%'
      );
    });
    it('decodes HTML entities', () => {
      expect(cleanThurklinikTitle('Lagerungspflege &amp; Springer 20-80%')).toBe(
        'Lagerungspflege & Springer 20-80%'
      );
    });
  });

  describe('parseListing', () => {
    it('extracts legacy PDF anchors with their visible titles', () => {
      const rows = parseListing(FIXTURE_HTML);
      expect(rows.length).toBe(4);
      expect(rows[0].title).toMatch(/^Dipl\. Anästhesiepflegerin/);
      expect(rows[1].title).toBe('Facharzt*ärztin Gynäkologie');
    });
    it('extracts current detail links and rejects listing/non-Thurklinik paths', () => {
      const rows = parseListing(CURRENT_FIXTURE_HTML);
      expect(rows.map((row) => row.detailUrl)).toEqual([
        'https://thurklinik.ch/stellen/belegaerztinnen-belegaerzte/',
        'https://thurklinik.ch/stellen/leitung-op-fachperson-operationstechnik/',
        'https://thurklinik.ch/stellen/spontanbewerbung-pflegefachperson-hf/',
      ]);
      expect(rows.filter((row) => row.isSpontaneous)).toHaveLength(1);
    });
    it('flags Spontanbewerbung anchors via isSpontaneous', () => {
      const rows = parseListing(FIXTURE_HTML);
      const sponti = rows.filter((r) => r.isSpontaneous);
      const real = rows.filter((r) => !r.isSpontaneous);
      expect(sponti.length).toBe(1);
      expect(real.length).toBe(3);
    });
    it('cleans the Spontanbewerbung prefix from the title', () => {
      const rows = parseListing(FIXTURE_HTML);
      const sponti = rows.find((r) => r.isSpontaneous);
      expect(sponti?.title.toLowerCase()).not.toMatch(/^spontanbewerbung:/);
    });
    it('dedupes identical PDF URLs', () => {
      const html =
        '<a href="https://thurklinik.ch/wp/x.pdf">Pflege 80%</a><a href="https://thurklinik.ch/wp/x.pdf">Pflege 80%</a>';
      expect(parseListing(html).length).toBe(1);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('parseDetailPage', () => {
    it('keeps the vacancy body and excludes page chrome', () => {
      const detail = parseDetailPage(DETAIL_FIXTURE_HTML);
      expect(detail.title).toBe('Fachperson Operationstechnik HF oder TOA (20–80 %)');
      expect(detail.description).toContain('Zur Verstärkung unseres OP-Teams');
      expect(detail.description).toContain('• Instrumentation und Zudienung');
      expect(detail.description).not.toContain('Site header');
      expect(detail.description).not.toContain('Site footer');
      expect(detail.description).not.toContain('Zurück zu allen Stellen');
    });
    it('fails closed when the page has no semantic vacancy root', () => {
      expect(parseDetailPage('<body><h1>Stelle</h1><p>Navigation only</p></body>')).toEqual({
        title: 'Stelle',
        description: '',
      });
    });
  });

  describe('buildThurklinikDescription', () => {
    // Only the PDF's own text (#5253): no intro on the clinic, no "Stelle:"
    // line, no "Quelle (PDF)" / "Karriereseite" / "Spital:" footer.
    it('publishes the PDF text alone', () => {
      const body = 'Aufgaben: OP-Assistenz, Schmerztherapie. '.repeat(15);
      const out = buildThurklinikDescription({ pdfText: body });
      expect(out).toBe(buildPdfBackedDescription({ pdfText: body }));
      expect(out).toContain('Aufgaben');
      expect(out).not.toMatch(THURKLINIK_FABRICATED_DESCRIPTION_RE);
      expect(out).not.toMatch(/Belegspital-Tagesklinik|Quelle \(PDF\)|Karriereseite/);
    });
    it('writes no description of its own when the PDF text is empty', () => {
      expect(buildThurklinikDescription({ pdfText: '' })).toBe('');
    });
    it('normalizes source text from the current HTML detail page', () => {
      const detailText = 'Aufgaben: OP-Assistenz. '.repeat(15);
      expect(buildThurklinikDescription({ detailText })).toBe(
        buildPdfBackedDescription({ pdfText: detailText }),
      );
    });
    it('caps output length below 7000 chars', () => {
      const out = buildThurklinikDescription({
        title: 'X',
        pdfText: 'A'.repeat(20000),
        pdfUrl: 'https://thurklinik.ch/wp/x.pdf',
      });
      expect(out.length).toBeLessThanOrEqual(7000);
    });
  });

  describe('slugify', () => {
    it('handles German diacritics + slash + percent', () => {
      expect(slugify('Dipl. Anästhesiepflegerin oder Anästhesiepfleger 60 – 80%')).toBe(
        'dipl-anasthesiepflegerin-oder-anasthesiepfleger-60-80'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
