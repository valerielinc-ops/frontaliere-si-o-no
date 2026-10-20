/**
 * Osservatore della prova CI degli item bloccati SOLO dalla guardia risorse
 * locale (`scripts/ci/lib/followup-ci-suite-proof.mjs`, decisione del
 * proprietario I4 del 2026-10-05).
 *
 * Titolo di fallimento: «Bucket follow-up: item bloccato dalla guardia locale
 * chiuso senza la suite verde in CI, o lasciato bloccato con la prova».
 *
 * Un item «CI verification of …» (blocco dichiarato: la guardia risorse
 * locale ha rifiutato vitest) diventa `done` quando la CI required della sua
 * PR ha eseguito verde la suite dell'item. Prova mancante, ambigua o
 * contraddetta → l'item resta com'e'. Un blocco di altro tipo non si tocca.
 */
import { describe, expect, it } from 'vitest';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';
import {
  applyCiSuiteProof,
  ciSuiteCandidates,
  ciSuiteProofCommentBody,
  ciSuiteProofSummary,
  decideCiSuiteProof,
  itemSourcePr,
  itemSuiteFiles,
  latestCompletedRun,
  localGuardBlock,
  planCiSuiteProof,
  readCiSuiteCandidates,
  suiteFileVerdict,
  suiteResultsFromJobLog,
  suiteResultsFromVitestReport,
  vitestStepConclusion,
} from '../scripts/ci/lib/followup-ci-suite-proof.mjs';
import { itemCiSuiteMarker, parseItemMarkers } from '../scripts/ci/lib/followup-item-evidence.mjs';
import { isTrustedAuthor } from '../scripts/ci/route-already-fixed.mjs';
import {
  ciSuiteProvenItemIds,
  dailyBucketCloseGate,
  dailyBucketGateInputs,
} from '../scripts/ci/reconcile-followups.mjs';

const DAY = '2026-09-30';
const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const A = `FU-${DAY}-002`;
const B = `FU-${DAY}-079`;
const MERGE = '714cf5b96342aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD = '2ee981aa0a57bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUITE = ['tests/services/posthog-error-filter.test.ts', 'tests/build-plugins/posthogInitBeforeSend.test.ts'];

// Forma reale (site#10433, FU-2026-09-30-002).
const guardItem = (id = A, state = 'blocked', overrides: Record<string, string> = {}) => [
  `### ${id} — CI verification of GPT-only exception filter`,
  `- State: ${state}`,
  `- Sources: ${overrides.sources ?? 'PR #10197; PR body `## Non implementato (ancora)`'}`,
  `- Stato dichiarato nella PR: ${overrides.declared ?? "blocked: la suite Vitest locale è stata rifiutata dal resource guard per swap oltre la soglia dell'85%"}`,
  `- Target repository: ${REPO}`,
  '- Target file: `services/posthog-error-filter.ts`',
  `- Blocked on: ${overrides.blockedOn ?? "il resource guard locale ha rifiutato la suite per swap oltre l'85%; serve il verdetto della CI della PR."}`,
  '- Original text:',
  "  > blocked: la suite Vitest locale è stata rifiutata dal resource guard per swap oltre la soglia dell'85%; la verifica completa è affidata alla CI di questa PR.",
  '- Funnel area: monetizzazione',
  '- Suggested action: rieseguire in CI la selezione di test indicata nella scheda e registrare il verdetto.',
  '- Acceptance token: (scheda COMANDO verificabile)',
  `- METRICA: prima=0 atteso=1 | COMANDO: ${overrides.command ?? `npx vitest run ${SUITE.join(' ')}`}`,
].join('\n');

// Forma reale di un blocco di ALTRO tipo (site#11228, FU-2026-09-30-079).
const otherItem = (id = B, state = 'open') => [
  `### ${id} — Correct Coop workplace locality evidence`,
  `- State: ${state}`,
  '- Sources: PR #10332; PR body ` Non implementato (ancora)',
  '- Stato dichiarato nella PR: blocked: località HQ in coop-job-parser.mjs — PR del lotto D',
  `- Target repository: ${REPO}`,
  '- Target file: `scripts/lib/coop-job-parser.mjs`',
  '- Blocked on: la correzione delle località HQ è assegnata al PR del lotto D.',
  '- Suggested action: correggere `listingAddressEvidence()`.',
  '- Acceptance token: `listingAddressEvidence()`',
  '- METRICA: prima=0 atteso=1 | COMANDO: npx vitest run tests/prospective-detail-description.test.ts',
].join('\n');

const bucket = (...items: string[]) => [
  '## Batch',
  '',
  `- Daily key: ${DAY} (Europe/Zurich)`,
  '- State: sealed',
  `- Target repository: ${REPO}`,
  '',
  '## Item',
  ...items.flatMap((entry) => ['', entry]),
  '',
].join('\n');

const itemOf = (text: string) => parseFollowupItems(bucket(text))[0];
const passedFile = (file: string, passed = 3) => ({ file: `/home/runner/work/repo/repo/${file}`, passed, failed: 0, skipped: 0 });

type Candidate = Record<string, unknown>;
const green = (results: unknown[] | null, extra: Candidate = {}) => ({
  kind: 'head', sha: HEAD, run: { id: 36560272815, conclusion: 'success' }, job: { id: 109379201715, conclusion: 'success' }, results, source: 'log', ...extra,
});
const red = (results: unknown[] | null, extra: Candidate = {}) => ({
  ...green(results, extra), run: { id: 36560272816, conclusion: 'failure' }, job: { id: 109379201716, conclusion: 'failure' },
});

/** Lettori finti nella forma di `readCiSuiteCandidates`. */
function readers({
  merged = true,
  mergeRun = null as null | { id: number, conclusion: string },
  headRun = { id: 36560272815, conclusion: 'success' } as null | { id: number, conclusion: string },
  jobConclusion = {} as Record<number, string>,
  results = {} as Record<number, unknown[] | null>,
  failing = '' as '' | 'pull' | 'latestRun' | 'vitestJob' | 'results',
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    pull: (n: number) => { calls.push(`pull:${n}`); return failing === 'pull' ? { status: 'budget' } : { status: 'ok', merged, mergeSha: MERGE, headSha: HEAD }; },
    latestRun: (sha: string) => {
      calls.push(`run:${sha.slice(0, 4)}`);
      if (failing === 'latestRun') return { status: 'error' };
      return { status: 'ok', run: sha === MERGE ? mergeRun : headRun };
    },
    vitestJob: (runId: number) => (failing === 'vitestJob' ? { status: 'error' } : { status: 'ok', job: { id: runId + 1, conclusion: jobConclusion[runId] ?? 'success' } }),
    results: (runId: number) => (failing === 'results' ? { status: 'error' } : { status: 'ok', results: results[runId] ?? null, source: 'log' }),
  };
}

describe('classificazione: bloccato SOLO dalla guardia risorse locale', () => {
  it('riconosce le forme reali del blocco della guardia', () => {
    for (const declared of [
      "blocked: la suite Vitest locale è stata rifiutata dal resource guard per swap oltre la soglia dell'85%",
      'blocked: il resource guard blocca l\'esecuzione con swap al 89,3%',
      "blocked: la resource-guard locale blocca i comandi pesanti con lo swap sopra l'85%",
      'blocked: la guardia risorse (`bin/agent-resource-guard.mjs`) blocca vitest e il sibling check con swap al 90-94 %',
    ]) {
      expect(localGuardBlock(itemOf(guardItem(A, 'blocked', { declared }))), declared).toEqual({ guardOnly: true, why: 'local-guard' });
    }
    // Anche `open` (stato dichiarato dalla PR, item mai passato a `blocked`).
    expect(localGuardBlock(itemOf(guardItem(A, 'open'))).guardOnly).toBe(true);
  });

  it('un blocco di altro tipo, o la guardia insieme a un altro blocco, NON e\' candidato', () => {
    expect(localGuardBlock(itemOf(otherItem()))).toEqual({ guardOnly: false, why: 'not-local-guard' });
    expect(localGuardBlock(itemOf(guardItem(A, 'blocked', { blockedOn: 'il resource guard locale blocca vitest; serve anche la PR del lotto C' }))))
      .toEqual({ guardOnly: false, why: 'other-blocker' });
    expect(localGuardBlock(itemOf(guardItem(A, 'blocked', { declared: 'blocked: resource guard e chiusura end-to-end della issue #9609' }))).guardOnly)
      .toBe(false);
  });

  it('un item done o in-progress non e\' mai candidato', () => {
    for (const state of ['done', 'in-progress']) {
      expect(localGuardBlock(itemOf(guardItem(A, state)))).toEqual({ guardOnly: false, why: 'state' });
    }
  });

  it('la suite e\' la COMANDO `npx vitest run <file di test>` e nient\'altro', () => {
    expect(itemSuiteFiles(itemOf(guardItem()))).toEqual(SUITE);
    for (const command of [
      'npx vitest run tests/a.test.ts --reporter=json',
      'npx vitest run tests/*.test.ts',
      'node --test generator/tests/pr-gate-test-list.test.mjs',
      'npx vitest run scripts/foo.mjs',
      'npx vitest run tests/../x.test.ts',
    ]) {
      expect(itemSuiteFiles(itemOf(guardItem(A, 'blocked', { command }))), command).toBeNull();
    }
  });

  it('la PR dell\'item e\' UNA sola fra le Sources', () => {
    expect(itemSourcePr(itemOf(guardItem()))).toBe(10197);
    expect(itemSourcePr(itemOf(guardItem(A, 'blocked', { sources: 'PR #10197; PR #10200' })))).toBeNull();
  });

  it('un item che chiede la suite intera non e\' candidato (la selezione CI non la esegue)', () => {
    // Forma reale: site#10831, FU-2026-10-02-004 («Full suite dopo l'aggiornamento delle dipendenze»).
    const full = guardItem(A, 'open', { declared: 'blocked: resource guard locale per pressione elevata della memoria/swap', command: 'npx vitest run tests/full-suite-dispatch-workflow.test.ts' })
      .replace('CI verification of GPT-only exception filter', 'Full suite dopo l’aggiornamento delle dipendenze');
    expect(localGuardBlock(itemOf(full)).guardOnly).toBe(true);
    expect(ciSuiteCandidates(bucket(full))).toEqual([expect.objectContaining({ id: A, candidate: false, why: 'full-suite-requested' })]);
    const prose = guardItem().replace('la verifica completa è affidata', 'la suite completa è affidata');
    expect(ciSuiteCandidates(bucket(prose))[0]).toMatchObject({ candidate: false, why: 'full-suite-requested' });
  });

  it('candidati di un corpo: solo l\'item della guardia, con suite e PR', () => {
    const list = ciSuiteCandidates(bucket(guardItem(), otherItem()));
    expect(list.filter((entry: { candidate: boolean }) => entry.candidate).map((entry: { id: string }) => entry.id)).toEqual([A]);
    expect(list.find((entry: { id: string }) => entry.id === A)).toMatchObject({ suite: SUITE, pr: 10197 });
    expect(list.some((entry: { id: string }) => entry.id === B)).toBe(false);
  });
});

describe('esiti per file della run', () => {
  it('report JSON di vitest: file passato, fallito, solo saltato', () => {
    const results = suiteResultsFromVitestReport({
      testResults: [
        { name: `/home/runner/work/r/r/${SUITE[0]}`, status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] },
        { name: `/home/runner/work/r/r/${SUITE[1]}`, status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'failed' }] },
        { name: '/home/runner/work/r/r/tests/skip.test.ts', status: 'passed', assertionResults: [{ status: 'skipped' }] },
        { name: '/home/runner/work/r/r/tests/import-broken.test.ts', status: 'failed', assertionResults: [] },
      ],
    });
    expect(suiteFileVerdict(results, SUITE[0])).toBe('passed');
    expect(suiteFileVerdict(results, SUITE[1])).toBe('failed');
    expect(suiteFileVerdict(results, 'tests/skip.test.ts')).toBe('missing');
    expect(suiteFileVerdict(results, 'tests/import-broken.test.ts')).toBe('failed');
    expect(suiteFileVerdict(results, 'tests/absent.test.ts')).toBe('missing');
    // Confronto sul path esatto relativo al repository: suffissi e cartelle annidate non contano.
    expect(suiteFileVerdict(results, 'posthog-error-filter.test.ts')).toBe('missing');
    const nested = suiteResultsFromVitestReport({ testResults: [{ name: `/home/runner/work/r/r/packages/articles/${SUITE[0]}`, status: 'passed', assertionResults: [{ status: 'passed' }] }] });
    expect(suiteFileVerdict(nested, SUITE[0])).toBe('missing');
    expect(suiteResultsFromVitestReport({ nope: true })).toBeNull();
  });

  it('log del job: righe per file del reporter default, con ANSI e timestamp', () => {
    const log = [
      '﻿2026-09-29T11:13:13.7595909Z Current runner version: \'2.337.0\'',
      '2026-09-29T11:15:35.1689515Z ✓ check-cls-ad-slots: no hard-coded AdSense <ins> in build-plugins.',
      `2026-09-29T11:16:16.3250077Z  \u001b[32m✓\u001b[39m \u001b[30m\u001b[43m node \u001b[49m\u001b[39m ${SUITE[0]} \u001b[2m(\u001b[22m\u001b[2m15 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[32m 44\u001b[2mms\u001b[22m\u001b[39m`,
      `2026-09-29T11:16:14.4144935Z  ✓  node  ${SUITE[1]} (9 tests | 1 skipped) 812ms`,
      '2026-09-29T11:16:20.0000000Z  ❯  node  tests/red.test.ts (5 tests | 1 failed) 30ms',
      '2026-09-29T11:16:21.0000000Z  ↓  node  tests/skipped.test.ts (3 tests | 3 skipped)',
      '2026-09-29T11:16:22.0000000Z      ✓ fails closed when index-only tenant text is available 302ms',
    ].join('\n');
    const results = suiteResultsFromJobLog(log);
    expect(suiteFileVerdict(results, SUITE[0])).toBe('passed');
    expect(suiteFileVerdict(results, SUITE[1])).toBe('passed');
    expect(suiteFileVerdict(results, 'tests/red.test.ts')).toBe('failed');
    expect(suiteFileVerdict(results, 'tests/skipped.test.ts')).toBe('missing');
    expect(suiteResultsFromJobLog('2026-09-29T11:13:13Z nessuna riga di vitest')).toBeNull();
  });

  it('la run piu\' recente fra quelle COMPLETATE dello sha', () => {
    expect(latestCompletedRun([
      { id: 1, status: 'completed', conclusion: 'failure', created_at: '2026-09-29T10:00:00Z' },
      { id: 2, status: 'completed', conclusion: 'success', created_at: '2026-09-29T11:00:00Z' },
      { id: 3, status: 'in_progress', conclusion: null, created_at: '2026-09-29T12:00:00Z' },
    ])).toMatchObject({ id: 2 });
    expect(latestCompletedRun([])).toBeNull();
  });
});

describe('decisione: done solo con la suite verde nella CI required', () => {
  const passing = SUITE.map((file) => passedFile(file));

  it('run verde che ha eseguito la suite → done, con PR, sha, run e job', () => {
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green(passing)] })).toEqual({
      outcome: 'done',
      why: 'ci-suite-green',
      proof: { kind: 'head', sha: HEAD, run: 36560272815, job: 109379201715, source: 'log', files: SUITE },
    });
  });

  it('run verde SENZA la suite (o con un solo file dei due) → resta bloccato', () => {
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green([passedFile('tests/other.test.ts')])] }))
      .toEqual({ outcome: 'waiting', why: 'suite-not-run' });
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green([passedFile(SUITE[0])])] }))
      .toEqual({ outcome: 'waiting', why: 'suite-not-run' });
  });

  it('run rossa → resta bloccato, anche se un\'altra run e\' verde con la suite', () => {
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [red(null)] })).toEqual({ outcome: 'waiting', why: 'red-run' });
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [red([passedFile('tests/other.test.ts')]), green(passing)] }))
      .toEqual({ outcome: 'waiting', why: 'red-run' });
    // La suite fallita in una run contraddice la run verde.
    const failedSuite = [{ ...passedFile(SUITE[0]), failed: 1 }, passedFile(SUITE[1])];
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green(passing), red(failedSuite)] }))
      .toEqual({ outcome: 'waiting', why: 'suite-failed' });
  });

  it('una run rossa PRIMA di vitest (step skipped) non prova e non contraddice', () => {
    // Forma reale: push di main per la PR 10222, `Assemble + migrate` fallito, vitest `skipped`.
    const assembleFailed = { ...red(null, { kind: 'merge', sha: MERGE }), job: { id: 108955150448, conclusion: 'failure', vitestStep: 'skipped' } };
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [assembleFailed, green(passing)] }))
      .toMatchObject({ outcome: 'done', proof: { kind: 'head', sha: HEAD } });
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [assembleFailed] })).toEqual({ outcome: 'waiting', why: 'red-run' });
    // Vitest ha girato (step failure) senza esiti leggibili: contraddice.
    const vitestRed = { ...assembleFailed, job: { ...assembleFailed.job, vitestStep: 'failure' } };
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [vitestRed, green(passing)] })).toEqual({ outcome: 'waiting', why: 'red-run' });
    expect(vitestStepConclusion([{ name: 'Assemble + migrate', conclusion: 'failure' }, { name: 'vitest related (PR diff)', conclusion: 'skipped' }])).toBe('skipped');
    expect(vitestStepConclusion([{ name: 'Assemble + migrate', conclusion: 'failure' }])).toBeNull();
  });

  it('una run rossa per altro, che si legge con la suite verde, non contraddice', () => {
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [red(passing, { kind: 'merge', sha: MERGE }), green(passing)] }))
      .toMatchObject({ outcome: 'done', proof: { kind: 'head' } });
  });

  it('esiti illeggibili, nessuna run, lettura fallita → mai done', () => {
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green(null)] })).toEqual({ outcome: 'waiting', why: 'ci-results-unreadable' });
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [{ kind: 'head', sha: HEAD, run: null, job: null, results: null }] }))
      .toEqual({ outcome: 'waiting', why: 'no-ci-run' });
    expect(decideCiSuiteProof({ suite: SUITE, candidates: [green(passing), { kind: 'merge', sha: MERGE, readError: true }] }))
      .toEqual({ outcome: 'unknown', why: 'ci-read-unavailable' });
    expect(decideCiSuiteProof({ suite: [], candidates: [green(passing)] }).outcome).toBe('waiting');
  });
});

describe('piano per bucket con letture iniettate', () => {
  const passing = SUITE.map((file) => passedFile(file));

  it('item della guardia con la suite verde → done; il blocco di altro tipo non viene toccato', () => {
    const r = readers({ results: { 36560272815: passing } });
    const plan = planCiSuiteProof({ body: bucket(guardItem(), otherItem()), readers: r, targetRepository: REPO, localRepository: REPO });
    expect(plan.skipped).toBeNull();
    expect(plan.results.map((entry: { id: string, outcome: string }) => [entry.id, entry.outcome])).toEqual([[A, 'done']]);
    expect(r.calls).toEqual(['pull:10197', `run:${MERGE.slice(0, 4)}`, `run:${HEAD.slice(0, 4)}`]);
    const { body, applied } = applyCiSuiteProof(bucket(guardItem(), otherItem()), [A, B]);
    expect(applied).toEqual([A]);
    const items = parseFollowupItems(body);
    expect(items.map((item: { id: string, state: string }) => [item.id, item.state])).toEqual([[A, 'done'], [B, 'open']]);
  });

  it('run verde senza la suite → resta bloccato; run rossa → resta bloccato', () => {
    const without = planCiSuiteProof({ body: bucket(guardItem()), readers: readers({ results: { 36560272815: [passedFile('tests/other.test.ts')] } }), targetRepository: REPO, localRepository: REPO });
    expect(without.results).toEqual([expect.objectContaining({ id: A, outcome: 'waiting', why: 'suite-not-run' })]);
    const redRun = planCiSuiteProof({
      body: bucket(guardItem()),
      readers: readers({ headRun: { id: 36560272815, conclusion: 'failure' }, jobConclusion: { 36560272815: 'failure' } }),
      targetRepository: REPO,
      localRepository: REPO,
    });
    expect(redRun.results).toEqual([expect.objectContaining({ id: A, outcome: 'waiting', why: 'red-run' })]);
  });

  it('PR non mergiata, lettura fallita, bucket di un altro repository o decomposto → nessun done', () => {
    expect(planCiSuiteProof({ body: bucket(guardItem()), readers: readers({ merged: false }), targetRepository: REPO, localRepository: REPO }).results)
      .toEqual([expect.objectContaining({ outcome: 'waiting', why: 'pr-not-merged' })]);
    for (const failing of ['pull', 'latestRun', 'vitestJob', 'results'] as const) {
      const plan = planCiSuiteProof({ body: bucket(guardItem()), readers: readers({ failing, results: { 36560272815: passing } }), targetRepository: REPO, localRepository: REPO });
      expect(plan.results[0].outcome, failing).toBe('unknown');
    }
    expect(planCiSuiteProof({ body: bucket(guardItem()), readers: readers(), targetRepository: 'owner/other', localRepository: REPO }))
      .toEqual({ skipped: 'foreign-target-repository', results: [] });
    expect(planCiSuiteProof({ body: bucket(guardItem()), labels: ['decomposed:1'], readers: readers(), targetRepository: REPO, localRepository: REPO }))
      .toEqual({ skipped: 'decomposed', results: [] });
    expect(readCiSuiteCandidates(10197, {})).toEqual({ status: 'error' });
  });
});

describe('prova registrata e gate di chiusura', () => {
  const proof = { kind: 'head', sha: HEAD, run: 36560272815, job: 109379201715, source: 'log', files: SUITE };
  const bot = (body: string) => ({ author: { login: 'github-actions' }, authorAssociation: 'NONE', createdAt: '2026-10-05T06:00:00Z', body });

  it('il commento porta il marker FU_ITEM_CI_SUITE con PR, sha, run e job', () => {
    const text = ciSuiteProofCommentBody({ id: A, pr: 10197, proof, repository: REPO });
    expect(text.split('\n')[0]).toBe(itemCiSuiteMarker({ item: A, pr: 10197, commit: HEAD, run: 36560272815, job: 109379201715 }));
    for (const file of SUITE) expect(text).toContain(file);
    expect(parseItemMarkers([bot(text)], { isTrusted: isTrustedAuthor }))
      .toEqual([expect.objectContaining({ type: 'ci-suite', item: A, pr: 10197, commit: HEAD, run: 36560272815, job: 109379201715 })]);
    expect(() => ciSuiteProofCommentBody({ id: A, pr: 10197, proof: { ...proof, sha: 'abc' } })).toThrow();
  });

  it('il gate conta l\'item done con la prova come confermato; senza prova resta bloccato', () => {
    const io = { fileExists: () => false, readFile: () => null };
    const allDone = bucket(guardItem(A, 'done'));
    const title = `follow-up(daily:${DAY}): 1 item — ${REPO}`;
    const marker = bot(itemCiSuiteMarker({ item: A, pr: 10197, commit: HEAD, run: 36560272815, job: 109379201715 }));
    const withProof = dailyBucketGateInputs(title, [marker]);
    expect([...(withProof?.ciSuiteProven ?? [])]).toEqual([A]);
    expect(dailyBucketCloseGate(allDone, io, ...(withProof?.gateArgs ?? []))).toMatchObject({ blocks: false });
    const without = dailyBucketGateInputs(title, []);
    expect(dailyBucketCloseGate(allDone, io, ...(without?.gateArgs ?? []))).toMatchObject({ blocks: true, reason: 'valid-item-unconfirmed' });
    // Il marker senza `State: done` non conferma nulla.
    expect(dailyBucketCloseGate(bucket(guardItem(A, 'blocked')), io, ...(withProof?.gateArgs ?? []))).toMatchObject({ blocks: true });
    // Un marker di autore non fidato non conta.
    const forged = { ...marker, author: { login: 'drive-by-user' } };
    expect(ciSuiteProvenItemIds(parseItemMarkers([forged], { isTrusted: isTrustedAuthor })).size).toBe(0);
  });

  it('riepilogo della run', () => {
    expect(ciSuiteProofSummary([
      { id: A, outcome: 'done' },
      { id: B, outcome: 'waiting', why: 'red-run' },
      { id: 'X', outcome: 'unknown', why: 'ci-read-unavailable' },
    ])).toBe(`ci_suite_done=1 waiting=${B}:red-run unknown=1`);
  });
});
