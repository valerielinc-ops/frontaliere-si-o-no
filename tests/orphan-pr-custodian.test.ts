import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  actionMarker,
  cancelledRequiredSuites,
  classifyOrphan,
  isAutonomousPr,
  reviewRevisionForBody,
} from '../scripts/ci/orphan-pr-custodian.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW_S = Date.parse('2026-09-19T17:40:00Z') / 1000;
const WORKFLOW = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1591,
    draft: false,
    headRef: 'audit-stale-claim-marker',
    headSha: HEAD,
    updatedAt: '2026-09-19T11:09:00Z',
    headCommittedAt: '2026-09-19T11:09:00Z',
    authorType: 'User',
    labels: [] as string[],
    ...overrides,
  };
}

function review(body: string, commit = HEAD, id = 10) {
  return { id, state: 'COMMENTED', commit_id: commit, body, user: { type: 'Bot', login: 'frontaliere-automation[bot]' } };
}

function checkRun(id: number, suite: number, conclusion: string | null, status = 'completed', sha = HEAD) {
  return {
    id,
    name: VITEST_CHECK_NAME,
    head_sha: sha,
    status,
    conclusion,
    check_suite: { id: suite },
    details_url: `https://github.com/o/r/actions/runs/${suite * 10}/job/${id}`,
  };
}

const outOfScope = {
  user: { login: 'github-actions[bot]' },
  body: '<!-- REDFLAG_OUT_OF_SCOPE -->\nℹ️ 🔴-fixer: fuori scope',
};
const IMPORTANT = '## Findings\nscripts/x.mjs:L1: 🔴 Important: rompe il contratto.';

describe('orphan-pr-custodian — rerun di un check richiesto CANCELLED con LGTM (corpus #1591)', () => {
  it('rilancia la suite cancellata anche quando un\'altra suite dello stesso check e\' verde', () => {
    const decision = classifyOrphan({
      pr: pr(),
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(2, 8, 'success')],
      reviews: [review('## LGTM\nTutto ok.')],
      comments: [],
      nowS: NOW_S,
    });
    expect(decision.action).toBe('rerun');
    expect(decision.runIds).toEqual(['70']);
  });

  it('usa solo l\'ultima generazione di ogni suite: un rerun verde chiude la suite', () => {
    const { cancelled } = cancelledRequiredSuites(
      [checkRun(1, 7, 'cancelled'), checkRun(3, 7, 'success')], HEAD, VITEST_CHECK_NAME);
    expect(cancelled).toEqual([]);
  });

  it('non agisce senza LGTM sulla HEAD, con una run in volo, o dopo il marker', () => {
    const base = { checkRuns: [checkRun(1, 7, 'cancelled')], comments: [] as unknown[], nowS: NOW_S };
    expect(classifyOrphan({ ...base, pr: pr(), reviews: [review('## LGTM', OLD)] }).action).toBe('none');
    expect(classifyOrphan({ ...base, pr: pr(), reviews: [review(`## LGTM\n${IMPORTANT}`)] }).action).not.toBe('rerun');
    expect(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(4, 9, null, 'in_progress')],
    }).action).toBe('none');
    expect(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      // Il marker del rerun porta la generazione cancellata (check-run id 1).
      comments: [{ user: { login: 'github-actions[bot]' }, body: actionMarker('rerun', HEAD, '1') }],
    }).action).toBe('none');
  });

  it('non tocca una PR con un push nelle ultime 2 ore o in draft', () => {
    const args = { checkRuns: [checkRun(1, 7, 'cancelled')], reviews: [review('## LGTM')], comments: [], nowS: NOW_S };
    expect(classifyOrphan({
      ...args,
      pr: pr({ updatedAt: '2026-09-19T16:30:00Z', headCommittedAt: '2026-09-19T16:30:00Z' }),
    }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ draft: true }) }).action).toBe('none');
  });

  it('l\'orologio e\' il push, non `updated_at` che il bot di review rinfresca', () => {
    // Corpus #1599: aperta da 11,7 h, ultimo push 20:04Z, nessun agente vivo —
    // ma `updated_at` diceva 1,8 h perche' il reviewer aveva appena postato il
    // suo ennesimo 🔴. Con l'orologio su `updated_at` il custode non agiva MAI
    // proprio sulle PR che il ciclo tocca senza sbloccarle.
    const rinfrescata = pr({
      updatedAt: '2026-09-19T17:00:00Z', // review del bot 40 minuti fa
      headCommittedAt: '2026-09-19T09:00:00Z', // ultimo push: 8h40 fa
    });
    const decision = classifyOrphan({
      pr: rinfrescata, checkRuns: [], reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    });
    expect(decision.action).toBe('adopt');
  });

  it('ricade su `updated_at` quando la data del push non e\' leggibile', () => {
    const decision = classifyOrphan({
      pr: pr({ headCommittedAt: undefined }), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [], nowS: NOW_S,
    });
    expect(decision.action).toBe('adopt');
    expect(classifyOrphan({
      pr: pr({ headCommittedAt: '', updatedAt: 'non-una-data' }), checkRuns: [],
      reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    }).action).toBe('none');
  });
});

describe('orphan-pr-custodian — adozione di un 🔴 fuori scope (sito #9221/#9224/#9230)', () => {
  it('adotta una PR umana con 🔴 sulla HEAD e REDFLAG_OUT_OF_SCOPE', () => {
    const decision = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S,
    });
    expect(decision.action).toBe('adopt');
  });

  it('lascia ai fixer le PR gia\' autonome e rispetta needs-human', () => {
    const args = { checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S };
    expect(classifyOrphan({ ...args, pr: pr({ headRef: 'fix/issue-1' }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ labels: ['agent:autofix'] }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ authorType: 'Bot' }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ labels: ['needs-human'] }) }).action).toBe('none');
  });

  it('adotta anche senza REDFLAG_OUT_OF_SCOPE: il marker e\' prova, non precondizione', () => {
    // Il commento lo scrive `pr-redflag-fixer.yml` con lo stesso predicato di
    // `isAutonomousPr` gia' valutato qui. Pretenderlo subordina l'adozione a un
    // run che puo' non esistere: sul corpus il fixer non girava dal 17-09
    // (le review le posta `github-actions[bot]`, e GitHub sopprime il
    // `pull_request_review` a valle), quindi questo ramo era codice morto.
    const senzaMarker = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    });
    expect(senzaMarker.action).toBe('adopt');
    expect(senzaMarker.outOfScopeDeclared).toBe(false);
    expect(senzaMarker.reason).toContain('nessun run del redflag-fixer');

    const conMarker = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S,
    });
    expect(conMarker.action).toBe('adopt');
    expect(conMarker.outOfScopeDeclared).toBe(true);
  });

  it('non adotta su review vecchia o due volte', () => {
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT, OLD)], comments: [outOfScope], nowS: NOW_S,
    }).action).toBe('none');
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [outOfScope, { user: { login: 'github-actions[bot]' }, body: actionMarker('adopt', HEAD) }],
      nowS: NOW_S,
    }).action).toBe('none');
  });

  it('non accredita un REDFLAG_OUT_OF_SCOPE scritto da un utente qualsiasi', () => {
    const decision = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [{ user: { login: 'someone' }, body: outOfScope.body }], nowS: NOW_S,
    });
    expect(decision.outOfScopeDeclared).toBe(false);
  });

  it('non riusa un verdetto emesso su una revisione precedente del body', () => {
    const REV_A = `body:${'1'.repeat(64)}`;
    const REV_B = `body:${'2'.repeat(64)}`;
    const marcata = (rev: string, body: string) => review(`<!-- REVIEW_INPUT_REVISION: ${rev} -->\n${body}`);
    const base = { pr: pr(), checkRuns: [], comments: [], nowS: NOW_S };

    // Il 🔴 e' sulla revisione corrente: si adotta.
    expect(classifyOrphan({ ...base, reviews: [marcata(REV_B, IMPORTANT)], reviewRevision: REV_B })
      .action).toBe('adopt');
    // Stessa HEAD, body cambiato: il verdetto vecchio non vale piu'.
    expect(classifyOrphan({ ...base, reviews: [marcata(REV_A, IMPORTANT)], reviewRevision: REV_B })
      .action).toBe('none');
    // Marker presenti ma revisione corrente ignota: si chiude, non si indovina.
    expect(classifyOrphan({ ...base, reviews: [marcata(REV_A, IMPORTANT)] }).action).toBe('none');
    // Dove il reviewer non emette il marker (sito) nulla cambia.
    expect(classifyOrphan({ ...base, reviews: [review(IMPORTANT)], reviewRevision: REV_B })
      .action).toBe('adopt');
    // Due marker: il gate non riusa quel verdetto, e nemmeno noi.
    expect(classifyOrphan({
      ...base,
      reviews: [review(`<!-- REVIEW_INPUT_REVISION: ${REV_A} -->\n<!-- REVIEW_INPUT_REVISION: ${REV_B} -->\n${IMPORTANT}`)],
      reviewRevision: REV_B,
    }).action).toBe('none');
    // Newline serializzati come due caratteri: li normalizza il parser canonico.
    expect(classifyOrphan({
      ...base,
      reviews: [review(`<!-- REVIEW_INPUT_REVISION: ${REV_B} -->\\n${IMPORTANT}`)],
      reviewRevision: REV_B,
    }).action).toBe('adopt');
  });

  it('usa il parser canonico dei marker, non una copia locale della regex', () => {
    const src = readFileSync(new URL('../scripts/ci/orphan-pr-custodian.mjs', import.meta.url), 'utf8');
    expect(src).toContain("from './lib/review-input-revision.mjs'");
    expect(src).not.toMatch(/REVIEW_INPUT_REVISION: \(body/);
  });

  it('la revisione si calcola come `body:sha256(body + newline)`', () => {
    expect(reviewRevisionForBody('ciao')).toBe(
      `body:${createHash('sha256').update('ciao\n').digest('hex')}`);
    expect(reviewRevisionForBody(undefined as unknown as string)).toBeNull();
  });

  it('un rerun a sua volta cancellato non mura la PR: il marker e\' per generazione', () => {
    const base = { pr: pr(), reviews: [review('## LGTM')], nowS: NOW_S };
    const primo = classifyOrphan({ ...base, checkRuns: [checkRun(1, 7, 'cancelled')], comments: [] });
    expect(primo.action).toBe('rerun');
    const markerPrimo = { user: { login: 'github-actions[bot]' }, body: actionMarker('rerun', HEAD, primo.rerunKey) };
    // Stessa generazione: non si ripete.
    expect(classifyOrphan({
      ...base, checkRuns: [checkRun(1, 7, 'cancelled')], comments: [markerPrimo],
    }).action).toBe('none');
    // Il rerun ha prodotto una generazione NUOVA, di nuovo cancelled: si ritenta.
    expect(classifyOrphan({
      ...base, checkRuns: [checkRun(5, 7, 'cancelled')], comments: [markerPrimo],
    }).action).toBe('rerun');
  });

  it('non adotta una PR il cui head sta su un fork', () => {
    expect(classifyOrphan({
      pr: pr({ headRepo: 'someone/fork', baseRepo: 'o/r' }), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [outOfScope], nowS: NOW_S,
    }).action).toBe('none');
  });

  it('rilancia la run intera (niente --failed) e ritira le label se il dispatch fallisce', () => {
    const src = readFileSync(new URL('../scripts/ci/orphan-pr-custodian.mjs', import.meta.url), 'utf8');
    expect(src).toContain("gh(['run', 'rerun', runId, '--repo', repo]);");
    expect(src).not.toContain("'--failed'");
    const onFail = src.slice(src.indexOf('dispatch del redflag-fixer fallito') - 600);
    expect(onFail).toContain('ok = false;');
    expect(onFail).toContain("'--remove-label', AUTOFIX_LABEL, '--remove-label', ORPHANED_LABEL");
  });

  it('usa la stessa definizione di autonomia dei fixer', () => {
    expect(isAutonomousPr(pr({ headRef: 'automerge-x' }))).toBe(true);
    expect(isAutonomousPr(pr())).toBe(false);
  });
});

describe('stale-pr-rescuer — cablaggio', () => {
  it('non crea nemmeno il run per i tests di main (filtro sul trigger)', () => {
    expect(WORKFLOW).toMatch(/workflow_run:\n\s+workflows: \["tests"\]\n\s+types: \[completed\]\n(?:\s+#.*\n)*\s+branches-ignore: \[main\]\n/);
  });

  it('non gira sui completamenti di tests dei push su main', () => {
    expect(WORKFLOW).toContain("if: github.event_name != 'workflow_run' || github.event.workflow_run.event != 'push'");
  });

  it('misura l\'inattivita\' sul push, come il custode che esegue', () => {
    // Lo scan e il custode pongono la stessa domanda («qualcuno spingera' un
    // commit?») e devono usare lo stesso orologio: `updated_at` risponde a una
    // domanda diversa, perche' lo rinfresca ogni review del bot.
    expect(WORKFLOW).toContain("PUSHED_AT=$(gh api \"repos/$REPO/commits/$HEAD\" --jq '.commit.committer.date'");
    expect(WORKFLOW).toContain('IDLE_SINCE="${PUSHED_AT:-$UPD}"');
    expect(WORKFLOW).not.toContain('UPD_S=$(date -u -d "$UPD" +%s');
  });

  it('sceglie la review del bot con il fencing sulla revisione del body', () => {
    // `commit_id` da solo lascia attivo un verdetto che una modifica del body
    // ha gia' invalidato: la selezione passa dal filtro sui marker.
    expect(WORKFLOW).toContain('node scripts/ci/lib/review-input-revision.mjs hash-pr-json --file "$PR_JSON"');
    expect(WORKFLOW).toContain('LAST_BODY=$(printf \'%s\' "$fenced" | jq -r \'last | .body // ""\')');
    expect(WORKFLOW).toContain('LAST_CID=$(printf \'%s\' "$fenced" | jq -r \'last | .commit_id // ""\')');
    // Il modulo canonico deve stare nel checkout sparse del job.
    expect(WORKFLOW).toMatch(/sparse-checkout: \|\n(?:\s+\S+\n)*\s+scripts\/ci\/lib\/review-input-revision\.mjs\n/);
  });

  it('esegue il custode con lo script e le costanti presenti nel checkout sparse', () => {
    expect(WORKFLOW).toMatch(/sparse-checkout: \|\n(?:\s+\S+\n)*\s+scripts\/ci\/orphan-pr-custodian\.mjs\n/);
    expect(WORKFLOW).toContain('scripts/ci/lib/constants.mjs');
    expect(WORKFLOW).toContain('run: node scripts/ci/orphan-pr-custodian.mjs');
  });
});
