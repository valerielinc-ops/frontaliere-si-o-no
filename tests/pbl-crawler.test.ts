/**
 * Psychiatrie Baselland (PBL) — description of one vacancy from its detail page.
 *
 * Audit 2026-09-29 (issue #5253): the parser published four id-scoped sections,
 * flattened to prose (29-42 % of the rendered vacancy, 50/50 without lists),
 * and cut its fallback at 6000 characters. Fixture: real detail page, minimized
 * (scripts/media removed, contact names replaced).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPblDetailDescription } from '../scripts/lib/pbl-job-parser.mjs';

const html = readFileSync(
  path.resolve(process.cwd(), 'tests/fixtures/prospective-detail/pbl-unterassistenz.html'),
  'utf8',
);

describe('buildPblDetailDescription', () => {
  it('publishes the rendered vacancy with its lists and the page-only sections', () => {
    const description = buildPblDetailDescription(html, {
      title: 'Unterassistentin / Unterassistent (m/w/d)',
      fallbackTeaser: 'teaser',
    });
    expect(description).toContain('## Ihre Aufgaben');
    expect(description).toMatch(/^• Ab 3\. bis 4\. Studienjahr der Humanmedizin$/m);
    expect(description).toContain('## Unser Angebot');
    expect(description).toContain('## Über uns');
    expect(description).not.toMatch(/Ina Muster|Kim Beispiel/);
  });

  it('keeps a long section whole when the page text is not usable (no character cap)', () => {
    // The rendered text is unreadable here (the vacancy sits in <noscript>,
    // which the page reader drops), so the id-scoped sections are the body.
    const items = Array.from(
      { length: 250 },
      (_, index) => `<li>Aufgabe ${index + 1}: Betreuung und Dokumentation im stationären Setting</li>`,
    ).join('');
    const page = `<html><body><noscript>
      <section id="tasks"><h3>Ihre Aufgaben</h3><ul>${items}</ul></section>
      <section id="profile"><h3>Ihr Profil</h3><p>Abgeschlossenes Studium der Humanmedizin.</p></section>
    </noscript></body></html>`;

    const description = buildPblDetailDescription(page, { fallbackTeaser: 'teaser' });

    expect(description.length).toBeGreaterThan(6000);
    expect(description).toContain('Aufgabe 250: Betreuung und Dokumentation im stationären Setting');
    expect(description).toContain('Abgeschlossenes Studium der Humanmedizin.');
  });

  it('falls back to the listing teaser when the page carries no vacancy section', () => {
    expect(buildPblDetailDescription('<html><body><p>Seite nicht gefunden</p></body></html>', {
      fallbackTeaser: 'Unterassistenz — Psychiatrie Baselland, Liestal.',
    })).toBe('Unterassistenz — Psychiatrie Baselland, Liestal.');
  });
});
