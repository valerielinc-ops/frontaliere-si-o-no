/**
 * LWP Ledermann Wieting & Partners crawler parser tests
 *
 * Tests extractTitleFromPdfText(), titleOverlap(), reconcilePdfTitle(),
 * parseLwphrOpenJobs(), inferLwphrLocation(), inferLwphrCategory()
 * using HTML and text fixtures.
 *
 * Regression case: "web-developer-lwp-ledermann-wieting-partners-lugano"
 *   Page link text was "WEB DEVELOPER" (generic uppercase)
 *   PDF heading was "Full Stack Developer" (specific, title-cased)
 *   Overlap = 1/4 = 0.25 < 0.7 → should prefer PDF heading
 */
import { describe, it, expect } from 'vitest';

import {
  extractTitleFromPdfText,
  reconcilePdfTitle,
  titleOverlap,
  parseLwphrOpenJobs,
  inferLwphrLocation,
  inferLwphrCategory,
  MIN_TITLE_OVERLAP,
} from '@/scripts/lib/lwphr-job-parser.mjs';

// ─── Fixtures: PDF text ────────────────────────────────────────────────────

// Regression: page says "WEB DEVELOPER", PDF heading says "Full Stack Developer"
const PDF_TEXT_WEB_DEV = `LWP LEDERMANN WIETING & PARTNERS

Full Stack Developer

LWP Ledermann Wieting & Partners is looking for a talented Full Stack Developer for a leading client based in Lugano.

Responsibilities:
- Develop and maintain web applications using React and Node.js
- Collaborate with cross-functional teams to define and implement new features
- Write clean, maintainable code with unit tests

Requirements:
- 3+ years of experience in full-stack development
- Strong proficiency in JavaScript/TypeScript
- Experience with cloud platforms (AWS, GCP, or Azure)
- Excellent communication skills in English and Italian`;

// PDF where title is already well-aligned with page link
const PDF_TEXT_HR_SPECIALIST = `LWP HR CONSULTING

HR Specialist

We are seeking an experienced HR Specialist to join our client's HR department in Lugano.

Your responsibilities will include:
- Managing recruitment and onboarding processes
- Supporting HR administration tasks
- Advising managers on HR policies

Your profile:
- Degree in HR, Business Administration or equivalent
- Minimum 3 years of HR experience
- Fluent in Italian and English`;

// PDF with all-caps first paragraph (company header) before actual title
const PDF_TEXT_WITH_CAPS_HEADER = `LWP LEDERMANN WIETING & PARTNERS LUGANO

Senior Financial Analyst

Our client, a leading financial services firm in Lugano, is seeking a Senior Financial Analyst.

Main tasks:
- Prepare financial reports and forecasts
- Conduct variance analysis
- Support the CFO in strategic planning`;

// PDF where first meaningful line is a bullet (no clean title line)
const PDF_TEXT_BULLET_FIRST = `- Gestire le operazioni quotidiane
- Supportare il team di vendita
- Contribuire alla crescita aziendale

Sales Manager

Profilo ricercato: esperienza nel settore vendite.`;

// PDF with no title-like line (all lines too long or bullets)
const PDF_TEXT_NO_TITLE = `LWP LEDERMANN WIETING & PARTNERS STA CERCANDO UN CANDIDATO CON ESPERIENZA

- Più di 5 anni nel settore bancario e finanziario con competenze specializzate
- Capacità di gestire portafogli clienti di grandi dimensioni
- Esperienza con sistemi informatici avanzati e piattaforme digitali`;

// ─── Fixtures: HTML page ───────────────────────────────────────────────────

const FIXTURE_CAREERS_HTML = `<!DOCTYPE html>
<html lang="it">
<head><title>Opportunità | LWP HR</title></head>
<body>
<div class="accordion">
  <div class="accordion__item">
    <div class="accordion__label">Posizioni chiuse</div>
    <div class="accordion__content">
      <a href="/uploads/1/4/6/5/146598773/old_role.pdf">Posizione chiusa</a>
    </div>
  </div>
  <div class="accordion__item">
    <div class="accordion__label">Posizioni Aperte / Open Positions</div>
    <div class="accordion__content">
      <a href="/uploads/1/4/6/5/146598773/web_developer.pdf">WEB DEVELOPER</a>
      <a href="/uploads/1/4/6/5/146598773/hr_specialist.pdf">HR Specialist</a>
      <a href="/uploads/1/4/6/5/146598773/hr_specialist.pdf">HR Specialist</a>
    </div>
  </div>
</div>
</body>
</html>`;

// ─── extractTitleFromPdfText ───────────────────────────────────────────────

describe('extractTitleFromPdfText', () => {
  it('extracts the first title-cased heading, skipping all-caps company header', () => {
    expect(extractTitleFromPdfText(PDF_TEXT_WEB_DEV)).toBe('Full Stack Developer');
  });

  it('extracts title when it immediately follows company header', () => {
    expect(extractTitleFromPdfText(PDF_TEXT_WITH_CAPS_HEADER)).toBe('Senior Financial Analyst');
  });

  it('extracts title when no caps header precedes it', () => {
    expect(extractTitleFromPdfText(PDF_TEXT_HR_SPECIALIST)).toBe('HR Specialist');
  });

  it('skips bullet-prefixed first lines and finds a later title', () => {
    // After bullets, "Sales Manager" is the first valid short title
    expect(extractTitleFromPdfText(PDF_TEXT_BULLET_FIRST)).toBe('Sales Manager');
  });

  it('returns empty string when no valid title line exists', () => {
    expect(extractTitleFromPdfText(PDF_TEXT_NO_TITLE)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractTitleFromPdfText('')).toBe('');
    expect(extractTitleFromPdfText(null as any)).toBe('');
  });

  it('does not return a line longer than 80 characters', () => {
    const longLine =
      'This is a very long line that exceeds the maximum title length limit and should not be considered as a job title by the extractor';
    const pdf = `${longLine}\n\nShort Title\n\nSome body text.`;
    expect(extractTitleFromPdfText(pdf)).toBe('Short Title');
  });

  it('does not return a single-word line', () => {
    const pdf = `Engineer\n\nSoftware Engineer\n\nSome body text here.`;
    expect(extractTitleFromPdfText(pdf)).toBe('Software Engineer');
  });
});

// ─── titleOverlap ─────────────────────────────────────────────────────────

describe('titleOverlap', () => {
  it(`has a MIN_TITLE_OVERLAP of ${MIN_TITLE_OVERLAP}`, () => {
    expect(MIN_TITLE_OVERLAP).toBe(0.7);
  });

  it('returns 1 for identical titles', () => {
    expect(titleOverlap('HR Specialist', 'HR Specialist')).toBe(1);
  });

  it('returns 1 for both empty strings', () => {
    expect(titleOverlap('', '')).toBe(1);
  });

  it('returns 0 if one title is empty', () => {
    expect(titleOverlap('HR Specialist', '')).toBe(0);
    expect(titleOverlap('', 'HR Specialist')).toBe(0);
  });

  it('returns high overlap for synonymous titles (same key words)', () => {
    // "HR Specialist Lugano" vs "HR Specialist" → {hr, specialist} / {hr, specialist, lugano} = 2/3 ≈ 0.67
    const overlap = titleOverlap('HR Specialist Lugano', 'HR Specialist');
    expect(overlap).toBeGreaterThan(0.6);
  });

  it('returns low overlap for clearly different titles — regression WEB DEVELOPER vs Full Stack Developer', () => {
    // {web, developer} vs {full, stack, developer} → intersection: {developer} = 1
    // union: {web, developer, full, stack} = 4 → 1/4 = 0.25
    expect(titleOverlap('WEB DEVELOPER', 'Full Stack Developer')).toBeLessThan(MIN_TITLE_OVERLAP);
  });

  it('is case-insensitive', () => {
    expect(titleOverlap('HR Specialist', 'hr specialist')).toBe(1);
  });

  it('ignores punctuation', () => {
    expect(titleOverlap('HR-Specialist', 'HR Specialist')).toBe(1);
  });
});

// ─── reconcilePdfTitle ────────────────────────────────────────────────────

describe('reconcilePdfTitle', () => {
  it('falls back to pageTitle when pdfTitle is empty', () => {
    expect(reconcilePdfTitle('WEB DEVELOPER', '')).toBe('WEB DEVELOPER');
  });

  it('uses pageTitle when overlap >= 0.7 (same role, cleaner page text)', () => {
    // "HR Specialist" vs "HR Specialist" → overlap 1.0 → keep pageTitle
    expect(reconcilePdfTitle('HR Specialist', 'HR Specialist')).toBe('HR Specialist');
  });

  it('prefers pdfTitle when overlap < 0.7 — regression: WEB DEVELOPER vs Full Stack Developer', () => {
    expect(reconcilePdfTitle('WEB DEVELOPER', 'Full Stack Developer')).toBe('Full Stack Developer');
  });

  it('prefers pdfTitle when page title is a generic uppercase label', () => {
    expect(reconcilePdfTitle('OPEN POSITION', 'Senior Financial Analyst')).toBe('Senior Financial Analyst');
  });
});

// ─── parseLwphrOpenJobs ───────────────────────────────────────────────────

describe('parseLwphrOpenJobs', () => {
  it('finds jobs only in the open positions accordion', () => {
    const jobs = parseLwphrOpenJobs(FIXTURE_CAREERS_HTML);
    // Should find 2 unique jobs (not the "closed" one)
    expect(jobs).toHaveLength(2);
  });

  it('extracts titles from link text', () => {
    const jobs = parseLwphrOpenJobs(FIXTURE_CAREERS_HTML);
    const titles = jobs.map((j: any) => j.title);
    expect(titles).toContain('WEB DEVELOPER');
    expect(titles).toContain('HR Specialist');
  });

  it('deduplicates jobs with the same title and URL', () => {
    const jobs = parseLwphrOpenJobs(FIXTURE_CAREERS_HTML);
    const hrJobs = jobs.filter((j: any) => j.title === 'HR Specialist');
    expect(hrJobs).toHaveLength(1);
  });

  it('generates absolute PDF URLs', () => {
    const jobs = parseLwphrOpenJobs(FIXTURE_CAREERS_HTML);
    for (const job of jobs) {
      expect((job as any).pdfUrl).toMatch(/^https?:\/\//);
    }
  });

  it('throws when no open positions accordion is found', () => {
    const emptyHtml = '<html><body><div class="accordion__item"><div class="accordion__label">Closed</div></div></body></html>';
    expect(() => parseLwphrOpenJobs(emptyHtml)).toThrow();
  });
});

// ─── inferLwphrLocation ───────────────────────────────────────────────────

describe('inferLwphrLocation', () => {
  it('extracts Lugano when mentioned in title', () => {
    expect(inferLwphrLocation('HR Specialist Lugano', '')).toBe('Lugano');
  });

  it('extracts Lugano when mentioned in PDF text', () => {
    expect(inferLwphrLocation('HR Specialist', 'based in Lugano')).toBe('Lugano');
  });

  it('extracts Locarno when mentioned', () => {
    expect(inferLwphrLocation('Manager', 'office in Locarno')).toBe('Locarno');
  });

  it('defaults to Lugano when no location found', () => {
    expect(inferLwphrLocation('Software Engineer', 'No location mentioned here.')).toBe('Lugano');
  });
});

// ─── inferLwphrCategory ───────────────────────────────────────────────────

describe('inferLwphrCategory', () => {
  it('returns "tech" for developer roles', () => {
    expect(inferLwphrCategory('Full Stack Developer', '')).toBe('tech');
  });

  it('returns "finance" for financial analyst roles', () => {
    expect(inferLwphrCategory('Senior Financial Analyst', '')).toBe('finance');
  });

  it('returns "admin" for HR specialist roles', () => {
    expect(inferLwphrCategory('HR Specialist', '')).toBe('admin');
  });

  it('returns "other" when no category matches', () => {
    expect(inferLwphrCategory('Generic Role', 'Some generic job description.')).toBe('other');
  });
});
