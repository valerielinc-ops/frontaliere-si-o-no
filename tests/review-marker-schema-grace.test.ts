import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_INPUT_SERIALIZATIONS,
  acceptedReviewInputRevisions,
  acceptedReviewInputRevisionsFromBody,
  acceptedReviewInputRevisionsFromPullRequest,
  normalizeReviewInputRevisionInput,
  reviewHasInputRevision,
  reviewInputMarker,
  reviewInputRevisionFromBody,
  reviewInputSerialization,
} from '../scripts/ci/lib/review-input-revision.mjs';
import { evaluateNativeAutoMerge } from '../scripts/ci/native-automerge-gate.mjs';
import { acceptedReviewRevisionsForBody } from '../scripts/ci/orphan-pr-custodian.mjs';

/**
 * Replay dell'incidente del 2026-09-19.
 *
 * Alle 23:35:32Z il merge di #9328 ha cambiato la rappresentazione del body su
 * cui si calcola `REVIEW_INPUT_REVISION`, da `sha256(body)` a
 * `sha256(body + "\n")`. Da quel momento il guard del native auto-merge — che
 * gira da `main`, perche' deve essere fidato — ha rifiutato con «nessuna review
 * bot verificabile» TUTTE e 6 le PR aperte: le loro review erano state emesse
 * da un job che aveva fatto checkout del BRANCH, cioe' dal codice vecchio, e
 * portavano il marker vecchio. Una PR e' rimasta ferma 74 minuti pur avendo
 * `## LGTM` e ogni check verde; l'unico rimedio e' stato un
 * `git merge origin/main` a mano su ogni branch.
 *
 * La classe non e' «quel cambio li'»: e' che produttore e verificatore del
 * marker non girano mai dallo stesso commit, quindi OGNI cambio di schema
 * blocca tutto cio' che e' in volo finche' non viene ribasato a mano. Il
 * rimedio e' che il verificatore sappia leggere anche gli schemi ritirati.
 */

const HEAD = 'a'.repeat(40);
const PR_BODY = '## Implementato\n\n- una riga.\n\n## Non implementato (ancora)\n\n- Nessuno.\n';
const CLEAN_REVIEW = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';

/** Il digest dello schema RITIRATO: il body senza il newline finale. */
const retiredRevision = (body: string) => `body:${createHash('sha256').update(body, 'utf8').digest('hex')}`;

function pr(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    title: 'Safe change',
    body: PR_BODY,
    labels: [],
    headRefOid: HEAD,
    autoMergeRequest: null,
    changedFiles: ['src/safe.ts'],
    changedFilesComplete: true,
    ...overrides,
  };
}

function reviewWithMarker(revision: string) {
  return {
    id: 1,
    user: { type: 'Bot', login: 'claude[bot]' },
    state: 'COMMENTED',
    body: `${reviewInputMarker(revision)}\n${CLEAN_REVIEW}`,
    commit_id: HEAD,
    submitted_at: '2026-09-19T23:30:00Z',
  };
}

const vitestCheck = {
  name: 'vitest (unit + integration)',
  head_sha: HEAD,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-09-19T23:31:00Z',
};

describe('schema dei marker di review — periodo di grazia', () => {
  it('si emette con UNO schema solo: il primo, quello di `gh api --jq`', () => {
    expect(REVIEW_INPUT_SERIALIZATIONS[0].id).toBe('jq-newline');
    expect(REVIEW_INPUT_SERIALIZATIONS[0].retiredOn).toBeNull();
    expect(reviewInputSerialization(PR_BODY)).toBe(`${PR_BODY}\n`);
    expect(reviewInputRevisionFromBody(PR_BODY))
      .toBe(acceptedReviewInputRevisionsFromBody(PR_BODY)[0]);
  });

  it('ogni schema oltre il primo e’ dichiarato ritirato, con data e motivo', () => {
    expect(REVIEW_INPUT_SERIALIZATIONS.length).toBeGreaterThan(1);
    for (const serialization of REVIEW_INPUT_SERIALIZATIONS.slice(1)) {
      expect(serialization.retiredOn, serialization.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(String(serialization.reason).length, serialization.id).toBeGreaterThan(40);
    }
    // Gli schemi non possono collidere fra loro: due voci che producono lo
    // stesso digest sarebbero una voce sola con due nomi.
    const digests = acceptedReviewInputRevisionsFromBody(PR_BODY);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('il verificatore accetta il marker dello schema ritirato per lo STESSO body', () => {
    const accepted = acceptedReviewInputRevisionsFromBody(PR_BODY);
    expect(accepted).toContain(retiredRevision(PR_BODY));
    const legacyReview = reviewWithMarker(retiredRevision(PR_BODY));
    expect(reviewHasInputRevision(legacyReview.body, accepted)).toBe(true);
    // E continua ad accettare quello corrente, ovviamente.
    expect(reviewHasInputRevision(
      reviewWithMarker(reviewInputRevisionFromBody(PR_BODY)).body,
      accepted,
    )).toBe(true);
  });

  it('nessuno schema apre la porta al marker di un body DIVERSO', () => {
    const accepted = acceptedReviewInputRevisionsFromBody(PR_BODY);
    const otherBody = `${PR_BODY}modificato dopo la review\n`;
    for (const stale of acceptedReviewInputRevisionsFromBody(otherBody)) {
      expect(reviewHasInputRevision(reviewWithMarker(stale).body, accepted), stale).toBe(false);
    }
    // Un digest inventato resta fuori da ogni schema.
    expect(reviewHasInputRevision(
      reviewWithMarker(`body:${'d'.repeat(64)}`).body,
      accepted,
    )).toBe(false);
  });

  it('il contratto duro resta: esattamente UN marker, mai zero e mai due', () => {
    const accepted = acceptedReviewInputRevisionsFromBody(PR_BODY);
    const current = reviewInputRevisionFromBody(PR_BODY);
    const twoMarkers = `${reviewInputMarker(current)}\n${reviewInputMarker(retiredRevision(PR_BODY))}\n${CLEAN_REVIEW}`;
    expect(reviewHasInputRevision(twoMarkers, accepted)).toBe(false);
    expect(reviewHasInputRevision(CLEAN_REVIEW, accepted)).toBe(false);
    // Un elenco vuoto o non valido chiude, come prima.
    expect(reviewHasInputRevision(reviewWithMarker(current).body, [])).toBe(false);
    expect(reviewHasInputRevision(reviewWithMarker(current).body, ['non-una-revision'])).toBe(false);
    expect(acceptedReviewInputRevisions('non-una-revision')).toEqual([]);
    expect(normalizeReviewInputRevisionInput(['non-una-revision'])).toBe('');
  });

  it('REPLAY: il guard del native auto-merge non rifiuta piu’ la review con lo schema ritirato', () => {
    const legacyReview = reviewWithMarker(retiredRevision(PR_BODY));
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [legacyReview],
      checkRuns: [vitestCheck],
    });
    expect(result.reason).not.toMatch(/nessuna review bot verificabile/iu);
    expect(result.allow).toBe(true);
  });

  it('REPLAY: e continua a rifiutare la review il cui marker e’ di un altro body', () => {
    const otherBody = `${PR_BODY}modificato dopo la review\n`;
    const staleReview = reviewWithMarker(reviewInputRevisionFromBody(otherBody));
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [staleReview],
      checkRuns: [vitestCheck],
    })).toMatchObject({ allow: false, reason: /nessuna review bot verificabile/iu });
  });

  it('il custode delle PR orfane usa lo stesso elenco, non la sola revisione corrente', () => {
    const accepted = acceptedReviewRevisionsForBody(PR_BODY);
    expect(accepted).toEqual(acceptedReviewInputRevisionsFromBody(PR_BODY));
    expect(acceptedReviewRevisionsForBody(undefined as unknown as string)).toEqual([]);
  });

  it('la variante dalla risposta API valida la forma prima di digerirla', () => {
    expect(acceptedReviewInputRevisionsFromPullRequest({ body: PR_BODY }))
      .toEqual(acceptedReviewInputRevisionsFromBody(PR_BODY));
    // `null` e' il body vuoto secondo GitHub, non un errore.
    expect(acceptedReviewInputRevisionsFromPullRequest({ body: null }))
      .toEqual(acceptedReviewInputRevisionsFromBody(''));
    expect(() => acceptedReviewInputRevisionsFromPullRequest({})).toThrow(/no body field/u);
    expect(() => acceptedReviewInputRevisionsFromPullRequest(null)).toThrow(/not an object/u);
  });

  // La CLASSE, non il solo guard che ha fermato le 6 PR (AGENTS.md #6): ogni
  // verificatore che gira da un checkout diverso da quello che ha emesso il
  // marker deve confrontare il marker con l'ELENCO degli schemi, non con la
  // sola revisione corrente. Un test funzionale per ognuno costerebbe di piu'
  // di quel che dice; qui si pinna che nessuno di loro sia tornato al
  // confronto stretto, che e' la regressione da impedire.
  it('nessun verificatore lato main confronta il marker con un solo schema', () => {
    const verifiers = [
      'scripts/ci/native-automerge-gate.mjs',
      'scripts/ci/review-gate.mjs',
      'scripts/ci/orphan-pr-custodian.mjs',
      'scripts/ci/pr-fixer-claim.mjs',
    ];
    for (const file of verifiers) {
      const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
      expect(source, file).toMatch(/acceptedReviewInputRevisionsFrom(Body|PullRequest)/u);
    }
  });
});
