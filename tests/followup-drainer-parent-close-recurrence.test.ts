/**
 * followup-drainer — PARENT-CLOSE non richiude un padre che un monitor ha
 * riaperto dopo la decomposizione.
 *
 * Caso reale (site 5661, 2026-10-04): padre `decomposed:1` con figlie tutte
 * chiuse e, insieme, issue canonica del reporter di factuality. Il creator la
 * riapriva a ogni ricorrenza (`🔁 **Reopened**`), il PARENT-CLOSE la richiudeva
 * al tick dopo: 140 chiusure e 141 riaperture nello stesso thread.
 *
 * Se questo file diventa rosso: «PARENT-CLOSE richiude un padre riaperto da un
 * monitor: la guardia reopenedAfterDecomposition manca o e' dopo la chiusura».
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  reopenedAfterDecomposition,
  decomposedIntoNumbers,
} from '../scripts/ci/lib/parent-close-recurrence.mjs';
import { decomposedChildNumbers } from '../scripts/ci/followup-drainer.mjs';

const decomposed = (createdAt?: string) => ({
  body: 'Decomposta.\n<!-- DECOMPOSED_INTO: #6672, #6673, #6674 -->',
  ...(createdAt === undefined ? {} : { createdAt }),
});
const parentClose = (createdAt: string) => ({
  body: '✅ Auto-chiusa dal followup-drainer (PARENT-CLOSE): tutte le sub-issue della decomposizione (#6672, #6673, #6674) risultano chiuse.',
  createdAt,
});
const reopened = (createdAt?: string) => ({
  body: '🔁 **Reopened** — ricorrenza il 2026-10-03T11:00:00Z: la stessa condizione si è ripresentata entro 720h dalla chiusura.\n\n**Misura corrente:**\n\n…',
  ...(createdAt === undefined ? {} : { createdAt }),
});

describe('reopenedAfterDecomposition', () => {
  it('true: decomposizione, PARENT-CLOSE, poi riapertura del monitor', () => {
    expect(reopenedAfterDecomposition([
      decomposed('2026-10-03T10:00:00Z'),
      parentClose('2026-10-03T10:05:00Z'),
      reopened('2026-10-03T11:00:00Z'),
    ])).toBe(true);
  });

  it('false: decomposizione rifatta DOPO la ricorrenza ridà l\'autorità al PARENT-CLOSE', () => {
    expect(reopenedAfterDecomposition([
      reopened('2026-10-03T11:00:00Z'),
      decomposed('2026-10-03T12:00:00Z'),
    ])).toBe(false);
  });

  it('false: l\'ULTIMO marker vince anche se una riapertura segue un marker precedente', () => {
    expect(reopenedAfterDecomposition([
      decomposed('2026-10-01T10:00:00Z'),
      reopened('2026-10-02T10:00:00Z'),
      decomposed('2026-10-03T12:00:00Z'),
    ])).toBe(false);
  });

  it('false: nessuna riapertura', () => {
    expect(reopenedAfterDecomposition([
      decomposed('2026-10-03T10:00:00Z'),
      parentClose('2026-10-03T10:05:00Z'),
    ])).toBe(false);
  });

  it('false: riapertura senza alcun marker DECOMPOSED_INTO', () => {
    expect(reopenedAfterDecomposition([reopened('2026-10-03T11:00:00Z')])).toBe(false);
  });

  it('false: createdAt della decomposizione mancante o non parsabile', () => {
    expect(reopenedAfterDecomposition([decomposed(), reopened('2026-10-03T11:00:00Z')])).toBe(false);
    expect(reopenedAfterDecomposition([decomposed('ieri'), reopened('2026-10-03T11:00:00Z')])).toBe(false);
  });

  it('false: riapertura senza createdAt non prova di essere posteriore', () => {
    expect(reopenedAfterDecomposition([decomposed('2026-10-03T10:00:00Z'), reopened()])).toBe(false);
  });

  it('false: «🔁 **Reopened**» citato dentro un altro commento non è una riapertura', () => {
    expect(reopenedAfterDecomposition([
      decomposed('2026-10-03T10:00:00Z'),
      { body: 'Il creator scrive `🔁 **Reopened**` a ogni ricorrenza.', createdAt: '2026-10-03T11:00:00Z' },
      { body: '> 🔁 **Reopened** — ricorrenza il …', createdAt: '2026-10-03T11:30:00Z' },
    ])).toBe(false);
  });

  it('false: input non-array o commenti nulli (lettura fallita)', () => {
    expect(reopenedAfterDecomposition(null)).toBe(false);
    expect(reopenedAfterDecomposition(undefined)).toBe(false);
    expect(reopenedAfterDecomposition([null, decomposed('2026-10-03T10:00:00Z'), undefined] as never)).toBe(false);
  });
});

describe('decomposedIntoNumbers — stessa regola di decomposedChildNumbers', () => {
  it('il marker che la guardia data è quello da cui il drainer legge le figlie', () => {
    const body = decomposed('2026-10-03T10:00:00Z').body;
    expect(decomposedIntoNumbers(body)).toEqual(decomposedChildNumbers([{ body }]));
    expect(decomposedIntoNumbers('niente marker')).toEqual([]);
  });
});

describe('cablaggio nel PARENT-CLOSE di followup-drainer.mjs', () => {
  const src = readFileSync('scripts/ci/followup-drainer.mjs', 'utf8');

  it('importa la guardia dal modulo condiviso', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\breopenedAfterDecomposition\b[^}]*\}\s*from\s*'\.\/lib\/parent-close-recurrence\.mjs'/,
    );
  });

  it('chiama la guardia nel blocco PARENT-CLOSE prima di `gh issue close` e del commento di chiusura', () => {
    const start = src.indexOf('// --- PARENT-CLOSE:');
    const end = src.indexOf('// --- VERDICT-EXIT:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const guard = block.indexOf('reopenedAfterDecomposition(');
    const closeComment = block.indexOf('Auto-chiusa dal followup-drainer (PARENT-CLOSE)');
    const close = block.indexOf("'issue', 'close'");
    expect(guard).toBeGreaterThan(-1);
    expect(closeComment).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(closeComment);
    expect(guard).toBeLessThan(close);
  });
});
