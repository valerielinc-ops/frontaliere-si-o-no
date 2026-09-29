import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSpitexEmployerSectionsHtml } from '../scripts/lib/spitex-ch-job-parser.mjs';
import { htmlToText } from '../scripts/lib/hospital-custom-html-helpers.mjs';

// Real spitexjobs.ch page, minimised (three benefit cards; contact anonymised):
// J990528, Spitex Burgdorf-Oberburg. Its JobPosting JSON-LD carries the intro
// and the role lists only; the portrait and the benefit cards are page sections.
const J990528 = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-quality-f', 'spitex-J990528.html'),
  'utf8',
);

describe('extractSpitexEmployerSectionsHtml (#5253)', () => {
  const text = htmlToText(extractSpitexEmployerSectionsHtml(J990528));

  it('adds the organisation portrait under the page label', () => {
    expect(text).toMatch(/Porträt\s+Die Spitex Burgdorf-Oberburg ist zusammen mit ihrer Tochtergesellschaft/);
  });

  it('turns every benefit card into one bullet with its heading and text', () => {
    expect(text).toContain('Benefits');
    expect(text).toContain('• Flexible Arbeitszeiten: Jahresarbeitszeit für alle Mitarbeitenden.');
    expect(text).toContain('• Ferien Plus: Grundguthaben 25 Ferientage.');
  });

  it('does not read the icons\' <line> elements as empty list items', () => {
    expect(J990528).toContain('<line');
    expect(text).not.toMatch(/•\s*•/);
    expect(text).not.toMatch(/^\s*•\s*$/m);
  });

  it('leaves the contact person, the job abstract and the metadata out', () => {
    expect(text).not.toContain('Leiterin Pflege');
    expect(text).not.toContain('Kontakt');
    expect(text).not.toContain('Individuelle und ganzheitliche Betreuung');
  });

  it('returns nothing for a page without the employer sections', () => {
    expect(extractSpitexEmployerSectionsHtml('<html><body><p>x</p></body></html>')).toBe('');
  });
});
