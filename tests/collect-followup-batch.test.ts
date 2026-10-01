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
  ghBucketRead,
  ISSUE_NUMBER_NOT_FOUND_RE,
  verifyPersistenceCli,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
  canonicalLogin,
  maxTurnsFor,
  selectFollowupSessionBatch,
  FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS,
  FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_PR_COUNT,
  FOLLOWUP_SESSION_BATCH_LIMIT,
  deferredCount,
  orderCandidatesFifo,
  shouldTriageAfterCandidateGate,
  shouldTriageAfterFixGate,
  markerIdempotencyDecision,
  MARKER_QUARANTINE_AFTER_MS,
  quarantineReason,
  unreportedQuarantine,
  reportQuarantinedMarkers,
  QUARANTINE_ALARM_TITLE,
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
  //  1. cap <= PR della sessione COMPLETATA misurata (corpus 36352293610:
  //     14 PR, 1.502.814 ms, triage_complete=true), e quella durata sotto il
  //     watchdog. Si confronta la sessione intera: la media per PR non è un
  //     upper bound;
  //  2. watchdog + setup/kill grace/coda (300 s) STRETTAMENTE sotto lo step;
  //  3. cap x run reali/giorno (cron nominali x 62%) >= picco di ~80 candidati
  //     al giorno (110 merge x ~72% oltre i gate).
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
    expect(FOLLOWUP_SESSION_BATCH_LIMIT)
      .toBeLessThanOrEqual(FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_PR_COUNT);
    expect(FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS).toBeLessThan(6_840_000);
    expect(FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS)
      .toBeLessThan(watchdogSeconds * 1000);
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

    // La run #36799206433 ha raccolto 179 candidati: i 165 oltre il cap erano
    // un rinvio pianificato, con collection_ok=true. Il guasto di un reader
    // GitHub ha un bit separato e non deve riscrivere questa classificazione.
    const candidates = Array.from({ length: FOLLOWUP_SESSION_BATCH_LIMIT + 165 }, (_, i) => i + 1);
    const session = selectFollowupSessionBatch(candidates);
    expect(deferredCount(candidates, session)).toBe(165);
    const collector = readFileSync(new URL('../scripts/ci/collect-followup-batch.mjs', import.meta.url), 'utf8');
    expect(collector).toContain('emit(sessionBatch, dailyKey, { collectionOk: true, deferred, quarantined });');
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

describe('marker su piu bucket: conteggio in testa e un bucket per bullet (#10015, #10050)', () => {
  // Marker, commento del gate e blocchi item dei bucket REALI, parola per
  // parola (run 36461728260, 36495756021, 36520419253: verifica rossa a ogni
  // run con «marker … senza riferimento a un bucket persistito»).
  const fixture = JSON.parse(readFileSync(
    new URL('./fixtures/followup-multi-bucket-markers.json', import.meta.url),
    'utf8',
  ));
  const commentsOf = (pr: string) => JSON.stringify({ comments: fixture.prs[pr].comments });
  const markerOf = (pr: string) => latestTriageCommentBody(commentsOf(pr));
  const corpusBucket = fixture.buckets['nanakokyobashi-rgb/frontaliere-articles#1957'];
  const siteBucket = fixture.buckets['valerielinc-ops/frontaliere-si-o-no#10171'];
  // Come readBucketIssue: ogni numero letto in ENTRAMBI i repository; il
  // numero assente da un repository e' «non lo so» per quel repository.
  const readBoth = (bucket: number) => ({
    candidates: [corpusBucket, siteBucket].filter((issue) => issue.number === bucket),
    unreadable: true,
  });

  it('trova i bucket nei bullet sotto la riga di claim', () => {
    expect(triageMarkerPersistenceExpectation(markerOf('10015'))).toEqual({
      buckets: [1957, 10171],
      requiresBucket: true,
    });
    expect(triageMarkerPersistenceExpectation(markerOf('10050'))).toEqual({
      buckets: [1957],
      requiresBucket: true,
    });
  });

  it('prova la persistenza reale: corpus #1957 + sito #10171, e il gate per #10050', () => {
    expect(verifyTriageMarkerPersistence(markerOf('10015'), 10015, readBoth, commentsOf('10015'))).toBe(true);
    // FU-2026-09-28-010 e' stato demotato dal gate DOPO il marker: la prova e'
    // il commento di conservazione che cita Issue #1957.
    expect(verifyTriageMarkerPersistence(markerOf('10050'), 10050, readBoth, commentsOf('10050'))).toBe(true);
    const lines: string[] = [];
    expect(verifyPersistenceCli(['10015', '10050'], {
      read: (pr: number) => commentsOf(String(pr)),
      readIssue: readBoth,
      log: (line: string) => lines.push(line),
    })).toBe(true);
    expect(lines).toEqual([
      'PR #10015: persistenza provata (bucket=[1957,10171]).',
      'PR #10050: persistenza provata (bucket=[1957]).',
    ]);
  });

  it('ogni bucket dichiarato va provato: un bullet non persistito resta rosso', () => {
    const onlyCorpus = (bucket: number) => (bucket === 1957 ? corpusBucket : false);
    expect(verifyTriageMarkerPersistence(markerOf('10015'), 10015, onlyCorpus, commentsOf('10015'))).toBe(false);
  });

  it('nei bullet vale solo #N col tag daily; PR citate e prosa dopo la lista restano fuori', () => {
    const marker = [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: 1 item.',
      '- FU-2026-09-28-001 da PR #10015 (vedi #9999), bucket PR #10015',
      '- Corpus #1957 `follow-up(daily:2026-09-28)` — `FU-2026-09-28-009`',
      '',
      '- Site #8248 `follow-up(daily:2026-09-11)` sealed, storico.',
      'Nota: il bucket #8249 e #8250 `follow-up(daily:2026-09-11)` sono chiusi.',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(marker)).toEqual({ buckets: [1957], requiresBucket: true });
  });

  it('`pull-request #N` e `pull request #N` col tag daily non sono bucket', () => {
    const marker = [
      '## Post-merge follow-up triage',
      'Created/updated: 1 item.',
      '- pull-request #10015 `follow-up(daily:2026-09-28)`',
      '- pull request #10050 `follow-up(daily:2026-09-28)`',
      '- Corpus #1957 `follow-up(daily:2026-09-28)`',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(marker)).toEqual({ buckets: [1957], requiresBucket: true });
  });

  it('un bullet non trasforma in promessa un claim a zero', () => {
    const marker = [
      '## Post-merge follow-up triage',
      'Created/updated: 0 item.',
      '- Corpus #1957 `follow-up(daily:2026-09-28)` non modificato da questa PR.',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(marker)).toEqual({ buckets: [], requiresBucket: false });
  });

  it('la forma canonica a piu bucket di FOLLOWUP.md e letta riga per riga', () => {
    const contract = readFileSync(new URL('../FOLLOWUP.md', import.meta.url), 'utf8');
    const template = /Created\/updated: daily bucket #<id-corpus>[\s\S]*?<item one-line>\nCreated\/updated: daily bucket #<id-sito>[^\n]*\n- <item one-line>/.exec(contract);
    expect(template).not.toBeNull();
    const marker = '## Post-merge follow-up triage\n\n' + template![0]
      .replace('<id-corpus>', '1957')
      .replace('<id-sito>', '10171')
      .replaceAll('<YYYY-MM-DD>', '2026-09-28')
      .replace('K item', '1 item')
      .replace('J item', '1 item');
    expect(triageMarkerPersistenceExpectation(marker)).toEqual({ buckets: [1957, 10171], requiresBucket: true });
    expect(verifyTriageMarkerPersistence(marker, 10015, readBoth)).toBe(true);
  });
});

describe('quarantena del marker che non converge', () => {
  const MARKER_AT = Date.parse('2026-09-28T18:23:51Z');
  const HOUR = 3600_000;

  it('false e vecchio → quarantena; false e recente → retry; null → retry', () => {
    expect(MARKER_QUARANTINE_AFTER_MS).toBe(6 * HOUR);
    expect(markerIdempotencyDecision(false, MARKER_AT, MARKER_AT + 6 * HOUR + 1)).toBe('quarantine');
    expect(markerIdempotencyDecision(false, MARKER_AT, MARKER_AT + 30 * HOUR)).toBe('quarantine');
    // Entro 6h il commento del gate puo' ancora arrivare dopo la verifica.
    expect(markerIdempotencyDecision(false, MARKER_AT, MARKER_AT + 6 * HOUR)).toBe('retry');
    expect(markerIdempotencyDecision(false, MARKER_AT, MARKER_AT + HOUR)).toBe('retry');
    // Lettura indisponibile: nessun verdetto, resta in retry anche se vecchio.
    expect(markerIdempotencyDecision(null, MARKER_AT, MARKER_AT + 30 * HOUR)).toBe('retry');
    // Eta' non misurabile: niente quarantena.
    expect(markerIdempotencyDecision(false, Number.NaN, MARKER_AT + 30 * HOUR)).toBe('retry');
    expect(markerIdempotencyDecision(false, undefined, MARKER_AT + 30 * HOUR)).toBe('retry');
    expect(markerIdempotencyDecision(true, MARKER_AT, MARKER_AT + 30 * HOUR)).toBe('skip');
  });

  it("l'eta e quella del marker CORRENTE (latestTriageComment)", () => {
    const comments = JSON.stringify({ comments: [
      { body: '## Post-merge follow-up triage\nCreated/updated: 1 item.', createdAt: '2026-09-20T00:00:00Z' },
      { body: '## Post-merge follow-up triage\nCreated/updated: 1 item.', createdAt: '2026-09-28T18:23:51Z' },
    ] });
    const at = latestTriageComment(comments)?.at;
    expect(markerIdempotencyDecision(false, at, MARKER_AT + HOUR)).toBe('retry');
  });

  it('il motivo distingue il marker senza bucket da quello con bucket non provato', () => {
    expect(quarantineReason('## Post-merge follow-up triage\nCreated/updated: 2 item.'))
      .toContain('senza riferimento a un bucket persistito');
    expect(quarantineReason('## Post-merge follow-up triage\nCreated/updated: daily bucket #42 con 1 item'))
      .toContain('bucket=[42]');
  });

  it("l'allarme riusa github-issue-creator ed e idempotente per PR", async () => {
    const quarantined = [
      { number: 10015, reason: 'r1' },
      { number: 10050, reason: 'r2' },
    ];
    const issues = JSON.stringify([
      { number: 1, title: QUARANTINE_ALARM_TITLE, body: '- PR #10015: r1.', comments: [] },
      { number: 2, title: 'altro titolo', body: '- PR #10050', comments: [] },
    ]);
    expect(unreportedQuarantine(quarantined, issues)).toEqual([{ number: 10050, reason: 'r2' }]);
    expect(unreportedQuarantine(quarantined, 'not json')).toBeNull();
    // #100150 non e' #10015.
    expect(unreportedQuarantine([{ number: 10015, reason: 'r' }], JSON.stringify([
      { title: QUARANTINE_ALARM_TITLE, body: 'PR #100150', comments: [{ body: 'PR #1001' }] },
    ]))).toHaveLength(1);

    const created: Array<Record<string, unknown>> = [];
    const createIssue = async (options: Record<string, unknown>) => {
      created.push(options);
      return { number: 1, persisted: true };
    };
    const log = () => {};
    const first = await reportQuarantinedMarkers(quarantined, { listIssues: () => issues, createIssue, log });
    expect(first.reported).toEqual([10050]);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe(QUARANTINE_ALARM_TITLE);
    expect(String(created[0].description)).toContain('- PR #10050: r2.');
    expect(String(created[0].description)).not.toContain('PR #10015');

    // Gia' segnalate entrambe: nessuna scrittura.
    const reported = JSON.stringify([
      { title: QUARANTINE_ALARM_TITLE, body: '- PR #10015: r1.', comments: [{ body: '- PR #10050: r2.' }] },
    ]);
    expect((await reportQuarantinedMarkers(quarantined, { listIssues: () => reported, createIssue, log })).reported).toEqual([]);
    // Elenco illeggibile: nessuna scrittura alla cieca.
    expect((await reportQuarantinedMarkers(quarantined, { listIssues: () => null, createIssue, log })).unverifiable).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe('bucket assente da un repository ≠ bucket illeggibile (run 36799206433)', () => {
  // Il bucket del sito #10433 non esiste nel corpus. Dopo che i suoi ultimi
  // item erano spariti dal corpo, il 404 del corpus rendeva il verdetto `null`
  // («bucket non leggibile»): il collector rimetteva le PR nel batch a ogni
  // run invece di metterle in quarantena con l'allarme.
  const SITE = 'valerielinc-ops/frontaliere-si-o-no';
  const CORPUS = 'nanakokyobashi-rgb/frontaliere-articles';
  const marker = '## Post-merge follow-up triage\n\nCreated/updated: daily bucket #10433 `follow-up(daily:2026-09-30)` (sito) con 1 item:\n- `FU-2026-09-30-079` — Correct Coop workplace locality evidence';
  const prComments = JSON.stringify({ comments: [{ createdAt: '2026-09-30T22:28:42Z', body: marker }] });
  const truncatedBucket = {
    number: 10433,
    title: 'follow-up(daily:2026-09-30): 69 items — valerielinc-ops/frontaliere-si-o-no',
    body: '## Batch\n- State: sealed\n\n### FU-2026-09-30-075 — Prevent nested-body duplication\n- State: open\n- Sources: PR #10325\n- ',
  };
  const notFound = Object.assign(new Error('Command failed: gh issue view 10433'), {
    stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 10433. (repository.issue)\n',
  });
  const rateLimited = Object.assign(new Error('gh issue view failed'), {
    stderr: Buffer.from('HTTP 502: Bad Gateway (https://api.github.com/graphql)'),
  });

  function runThroughGhBucketRead(siteOutcome: string | Error, corpusOutcome: string | Error = notFound) {
    const calls: Array<{ command: string; repo: string }> = [];
    const exec = (command: string, args: string[]) => {
      const repo = args[args.indexOf('--repo') + 1];
      calls.push({ command, repo });
      const outcome = repo === SITE ? siteOutcome : corpusOutcome;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    // Reproduce ghBucketRead's actual third parameter. If readBucketIssue
    // passes `true`, it reaches ghBucketRead as `exec` and the TypeError is
    // converted to null, exactly as in production.
    const run = (args: string[], token = '', execArg: unknown = exec) =>
      ghBucketRead(args, token, execArg as never);
    return { run, calls };
  }

  const realBucketSamples = [
    {
      bucket: 10433,
      pr: 10188,
      createdAt: '2026-09-29T23:45:30Z',
      marker: [
        '## Post-merge follow-up triage',
        '',
        'Created/updated: daily bucket #10433 `follow-up(daily:2026-09-30)` (valerielinc-ops/frontaliere-si-o-no) con 1 item:',
        '- `FU-2026-09-30-001` — prova post-merge di Deploy to GitHub Pages dopo la run cancellata.',
      ].join('\n'),
      issue: {
        number: 10433,
        title: 'follow-up(daily:2026-09-30): 69 items — valerielinc-ops/frontaliere-si-o-no',
        body: '## Batch\n- State: sealed\n\n### FU-2026-09-30-001 — Post-merge deploy proof\n- State: open\n- Sources: PR #10188',
      },
    },
    {
      bucket: 10283,
      pr: 10102,
      createdAt: '2026-09-29T04:29:34Z',
      marker: [
        '## Post-merge follow-up triage',
        '',
        'Created/updated: daily bucket #10283 `follow-up(daily:2026-09-29)` con 2 item:',
        '- `FU-2026-09-29-001` — verifica Vitest della closure crawler non eseguita per resource-guard locale.',
        '- `FU-2026-09-29-002` — mirror dei crawler-group nel corpus dopo il drift sync.',
      ].join('\n'),
      issue: {
        number: 10283,
        title: 'follow-up(daily:2026-09-29): 10 items — valerielinc-ops/frontaliere-si-o-no',
        body: '## Batch\n- State: sealed\n\n### FU-2026-09-29-001 — Vitest closure\n- State: open\n- Sources: PR #10102',
      },
    },
  ];

  it('classifica il NOT_FOUND del numero come risposta definitiva, il resto come illeggibile', () => {
    const exec = (outcome: unknown) => () => {
      if (outcome instanceof Error) throw outcome;
      return outcome as string;
    };
    expect(ghBucketRead(['issue', 'view', '10433'], '', exec(notFound) as never)).toBe(false);
    expect(ghBucketRead(['issue', 'view', '10433'], '', exec(Object.assign(new Error('x'), {
      stderr: Buffer.from('GraphQL: Could not resolve to an Issue with the number of 10433. (repository.issue)'),
    })) as never)).toBe(false);
    // Repository illeggibile/inesistente, guasto di rete o auth: non prova nulla.
    for (const stderr of [
      "GraphQL: Could not resolve to a Repository with the name 'owner/missing'. (repository)",
      'HTTP 502: Bad Gateway (https://api.github.com/graphql)',
      'HTTP 401: Bad credentials',
      '',
    ]) {
      expect(ghBucketRead(['issue', 'view', '10433'], '', exec(Object.assign(new Error('x'), { stderr })) as never)).toBeNull();
    }
    expect(ghBucketRead(['issue', 'view', '10433'], '', exec('{"number":10433}') as never)).toBe('{"number":10433}');
    expect(ISSUE_NUMBER_NOT_FOUND_RE.test('Could not resolve to a Repository with the name')).toBe(false);
  });

  it('un numero assente dal corpus lascia definitiva la lettura del sito', () => {
    const run = (args: string[]) => (args[args.indexOf('--repo') + 1] === CORPUS ? false : JSON.stringify(truncatedBucket));
    const read = readBucketIssue(10433, run as never, [SITE, CORPUS]);
    expect(read).toEqual({ candidates: [{ ...truncatedBucket, repo: SITE }], unreadable: false });
    // L'item della PR non c'e' piu': non persistito (`false`), non «illeggibile».
    expect(verifyTriageMarkerPersistence(marker, 10332, () => read, prComments)).toBe(false);
    // Un marker non provato piu' vecchio di 6h esce dal batch con l'allarme.
    expect(markerIdempotencyDecision(false, Date.parse('2026-09-30T22:28:42Z'), Date.parse('2026-10-01T05:00:00Z'))).toBe('quarantine');
    const lines: string[] = [];
    expect(verifyPersistenceCli(['10332'], { read: () => prComments, readIssue: () => read, log: (line: string) => lines.push(line) })).toBe(false);
    expect(lines).toEqual(['triage incompleta: PR #10332 senza item/Source persistito né prova del gate (bucket=[10433]).']);
  });

  for (const sample of realBucketSamples) {
    it(`verifica il bucket reale #${sample.bucket} passando la firma effettiva di ghBucketRead`, () => {
      const bucketJson = JSON.stringify(sample.issue);
      const { run, calls } = runThroughGhBucketRead(bucketJson);
      const comments = JSON.stringify({ comments: [{ createdAt: sample.createdAt, body: sample.marker }] });
      const read = readBucketIssue(sample.bucket, run as never, [SITE, CORPUS]);
      expect(read).toEqual({ candidates: [{ ...sample.issue, repo: SITE }], unreadable: false });
      expect(calls).toEqual([{ command: 'gh', repo: SITE }, { command: 'gh', repo: CORPUS }]);

      const lines: string[] = [];
      expect(verifyPersistenceCli([String(sample.pr)], {
        read: () => comments,
        readIssue: (number: number) => readBucketIssue(number, run as never, [SITE, CORPUS]),
        log: (line: string) => lines.push(line),
      })).toBe(true);
      expect(lines).toEqual([`PR #${sample.pr}: persistenza provata (bucket=[${sample.bucket}]).`]);
    });
  }

  it('un errore GitHub reale resta unreadable attraverso readBucketIssue e il verifier', () => {
    const { run, calls } = runThroughGhBucketRead(rateLimited);
    const read = readBucketIssue(10433, run as never, [SITE, CORPUS]);
    expect(read).toEqual({ candidates: [], unreadable: true });
    expect(calls).toEqual([{ command: 'gh', repo: SITE }, { command: 'gh', repo: CORPUS }]);
    expect(verifyTriageMarkerPersistence(marker, 10332, () => read, prComments)).toBeNull();
  });

  it('un vero guasto di lettura resta «non leggibile» e tiene la PR nel batch', () => {
    const run = (args: string[]) => (args[args.indexOf('--repo') + 1] === CORPUS ? null : JSON.stringify(truncatedBucket));
    const read = readBucketIssue(10433, run as never, [SITE, CORPUS]);
    expect(read.unreadable).toBe(true);
    expect(verifyTriageMarkerPersistence(marker, 10332, () => read, prComments)).toBeNull();
  });
});
