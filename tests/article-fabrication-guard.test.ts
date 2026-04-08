/**
 * article-fabrication-guard.test.ts
 *
 * Scans ALL Italian blog body files for known hallucination patterns:
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

const BLOG_BODY_IT = path.resolve(__dirname, '..', 'services', 'locales', 'blog-body', 'it');

function getArticleFiles(): string[] {
  if (!fs.existsSync(BLOG_BODY_IT)) return [];
  return fs.readdirSync(BLOG_BODY_IT)
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(BLOG_BODY_IT, f));
}

function extractTextContent(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Extract string values from the TS export (body1, body2, body3, faq content)
  const stringMatches = raw.match(/'[^']*'/g) || [];
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

describe('article fabrication guard', () => {
  const files = getArticleFiles();

  it('should have Italian blog body files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map(f => [path.basename(f, '.ts'), f]))(
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

  it.each(files.map(f => [path.basename(f, '.ts'), f]))(
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

  it.each(files.map(f => [path.basename(f, '.ts'), f]))(
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

  it.each(files.map(f => [path.basename(f, '.ts'), f]))(
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
