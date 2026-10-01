import { describe, expect, it } from 'vitest';
import { parseClinicaHildebrandListing } from '../scripts/lib/clinica-hildebrand-job-parser.mjs';
import { parseRehaAndeerListing } from '../scripts/lib/reha-andeer-job-parser.mjs';
import { parseClinicaVariniListing } from '../scripts/lib/clinica-varini-job-parser.mjs';
import { extractPdfLinks } from '../scripts/lib/hospital-custom-html-helpers.mjs';

describe('PDF-backed HTML listing parsers', () => {
  it('normalizes Reha Andeer PDF links across HTML quoting and URL shapes', () => {
    const html = [
      "<a href='/wp-content/uploads/2026/07/Stelleninserat-Pflegehelferin.pdf?download=1#page=1'>Pflege</a>",
      '<a href="./wp-content/uploads/2026/07/2026_Stelleninserat-med.-Masseurin.PDF">Massage</a>',
      '<a href="https://elsewhere.example/wp-content/uploads/2026/07/other.pdf">Foreign</a>',
    ].join('');

    expect(parseRehaAndeerListing(html)).toEqual([
      expect.objectContaining({
        title: 'Pflegehelferin',
        pdfUrl: 'https://reha-andeer.ch/wp-content/uploads/2026/07/Stelleninserat-Pflegehelferin.pdf?download=1#page=1',
        filename: 'Stelleninserat-Pflegehelferin.pdf',
      }),
      expect.objectContaining({
        title: 'Med. Masseurin',
        pdfUrl: 'https://reha-andeer.ch/de/reha-andeer/wp-content/uploads/2026/07/2026_Stelleninserat-med.-Masseurin.PDF',
        filename: '2026_Stelleninserat-med.-Masseurin.PDF',
      }),
    ]);
  });

  it('skips malformed href entities without aborting later PDF links', () => {
    expect(extractPdfLinks(
      '<a href="/ok.pdf"></a><a href="/bad?x=&#x110000;"></a>',
      'https://reha-andeer.ch/offene-stellen/',
    )).toEqual([
      { href: 'https://reha-andeer.ch/ok.pdf', filename: 'ok.pdf' },
    ]);
  });

  it('extracts PDF URLs only from actual anchor href attributes', () => {
    expect(extractPdfLinks(
      '<div data-href="/wp-content/uploads/fake.pdf"></div><a href="/wp-content/uploads/real.pdf"></a>',
      'https://reha-andeer.ch/offene-stellen/',
    )).toEqual([
      {
        href: 'https://reha-andeer.ch/wp-content/uploads/real.pdf',
        filename: 'real.pdf',
      },
    ]);
  });

  it('allows the opposite quote character inside a quoted PDF URL', () => {
    expect(extractPdfLinks(
      '<a href="/wp-content/uploads/l\'pflege.pdf"></a>',
      'https://reha-andeer.ch/offene-stellen/',
    )).toEqual([
      {
        href: "https://reha-andeer.ch/wp-content/uploads/l'pflege.pdf",
        filename: "l'pflege.pdf",
      },
    ]);
  });

  it('keeps sibling rehabilitation PDF parsers on the same resolved-link contract', () => {
    expect(parseClinicaHildebrandListing([
      "<a href='./uploads/2026/Pflegefachperson.PDF?download=1'>Pflege</a>",
      '<a href="/uploads/2026/privacy.pdf">Privacy</a>',
    ].join(''))).toEqual([
      expect.objectContaining({
        pdfUrl: 'https://www.clinica-hildebrand.ch/uploads/2026/Pflegefachperson.PDF?download=1',
        filename: 'Pflegefachperson.PDF',
      }),
    ]);

    expect(parseClinicaVariniListing([
      "<a href='/wp-content/uploads/2026/concorso_infermiere.pdf?download=1'>Concorso</a>",
      '<a href="/wp-content/uploads/2026/comunicato.pdf">News</a>',
    ].join(''))).toEqual([
      expect.objectContaining({
        pdfUrl: 'https://clinicavarini.ch/wp-content/uploads/2026/concorso_infermiere.pdf?download=1',
        filename: 'concorso_infermiere.pdf',
      }),
    ]);
  });
});
