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
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
  // Backslash-escaped chars (e.g. \' inside "l\'IA") must not end the match,
  // or the fragment boundary can split a phrase and hide it from the patterns below.
  const stringMatches = raw.match(/'(?:\\.|[^'\\])*'/g) || [];
  return stringMatches.join(' ');
}

// Fabricated institution patterns
const FABRICATED_INSTITUTIONS = [
  { pattern: /Codice\s+federale\s+del\s+lavoro/i, desc: '"Codice federale del lavoro" non esiste (reale: Legge sul lavoro LL/ArG)' },
  { pattern: /\bCFL\b(?!\s*[A-Z])/, desc: '"CFL" è un acronimo inventato' },
  { pattern: /Dipartimento\s+delle\s+Entrate\b/i, desc: '"Dipartimento delle Entrate" non esiste' },
  { pattern: /Codice\s+federale\s+(?:della\s+)?(?:salute|sanità)/i, desc: '"Codice federale della salute" non esiste' },
  { pattern: /Ministero\s+(?:federale|cantonale)\s+del(?:la)?\s+(?:lavoro|salute|finanz)/i, desc: 'Ministero federale/cantonale non esiste in Svizzera (reale: Dipartimento)' },
  { pattern: /Ufficio\s+federale\s+del(?:la)?\s+(?:lavoro\s+transfrontaliero|migrazione\s+lavorativa)/i, desc: '"Ufficio federale del lavoro transfrontaliero" non esiste' },
  { pattern: /Legge\s+cantonale\s+(?:sui|del)\s+frontalier/i, desc: '"Legge cantonale sui frontalieri" non esiste' },
  { pattern: /Regolamento\s+ticinese\s+(?:del|sul)\s+lavoro/i, desc: '"Regolamento ticinese del lavoro" non esiste' },
  { pattern: /Commissione\s+(?:federale|cantonale)\s+(?:per\s+i\s+)?frontalier/i, desc: '"Commissione federale per i frontalieri" non esiste' },
  { pattern: /Osservatorio\s+nazionale\s+(?:del|sulla)\s+sicurezza\s+(?:sul\s+)?lavoro/i, desc: '"Osservatorio nazionale sulla sicurezza sul lavoro" non esiste (reale: SUVA)' },
];

// Fabricated Swiss acronyms
const FABRICATED_ACRONYMS = [
  { pattern: /\bUFOL\b/, desc: '"UFOL" non esiste (reale: SECO)' },
  { pattern: /\bUWL\b/, desc: '"UWL" non esiste (reale: SECO)' },
  { pattern: /\bUSTTI\b/, desc: '"USTTI" non esiste (reale: USTAT)' },
  { pattern: /\bUBSP\b/, desc: '"UBSP" non esiste (reale: UFSP/BAG)' },
  { pattern: /\bONSSL\b/, desc: '"ONSSL" non esiste (reale: SUVA)' },
  { pattern: /\bROSSL\b/, desc: '"ROSSL" non esiste' },
  { pattern: /\bLCFL\b/, desc: '"LCFL" non esiste (reale: LL/ArG)' },
  { pattern: /\bLTL\b/, desc: '"LTL" non esiste' },
  { pattern: /\bCCFL\b/, desc: '"CCFL" non esiste' },
  { pattern: /\bUFML\b/, desc: '"UFML" non esiste (reale: SEM)' },
];

// Known incorrect facts (proximity-constrained patterns)
const INCORRECT_FACTS = [
  { pattern: /convenzione.*9\s+marzo\s+1976/i, desc: 'Convenzione italo-svizzera: 9 DICEMBRE 1976, non marzo' },
  { pattern: /9\s+marzo\s+1976.*convenzione/i, desc: 'Convenzione italo-svizzera: 9 DICEMBRE 1976, non marzo' },
  { pattern: /tassa\s+(?:sulla\s+)?salute\s+(?:\w+\s+){0,5}(?:del\s+)?10\s*%/i, desc: '"Tassa sulla salute del 10%" è un dato inventato' },
];

// Vague source attributions that are red flags for fabricated stats
const VAGUE_SOURCING = [
  { pattern: /secondo\s+(?:uno\s+)?studio\s+(?:recente|del\s+20\d{2})[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a "uno studio" senza nome specifico' },
  { pattern: /secondo\s+(?:un(?:a|')\s+)?(?:indagine|ricerca|sondaggio)[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a indagine/ricerca senza fonte' },
];

// Cross-locale: the same fabricated "federal labour office" institution
// (real: SECO) recurs under a different fake acronym per article — matching
// the institution NAME itself (not a fixed acronym list) catches every
// variant regardless of what acronym a future auto-generated article invents.
const FABRICATED_LABOR_OFFICE: Partial<Record<string, RegExp>> = {
  it: /\b[Uu]fficio federale(?: svizzero)? del lavoro\b/,
  de: /\b([Bb]undesamt(?:es)? für Arbeit|[Bb]undesarbeitsamt)\b/,
  fr: /\b(?:[Oo]ffice|[Bb]ureau) fédéral du travail\b/,
  en: /\b[Ff]ederal (?:Labou?r Office|Office of Labou?r)\b/,
};

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
