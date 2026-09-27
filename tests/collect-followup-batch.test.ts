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
import { readFileSync } from 'node:fs';
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
  latestTriageComment,
  gatePreservedFollowupMatches,
  persistedBucketIssueMatches,
  readBucketIssue,
  verifyPersistenceCli,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
  canonicalLogin,
  maxTurnsFor,
  selectFollowupSessionBatch,
  FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_SECONDS_PER_PR,
  FOLLOWUP_SESSION_BATCH_LIMIT,
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

  it('keeps unsupported CI events fail-closed instead of querying as a schedule', () => {
    expect(() => main({ eventName: 'pull_request', inputPRNumber: '8101' }))
      .toThrow(/evento non supportato/);
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

  it('honors FOLLOWUP_ELIGIBLE_AUTHORS when set before module load', async () => {
    const previous = process.env.FOLLOWUP_ELIGIBLE_AUTHORS;
    process.env.FOLLOWUP_ELIGIBLE_AUTHORS = 'custom-owner,app/internal-bot';
    try {
      const { parseMergedPRs: parseWithOverride } = await import(
        '../scripts/ci/collect-followup-batch.mjs?followup-authors-override'
      );
      const prs = JSON.stringify([
        { number: 7, author: { login: 'custom-owner' } },
        { number: 8, author: { login: 'app/internal-bot' } },
        { number: 9, author: { login: 'valerielinc-ops' } },
      ]);
      expect(parseWithOverride(prs).map((pr) => pr.number)).toEqual([7, 8]);
    } finally {
      if (previous === undefined) delete process.env.FOLLOWUP_ELIGIBLE_AUTHORS;
      else process.env.FOLLOWUP_ELIGIBLE_AUTHORS = previous;
    }
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

describe('item demotato dal gate DOPO il marker (run 36212700029, 36202115664)', () => {
  // Riproduzione del caso reale: il marker di PR #9633 cita il bucket #9769,
  // poi il gate sul conio demota FU-2026-09-25-011 e lo toglie dal corpo del
  // bucket, conservandolo in un commento sulla PR. Il bucket non cita piu' la
  // PR: senza la prova del gate la verifica restava rossa per 48h.
  const MARKER_AT = '2026-09-25T02:40:00Z';
  const marker = '## Post-merge follow-up triage\nCreated/updated: daily bucket #9769 `follow-up(daily:2026-09-25)` con 1 item';
  const bucketAfterDemotion = {
    number: 9769,
    title: 'follow-up(daily:2026-09-25): 7 items — valerielinc-ops/frontaliere-si-o-no',
    body: '### FU-2026-09-25-001 — altro item\n- Sources: PR #9560\n',
  };
  const gateComment = (createdAt: string, pr = 9633, bucket = 9769) => ({
    createdAt,
    body: [
      '<!-- followup-mint-gate -->',
      '## Item demoti dal gate sul conio',
      '',
      `Non tracciati come item. Issue #${bucket} resta aperta con 7 item validi; questi sono stati tolti dal suo corpo e vivono solo qui.`,
      '',
      '### (senza titolo)',
      `- Sources: PR #${pr}; PR body \`## Non implementato (ancora)\``,
      '- Target repository: valerielinc-ops/frontaliere-si-o-no',
    ].join('\n'),
  });
  const comments = (...extra: object[]) => JSON.stringify({
    comments: [{ createdAt: MARKER_AT, body: marker }, ...extra],
  });

  it('verifica OK: il commento del gate posteriore al marker prova la persistenza', () => {
    const prComments = comments(gateComment('2026-09-25T02:43:00Z'));
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion, prComments)).toBe(true);
    expect(persistedBucketIssueMatches(bucketAfterDemotion, 9633, prComments, Date.parse(MARKER_AT))).toBe(true);
  });

  it('senza commento del gate il bucket demotato resta non provato (fail-closed)', () => {
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion, comments())).toBe(false);
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion)).toBe(false);
  });

  it('una prova del gate ANTERIORE al marker, di un altro bucket o di un altra PR non vale', () => {
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion,
      comments(gateComment('2026-09-25T02:30:00Z')))).toBe(false);
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion,
      comments(gateComment('2026-09-25T02:43:00Z', 9633, 9770)))).toBe(false);
    expect(verifyTriageMarkerPersistence(marker, 9633, () => bucketAfterDemotion,
      comments(gateComment('2026-09-25T02:43:00Z', 9634)))).toBe(false);
  });

  it('senza createdAt leggibile la prova del gate non vale', () => {
    expect(gatePreservedFollowupMatches(comments(gateComment('2026-09-25T02:43:00Z')), 9769, 9633, undefined)).toBe(false);
    expect(gatePreservedFollowupMatches(comments(gateComment('non una data')), 9769, 9633, MARKER_AT)).toBe(false);
    expect(latestTriageComment(comments())).toEqual({ body: marker, at: Date.parse(MARKER_AT) });
  });

  it('legge il bucket in ENTRAMBI i repository e usa il token di ciascuno', () => {
    const calls: Array<{ args: string[]; token: string }> = [];
    const run = (args: string[], token: string) => {
      calls.push({ args, token });
      const repo = args[args.indexOf('--repo') + 1];
      return repo === 'nanakokyobashi-rgb/frontaliere-articles' ? null : JSON.stringify(bucketAfterDemotion);
    };
    const read = readBucketIssue(9769, run, ['valerielinc-ops/frontaliere-si-o-no', 'nanakokyobashi-rgb/frontaliere-articles']);
    expect(read.candidates).toHaveLength(1);
    expect(read.candidates[0].repo).toBe('valerielinc-ops/frontaliere-si-o-no');
    expect(read.unreadable).toBe(true);
    expect(calls.map((call) => call.args[call.args.indexOf('--repo') + 1])).toEqual([
      'valerielinc-ops/frontaliere-si-o-no',
      'nanakokyobashi-rgb/frontaliere-articles',
    ]);
    // Provato in un repository: l'altro illeggibile non rende la PR non verificata.
    expect(verifyTriageMarkerPersistence(marker, 9633, () => read, comments(gateComment('2026-09-25T02:43:00Z')))).toBe(true);
  });

  it('--verify-persistence: esito OK sul caso demotato, rosso sul marker senza prova', () => {
    const lines: string[] = [];
    const ok = verifyPersistenceCli(['9633'], {
      read: () => comments(gateComment('2026-09-25T02:43:00Z')),
      readIssue: () => bucketAfterDemotion,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(true);
    expect(lines.join('\n')).toContain('PR #9633: persistenza provata');

    lines.length = 0;
    const ko = verifyPersistenceCli(['9633', 'x'], {
      read: () => comments(),
      readIssue: () => bucketAfterDemotion,
      log: (line: string) => lines.push(line),
    });
    expect(ko).toBe(false);
    expect(lines.join('\n')).toContain('triage incompleta: PR #9633');
    expect(lines.join('\n')).toContain("triage incompleta: PR 'x' non numerica");
  });

  it('--verify-persistence: PR senza marker o commenti illeggibili = incompleta', () => {
    const lines: string[] = [];
    expect(verifyPersistenceCli(['9633'], { read: () => null, log: (l: string) => lines.push(l) })).toBe(false);
    expect(verifyPersistenceCli(['9633'], { read: () => JSON.stringify({ comments: [] }), log: (l: string) => lines.push(l) })).toBe(false);
    expect(lines.every((line) => line.includes('senza marker di triage leggibile'))).toBe(true);
  });
});

describe('maxTurnsFor', () => {
  it('keeps the floor at 26 (AGENTS.md: mai abbassare)', () => {
    expect(maxTurnsFor(-1)).toBe(26);
    expect(maxTurnsFor(0)).toBe(26);
    expect(maxTurnsFor(1)).toBe(34);
  });
  it('scales with batch size', () => {
    expect(maxTurnsFor(5)).toBe(66);
  });
  it('keeps scaling beyond the former 80-turn ceiling', () => {
    expect(maxTurnsFor(7)).toBe(82);
    expect(maxTurnsFor(11)).toBe(114);
  });
  it('caps at 240 only after the linear range', () => {
    expect(maxTurnsFor(26)).toBe(234);
    expect(maxTurnsFor(27)).toBe(240);
    expect(maxTurnsFor(30)).toBe(240);
  });
});

describe('ordine FIFO dei candidati', () => {
  // Il finding 🔴 della review sulla prima stesura: con `collection_ok=true` su
  // una sessione troncata il residuo deve restare RAGGIUNGIBILE. Metà della
  // garanzia e' la finestra a lookback fisso, l'altra metà e' l'ordine: il cap
  // taglia la coda, quindi servendo prima le PR recenti la coda vecchia non
  // veniva mai lavorata. Questo test fallisce se si torna all'ordine naturale
  // della Search API.
  // Ordine naturale della Search API: dal piu recente. Una PR oltre il cap, cosi
  // il test resta vero qualunque sia FOLLOWUP_SESSION_BATCH_LIMIT.
  const total = FOLLOWUP_SESSION_BATCH_LIMIT + 1;
  const base = Date.parse('2026-09-17T00:00:00Z');
  const searchApiOrder = Array.from({ length: total }, (_, i) => ({
    number: 9200 - i,
    mergedAt: new Date(base + (total - i) * 3600_000).toISOString(),
  }));

  it('serve prima le PR piu vecchie, cosi il cap rinvia le piu recenti', () => {
    const ordered = orderCandidatesFifo(searchApiOrder);
    expect(ordered.map((p) => p.number)).toEqual(searchApiOrder.map((p) => p.number).reverse());
    const session = selectFollowupSessionBatch(ordered.map((p) => p.number));
    // Le piu VECCHIE entrano in sessione; la piu recente (#9200) e' quella
    // rinviata, ed e' anche quella che la finestra successiva ritrovera' comunque.
    expect(session).toHaveLength(FOLLOWUP_SESSION_BATCH_LIMIT);
    expect(session).not.toContain(9200);
    expect(session[0]).toBe(9200 - FOLLOWUP_SESSION_BATCH_LIMIT);
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
    const candidates = Array.from({ length: FOLLOWUP_SESSION_BATCH_LIMIT + 2 }, (_, i) => i + 1);
    const snapshot = [...candidates];
    expect(selectFollowupSessionBatch(candidates)).toEqual(snapshot.slice(0, FOLLOWUP_SESSION_BATCH_LIMIT));
    expect(candidates).toEqual(snapshot);
  });

  // Capacità vs flusso (2026-09-27). Con cap 4 e cron ogni 3h la coda non si
  // smaltiva: GitHub esegue ~62% dei cron nominali (5,1 run reali/giorno su 8,
  // gap mediano 4,9h) = ~20 PR/giorno contro rinvii di 65-146 PR a ogni run.
  // Tre vincoli letti dal workflow reale, così che cap, watchdog, step e cron
  // non possano divergere in silenzio:
  //  1. cap x upper bound per PR osservato su un batch COMPLETATO
  //     (ceil(1.792.000 ms / 21 PR) = 86 s, corpus 34602892494) < watchdog;
  //  2. watchdog + setup/kill grace/coda (300 s) STRETTAMENTE sotto lo step;
  //  3. cap x run reali/giorno (cron nominali x 62%) >= picco di ~80 candidati
  //     al giorno (110 merge x ~72% oltre i gate).
  const COMPLETED_BATCH_DURATION_MS = 1_792_000;
  const COMPLETED_BATCH_PR_COUNT = 21;
  const COMPLETED_BATCH_UPPER_BOUND_SECONDS_PER_PR = Math.ceil(
    COMPLETED_BATCH_DURATION_MS / COMPLETED_BATCH_PR_COUNT / 1000,
  );
  const CODEX_SETUP_AND_TAIL_SECONDS = 300;
  const CRON_EXECUTED_RATIO = 0.62;
  const PEAK_CANDIDATES_PER_DAY = 80;
  const workflow = readFileSync(
    new URL('../.github/workflows/post-merge-followup.yml', import.meta.url),
    'utf8',
  );

  it('il batch completato dimensiona il cap sotto watchdog e step', () => {
    const watchdogSeconds = Number(/exec_timeout_minutes: "(\d+)"/u.exec(workflow)?.[1]) * 60;
    const stepAt = workflow.indexOf('id: followup\n');
    const stepHead = workflow.slice(workflow.lastIndexOf('      - name:', stepAt), stepAt);
    const stepMinutes = Number(/timeout-minutes: (\d+)/u.exec(stepHead)?.[1]);
    expect(watchdogSeconds).toBeGreaterThan(0);
    expect(stepMinutes).toBeGreaterThan(0);
    expect(FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_SECONDS_PER_PR)
      .toBe(COMPLETED_BATCH_UPPER_BOUND_SECONDS_PER_PR);
    const projectedDurationMs = FOLLOWUP_SESSION_BATCH_LIMIT
      * FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_SECONDS_PER_PR * 1000;
    expect(projectedDurationMs).toBeLessThan(6_840_000);
    expect(projectedDurationMs).toBeLessThan(watchdogSeconds * 1000);
    expect(watchdogSeconds + CODEX_SETUP_AND_TAIL_SECONDS).toBeLessThan(stepMinutes * 60);
  });

  it('il cap alla cadenza reale del cron copre il picco di candidati', () => {
    const hours = Number(/cron: '\d+ \*\/(\d+) \* \* \*'/u.exec(workflow)?.[1]);
    expect(Number.isFinite(hours) && hours > 0).toBe(true);
    const capacity = FOLLOWUP_SESSION_BATCH_LIMIT * (24 / hours) * CRON_EXECUTED_RATIO;
    expect(capacity).toBeGreaterThanOrEqual(PEAK_CANDIDATES_PER_DAY);
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
