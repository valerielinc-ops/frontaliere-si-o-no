/**
 * Osservatore della rimisura degli item `blocked` dei bucket giornalieri
 * (`scripts/ci/lib/followup-blocked-recheck.mjs`).
 *
 * Titolo di fallimento: «Bucket follow-up: item `blocked` riaperto più di una
 * volta o senza segnale nuovo». Un item bloccato esce per token (se il token
 * non era già vero quando l'item è nato) o rientra UNA volta su un commit
 * nuovo sul suo `Target file`; ogni lettura fallita è «non so», mai un'uscita.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';
import {
  applyBlockedRecheck,
  blockedRecheckSummary,
  blockedSince,
  bornTrueCommentBody,
  bucketBirthBoundIso,
  bucketStartIso,
  planBlockedRecheck,
  tokenBornAt,
  unblockedCommentBody,
} from '../scripts/ci/lib/followup-blocked-recheck.mjs';
import {
  itemBlockedMarker,
  itemBornSatisfiedMarker,
  itemTargetPath,
  itemUnblockedMarker,
  parseItemMarkers,
} from '../scripts/ci/lib/followup-item-evidence.mjs';
import { isTrustedAuthor } from '../scripts/ci/route-already-fixed.mjs';

const DAY = '2026-09-24';
const START = `${DAY}T00:00:00Z`;
// Limite superiore del conio: dopo la fine del giorno di Zurigo per DAY.
const BIRTH_BOUND = '2026-09-25T00:00:00Z';
const A = `FU-${DAY}-001`;
const B = `FU-${DAY}-002`;
const TARGET = 'scripts/update-jysk-jobs.mjs';
const SHA = '4bd626f3b4d0123456789abcdef0123456789abc';
const NOW = Date.parse('2026-10-04T06:00:00Z');

const item = (id: string, state = 'blocked', token = 'writeJobsCrawlerSlice()') => [
  `### ${id} — aggiornare il record JYSK`,
  `- State: ${state}`,
  '- Sources: PR #9500; PR body `## Non implementato (ancora)` — #9470',
  '- Target repository: valerielinc-ops/frontaliere-si-o-no',
  `- Target file: \`${TARGET}\``,
  '- Blocked on: nuova esecuzione del crawler JYSK.',
  `- Suggested action: verificare che \`${token}\` pubblichi una slice fresca`,
  `- Acceptance token: \`${token}\``,
].join('\n');
const bucket = (...items: string[]) => [
  '## Batch',
  '',
  `- Daily key: ${DAY} (Europe/Zurich)`,
  '- State: sealed',
  '- Target repository: valerielinc-ops/frontaliere-si-o-no',
  '',
  '## Item',
  ...items.flatMap((entry) => ['', entry]),
  '',
].join('\n');

const bot = (body: string, createdAt = '2026-09-30T08:00:00Z') => ({ author: { login: 'github-actions' }, authorAssociation: 'NONE', createdAt, body });
const markersOf = (comments: object[]) => parseItemMarkers(comments, { isTrusted: isTrustedAuthor });

const ioWith = (content: string | null) => ({
  fileExists: (p: string) => p === TARGET,
  readFile: (p: string) => (p === TARGET ? content : null),
});
const TODAY_WITH_TOKEN = 'export function run() { return writeJobsCrawlerSlice(); }';
const TODAY_WITHOUT_TOKEN = 'export function run() { return legacyWrite(); }';

function readers({
  commit = null as null | { sha: string, date: string },
  commitStatus = 'ok',
  historic = TODAY_WITHOUT_TOKEN as string | null,
  historicStatus = 'ok',
} = {}) {
  return {
    commitAfter: vi.fn(() => (commitStatus === 'ok' ? { status: 'ok', commit } : { status: commitStatus })),
    fileAt: vi.fn(() => (historicStatus === 'ok'
      ? (historic === null ? { status: 'absent' } : { status: 'ok', content: historic })
      : { status: historicStatus })),
  };
}

function plan(input: { body?: string, comments?: object[], labels?: string[], io?: object, readers?: { commitAfter: unknown, fileAt: unknown }, budget?: { remaining: number }, targetRepository?: string, localRepository?: string } = {}) {
  return planBlockedRecheck({
    body: input.body ?? bucket(item(A)),
    labels: input.labels ?? ['follow-up'],
    dailyKey: DAY,
    markers: markersOf(input.comments ?? []),
    io: input.io ?? ioWith(TODAY_WITHOUT_TOKEN),
    readers: input.readers ?? readers(),
    now: NOW,
    reentryBudget: input.budget ?? { remaining: 3 },
    targetRepository: input.targetRepository,
    localRepository: input.localRepository,
  });
}

describe('uscita per token: lo stesso oracolo degli item open, mai su un token nato vero', () => {
  it('token confermato oggi e assente alla fine del giorno del bucket → done', () => {
    const r = readers({ historic: TODAY_WITHOUT_TOKEN });
    const result = plan({ io: ioWith(TODAY_WITH_TOKEN), readers: r });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: A, outcome: 'done' });
    expect(r.fileAt).toHaveBeenCalledWith(TARGET, BIRTH_BOUND);
    const applied = applyBlockedRecheck(bucket(item(A)), { done: [A] });
    expect(applied.applied.done).toEqual([A]);
    expect(parseFollowupItems(applied.body)[0].state).toBe('done');
  });

  it('marker FU_ITEM_BORN_SATISFIED fidato → resta blocked, nessuna lettura storica', () => {
    const r = readers();
    const result = plan({
      io: ioWith(TODAY_WITH_TOKEN),
      readers: r,
      comments: [bot(itemBornSatisfiedMarker({ item: A }))],
    });
    expect(result.results[0].outcome).not.toBe('done');
    expect(r.fileAt).not.toHaveBeenCalled();
  });

  it('token già presente alla fine del giorno del bucket e nessun marker → born-true, scrive il marker, resta blocked', () => {
    const result = plan({ io: ioWith(TODAY_WITH_TOKEN), readers: readers({ historic: TODAY_WITH_TOKEN }) });
    expect(result.results[0]).toMatchObject({ id: A, outcome: 'born-true' });
    const comment = bornTrueCommentBody({ id: A, evidence: result.results[0].evidence, atIso: BIRTH_BOUND });
    expect(markersOf([bot(comment)])).toEqual([{ type: 'born-satisfied', item: A, createdAt: '2026-09-30T08:00:00Z' }]);
    // Il giro dopo il marker c'è: il token non porta più a done.
    const next = plan({ io: ioWith(TODAY_WITH_TOKEN), comments: [bot(comment)] });
    expect(next.results[0].outcome).not.toBe('done');
  });

  it('token introdotto il giorno del bucket, prima del conio → born-true, mai done (caso ambiguo fail-closed)', () => {
    // Mezzanotte: token assente. Fine del giorno: presente. Il triage conia per
    // tutto il giorno, quindi l'item puo' essere nato DOPO il commit del token.
    const fileAt = vi.fn((_path: string, iso: string) => ({ status: 'ok', content: iso === START ? TODAY_WITHOUT_TOKEN : TODAY_WITH_TOKEN }));
    const result = plan({ io: ioWith(TODAY_WITH_TOKEN), readers: { commitAfter: vi.fn(), fileAt } });
    expect(result.results[0]).toMatchObject({ id: A, outcome: 'born-true' });
    expect(fileAt).toHaveBeenCalledWith(TARGET, BIRTH_BOUND);
    expect(fileAt).not.toHaveBeenCalledWith(TARGET, START);
  });

  it('file assente alla fine del giorno del bucket → il token è nuovo → done', () => {
    const result = plan({ io: ioWith(TODAY_WITH_TOKEN), readers: readers({ historic: null }) });
    expect(result.results[0].outcome).toBe('done');
  });

  it('usa l’esistenza dello snapshot storico, anche se il file manca nel checkout corrente', () => {
    const parsed = parseFollowupItems(bucket(item(A)))[0];
    const fileAt = vi.fn(() => ({ status: 'ok', content: TODAY_WITH_TOKEN }));
    const currentIo = { fileExists: () => false, readFile: () => null };
    expect(tokenBornAt(parsed, currentIo, fileAt, BIRTH_BOUND)).toBe('born');
    expect(fileAt).toHaveBeenCalledTimes(1);
    expect(fileAt).toHaveBeenCalledWith(TARGET, BIRTH_BOUND);
  });

  it('lettura storica fallita → unknown, mai done', () => {
    const result = plan({ io: ioWith(TODAY_WITH_TOKEN), readers: readers({ historicStatus: 'error' }) });
    expect(result.results[0]).toMatchObject({ outcome: 'unknown', why: 'born-check-unavailable' });
  });
});

describe('rientro: un commit nuovo sul Target file riapre l’item UNA volta', () => {
  const after = { sha: SHA, date: '2026-09-27T13:18:57Z' };

  it('commit dopo il blocco, nessun marker → open + marker FU_ITEM_UNBLOCKED col commit', () => {
    const r = readers({ commit: after });
    const result = plan({ readers: r });
    expect(r.commitAfter).toHaveBeenCalledWith(TARGET, START);
    expect(result.results[0]).toMatchObject({ id: A, outcome: 'reenter', target: TARGET, commit: after, blockedSource: 'bucket-date' });
    const comment = unblockedCommentBody(result.results[0]);
    expect(comment.startsWith(`<!-- FU_ITEM_UNBLOCKED: item=${A} commit=${SHA} -->`)).toBe(true);
    expect(comment.match(/<!--/gu)).toHaveLength(1);
    expect(markersOf([bot(comment)])).toEqual([{ type: 'unblocked', item: A, commit: SHA, createdAt: '2026-09-30T08:00:00Z' }]);
    const applied = applyBlockedRecheck(bucket(item(A)), { reentered: [A] });
    expect(parseFollowupItems(applied.body)[0].state).toBe('open');
  });

  it('item già rientrato (marker fidato) → nessun secondo rientro, nessuna lettura', () => {
    const r = readers({ commit: after });
    const comments = [
      bot(itemUnblockedMarker({ item: A, commit: SHA }), '2026-09-28T06:00:00Z'),
      // Il fixer lo ha ribloccato dopo il rientro; poi arriva un altro commit.
      bot(itemBlockedMarker({ item: A, reason: 'no-root-cause' }), '2026-09-29T06:00:00Z'),
    ];
    const result = plan({ readers: r, comments });
    expect(result.results[0]).toMatchObject({ outcome: 'waiting', why: 'already-reentered' });
    expect(r.commitAfter).not.toHaveBeenCalled();
  });

  it('marker FU_ITEM_UNBLOCKED di autore non fidato → ignorato', () => {
    const forged = { author: { login: 'drive-by-user' }, authorAssociation: 'NONE', createdAt: '2026-09-28T06:00:00Z', body: itemUnblockedMarker({ item: A, commit: SHA }) };
    const result = plan({ readers: readers({ commit: after }), comments: [forged] });
    expect(result.results[0].outcome).toBe('reenter');
  });

  it('nessun commit dopo il blocco, anche con tutte le Sources mergiate → invariato', () => {
    expect(plan({ readers: readers({ commit: null }) }).results[0]).toMatchObject({ outcome: 'waiting', why: 'no-new-commit' });
    // `since` di GitHub è inclusivo: un commit allo stesso istante del blocco non è un segnale nuovo.
    expect(plan({ readers: readers({ commit: { sha: SHA, date: START } }) }).results[0].outcome).toBe('waiting');
  });

  it('reason=awaiting-verification → mai rientro, nemmeno con un commit nuovo', () => {
    const r = readers({ commit: after });
    const result = plan({ readers: r, comments: [bot(itemBlockedMarker({ item: A, reason: 'awaiting-verification' }))] });
    expect(result.results[0]).toMatchObject({ outcome: 'waiting', why: 'awaiting-verification' });
    expect(r.commitAfter).not.toHaveBeenCalled();
  });

  it('lettura dei commit fallita → nessun rientro', () => {
    expect(plan({ readers: readers({ commitStatus: 'error' }) }).results[0]).toMatchObject({ outcome: 'unknown', why: 'commit-read-unavailable' });
    expect(plan({ readers: readers({ commitStatus: 'budget' }) }).results[0].outcome).toBe('unknown');
  });

  it('il blocco si data dal marker fidato più recente; senza marker dall’inizio del bucket', () => {
    const comments = [
      bot(itemBlockedMarker({ item: A, reason: 'no-root-cause' }), '2026-09-26T10:00:00Z'),
      bot(itemBlockedMarker({ item: A, reason: 'blocked-admin-settings' }), '2026-09-28T10:00:00Z'),
    ];
    expect(blockedSince(A, markersOf(comments), DAY)).toEqual({ at: '2026-09-28T10:00:00.000Z', source: 'marker', reason: 'blocked-admin-settings' });
    expect(blockedSince(A, [], DAY)).toEqual({ at: START, source: 'bucket-date', reason: null });
    const r = readers({ commit: after });
    expect(plan({ readers: r, comments }).results[0].outcome).toBe('waiting'); // commit del 27 < blocco del 28
    expect(r.commitAfter).toHaveBeenCalledWith(TARGET, '2026-09-28T10:00:00.000Z');
  });

  it('tetto di rientri per run: oltre il tetto resta waiting senza spendere letture', () => {
    const r = readers({ commit: after });
    const budget = { remaining: 1 };
    const result = plan({ body: bucket(item(A), item(B)), readers: r, budget });
    expect(result.results.map((entry: { outcome: string }) => entry.outcome)).toEqual(['reenter', 'waiting']);
    expect(result.results[1].why).toBe('reentry-cap');
    expect(r.commitAfter).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(0);
  });

  it('Target file non risolvibile → nessun rientro', () => {
    const odd = item(A).replace(`\`${TARGET}\``, '`../outside.mjs`');
    expect(plan({ body: bucket(odd), readers: readers({ commit: after }) }).results[0]).toMatchObject({ outcome: 'waiting', why: 'no-target-file' });
    expect(itemTargetPath({ targetFile: '`.github/workflows/x.yml:L12`' })).toBe('.github/workflows/x.yml');
    expect(itemTargetPath({ targetFile: 'a b.mjs' })).toBe('');
  });
});

describe('perimetro della rimisura', () => {
  it('bucket decomposed:1 → saltato', () => {
    const r = readers({ commit: { sha: SHA, date: '2026-09-27T13:18:57Z' } });
    expect(plan({ labels: ['follow-up', 'decomposed:1'], readers: r })).toEqual({ skipped: 'decomposed', results: [] });
    expect(r.commitAfter).not.toHaveBeenCalled();
  });

  it('bucket non sealed → saltato; nessun item blocked → niente da fare', () => {
    expect(plan({ body: bucket(item(A)).replace('- State: sealed', '- State: collecting') }).skipped).toBe('not-sealed');
    expect(plan({ body: bucket(item(A, 'open')) }).skipped).toBe('no-blocked');
    expect(bucketStartIso('2026-13-40')).toBeNull();
    expect(bucketBirthBoundIso('2026-13-40')).toBeNull();
    expect(bucketBirthBoundIso('2026-12-31')).toBe('2027-01-01T00:00:00Z');
  });

  it('bucket che punta a un altro repository → ogni blocked è unknown, nessuna lettura', () => {
    const r = readers({ commit: { sha: SHA, date: '2026-09-27T13:18:57Z' } });
    const result = plan({
      io: ioWith(TODAY_WITH_TOKEN),
      readers: r,
      targetRepository: 'valerielinc-ops/frontaliere-si-o-no',
      localRepository: 'nanakokyobashi-rgb/frontaliere-articles',
    });
    expect(result.results).toEqual([expect.objectContaining({ id: A, outcome: 'unknown', why: 'foreign-target-repository' })]);
    expect(r.commitAfter).not.toHaveBeenCalled();
    expect(r.fileAt).not.toHaveBeenCalled();
    // Stesso repository (maiuscole a parte) o repository locale ignoto → rimisura normale.
    const same = plan({ readers: readers({ commit: null }), targetRepository: 'valerielinc-ops/frontaliere-si-o-no', localRepository: 'Valerielinc-Ops/Frontaliere-Si-O-No' });
    expect(same.results[0].why).toBe('no-new-commit');
  });

  it('applyBlockedRecheck tocca solo item ancora blocked', () => {
    const body = bucket(item(A, 'open'), item(B));
    const applied = applyBlockedRecheck(body, { done: [A], reentered: [B] });
    expect(applied.applied).toEqual({ done: [], reentered: [B] });
    expect(parseFollowupItems(applied.body).map((entry: { state: string }) => entry.state)).toEqual(['open', 'open']);
  });

  it('riepilogo con conteggi ed età dei blocchi in attesa', () => {
    const results = [
      { id: A, outcome: 'done', ageDays: 10 },
      { id: B, outcome: 'reenter', ageDays: 10 },
      { id: `FU-${DAY}-003`, outcome: 'waiting', ageDays: 10 },
      { id: `FU-${DAY}-004`, outcome: 'born-true', ageDays: 10 },
      { id: `FU-${DAY}-005`, outcome: 'unknown', ageDays: null },
    ];
    expect(blockedRecheckSummary(results)).toBe(
      `blocked_done=1 reentered=1 born_marked=1 unknown=1 blocked_waiting=FU-${DAY}-003:10d,FU-${DAY}-004:10d,FU-${DAY}-005:?d`,
    );
    expect(blockedRecheckSummary([])).toBe('blocked_done=0 reentered=0 born_marked=0 unknown=0 blocked_waiting=-');
  });
});
