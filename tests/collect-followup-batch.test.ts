/**
 * collect-followup-batch — il collector zero-Claude che converte post-merge-followup
 * da trigger per-PR a batch schedulato. Sicurezza > velocità: il lookback fisso
 * ri-copre la finestra a ogni run, il parser rifiuta sorgenti API incomplete e il
 * dispatch manuale resta separato dalla ricerca schedulata. Il filtro autore
 * normalizza le forme login `app/<name>` (gh GraphQL) / `<name>[bot]` (REST), e
 * l'idempotenza salta le PR già commentate. Qui si testano i puri (gh non viene
 * invocato): lookback, paginazione fail-closed, filtro autore, idempotenza,
 * normalizzazione login, max-turns floor.
 */
import { describe, it, expect } from 'vitest';
import {
  collectionWindowStartISO,
  positiveHours,
  collectionMode,
  manualDispatchPR,
  main,
  parseCompleteMergedPRSearch,
  parseMergedPRPages,
  parseMergedPRs,
  hasTriageComment,
  latestTriageCommentBody,
  persistedBucketIssueMatches,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
  canonicalLogin,
  maxTurnsFor,
  selectFollowupSessionBatch,
  deferredCount,
  orderCandidatesFifo,
  shouldTriageAfterCandidateGate,
  shouldTriageAfterFixGate,
} from '../scripts/ci/collect-followup-batch.mjs';

describe('canonicalLogin', () => {
  it('strips the gh GraphQL `app/` prefix', () => {
    expect(canonicalLogin('app/frontaliere-automation')).toBe('frontaliere-automation');
  });
  it('strips the REST `[bot]` suffix', () => {
    expect(canonicalLogin('frontaliere-automation[bot]')).toBe('frontaliere-automation');
  });
  it('leaves a plain human login untouched', () => {
    expect(canonicalLogin('valerielinc-ops')).toBe('valerielinc-ops');
  });
  it('is safe on empty / non-string', () => {
    expect(canonicalLogin('')).toBe('');
    expect(canonicalLogin(null as unknown as string)).toBe('');
  });
});

describe('collectionWindowStartISO (lookback fisso)', () => {
  // Il difetto che questa forma elimina e' DOPPIO, e un tetto sul vecchio
  // watermark ne chiudeva solo metà:
  //  - run troncata VERDE  -> il watermark avanzava e il residuo oltre il cap
  //    non rientrava piu' in nessuna finestra (perdita silenziosa);
  //  - run troncata ROSSA  -> la finestra cresceva senza limite (35 run rosse,
  //    161,6 h misurate il 2026-09-18).
  // Un lookback fisso non dipende dall'esito delle run, quindi nessuna delle
  // due derive e' rappresentabile: la finestra e' sempre la stessa ampiezza.
  it('non dipende dallo storico delle run: la finestra e sempre di MAX_WINDOW_HOURS', () => {
    const now = Date.parse('2026-09-18T13:16:33Z');
    expect(collectionWindowStartISO(now)).toBe(new Date(now - 48 * 3600_000).toISOString());
    // Lo stesso istante dopo una settimana di run rosse da' lo STESSO confine.
    expect(collectionWindowStartISO(now)).toBe(collectionWindowStartISO(now));
  });

  it('rispetta un lookback esplicito', () => {
    const now = Date.parse('2026-09-18T13:16:33Z');
    expect(collectionWindowStartISO(now, 3)).toBe(new Date(now - 3 * 3600_000).toISOString());
  });

  // Finding del reviewer su L166: `Number(x) || 48` accettava negativi e
  // Infinity. Un negativo sposta il confine nel FUTURO (zero candidati, cioe'
  // follow-up persi senza che nulla diventi rosso); Infinity rompe la
  // serializzazione della data.
  it('un override malformato non sposta la finestra nel futuro', () => {
    const now = Date.parse('2026-09-18T13:16:33Z');
    const fallback = new Date(now - 48 * 3600_000).toISOString();
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, 'abc' as unknown as number]) {
      const got = collectionWindowStartISO(now, bad as number);
      expect(got).toBe(fallback);
      expect(Date.parse(got)).toBeLessThan(now);
    }
  });

  it('positiveHours accetta solo numeri finiti positivi', () => {
    expect(positiveHours('12', 48)).toBe(12);
    expect(positiveHours('-1', 48)).toBe(48);
    expect(positiveHours('Infinity', 48)).toBe(48);
    expect(positiveHours(undefined, 48)).toBe(48);
  });
});


describe('collector fail-closed parsing', () => {
  it('accepts all complete paginated search pages and preserves eligible authors', () => {
    const pages = [
      {
        total_count: 2,
        incomplete_results: false,
        items: [{
          number: 8101,
          title: 'first',
          user: { login: 'valerielinc-ops' },
          pull_request: { merged_at: '2026-09-09T08:00:00Z' },
          head: { ref: 'feature/first' },
        }],
      },
      {
        total_count: 2,
        incomplete_results: false,
        items: [{
          number: 8102,
          title: 'second',
          user: { login: 'app/frontaliere-automation' },
          pull_request: { merged_at: '2026-09-09T09:00:00Z' },
          head: { ref: 'feature/second' },
        }],
      },
    ];
    const parsed = parseMergedPRPages(JSON.stringify(pages));
    expect(parsed?.map((pr) => pr.number)).toEqual([8101, 8102]);
    expect(parseMergedPRs(JSON.stringify(parsed)).map((pr) => pr.number)).toEqual([8101, 8102]);
  });

  it('rejects incomplete, truncated, duplicated, or malformed pages instead of returning an empty batch', () => {
    const complete = {
      total_count: 2,
      incomplete_results: false,
      items: [{
        number: 8101,
        user: { login: 'valerielinc-ops' },
        pull_request: { merged_at: '2026-09-09T08:00:00Z' },
      }],
    };
    expect(parseMergedPRPages(JSON.stringify([{ ...complete, incomplete_results: true }]))).toBeNull();
    expect(parseMergedPRPages(JSON.stringify([complete]))).toBeNull();
    expect(parseMergedPRPages(JSON.stringify([complete, complete]))).toBeNull();
    expect(parseMergedPRPages(JSON.stringify([{
      ...complete,
      items: [{ ...complete.items[0], pull_request: { merged_at: 'not-a-date' } }],
      total_count: 1,
    }]))).toBeNull();
  });

  it('rejects an API error or a non-paginated response instead of treating it as an empty batch', () => {
    expect(() => parseCompleteMergedPRSearch(null as unknown as string)).toThrow(/incompleta\/non verificabile/);
    expect(() => parseCompleteMergedPRSearch('')).toThrow(/incompleta\/non verificabile/);
    expect(parseMergedPRPages(JSON.stringify({
      total_count: 0,
      incomplete_results: false,
      items: [],
    }))).toBeNull();
  });

  it('accepts every page beyond the old 100-PR cap when pagination is complete', () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      number: 9000 + index,
      title: `follow-up candidate ${index}`,
      user: { login: 'valerielinc-ops' },
      pull_request: { merged_at: '2026-09-09T08:00:00Z' },
      head: { ref: `feature/${index}` },
    }));
    const pages = [
      { total_count: items.length, incomplete_results: false, items: items.slice(0, 100) },
      { total_count: items.length, incomplete_results: false, items: items.slice(100) },
    ];
    const parsed = parseCompleteMergedPRSearch(JSON.stringify(pages));
    expect(parsed).toHaveLength(101);
    expect(parsed.at(0)?.number).toBe(9000);
    expect(parsed.at(-1)?.number).toBe(9100);
  });
});

describe('separazione dispatch manuale / raccolta schedulata', () => {
  it('routes only schedule (or local default) through the scheduled collector', () => {
    expect(collectionMode('schedule')).toBe('scheduled');
    expect(collectionMode('')).toBe('scheduled');
    expect(collectionMode('workflow_dispatch')).toBe('manual');
    expect(collectionMode('pull_request')).toBeNull();
  });

  it('validates the single PR number for a manual backfill', () => {
    expect(manualDispatchPR(' 8101 ')).toBe(8101);
    expect(() => manualDispatchPR('')).toThrow();
    expect(() => manualDispatchPR('0')).toThrow();
    expect(() => manualDispatchPR('not-a-pr')).toThrow();
    expect(() => manualDispatchPR('9007199254740992')).toThrow();
  });

  it('runs the manual path without requiring GH_REPO or invoking the scheduled search', () => {
    const outputPath = process.env.GITHUB_OUTPUT;
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      expect(() => main({ eventName: 'workflow_dispatch', inputPRNumber: '8101' })).not.toThrow();
    } finally {
      if (outputPath === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = outputPath;
      if (summaryPath === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = summaryPath;
    }
  });
});

describe('parseMergedPRs (author filter)', () => {
  const list = JSON.stringify([
    { number: 1, author: { login: 'valerielinc-ops' } },
    { number: 2, author: { login: 'app/frontaliere-automation' } },
    { number: 3, author: { login: 'frontaliere-automation[bot]' } },
    { number: 4, author: { login: 'app/claude' } }, // not in allowlist
    { number: 5, author: { login: 'dependabot[bot]' } }, // not in allowlist
    { number: 6 }, // no author → dropped
  ]);

  it('keeps only eligible authors (both gh `app/` and REST `[bot]` forms)', () => {
    expect(parseMergedPRs(list).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('returns [] on unparseable input (proceed-safe: window re-covered next run)', () => {
    expect(parseMergedPRs('garbage')).toEqual([]);
    expect(parseMergedPRs('')).toEqual([]);
  });

  it('returns [] when the list is not an array', () => {
    expect(parseMergedPRs(JSON.stringify({ nope: true }))).toEqual([]);
  });
});

describe('hasTriageComment (idempotency)', () => {
  const withTriage = JSON.stringify({
    comments: [
      { body: 'random chatter' },
      { body: '## Post-merge follow-up triage: zero outstanding items.' },
    ],
  });
  const withoutTriage = JSON.stringify({
    comments: [{ body: 'LGTM' }, { body: 'nice work' }],
  });

  it('detects an existing triage comment (any variant)', () => {
    expect(hasTriageComment(withTriage)).toBe(true);
  });

  it('detects the leading-whitespace variant', () => {
    expect(hasTriageComment(JSON.stringify({ comments: [{ body: '\n## Post-merge follow-up triage\n...' }] }))).toBe(true);
  });

  it('returns false when no triage comment is present (PR stays a candidate)', () => {
    expect(hasTriageComment(withoutTriage)).toBe(false);
  });

  it('accepts a bare comments array as well as the {comments:[...]} shape', () => {
    expect(hasTriageComment(JSON.stringify([{ body: '## Post-merge follow-up triage' }]))).toBe(true);
  });

  it('returns false on parse error (proceed-safe: NOT deduped → triage runs)', () => {
    expect(hasTriageComment('not json')).toBe(false);
    expect(hasTriageComment('')).toBe(false);
  });
});

describe('marker idempotency requires durable bucket/item evidence', () => {
  const marker = '## Post-merge follow-up triage\nCreated/updated: daily bucket #42 `follow-up(daily:2026-09-09)` con 1 item';
  const persisted = {
    number: 42,
    title: 'follow-up(daily:2026-09-09): 1 item — owner/repo',
    body: '### FU-2026-09-09-001 — item\n- Sources: PR #8101\n',
  };

  it('does not skip a marker whose bucket read failed or lacks the source item', () => {
    expect(verifyTriageMarkerPersistence(marker, 8101, () => null)).toBeNull();
    expect(verifyTriageMarkerPersistence(marker, 8101, () => ({ ...persisted, body: '### FU-2026-09-09-001 — item' }))).toBe(false);
  });

  it('accepts only a bucket/item persisted for the same PR and recognizes no-issue markers', () => {
    expect(verifyTriageMarkerPersistence(marker, 8101, () => persisted)).toBe(true);
    expect(verifyTriageMarkerPersistence(marker, 8102, () => persisted)).toBe(false);
    expect(verifyTriageMarkerPersistence('## Post-merge follow-up triage: zero outstanding items.', 8101, () => {
      throw new Error('must not read a bucket');
    })).toBe(true);
    expect(triageMarkerPersistenceExpectation(marker)).toEqual({ buckets: [42], requiresBucket: true });
    expect(latestTriageCommentBody(JSON.stringify({ comments: [{ body: marker }] }))).toBe(marker);
    expect(persistedBucketIssueMatches(persisted, 8101)).toBe(true);
  });

  it('recognizes Markdown bullet markers as persistence claims', () => {
    expect(triageMarkerPersistenceExpectation(
      '## Post-merge follow-up triage\n- Created: daily bucket #42 con 1 item',
    )).toEqual({ buckets: [42], requiresBucket: true });
  });

  it('ignores historical bucket references in a positive marker', () => {
    const markerWithHistory = [
      '## Post-merge follow-up triage',
      'Created/updated: daily bucket #8293 `follow-up(daily:2026-09-11)` con 1 item.',
      'Nota: il bucket #8248 della stessa chiave è già sealed e chiuso.',
    ].join('\n');
    const current = {
      number: 8293,
      title: 'follow-up(daily:2026-09-11): 1 item — owner/repo',
      body: '### FU-2026-09-11-005 — item\n- Sources: PR #8204\n',
    };
    expect(triageMarkerPersistenceExpectation(markerWithHistory)).toEqual({
      buckets: [8293],
      requiresBucket: true,
    });
    expect(verifyTriageMarkerPersistence(markerWithHistory, 8204, (bucket) => {
      if (bucket !== 8293) throw new Error(`historical bucket ${bucket} must not be read`);
      return current;
    })).toBe(true);
  });
});

describe('maxTurnsFor', () => {
  it('never drops below the original floor of 20 (AGENTS.md: mai abbassare)', () => {
    expect(maxTurnsFor(0)).toBeGreaterThanOrEqual(20);
    expect(maxTurnsFor(1)).toBe(34);
  });
  it('scales with batch size', () => {
    expect(maxTurnsFor(5)).toBe(66);
  });
  it('caps at 80', () => {
    expect(maxTurnsFor(20)).toBe(80);
  });
});

describe('ordine FIFO dei candidati', () => {
  // Il finding 🔴 della review sulla prima stesura: con `collection_ok=true` su
  // una sessione troncata il residuo deve restare RAGGIUNGIBILE. Metà della
  // garanzia e' la finestra a lookback fisso, l'altra metà e' l'ordine: il cap
  // taglia la coda, quindi servendo prima le PR recenti la coda vecchia non
  // veniva mai lavorata. Questo test fallisce se si torna all'ordine naturale
  // della Search API.
  const searchApiOrder = [
    { number: 9132, mergedAt: '2026-09-18T12:00:00Z' },
    { number: 9099, mergedAt: '2026-09-18T06:00:00Z' },
    { number: 9050, mergedAt: '2026-09-17T23:00:00Z' },
    { number: 9010, mergedAt: '2026-09-17T08:00:00Z' },
    { number: 8990, mergedAt: '2026-09-17T01:00:00Z' },
  ];

  it('serve prima le PR piu vecchie, cosi il cap rinvia le piu recenti', () => {
    const ordered = orderCandidatesFifo(searchApiOrder);
    expect(ordered.map((p) => p.number)).toEqual([8990, 9010, 9050, 9099, 9132]);
    const session = selectFollowupSessionBatch(ordered.map((p) => p.number));
    // Le 4 piu VECCHIE entrano in sessione; la piu recente e' quella rinviata,
    // ed e' anche quella che la finestra successiva ritrovera' comunque.
    expect(session).toEqual([8990, 9010, 9050, 9099]);
    expect(deferredCount(ordered, session)).toBe(1);
  });

  it('non muta l input e tollera una data illeggibile', () => {
    const input = [...searchApiOrder, { number: 1, mergedAt: 'not-a-date' }];
    const snapshot = input.map((p) => p.number);
    expect(() => orderCandidatesFifo(input)).not.toThrow();
    expect(input.map((p) => p.number)).toEqual(snapshot);
    expect(orderCandidatesFifo(null as unknown as typeof input)).toEqual([]);
  });
});

describe('follow-up provider session bound', () => {
  it('defers overflow PRs without mutating the candidate list', () => {
    const candidates = [1, 2, 3, 4, 5, 6];
    expect(selectFollowupSessionBatch(candidates)).toEqual([1, 2, 3, 4]);
    expect(candidates).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('conta il residuo rinviato senza trasformarlo in un errore di raccolta', () => {
    expect(deferredCount([1, 2, 3, 4], [1, 2, 3, 4])).toBe(0);
    expect(deferredCount([1, 2, 3, 4, 5, 6], [1, 2, 3, 4])).toBe(2);
    // Input non validi non devono inventare un residuo.
    expect(deferredCount(null as unknown as number[], [1])).toBe(0);
    expect(deferredCount([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('grandchild gate exception', () => {
  it('keeps ordinary fixes skipped but lets a marker-complete daily partial fix through', () => {
    expect(shouldTriageAfterFixGate({ isFollowupFix: true, followupPartial: false })).toBe(false);
    expect(shouldTriageAfterFixGate({ isFollowupFix: true, followupPartial: true })).toBe(true);
  });

  it('keeps an unreadable gate fail-open', () => {
    expect(shouldTriageAfterFixGate({ isFollowupFix: null, followupPartial: null })).toBe(true);
  });

  it('keeps a marker-complete daily partial fix even when the ordinary no-op gate is false', () => {
    expect(shouldTriageAfterCandidateGate({ hasCandidates: false, followupPartial: true })).toBe(true);
    expect(shouldTriageAfterCandidateGate({ hasCandidates: false, followupPartial: false })).toBe(false);
    expect(shouldTriageAfterCandidateGate({ hasCandidates: null, followupPartial: false })).toBe(true);
  });
});
