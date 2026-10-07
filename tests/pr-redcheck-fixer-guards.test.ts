/**
 * pr-redcheck-fixer.yml — le guardie che rendono sicuro un fixer che parte da
 * un CHECK ROSSO invece che da una review.
 *
 * Il buco che chiude: il 🔴-fixer parte su `pull_request_review`, cioè sui
 * findings che il reviewer SCRIVE. Ma il reviewer legge il diff, non la CI —
 * quindi una PR autonoma con un check required rosso e nessun 🔴 non aveva
 * alcun meccanismo che la guardasse. Verificato il 2026-08-23: nessuno dei 210
 * workflow del repo si attiva su `check_suite`/`check_run`.
 *
 * Il caso reale: PR #6296. Il 🔴-fixer pusha la sua fix alle 03:39, quella fix
 * rompe `monitor-issue-dedup`, il round cap scatta alle 04:12, e la PR resta
 * rossa **20 ore** — rossa per il commit del fixer stesso, con nessuno a
 * guardare. Misura di contorno: su 51 branch di PR, 11 hanno avuto un `tests`
 * rosso e 10 sono tornati verdi da soli; il buco è il residuo.
 *
 * Un fixer che parte dal rosso ha però un modo OVVIO e sbagliato di riuscire:
 * indebolire il test. Questi test fissano le guardie che lo impediscono, e
 * quelle che impediscono di lavorare su una PR o su un rosso che non sono suoi.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const WF = path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redcheck-fixer.yml');
const src = readFileSync(WF, 'utf-8');
const TWIN = readFileSync(
  path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redflag-fixer.yml'), 'utf-8');
const TESTS = readFileSync(
  path.resolve(__dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf-8');
const parsedTests = YAML.parse(TESTS) as any;
const redcheckProducer = parsedTests.jobs['post-review'].steps.find(
  (step: { name?: string }) => step.name === 'redcheck admission (trusted failure signal)',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

describe('trigger — parte solo su un rosso vero, di una PR vera', () => {
  it('ammette solo il dispatch esplicito o il segnale trusted del produttore', () => {
    expect(src).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(src).not.toMatch(/^\s*workflow_run:/m);
    expect(src).toContain('manuale o segnale trusted da tests');
    expect(TESTS).toContain('name: redcheck admission (trusted failure signal)');
    expect(TESTS).toContain("needs.vitest.result == 'failure'");
    expect(TESTS).toContain("github.event_name == 'pull_request'");
    expect(TESTS).toContain("github.event_name == 'workflow_dispatch'");
    expect(TESTS).toContain("workflow_id: 'pr-redcheck-fixer.yml'");
    expect(TESTS).toContain("ref: 'main'");
  });

  it('un workflow_dispatch eleggibile passa al fixer la run tests esatta', async () => {
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const dispatches: Array<Record<string, unknown>> = [];
    const currentPr = {
      state: 'open', draft: false, base: { ref: 'main' },
      head: { ref: 'fix/redcheck-test', sha: headSha, repo: { full_name: 'owner/repo' } },
      user: { type: 'Bot' }, labels: [],
    };
    const github = {
      paginate: async (fn: (args: unknown) => Promise<unknown>, args: unknown) => fn(args),
      rest: {
        pulls: { get: async () => ({ data: currentPr }) },
        actions: {
          listJobsForWorkflowRun: async () => [{
            name: 'vitest (unit + integration)', status: 'completed', conclusion: 'failure',
            steps: [{ name: 'vitest related (PR diff)', conclusion: 'failure' }],
          }],
          createWorkflowDispatch: async (input: Record<string, unknown>) => { dispatches.push(input); },
        },
      },
    };
    const failures: string[] = [];
    const core = { setFailed: (message: string) => failures.push(message), notice: () => undefined };
    const context = {
      eventName: 'workflow_dispatch', runId: 456, sha: headSha,
      payload: { inputs: { pr: '42' } }, repo: { owner: 'owner', repo: 'repo' },
    };

    await new AsyncFunction('github', 'context', 'core', redcheckProducer.with.script)(github, context, core);

    expect(failures).toEqual([]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      workflow_id: 'pr-redcheck-fixer.yml', ref: 'main',
      inputs: { pr: '42', run_id: '456' },
    });
  });

  it('il produttore esclude i failure di body/review e tratta API illeggibili come errore', () => {
    expect(TESTS).toContain('bodyContractSteps');
    expect(TESTS).toContain('reviewSteps');
    expect(TESTS).toContain('core.setFailed');
    expect(TESTS).toContain('failure was limited to body/review process steps');
    expect(TESTS).toContain('headRepo !== repository');
    expect(TESTS).toContain("headRef.startsWith('fix/')");
    expect(TESTS).toContain("headRef.startsWith('automerge-')");
    expect(TESTS).toContain("label?.name === 'agent:autofix'");
  });

  it('serializza i body writer per PR e cancella il precedente prima del nuovo CAS', () => {
    expect(src).toMatch(/group: body-revision-\$\{\{ github\.event\.inputs\.pr \}\}/);
    expect(src).toMatch(/cancel-in-progress: true/);
  });
});

describe('scope — non tocca ciò che non è suo', () => {
  it('salta le PR di un umano (stessa regola del gemello)', () => {
    expect(src).toContain('fuori scope per design');
    expect(src).toMatch(/autonomous=false/);
    expect(src).toMatch(/fix\/\*\|automerge-\*\) autonomous=true/);
    expect(src).toContain('prefisso riservato');
  });

  it('salta le draft', () => {
    expect(src).toMatch(/\[ "\$draft" = "true" \]/);
  });

  it('lega la run esatta alla HEAD corrente prima del preflight', () => {
    expect(src).toContain('DISPATCH_RUN_ID: ${{ github.event.inputs.run_id }}');
    expect(src).toContain('repos/$REPO/actions/runs/$RUN_ID');
    expect(src).toContain('run_head_sha');
    expect(src).toContain('[ "$run_head_sha" != "$head_sha" ]');
  });

  it('ri-verifica che la CI sia rossa ADESSO, non solo al trigger', () => {
    // Fra il trigger e il job può essere passato un re-run che l'ha rimessa verde.
    expect(src).toMatch(/check-runs\?per_page=100/);
    expect(src).toContain("gia' rientrato");
  });

  it('non corre sopra il 🔴-fixer sullo stesso branch (push race)', () => {
    expect(src).toContain('pr-redflag-fixer.yml');
    expect(src).toContain('push race');
  });
});

describe('trusted claim policy — il checkout PR non decide l ammissione', () => {
  it('scarica e ri-materializza l helper dei claim da main', () => {
    expect(src).toContain('Bootstrap trusted redcheck policy (no PR code)');
    expect(src).toContain('POLICY_REF: main');
    expect(src).toContain('Resolve trusted GitHub CLI (before PR checkout)');
    expect(src).toContain('TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}');
    expect(src).toContain('"$TRUSTED_GH_BIN" api "repos/${GITHUB_REPOSITORY}/contents/${path}?ref=${POLICY_REF}"');
    expect(src).toContain('TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy.outputs.root }}');
    expect(src).toContain('Refresh trusted redcheck policy before finalize');
    expect(src).toContain('TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_final.outputs.root }}');
    expect(src).not.toMatch(/run: node scripts\/ci\/pr-fixer-claim\.mjs --claim/);
  });
});

describe('anti-loop — bounded come il gemello', () => {
  it('conta i round con un marker proprio, non con quello del 🔴-fixer', () => {
    // Un marker condiviso farebbe consumare a un fixer i round dell'altro.
    expect(src).toContain('REDCHECK_FIX_ROUND');
    expect(src).not.toContain('REDFLAG_FIX_ROUND');
  });

  it('al cap escala a needs-human e NON invoca Claude', () => {
    const guard = src.slice(src.indexOf('MAX_ROUNDS=2'), src.indexOf('Configure git identity'));
    expect(guard).toContain('needs-human');
    expect(guard).toContain('proceed=false');
  });

  it('il marker si incrementa PRIMA di Claude (una run che muore conta lo stesso)', () => {
    // Scelta deliberata ereditata dal gemello: se una run che va in crash non
    // consumasse il round, un fixer che crasha sistematicamente girerebbe
    // all'infinito. L'anti-loop vale più del round sprecato.
    const i = src.indexOf('REDCHECK_FIX_ROUND: %s');
    const j = src.indexOf('Run Codex Luna Max');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });
});

describe('REGOLA #0 — il modo ovvio e sbagliato di far tornare verde un test', () => {
  const prompt = src.slice(src.indexOf('prompt: |'), src.indexOf('- name: Claude usage metrics'));

  it('il prompt vieta esplicitamente di indebolire il test', () => {
    expect(prompt).toContain('non si fa passare un test indebolendolo');
    expect(prompt).toContain('AGENTS.md non-negotiable #1');
  });

  it('enumera le scorciatoie vietate una per una, non genericamente', () => {
    // «non barare» in astratto non è azionabile: le forme concrete sì.
    for (const forma of ['.skip', 'rilassare', 'ratchet', 'allowlist']) {
      expect(prompt.toLowerCase()).toContain(forma.toLowerCase());
    }
  });

  it('l\'unica eccezione è vincolata a tre condizioni verificabili', () => {
    // I guard di questo repo a volte dichiarano ESSI STESSI una via d'uscita
    // (RAW_CREATE_ALLOWED). Usarla è legittimo solo se documentata dal guard,
    // verificata contro il codice, e motivata per iscritto.
    expect(prompt).toContain('RAW_CREATE_ALLOWED');
    expect(prompt).toContain('contro il codice');
  });

  it('impone di distinguere un rosso EREDITATO da un rosso della PR', () => {
    // Ripararlo qui lo nasconderebbe invece di risolverlo.
    expect(prompt).toContain('EREDITATO');
    expect(prompt).toContain('TERMINA senza toccare la PR');
  });

  it('impone di riprodurre il fallimento prima di fixarlo', () => {
    expect(prompt).toContain('npx vitest run');
    expect(prompt).toContain('non è un fix');
  });

  it('fa leggere al modello il patch preparato senza lazy-fetch del contesto', () => {
    expect(prompt).toContain('$RUNNER_TEMP/redcheck/diff.patch');
    expect(prompt).toContain('non ricostruire il contesto con `git diff origin/main...HEAD`');
  });
});

describe('costo — il contesto è raccolto senza Claude', () => {
  it('il log del job fallito è pre-raccolto e limitato', () => {
    // Far scaricare all'agente il log di `tests` (decine di MB) brucia turni di
    // setup, che è il primo consumatore misurato in questo repo.
    expect(src).toContain('Collect failing check context (zero-Claude)');
    expect(src).toContain('--log-failed');
    expect(src).toMatch(/head -c 24000/);
  });

  it('filtra sulle sole righe `FAIL `', () => {
    // `cancelled` e le righe di riepilogo si leggono come fallimenti e mandano
    // la diagnosi fuori strada.
    expect(src).toMatch(/FAIL /);
    expect(src).toContain('escape ANSI come TESTO');
  });

  it('prepara il diff dalla policy fidata prima del sandbox blobless', () => {
    expect(src).toContain('Prepare redcheck PR diff (zero-Claude)');
    expect(src).toContain('scripts/ci/prefetch-review-diff.mjs');
    expect(src).toContain('scripts/lib/loop-fleet-contract.mjs');
    expect(src).toContain('TRUSTED_GIT_BIN: ${{ steps.trusted_gh.outputs.git_path }}');
    expect(src).toContain("INCLUDE_TESTS: 'true'");
    expect(src).toContain('timeout 120 node "$TRUSTED_POLICY_ROOT/scripts/ci/prefetch-review-diff.mjs"');
    expect(src).toContain('$RUNNER_TEMP/redcheck/diff.patch');
  });
});

describe('parità col gemello — ciò che è stato ereditato deve restare intatto', () => {
  it('passa alla action lo stesso token con cui ha autenticato il remote', () => {
    // L'invariante di classe di issue-fix-app-token-wiring: senza, la action
    // conia un token proprio e riscrive il remote appena configurato.
    expect(src).toMatch(/github_token:\s*\$\{\{\s*env\.APP_TOKEN_DATA_REFRESH\s*==\s*'true'\s*&&\s*env\.APP_TOKEN\s*\|\|\s*env\.GITHUB_PAT\s*\}\}/);
  });

  it('classifica l\'esito sul LAVORO fatto, non sull\'exit della CLI', () => {
    expect(src).toContain('Classify outcome (work-done, not CLI exit)');
  });

  it('ha lo stesso capability guard su .github/workflows/**', () => {
    expect(src).toMatch(/touches_wf=/);
    expect(TWIN).toMatch(/touches_wf=/);
  });
});
