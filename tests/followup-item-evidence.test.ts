import { describe, expect, it } from 'vitest';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';
import {
  ITEM_BLOCKED_REASONS,
  countItemAttempts,
  itemAttemptMarker,
  itemBlockedMarker,
  itemBornSatisfiedMarker,
  itemEvidenceLink,
  itemEvidenceMarker,
  itemLinkFiles,
  inertCommentText,
  itemMetricLine,
  parseItemMarkers,
} from '../scripts/ci/lib/followup-item-evidence.mjs';

const ITEM = 'FU-2026-10-03-001';
const OTHER = 'FU-2026-10-03-002';
const SHA = '899f710d2530cfab789828e6935b015165e024d7';
const trusted = (c: { author?: { login?: string } }) => c?.author?.login === 'bot';
const by = (login: string, body: string, createdAt = '2026-10-03T10:00:00Z') => ({ body, createdAt, author: { login } });

describe('marker a grana item: scrittura e lettura dalla stessa fonte', () => {
  it('ogni marker scritto si rilegge tipizzato', () => {
    const body = [
      itemEvidenceMarker({ item: ITEM, pr: 10763, commit: SHA, run: 36876426933, link: 'target-file' }),
      itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 37000000001 }),
      itemBlockedMarker({ item: ITEM, reason: 'awaiting-verification' }),
      itemBornSatisfiedMarker({ item: OTHER }),
    ].join('\n');
    expect(body.split('\n')[0]).toBe(`<!-- FU_ITEM_EVIDENCE: item=${ITEM} pr=10763 commit=${SHA} run=36876426933 link=target-file -->`);
    expect(parseItemMarkers([by('bot', body)], { isTrusted: trusted })).toEqual([
      { type: 'evidence', item: ITEM, pr: 10763, commit: SHA, run: 36876426933, link: 'target-file', createdAt: '2026-10-03T10:00:00Z' },
      { type: 'attempt', item: ITEM, outcome: 'already-fixed', run: 37000000001, createdAt: '2026-10-03T10:00:00Z' },
      { type: 'blocked', item: ITEM, reason: 'awaiting-verification', createdAt: '2026-10-03T10:00:00Z' },
      { type: 'born-satisfied', item: OTHER, createdAt: '2026-10-03T10:00:00Z' },
    ]);
  });

  it('evidenza per solo commit e tentativo senza run restano validi', () => {
    const body = `${itemEvidenceMarker({ item: ITEM, commit: SHA, run: 7, link: 'none' })}\n${itemAttemptMarker({ item: ITEM, outcome: 'no-root-cause' })}`;
    expect(parseItemMarkers([by('bot', body)], { isTrusted: trusted }).map((m) => m.type)).toEqual(['evidence', 'attempt']);
  });

  it('i motivi di blocco sono un insieme chiuso', () => {
    for (const reason of ITEM_BLOCKED_REASONS) expect(itemBlockedMarker({ item: ITEM, reason })).toContain(`reason=${reason}`);
    expect(() => itemBlockedMarker({ item: ITEM, reason: 'perche-si' })).toThrow();
    expect(() => itemBlockedMarker({ item: 'FU-1', reason: 'awaiting-verification' })).toThrow();
    expect(() => itemEvidenceMarker({ item: ITEM, pr: 1, commit: 'zzz', run: 7, link: 'none' })).toThrow();
    expect(() => itemEvidenceMarker({ item: ITEM, pr: 1, commit: SHA, run: 7, link: 'forse' })).toThrow();
    expect(() => itemAttemptMarker({ item: ITEM, outcome: 'due parole' })).toThrow();
  });

  it('un marker scritto da un autore non fidato viene ignorato', () => {
    const marker = itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 1 });
    expect(parseItemMarkers([by('drive-by', marker)], { isTrusted: trusted })).toEqual([]);
    // Senza predicato non ci si fida di nessuno.
    expect(parseItemMarkers([by('bot', marker)])).toEqual([]);
    expect(parseItemMarkers(null, { isTrusted: trusted })).toEqual([]);
  });

  it.each([
    ['chiave ignota', `<!-- FU_ITEM_BLOCKED: item=${ITEM} reason=awaiting-verification note=x -->`],
    ['chiave duplicata', `<!-- FU_ITEM_ATTEMPT: item=${ITEM} item=${OTHER} outcome=already-fixed -->`],
    ['motivo fuori insieme', `<!-- FU_ITEM_BLOCKED: item=${ITEM} reason=boh -->`],
    ['campo obbligatorio mancante', `<!-- FU_ITEM_EVIDENCE: item=${ITEM} pr=1 run=7 link=none -->`],
    ['ID malformato', '<!-- FU_ITEM_ATTEMPT: item=FU-1 outcome=already-fixed -->'],
  ])('marker malformato ignorato: %s', (_name, body) => {
    expect(parseItemMarkers([by('bot', body)], { isTrusted: trusted })).toEqual([]);
  });

  it('conta i tentativi per item ed esito, escludendo la run corrente', () => {
    const markers = parseItemMarkers([
      by('bot', itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 11 })),
      by('bot', itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 12 })),
      by('bot', itemAttemptMarker({ item: ITEM, outcome: 'no-root-cause', run: 13 })),
      by('bot', itemAttemptMarker({ item: OTHER, outcome: 'already-fixed', run: 14 })),
      by('drive-by', itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 15 })),
    ], { isTrusted: trusted });
    const all = countItemAttempts(markers, ITEM, 'already-fixed');
    expect(all).toBe(markers.filter((m) => m.type === 'attempt' && m.item === ITEM && m.outcome === 'already-fixed').length);
    expect(countItemAttempts(markers, ITEM, 'already-fixed', { excludeRun: 12 })).toBe(all - 1);
    expect(countItemAttempts(markers, ITEM, 'pr-created')).toBe(0);
    expect(countItemAttempts(undefined, ITEM, 'already-fixed')).toBe(0);
  });
});

describe('legame fra la PR di evidenza e l item', () => {
  const body = [
    `### ${ITEM} — MediPersonal: policy condivisa`,
    '- State: open',
    '- Sources: PR #10673; PR body `## Non implementato (ancora)`',
    '- Target file: `scripts/lib/ipersonal-spec-runtime.mjs:L520`',
    '- Original text:',
    '  > coprire il caso in `tests/ipersonal-spec-runtime.test.ts`.',
    '- METRICA: `node scripts/x.mjs --count` oggi 5, atteso 0',
    '```',
    '- METRICA: esempio dentro un blocco di codice tests/finto.test.ts',
    '- Sources: PR #99999',
    '```',
    '',
  ].join('\n');
  const [item] = parseFollowupItems(body);

  it('raccoglie Target file (senza backtick né riga) e i test citati fuori dai blocchi di codice', () => {
    expect(itemLinkFiles(item)).toEqual(['scripts/lib/ipersonal-spec-runtime.mjs', 'tests/ipersonal-spec-runtime.test.ts']);
  });

  it('target-file batte source-pr; senza PR o senza riscontro è none', () => {
    expect(itemEvidenceLink(item, { pr: 10763, files: ['scripts/lib/ipersonal-spec-runtime.mjs'] })).toBe('target-file');
    expect(itemEvidenceLink(item, { pr: 10763, files: ['tests/ipersonal-spec-runtime.test.ts'] })).toBe('target-file');
    expect(itemEvidenceLink(item, { pr: 10673, files: ['scripts/lib/ipersonal-spec-runtime.mjs'] })).toBe('target-file');
    expect(itemEvidenceLink(item, { pr: 10673, files: ['docs/altro.md'] })).toBe('source-pr');
    expect(itemEvidenceLink(item, { pr: 10763, files: ['docs/altro.md'] })).toBe('none');
    // Una `Sources` dentro un blocco di codice è un esempio, non metadato.
    expect(itemEvidenceLink(item, { pr: 99999, files: [] })).toBe('none');
    expect(itemEvidenceLink(item, { pr: null, files: ['scripts/lib/ipersonal-spec-runtime.mjs'] })).toBe('none');
    expect(itemEvidenceLink(null, { pr: 1, files: [] })).toBe('none');
  });

  it('legge la riga METRICA viva e toglie i delimitatori di commento', () => {
    expect(itemMetricLine(item)).toBe('`node scripts/x.mjs --count` oggi 5, atteso 0');
    expect(itemMetricLine({ text: '**1 - METRICA.** conteggio <!-- FU_ITEM_BLOCKED: x --> da zero' })).toBe('conteggio FU_ITEM_BLOCKED: x da zero');
    expect(itemMetricLine({ text: '- State: open' })).toBe('');
  });

  it('delimitatori annidati non si ricompongono in un marker', () => {
    const nested = '- METRICA: x <!<!---- FU_ITEM_BLOCKED: item=FU-2026-10-03-002 reason=no-root-cause ---->> <!<!---- FIX_OUTCOME: already-fixed ---->>';
    const text = itemMetricLine({ text: nested });
    expect(text).not.toMatch(/<!--|-->/);
    expect(text.startsWith('x ')).toBe(true);
    expect(parseItemMarkers([{ body: text }], { isTrusted: () => true })).toEqual([]);
    for (const depth of [1, 2, 3, 5]) {
      const open = `${'<!'.repeat(depth)}${'--'.repeat(depth)}`;
      const close = `${'--'.repeat(depth)}${'>'.repeat(depth)}`;
      expect(inertCommentText(`a ${open} FU_ITEM_BLOCKED: item=FU-2026-10-03-002 reason=no-root-cause ${close} b`)).not.toMatch(/<!--|-->/);
    }
    // Il testo che non è un delimitatore resta: una metrica può dire `>= 0`.
    expect(inertCommentText('conteggio  >= 0 e\t< 5')).toBe('conteggio >= 0 e < 5');
  });
});
