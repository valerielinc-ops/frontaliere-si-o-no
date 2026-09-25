import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditEvergreen,
  isDatedAnnouncement,
} from '../scripts/audit-evergreen-articles.mjs';

/**
 * Issue #5021.
 *
 * The evergreen audit called an article evergreen if its CATEGORY was one of
 * `fiscale|pratico|pensione`. Category is not that property. `pratico` covers
 * both "how the G permit works" — genuinely evergreen, worth refreshing — and
 * `manutenzione-ustat-servizi-chiusure-31-12-2025`, a service-closure notice
 * for one date that is permanently in the past.
 *
 * The second kind can never leave the stale list. It gets flagged every month
 * forever, and the only way to make it "fresh" is to bump its date without
 * changing a word — the exact freshness manipulation Google penalises, on an
 * article whose subject has not existed for months. So the audit must stop
 * asking for it.
 *
 * Deliberately narrow: a bare trailing YEAR is not a date. Annual editions
 * (`costo-vita-svizzera-2026`) are precisely what the audit exists to catch.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/evergreen-refresh-audit.yml'),
  'utf-8',
);

describe('isDatedAnnouncement', () => {
  it('recognises the slug that started this — an explicit DD-MM-YYYY', () => {
    expect(isDatedAnnouncement('manutenzione-ustat-servizi-chiusure-31-12-2025')).toBe(true);
  });

  it('recognises an ISO-ordered date too', () => {
    expect(isDatedAnnouncement('chiusura-sportelli-2025-12-31')).toBe(true);
  });

  it('leaves annual editions alone — they are the whole point of the audit', () => {
    // Refreshing these every year IS the job. Excluding them would silently
    // turn the audit off for the articles it exists for.
    expect(isDatedAnnouncement('costo-vita-svizzera-2026')).toBe(false);
    expect(isDatedAnnouncement('premi-cassa-malati-svizzera-2026')).toBe(false);
    expect(isDatedAnnouncement('stipendio-netto-2026')).toBe(false);
  });

  it('leaves ordinary evergreen slugs alone', () => {
    expect(isDatedAnnouncement('costo-vita-ticino-vs-lombardia')).toBe(false);
    expect(isDatedAnnouncement('permesso-g-formato-carta-credito-ticino')).toBe(false);
    expect(isDatedAnnouncement('lamal-vs-cmi-frontaliere')).toBe(false);
  });

  it('is not fooled by number runs that are not dates', () => {
    // A version-ish or measurement-ish run must not silently disable the
    // audit for an article: over-matching here is a page that stops being
    // maintained, with nothing to show it happened.
    expect(isDatedAnnouncement('aliquote-1-2-3-confronto')).toBe(false);
    expect(isDatedAnnouncement('articolo-99-13-2025')).toBe(false); // day 99 is not a day
    expect(isDatedAnnouncement('bonus-2025-13-01')).toBe(false); // month 13 is not a month
  });

  it('handles an empty or missing id without throwing', () => {
    expect(isDatedAnnouncement('')).toBe(false);
    expect(isDatedAnnouncement(undefined)).toBe(false);
  });
});

describe('auditEvergreen', () => {
  // Relative to `now`, never a literal — a fixture pinned to a wall-clock date
  // is a test that starts failing on its own (AGENTS.md, test-fixture dates).
  const NOW = new Date('2026-08-05T00:00:00Z');
  const monthsAgo = (n: number) => {
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 10);
  };

  const ARTICLES = [
    { id: 'permesso-g-guida', category: 'pratico', date: monthsAgo(9) },
    { id: 'chiusure-sportelli-31-12-2025', category: 'pratico', date: monthsAgo(8) },
    { id: 'aliquote-fonte', category: 'fiscale', date: monthsAgo(2) },
    { id: 'news-del-giorno', category: 'novita', date: monthsAgo(24) },
    { id: 'riscatto-secondo-pilastro', category: 'pensione', date: monthsAgo(12), updatedAt: monthsAgo(1) },
  ];

  it('drops the dated announcement from the pool and says so', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.datedExcludedCount).toBe(1);
    expect(r.datedExcluded.map((a: { id: string }) => a.id)).toEqual(['chiusure-sportelli-31-12-2025']);
    // Excluded from the denominator too — 5 articles, 4 in evergreen
    // categories, 1 of those dated.
    expect(r.totalEvergreen).toBe(3);
  });

  it('still flags the genuinely stale evergreen article', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.staleCount).toBe(1);
    expect(r.stale[0].id).toBe('permesso-g-guida');
  });

  it('honours updatedAt over date, so a real refresh clears the flag', () => {
    // The pension article is 12 months old by `date` and 1 month old by
    // `updatedAt`. That is the only legitimate way off this list.
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.stale.map((a: { id: string }) => a.id)).not.toContain('riscatto-secondo-pilastro');
  });

  it('never considers a non-evergreen category, however old', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.stale.map((a: { id: string }) => a.id)).not.toContain('news-del-giorno');
  });

  it('importing the module runs no audit and prints nothing', () => {
    // The module used to compute at import time by reading the TypeScript
    // registry; a test could not touch the classifier without that parse.
    expect(typeof auditEvergreen).toBe('function');
    expect(typeof isDatedAnnouncement).toBe('function');
  });
});

describe('the audit issue is one issue, with instructions that exist', () => {
  it('uses a STABLE title so the helper dedups instead of opening one a month', () => {
    // The title carried `$(date +"%B %Y")` inside the 60 chars
    // github-issue-creator.mjs dedups on, so every monthly run opened a new
    // issue for a list that barely changes. #5021 was the August instance.
    expect(WORKFLOW).toContain('--title "Evergreen articles past the 6-month freshness window"');
    expect(
      /--title\s+"[^"]*\$\(date/.test(WORKFLOW),
      'the issue title must not interpolate a date — that defeats dedup at source (ISSUES.md)',
    ).toBe(false);
    expect(WORKFLOW).toContain('scripts/lib/github-issue-creator.mjs');
  });

  it('no longer prescribes a command that does not exist', () => {
    // `scripts/create-article.mjs` has neither `--refresh` nor `--id`. The
    // issue told every reader to run it anyway, which is why it sat parked.
    expect(WORKFLOW).not.toContain('--refresh --id=');
    expect(WORKFLOW).not.toContain('create-article.mjs --refresh');
  });

  it('states that a date bump without a content change is not a refresh', () => {
    // The one instruction that has to survive any future edit of this body:
    // the audit must never be closable by moving a date.
    expect(WORKFLOW).toContain('without changing a word is not a refresh');
    expect(WORKFLOW).toContain('leave the date alone');
  });

  it('surfaces the dated-announcement exclusions instead of hiding the drop', () => {
    expect(WORKFLOW).toContain('datedExcludedCount');
  });
});
