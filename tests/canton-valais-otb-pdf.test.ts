/**
 * Canton du Valais OTB job-ad PDF description tests (issue #3836).
 *
 * The vs.ch portlet listing only carries a one-line department blurb, so
 * 13/19 crawled jobs shipped thin stub descriptions. The rich ad body lives
 * exclusively in the per-job PDF (otb.apps.vs.ch/svc/api/joboffersdocument).
 *
 * Fixtures in canton-valais-otb-pdf-lines.json are REAL positioned text
 * lines extracted live (2026-07-10) from three current job-ad PDFs via
 * extractOtbPdfLines() — one FR police ad, one FR legal ad, one DE police ad.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  formatOtbJobDescription,
  fetchOtbJobPdfDescription,
} from '../scripts/lib/canton-valais-otb-pdf.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LINE_FIXTURES: Record<string, Array<{ x: number; text: string }>> = JSON.parse(
  readFileSync(join(FIXTURES, 'canton-valais-otb-pdf-lines.json'), 'utf8'),
);

describe('formatOtbJobDescription', () => {
  it('rebuilds a rich, structured description from a real FR ad (analyste criminel)', () => {
    const text = formatOtbJobDescription(LINE_FIXTURES['analyste-criminel-fr']);

    // Rich, non-thin body
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('analyses stratégiques et opérationnelles');

    // Template sections become labelled headings
    expect(text).toMatch(/^Vos tâches:$/m);
    expect(text).toMatch(/^Votre profil:$/m);
    expect(text).toMatch(/^Entrée en fonction:$/m);

    // Indented item starts become bullet lines (audit structured-content)
    expect(/^\s*[-•*]\s/m.test(text)).toBe(true);

    // Letterhead chrome is dropped
    expect(text).not.toContain('Departement für Finanzen und Energie');
    expect(text).not.toMatch(/Sion, le \d/);
    expect(text).not.toMatch(/^Postulation en ligne: www\.vs\.ch\/jobs$/m);
  });

  it('rebuilds a structured description from a real DE ad (Einsatzdisponent)', () => {
    const text = formatOtbJobDescription(LINE_FIXTURES['einsatzdisponent-de']);

    expect(text.length).toBeGreaterThan(1000);
    expect(text).toMatch(/^Ihre Aufgaben:$/m);
    expect(text).toMatch(/^Ihr Profil:$/m);
    expect(text).toMatch(/^Arbeitsort:$/m);
    expect(/^• /m.test(text)).toBe(true);

    // Soft line-wrap hyphenation is re-joined ("Ausbil-" + "dung")
    expect(text).toContain('gleichwertige Ausbildung');
    expect(text).not.toContain('Ausbil- dung');
  });

  it('keeps the department line as the intro paragraph (juriste ad)', () => {
    const text = formatOtbJobDescription(LINE_FIXTURES['juriste-fr']);
    expect(text.startsWith('Un ou une juriste (80%)')).toBe(true);
    expect(text).toContain('auprès de la section « biodiversité, territoire et environnement »');
    expect(text).toMatch(/^Vos tâches:$/m);
  });

  it('does NOT drop in-body mentions of the HR service (only letterhead-exact lines)', () => {
    const text = formatOtbJobDescription(LINE_FIXTURES['juriste-fr']);
    // The apply paragraph legitimately mentions the HR service inline.
    expect(text).toContain('Service des ressources humaines, Place St-Théodule 15, 1951 Sion');
  });

  it('respects maxChars truncation', () => {
    const text = formatOtbJobDescription(LINE_FIXTURES['juriste-fr'], { maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('…')).toBe(true);
  });

  it('returns empty string for empty/noise-only input', () => {
    expect(formatOtbJobDescription([])).toBe('');
    expect(formatOtbJobDescription([{ x: 99, text: 'Postulation en ligne: www.vs.ch/jobs' }])).toBe('');
  });
});

describe('fetchOtbJobPdfDescription', () => {
  it('returns empty string on HTTP failure (caller falls back to listing blurb)', async () => {
    const text = await fetchOtbJobPdfDescription('https://otb.apps.vs.ch/svc/api/joboffersdocument/0?language=fr', {
      fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });
    expect(text).toBe('');
  });

  it('returns empty string when no pdfUrl is given', async () => {
    expect(await fetchOtbJobPdfDescription('')).toBe('');
  });
});
