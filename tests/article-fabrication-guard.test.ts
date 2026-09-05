/**
 * article-fabrication-guard.test.ts
 *
 * Scans ALL blog body files (blog-body + blog-body-ch, all 4 locales) for
 * known hallucination patterns:
 * - Fabricated Swiss/Italian laws and legal references
 * - Fabricated institutions and acronyms
 * - Known incorrect facts (wrong convention dates, fake tax rates)
 * - Fabricated statistics (unsourced precise percentages)
 *
 * This test acts as a permanent safety net: any article containing
 * fabricated content will fail the test suite and block deployment.
 *
 * IT ONLY RUNS IN THE FULL SUITE (`npm test`), which never sees article
 * bodies landing through `sync-articles-sitemaps.yml` — that job commits
 * straight to `main` with no PR (verified 2026-08-11: zero `push` check-runs
 * on a sync commit). Issue #5671: two fabricated-institution incidents shipped
 * through exactly that gap in one day and only surfaced as `main` going red on
 * unrelated PRs, hours later. The patterns below now also run at sync time,
 * scoped to the delta, via scripts/ci/report-synced-article-fabrication.mjs —
 * both import scripts/lib/article-fabrication-patterns.mjs so there is one
 * definition, not two that can drift apart (AGENTS.md #6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEscalatableFinding, buildFindingsIssue } from '../scripts/ci/report-synced-article-fabrication.mjs';
import {
  FABRICATED_INSTITUTIONS,
  FABRICATED_ACRONYMS,
  INCORRECT_FACTS,
  VAGUE_SOURCING,
  FABRICATED_LABOR_OFFICE,
  extractTextContentFromSource,
} from '../scripts/lib/article-fabrication-patterns.mjs';

const BODY_ROOTS = ['blog-body', 'blog-body-ch'];
const LOCALES = ['it', 'de', 'en', 'fr'];

interface ArticleFile {
  id: string;
  path: string;
  locale: string;
}

function getArticleFiles(): ArticleFile[] {
  const results: ArticleFile[] = [];
  for (const root of BODY_ROOTS) {
    for (const locale of LOCALES) {
      const dir = path.resolve(__dirname, '..', 'services', 'locales', root, locale);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
        results.push({
          id: `${root}/${locale}/${path.basename(f, '.ts')}`,
          path: path.join(dir, f),
          locale,
        });
      }
    }
  }
  return results;
}

function extractTextContent(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Extract string values from the TS export (body1, body2, body3, faq content).
  // Must treat a backslash-escaped quote (`\'`) as part of the string content,
  // not a terminator — `/'[^']*'/g` (the prior version) stopped at the FIRST
  // `\'` it saw (e.g. "dell\'Ufficio..."), silently truncating the extracted
  // text and losing everything after it. That's exactly where Italian/French/
  // German elisions put an apostrophe right before a fabricated institution
  // name ("dell\'Ufficio federale...", "l\'Office fédéral...") — this safety
  // net had a blind spot for the single most common surrounding grammar
  // pattern of the exact fabrication it exists to catch (confirmed live: 2
  // articles with the fabricated institution sitting immediately after an
  // escaped apostrophe passed this test undetected until this fix).
  return extractTextContentFromSource(raw);
}

describe('article fabrication guard', () => {
  const files = getArticleFiles();
  const itFiles = files.filter(f => f.locale === 'it');

  it('should have blog body files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no fabricated institutions',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of FABRICATED_INSTITUTIONS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Fabricated institutions found in ${_id}`).toEqual([]);
    }
  );

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no fabricated acronyms',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of FABRICATED_ACRONYMS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Fabricated acronyms found in ${_id}`).toEqual([]);
    }
  );

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no known incorrect facts',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of INCORRECT_FACTS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Incorrect facts found in ${_id}`).toEqual([]);
    }
  );

  it.each(files.map(f => [f.id, f.path, f.locale]))(
    '%s — no fabricated "federal labour office" institution (real: SECO)',
    (_id, filePath, locale) => {
      const pattern = FABRICATED_LABOR_OFFICE[locale as string];
      if (!pattern) return;
      const text = extractTextContent(filePath as string);
      expect(pattern.test(text), `Fabricated "federal labour office" (real: SECO) found in ${_id}`).toBe(false);
    }
  );

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no vague sourcing with precise statistics',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of VAGUE_SOURCING) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Vague sourcing found in ${_id}`).toEqual([]);
    }
  );
});

/**
 * ── Flusso, non stock: gemello del filtro in
 * `tests/ci/report-synced-article-factuality.test.ts` (#5661) ───────────────
 *
 * Questi casi NON leggono il corpus: girano sulle funzioni pure del reporter,
 * quindi restano validi anche in un worktree sparse dove i body non ci sono.
 *
 * Il difetto che sorvegliano e' quello che ha riaperto #5661 trentaquattro
 * minuti dopo la chiusura: un articolo generato il 2026-08-11 e riscritto il
 * 2026-09-05 da una PR di riparazione rientra nel diff del sync e diventa
 * indistinguibile da uno appena ammesso. Su un articolo gia' pubblicato il
 * rilievo non e' «ricomparso»: non se n'e' mai andato.
 */
describe('fabrication reporter: escala il flusso, non lo stock (#5661)', () => {
  const vecchio = {
    id: 'articolo-di-agosto',
    dir: 'services/locales/blog-body',
    locale: 'en',
    violations: [{ code: 'fabricated-institution', desc: 'ente inventato', evidence: 'Ufficio X' }],
    isNew: false,
  };
  const nuovo = { ...vecchio, id: 'articolo-appena-ammesso', isNew: true };

  it('non escala un articolo che il sync ha solo modificato', () => {
    expect(isEscalatableFinding(vecchio)).toBe(false);
  });

  it('escala un articolo ammesso in questo sync', () => {
    expect(isEscalatableFinding(nuovo)).toBe(true);
  });

  it('se flusso e stock non sono distinguibili NON smette di segnalare', () => {
    // Fail-open deliberato: git muto non deve rendere il guard un no-op muto.
    expect(isEscalatableFinding({ ...vecchio, isNew: null })).toBe(true);
    expect(isEscalatableFinding({ ...vecchio, isNew: undefined })).toBe(true);
  });

  it('il corpo della issue non elenca gli articoli gia\' pubblicati', () => {
    const report = { scanned: 8, flagged: 2, escalatable: 1, diffUnavailable: false, findings: [vecchio, nuovo] };
    const { description } = buildFindingsIssue(report, 'https://example.test/run/1');
    expect(description).toContain('articolo-appena-ammesso');
    expect(description).not.toContain('articolo-di-agosto');
    // Il conteggio in testa deve contare gli escalabili, non i segnalati.
    expect(description).toContain('**1** body-locale');
  });
});
