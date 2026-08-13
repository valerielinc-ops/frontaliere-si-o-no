/**
 * workflow-scope-detect — verdicts pinned to REAL issue bodies (issue #5595).
 *
 * The detector decides whether the autonomous fixer is allowed to attempt an issue at
 * all: a `true` verdict removes `agent:fix`, adds `blocked-workflows-scope` + `fu-parked`,
 * and — once `needs-human` lands downstream — makes the issue owner-only work for good.
 * A wrong `true` therefore does not delay a fix, it buries one, and the argument about
 * whether a given body "reads as workflow-only" is exactly the kind of argument that
 * cannot be settled by opinion. So it is settled by the bodies themselves.
 *
 * The three fixtures under `tests/fixtures/workflow-scope/` are byte-for-byte
 * `gh api repos/<owner>/<repo>/issues/<n> --jq .body` captures, taken 2026-08-11:
 *
 *   site-5595-hallucinations.md      valerielinc-ops/frontaliere-si-o-no#5595
 *   corpus-225-workflow-failure.md   nanakokyobashi-rgb/frontaliere-articles#225
 *   corpus-217-lockstep-no-alarm.md  nanakokyobashi-rgb/frontaliere-articles#217
 *
 * Why these three, and not three invented strings:
 *
 *  - #5595 is the false positive. It is the highest-value issue in the backlog
 *    (generated articles asserting facts their source never states — E-E-A-T, YMYL,
 *    the one failure mode that costs trust directly). Its "Implementazione tecnica
 *    indicativa" section lists seven targets: six code files written with a `.*`
 *    extension stem, one workflow marked explicitly optional ("se il processo risiede
 *    nel repository"). Before this change the six were invisible to `CODE_PATH_RE`, the
 *    one decided the verdict, and the issue was blocked.
 *  - #225 is the true positive the detector could not see at all: a monitor auto-file
 *    whose subject is a workflow named in the TITLE, with a body that cites only the
 *    auto-filer's own script as boilerplate.
 *  - #217 is the true positive the exclusivity valve was opening by mistake: it quotes a
 *    `.json` manifest as EVIDENCE of the missing alarm while its whole remedy is a new
 *    `.github/workflows/**` guardian. It was promoted, and the run came back with the
 *    push refused verbatim ("refusing to allow a GitHub App to create or update workflow
 *    `.github/workflows/lockstep-stall-watchdog.yml` without `workflows` permission")
 *    after paying the full diagnosis cost.
 *
 * Both entry points are asserted on every fixture — `detectWorkflowScoped` (the drainer's
 * pre-promotion park) and `isExclusivelyWorkflowScoped` (issue-fix.yml's Mode 1 pre-flight).
 * They must agree: the #4437 infinite loop (51 identical park comments over 9 days) was
 * caused by exactly one guard saying promote while the other said block.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectWorkflowScoped,
  extractNonWorkflowCodeRefs,
  extractWorkflowRefs,
  isMonitorFiledWorkflowFailure,
} from '../scripts/lib/workflow-scope-detect.mjs';
import { isExclusivelyWorkflowScoped } from '../scripts/ci/check-workflows-scope.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/workflow-scope');
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

type Case = {
  id: string;
  file: string;
  title: string;
  labels: string[];
  scoped: boolean;
};

const CASES: Case[] = [
  {
    id: 'site#5595 — allucinazioni negli articoli generati (propone UN workflow, sei file di codice)',
    file: 'site-5595-hallucinations.md',
    title: 'Bug: gli articoli generati introducono dati inventati non supportati dalla fonte',
    labels: ['agent:fix', 'agent:triaged', 'fu-prio:low'],
    scoped: false, // PROCEDE
  },
  {
    id: 'corpus#225 — Workflow Failure: Generate Blog Article (auto-file di un monitor)',
    file: 'corpus-225-workflow-failure.md',
    title: 'Workflow Failure: Generate Blog Article',
    labels: ['bug', 'agent:triaged', 'fu-prio:high', 'fu-parked', 'priority:high', 'needs-human'],
    scoped: true, // BLOCCA
  },
  {
    id: 'corpus#217 — lockstep senza allarme (rimedio = un nuovo workflow guardiano)',
    file: 'corpus-217-lockstep-no-alarm.md',
    title:
      "Nessun allarme quando la lockstep dell'engine si incaglia: #205 ferma 4h in deadlock permanente, invisibile a ogni gate",
    labels: ['agent:triaged', 'fu-prio:high', 'fu-parked'],
    scoped: true, // BLOCCA
  },
];

describe('detectWorkflowScoped — tabella di fixture sui body reali (#5595)', () => {
  it.each(CASES)('$id', ({ file, title, labels, scoped }) => {
    const body = readFixture(file);
    expect(detectWorkflowScoped(`${title}\n${body}`, { title, labels })).toBe(scoped);
  });

  it.each(CASES)('Mode 1 concorda con il drainer — $id', ({ file, title, labels, scoped }) => {
    const body = readFixture(file);
    expect(isExclusivelyWorkflowScoped(body, { title, labels })).toBe(scoped);
  });
});

describe('perché ciascun verdetto cade dove cade (il meccanismo, non solo l’esito)', () => {
  it('#5595: la valvola si apre sui target scritti con lo stem glob `.*`, non su un nome concreto', () => {
    const body = readFixture('site-5595-hallucinations.md');
    const code = extractNonWorkflowCodeRefs(body);
    // I sei bullet di "Implementazione tecnica indicativa": tutti `.*`, nessuna estensione.
    expect(code).toContain('src/content-generation/sourceSnapshot.*');
    expect(code).toContain('src/content-generation/claimExtractor.*');
    expect(code).toContain('src/content-generation/claimVerifier.*');
    expect(code).toContain('src/content-generation/publishPolicy.*');
    expect(code).toContain('scripts/audit-generated-articles.*');
    // Il workflow c'è, ed è citato per intero: da solo non basta più a decidere.
    expect(extractWorkflowRefs(body)).toContain('.github/workflows/content-grounding-audit.yml');
    expect(isMonitorFiledWorkflowFailure({ title: 'Bug: gli articoli generati…', labels: [] })).toBe(false);
  });

  it('#225: nessun `.yml` nel body — il soggetto è nel TITOLO, e il body cita solo il boilerplate del monitor', () => {
    const body = readFixture('corpus-225-workflow-failure.md');
    expect(extractWorkflowRefs(body)).toHaveLength(0);
    // La riga di firma dell'auto-filer: è boilerplate, non il target del fix.
    expect(extractNonWorkflowCodeRefs(body)).toEqual(['scripts/ci/scan-failed-runs.mjs']);
    expect(isMonitorFiledWorkflowFailure({ title: 'Workflow Failure: Generate Blog Article' })).toBe(true);
  });

  it('#217: il solo path citato è un manifest `.json` (evidenza, non target) → la valvola resta chiusa', () => {
    const body = readFixture('corpus-217-lockstep-no-alarm.md');
    expect(body).toContain('scripts/ci/loop-sync-manifest.json');
    expect(extractNonWorkflowCodeRefs(body)).toHaveLength(0);
    expect(extractWorkflowRefs(body)).toContain('mirror-articles-engine.yml');
  });
});

describe('isMonitorFiledWorkflowFailure — riconosce l’auto-file, non la parola "workflow"', () => {
  it('scatta sul prefisso `Workflow Failure:` (scan-failed-runs.mjs)', () => {
    expect(isMonitorFiledWorkflowFailure({ title: 'Workflow Failure: cathedral-seo-gates-check' })).toBe(true);
  });

  it('scatta sul prefisso `CI Failure:` (scan-job-timeouts.mjs)', () => {
    expect(isMonitorFiledWorkflowFailure({ title: 'CI Failure: Refresh thin-page promotions' })).toBe(true);
  });

  it('scatta sulla label `ci-timeout` anche con un titolo qualunque', () => {
    expect(isMonitorFiledWorkflowFailure({ title: 'qualcosa', labels: [{ name: 'ci-timeout' }] })).toBe(true);
    expect(isMonitorFiledWorkflowFailure({ title: 'qualcosa', labels: ['ci-timeout'] })).toBe(true);
  });

  it('NON scatta su un titolo che contiene le stesse parole senza esserne il prefisso (#5455)', () => {
    // #5455: una regex sulla parola nuda "workflow" escludeva per sempre dal parked-retry
    // issue il cui fix reale vive in `scripts/`. L'ancora `^` è ciò che lo impedisce.
    expect(isMonitorFiledWorkflowFailure({ title: 'Il workflow failure notifier duplica le issue' })).toBe(false);
    expect(isMonitorFiledWorkflowFailure({ title: 'Retry on CI failure: aggiungere backoff' })).toBe(false);
  });

  it('NON scatta senza titolo né label, e non lancia su input malformati', () => {
    expect(isMonitorFiledWorkflowFailure()).toBe(false);
    expect(isMonitorFiledWorkflowFailure({})).toBe(false);
    expect(isMonitorFiledWorkflowFailure({ title: undefined, labels: [null as never, { }] })).toBe(false);
  });
});

describe('extractNonWorkflowCodeRefs — payload di dati vs target di fix', () => {
  it('un `.mjs`/`.ts`/`.js` citato apre la valvola (è un fix plausibile)', () => {
    expect(extractNonWorkflowCodeRefs('vedi `scripts/ci/foo.mjs`')).toEqual(['scripts/ci/foo.mjs']);
    expect(extractNonWorkflowCodeRefs('vedi build-plugins/shared/criticalCss.ts')).toHaveLength(1);
    expect(extractNonWorkflowCodeRefs('vedi infra/cloudflare-worker/locale-router.js')).toHaveLength(1);
  });

  it('un `.json`/`.md`/`.csv` citato NON la apre (è evidenza citata, non un target)', () => {
    expect(extractNonWorkflowCodeRefs('vedi `scripts/ci/loop-sync-manifest.json`')).toHaveLength(0);
    expect(extractNonWorkflowCodeRefs('vedi scripts/README.md')).toHaveLength(0);
    expect(extractNonWorkflowCodeRefs('vedi src/data/report.csv')).toHaveLength(0);
  });

  it('lo stem glob `.*` conta come codice (forma tipica di un piano di implementazione)', () => {
    expect(extractNonWorkflowCodeRefs('- `src/content-generation/claimVerifier.*` — verifica')).toEqual([
      'src/content-generation/claimVerifier.*',
    ]);
  });

  it('input vuoto/undefined → nessun ref, nessun throw', () => {
    expect(extractNonWorkflowCodeRefs('')).toHaveLength(0);
    expect(extractNonWorkflowCodeRefs(undefined as unknown as string)).toHaveLength(0);
  });

  it('il path è riconosciuto per intero, non dalla directory in poi (corpus #229/#274)', () => {
    // Questo modulo è `mode: identical`: gli stessi byte girano sul mirror corpus, dove i
    // path hanno una radice in più. Con l'ancora `\b` sulla directory, da
    // `generator/scripts/create-article.mjs` usciva `scripts/create-article.mjs`, che non
    // esiste in nessun repo — e la pre-flight overlap del drainer, che confronta con un
    // `Set.has` esatto sui file di una PR, non trovava mai niente.
    expect(extractNonWorkflowCodeRefs('vedi `generator/scripts/create-article.mjs`'))
      .toEqual(['generator/scripts/create-article.mjs']);
    expect(extractNonWorkflowCodeRefs('vedi `packages/articles/engine/rssFeeds.mjs`'))
      .toHaveLength(0); // `engine` non è (e non deve essere) una directory di codice qui
  });

  it('`content/**` conta come codice: è l\'albero più modificato del corpus', () => {
    expect(extractNonWorkflowCodeRefs('il registro `content/it/blog-body-2026-08.ts`'))
      .toEqual(['content/it/blog-body-2026-08.ts']);
    expect(extractNonWorkflowCodeRefs('sul sito è `packages/articles/content/it/blog-body-2026-08.ts`'))
      .toEqual(['packages/articles/content/it/blog-body-2026-08.ts']);
    // …ma un payload di dati sotto content/ resta evidenza, non target (NON_CODE_EXT).
    expect(extractNonWorkflowCodeRefs('vedi `content/index.json`')).toHaveLength(0);
  });
});

describe('regressioni che questo cambio NON deve introdurre', () => {
  it('un body che cita SOLO un workflow resta bloccato (fixture reale #1607)', () => {
    // Il caso per cui il gate esiste: il fix è letteralmente un file `.github/workflows/**`
    // e il token del fixer non può pusharlo. Togliere la regola di prosa lo promuoverebbe
    // e comprerebbe un run sprecato garantito.
    const body = [
      '### 1. Guard rehydrate controlla solo `dist/$loc`',
      'Suggested action: in `.github/workflows/post-deploy-validate-dist.yml`, allargare il guard',
    ].join('\n');
    expect(detectWorkflowScoped(body)).toBe(true);
    expect(isExclusivelyWorkflowScoped(body)).toBe(true);
  });

  it('workflow + path di codice co-citati restano PROMOSSI (#4437)', () => {
    const body = [
      'Fix in scripts/send-job-alerts.mjs: wrap the zero-match createGithubIssue call in try-catch.',
      '',
      '## Live-verification (manuale post-deploy)',
      '- [ ] check .github/workflows/send-job-alerts.yml run succeeded',
    ].join('\n');
    expect(detectWorkflowScoped(body)).toBe(false);
    expect(isExclusivelyWorkflowScoped(body)).toBe(false);
  });

  it('il titolo di default è la prima riga del testo (i due call site del drainer passano `title\\nbody`)', () => {
    const text = 'Workflow Failure: Generate Blog Article\nqualunque corpo senza yml.';
    expect(detectWorkflowScoped(text)).toBe(true);
    // …ma un titolo esplicito vince sul default.
    expect(detectWorkflowScoped(text, { title: 'Bug in scripts/foo.mjs' })).toBe(false);
  });
});
