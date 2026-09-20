import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  classifyReview,
  compareChangedLines,
  changedLinesFromCompareApi,
  changedLinesForScope,
  scopeDeclassificationOptions,
  scopeExit,
  SCOPE_EXITS,
} from '../scripts/ci/review-gate.mjs';

/**
 * Due difetti misurati sul ciclo reale il 2026-09-20, finestra
 * 2026-09-18T07:06Z → 2026-09-19T20:54Z (400 run di `pr-redflag-fixer.yml`,
 * 50 con il job `scope` eseguito e almeno un 🔴 nella review che l'ha
 * triggerato).
 *
 * 1. ROUND SPRECATI. `runReviewGate()` passa da tempo `priorFindingIds` e
 *    `changedLinesSince` al classificatore; il percorso `--scope`, che è
 *    quello che decide se lanciare il fixer, non li passava affatto. Replay
 *    degli stessi verdetti reali coi due parametri: **47 run facevano partire
 *    `redflag-fix`, 11 (23%) non sarebbero dovute partire** — un turno Codex
 *    più una run completa di `tests.yml` ciascuna.
 *
 * 2. USCITA SILENZIOSA. `redflag-fix` parte solo su `blocking`. Quando l'unico
 *    🔴 viene declassato senza che nessun finding risolva FUORI dal diff, la
 *    follow-up aggregata non viene coniata (il mint guarda solo `outside`), il
 *    job è skippato, la run è verde e sulla PR non resta niente. Il caso era
 *    irraggiungibile prima della fix 1 ed è raggiungibile 11 volte subito
 *    dopo: le due correzioni sono accoppiate e vivono nella stessa PR.
 *    Il gemello del difetto è il 🔴 ancorato al solo `PR body:L<n>` — 14
 *    finding su 85 nella finestra, lo stesso ripetuto su 4 review consecutive
 *    di #9238 fino a `needs-human` — che finiva in `unresolved` e mandava il
 *    fixer a cercare nell'albero un difetto che sta nel body.
 */

const SUVA = 'scripts/lib/suva-job-parser.mjs';
const FILES = [SUVA, 'tests/suva-job-parser.test.ts'];
const FINDING = `- ${SUVA}:L233: 🔴 Important: \`descMatch\` usa una chiusura non bilanciata.`;
const REVIEW = ['## Review', '', FINDING, ''].join('\n');

const HEAD_SHA = 'a'.repeat(40);
const PRIOR_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);

function botReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    state: 'COMMENTED',
    submitted_at: '2026-09-19T08:00:00Z',
    commit_id: PRIOR_SHA,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    body: REVIEW,
    ...overrides,
  };
}

describe('scope classifier: i due parametri che il fixer perdeva (difetto 1)', () => {
  it('senza i parametri lo stesso 🔴 ripetuto resta bloccante — è il comportamento da correggere', () => {
    const classification = classifyReview(REVIEW, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
    });
    expect(classification.blocking).toBe(true);
    expect(classification.inScope).toHaveLength(1);
  });

  it('con i parametri il 🔴 su una riga che nessuno ha toccato non fa ripartire il fixer', () => {
    const classification = classifyReview(REVIEW, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
      priorFindingIds: new Set<string>(),
      // La riga citata è 233; il delta dall'ultima review tocca solo la 10.
      changedLinesSince: new Map([
        [SUVA, new Set([10])],
        ['tests/suva-job-parser.test.ts', new Set([5])],
      ]),
    });
    expect(classification.blocking).toBe(false);
    expect(classification.staleDeclassified).toHaveLength(1);
    expect(classification.outsideOnly).toBe(true);
  });

  it('`scopeDeclassificationOptions` ricava entrambi i parametri dalla review precedente', () => {
    const reviews = [
      botReview({ id: 1, commit_id: PRIOR_SHA, submitted_at: '2026-09-19T08:00:00Z' }),
      botReview({ id: 2, commit_id: HEAD_SHA, submitted_at: '2026-09-19T08:30:00Z' }),
    ];
    const seen: unknown[] = [];
    const options = scopeDeclassificationOptions({
      reviews,
      reviewCommit: HEAD_SHA,
      headSha: HEAD_SHA,
      repo: 'owner/repo',
      repositoryPaths: FILES,
      changedLinesFn: (repo, from, to) => {
        seen.push([repo, from, to]);
        return new Map([[SUVA, new Set([10])]]);
      },
    });
    // La finestra di confronto è la review PRECEDENTE, non la corrente.
    expect(seen).toEqual([['owner/repo', PRIOR_SHA, HEAD_SHA]]);
    expect(options.priorFindingIds).toBeInstanceOf(Set);
    expect(options.priorFindingIds!.size).toBeGreaterThan(0);
    expect(options.changedLinesSince).toBeInstanceOf(Map);
    expect(options.priorReviewCommit).toBe(PRIOR_SHA);
  });

  it('senza una review precedente non declassa niente: su un dato assente si tiene il finding', () => {
    const options = scopeDeclassificationOptions({
      reviews: [botReview({ id: 1, commit_id: HEAD_SHA })],
      reviewCommit: HEAD_SHA,
      headSha: HEAD_SHA,
      repo: 'owner/repo',
      changedLinesFn: () => new Map([[SUVA, new Set()]]),
    });
    expect(options.priorFindingIds).toBeUndefined();
    expect(options.changedLinesSince).toBeUndefined();
  });

  it('la review che ha triggerato è quella del commit dell'
    + ' evento, non semplicemente l\'ultima arrivata', () => {
    const reviews = [
      botReview({ id: 1, commit_id: PRIOR_SHA, submitted_at: '2026-09-19T08:00:00Z' }),
      botReview({ id: 2, commit_id: HEAD_SHA, submitted_at: '2026-09-19T08:30:00Z' }),
      // Una review più recente, arrivata mentre il job girava.
      botReview({ id: 3, commit_id: OTHER_SHA, submitted_at: '2026-09-19T08:45:00Z' }),
    ];
    const seen: string[][] = [];
    scopeDeclassificationOptions({
      reviews,
      reviewCommit: HEAD_SHA,
      headSha: HEAD_SHA,
      repo: 'owner/repo',
      changedLinesFn: (_repo, from, to) => {
        seen.push([from, to]);
        return new Map();
      },
    });
    expect(seen).toEqual([[PRIOR_SHA, HEAD_SHA]]);
  });
});

describe('compareChangedLines: il delta a due punti, o niente', () => {
  const compare = (files: unknown[], mergeBase = PRIOR_SHA) => ({
    merge_base_commit: { sha: mergeBase },
    files,
  });

  it('traduce il patch della compare API nella Map che la regola si aspetta', () => {
    const map = compareChangedLines(
      compare([{ filename: SUVA, changes: 2, patch: '@@ -10,0 +11,2 @@\n+uno\n+due' }]),
      PRIOR_SHA,
    );
    expect(map).toBeInstanceOf(Map);
    expect([...map!.get(SUVA)!]).toEqual([11, 12]);
  });

  it('restituisce null dopo un rebase/force-push: tre punti ≠ due punti', () => {
    // `merge_base` diverso dal commit di partenza significa che la HEAD non
    // discende più da quella review: il tre-punti è più PICCOLO del due-punti
    // e dichiarerebbe «riga non cambiata» su righe riscritte.
    expect(compareChangedLines(
      compare([{ filename: SUVA, changes: 1, patch: '@@ -1 +1 @@\n+x' }], OTHER_SHA),
      PRIOR_SHA,
    )).toBeNull();
  });

  it('restituisce null su una risposta troncata (>= 300 file)', () => {
    const files = Array.from({ length: 300 }, (_unused, index) => ({
      filename: `scripts/f${index}.mjs`,
      changes: 1,
      patch: '@@ -1 +1 @@\n+x',
    }));
    expect(compareChangedLines(compare(files), PRIOR_SHA)).toBeNull();
  });

  it('restituisce null quando un file cambiato arriva senza patch', () => {
    // Un path senza patch entrerebbe nella Map con un Set vuoto, e
    // `classifyReview` semina la Map con TUTTI i file della PR: diventerebbe
    // «confrontato e immutato», cioè una declassazione senza prova.
    expect(compareChangedLines(
      compare([{ filename: SUVA, changes: 400 }]),
      PRIOR_SHA,
    )).toBeNull();
  });

  it('accetta un file binario/immutato senza patch e senza modifiche', () => {
    const map = compareChangedLines(
      compare([{ filename: 'public/logo.png', changes: 0 }]),
      PRIOR_SHA,
    );
    expect(map!.get('public/logo.png')).toEqual(new Set());
  });

  it('changedLinesFromCompareApi rifiuta shas non validi senza chiamare gh', () => {
    let called = 0;
    const ghFn = () => { called += 1; return null; };
    expect(changedLinesFromCompareApi('owner/repo', 'nope', HEAD_SHA, { ghFn })).toBeNull();
    expect(changedLinesFromCompareApi('owner/repo', HEAD_SHA, HEAD_SHA, { ghFn })).toBeNull();
    expect(called).toBe(0);
  });

  it('changedLinesFromCompareApi concatena le pagine e null se una manca', () => {
    const page = (files: unknown[]) => ({ merge_base_commit: { sha: PRIOR_SHA }, files });
    const ok = changedLinesFromCompareApi('owner/repo', PRIOR_SHA, HEAD_SHA, {
      ghFn: () => [
        page([{ filename: SUVA, changes: 1, patch: '@@ -1,0 +2 @@\n+x' }]),
        page([{ filename: 'tests/a.test.ts', changes: 1, patch: '@@ -1,0 +3 @@\n+y' }]),
      ],
    });
    expect([...ok!.keys()]).toEqual([SUVA, 'tests/a.test.ts']);
    const broken = changedLinesFromCompareApi('owner/repo', PRIOR_SHA, HEAD_SHA, {
      ghFn: () => [page([{ filename: SUVA, changes: 0 }]), { merge_base_commit: { sha: PRIOR_SHA } }],
    });
    expect(broken).toBeNull();
  });
});

describe('changedLinesForScope: git davanti, compare API come rete', () => {
  it('usa il git diff quando i commit sono lì e non chiama l\'API', () => {
    let apiCalls = 0;
    const map = changedLinesForScope('owner/repo', PRIOR_SHA, HEAD_SHA, {
      gitFn: () => new Map([[SUVA, new Set([1])]]),
      apiFn: () => { apiCalls += 1; return null; },
    });
    expect([...map!.keys()]).toEqual([SUVA]);
    expect(apiCalls).toBe(0);
  });

  it('ricade sulla compare API quando il pre-fetch del workflow non è atterrato', () => {
    // Misurato il 2026-09-20: la sola compare API risolve 14 delta su 50 (il
    // resto è `422 this diff is taking too long`), il solo git 0 su un
    // checkout `depth: 1` di main. I due insieme: 44 su 50.
    const map = changedLinesForScope('owner/repo', PRIOR_SHA, HEAD_SHA, {
      gitFn: () => null,
      apiFn: () => new Map([['tests/a.test.ts', new Set([3])]]),
    });
    expect([...map!.keys()]).toEqual(['tests/a.test.ts']);
  });

  it('se nessuna delle due sorgenti risponde, il delta è non calcolabile', () => {
    expect(changedLinesForScope('owner/repo', PRIOR_SHA, HEAD_SHA, {
      gitFn: () => null,
      apiFn: () => null,
    })).toBeNull();
  });
});

describe('scopeExit: ogni uscita ha un nome, nessuna è muta (difetto 2)', () => {
  it('declassazione senza nessun `outside` = uscita silenziosa da annunciare', () => {
    const classification = classifyReview(REVIEW, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
      priorFindingIds: new Set<string>(),
      changedLinesSince: new Map([
        [SUVA, new Set([10])],
        ['tests/suva-job-parser.test.ts', new Set([5])],
      ]),
    });
    const exit = scopeExit(classification);
    expect(exit.kind).toBe(SCOPE_EXITS.DECLASSIFIED);
    expect(exit.silent).toBe(true);
    expect(exit.declassified).toHaveLength(1);
    expect(exit.declassified[0].reason).toBe('stale');
  });

  it('un finding fuori dal diff conia la follow-up: la traccia esiste già', () => {
    const outsideReview = [
      '## Review',
      '',
      '- scripts/altro-file.mjs:L12: 🔴 Important: `parseFoo()` non gestisce il caso vuoto.',
      '',
    ].join('\n');
    const classification = classifyReview(outsideReview, {
      files: FILES,
      complete: true,
      repositoryPaths: [...FILES, 'scripts/altro-file.mjs'],
    });
    const exit = scopeExit(classification);
    expect(classification.outside).toHaveLength(1);
    expect(exit.kind).toBe(SCOPE_EXITS.FOLLOWUP);
    expect(exit.silent).toBe(false);
  });

  it('un 🔴 in-diff resta bloccante e non è un\'uscita', () => {
    const exit = scopeExit(classifyReview(REVIEW, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
    }));
    expect(exit.kind).toBe(SCOPE_EXITS.BLOCKING);
    expect(exit.silent).toBe(false);
  });

  it('riconosce il 🔴 ancorato al solo body della PR', () => {
    // La forma misurata 14 volte nella finestra, 4 delle quali identiche su
    // #9238: `PR body:L14`, zero file citati.
    const bodyReview = [
      '## Review',
      '',
      '- PR body:L14: 🔴 Important: `production-deploy` è dichiarato `blocked: configurazione owner-only`,'
        + ' che non è uno stato chiudente.',
      '',
    ].join('\n');
    const exit = scopeExit(classifyReview(bodyReview, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
    }));
    expect(exit.bodyOnly).toBe(true);
    // Resta azionabile: il fixer PUÒ riscrivere il body, quindi non si
    // declassa — si instrada.
    expect(exit.kind).toBe(SCOPE_EXITS.BLOCKING);
  });

  it('un 🔴 misto (body + file) non è body-only', () => {
    const mixed = [
      '## Review',
      '',
      '- PR body:L14: 🔴 Important: stato mancante.',
      `- ${SUVA}:L233: 🔴 Important: \`descMatch\` non bilanciato.`,
      '',
    ].join('\n');
    const exit = scopeExit(classifyReview(mixed, {
      files: FILES,
      complete: true,
      repositoryPaths: FILES,
    }));
    expect(exit.bodyOnly).toBe(false);
  });
});

describe('pr-redflag-fixer.yml: il workflow consuma davvero il verdetto', () => {
  const ROOT = process.cwd();
  const raw = readFileSync(join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
  const doc = YAML.parse(raw) as {
    jobs: Record<string, {
      if?: string;
      outputs?: Record<string, string>;
      steps?: Array<{ name?: string; id?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }>;
    }>;
  };
  const stepOf = (job: string, name: string) =>
    doc.jobs[job]?.steps?.find((step) => String(step.name || '').includes(name));

  it('il job `scope` espone il verdetto esteso', () => {
    expect(Object.keys(doc.jobs.scope.outputs || {}))
      .toEqual(expect.arrayContaining(['blocking', 'error', 'body_only', 'silent_exit', 'declassified']));
  });

  it('lo schema del verdetto pretende i campi nuovi: un classificatore vecchio è fail-closed', () => {
    const run = stepOf('scope', 'Classify review scope')?.run || '';
    expect(run).toContain('.silentExit | type == "boolean"');
    expect(run).toContain('.bodyOnly | type == "boolean"');
    // Il ramo di fallback deve comunque scrivere i nuovi output, altrimenti un
    // `needs.scope.outputs.silent_exit` vuoto verrebbe letto come «non
    // silenzioso» proprio nel caso in cui il classificatore non ha parlato.
    expect(run).toContain('silent_exit=false');
    expect(run).toContain('body_only=false');
  });

  it('esiste un job che rende esplicita l\'uscita silenziosa', () => {
    const notice = doc.jobs['declassified-notice'];
    expect(notice).toBeDefined();
    expect(notice.if).toContain("needs.scope.outputs.silent_exit == 'true'");
    const run = notice.steps?.map((step) => step.run || '').join('\n') || '';
    // Commento con marker per idempotenza + fail-closed se non si posta.
    expect(run).toContain('REDFLAG_DECLASSED');
    expect(run).toMatch(/pr comment "\$PR_NUMBER"/u);
    expect(run).toContain("l'uscita resterebbe silenziosa");
  });

  it('il fixer riceve il verdetto body-only e il prompt lo indirizza al body', () => {
    const codex = stepOf('redflag-fix', 'Run Codex Luna Max');
    expect(codex?.env?.REDFLAG_BODY_ONLY).toContain('needs.scope.outputs.body_only');
    const prompt = String(codex?.with?.prompt || '');
    expect(prompt).toContain('SOLO-BODY');
    expect(prompt).toContain('NON cercare il fix nel codice');
    expect(prompt).toContain('gh pr edit');
    expect(prompt).toContain('non auto-fixabile');
  });

  it('il round registra il digest del body prima del modello', () => {
    const base = stepOf('redflag-fix', 'Record base SHA')?.run || '';
    expect(base).toContain('body_digest=');
  });

  it('un body riscritto fa avanzare la HEAD, altrimenti la PR resta bloccata', () => {
    // `tests.yml` non è triggerato da `edited` (tolto il 2026-09-18) e il suo
    // re-review guard salta quando esiste già una review terminale sulla HEAD:
    // un 🔴 che vive solo nel body è assorbente, e correggere il body senza un
    // commit nuovo lascia la PR ferma per sempre con la run verde.
    const advance = stepOf('redflag-fix', 'Advance HEAD after a PR-body fix');
    expect(advance).toBeDefined();
    const run = advance?.run || '';
    // Si spinge SOLO quando il body è cambiato e la HEAD non è avanzata: non è
    // il commit vuoto che il prompt vieta (quello nasce da un round che non ha
    // fatto nulla).
    // Solo su un round body-only: un edit del body concorrente, su un round
    // che di codice non ha fatto nulla, non deve far avanzare la HEAD e
    // bruciare una re-review (❓ q: della review 5259835406).
    expect(run).toMatch(/\$\{BODY_ONLY:-false\}" != "true"/u);
    expect(run).toContain('BASE_BODY_DIGEST');
    expect(run).toContain('git rev-parse HEAD');
    expect(run).toMatch(/git commit --allow-empty/u);
    expect(run).toContain('--trailer "Fixer: redflag-round-');
    expect(run).toMatch(/git push origin "HEAD:\$\{HEAD_REF\}"/u);
    // Il push è l'unica uscita dallo stallo: se fallisce, non si esce verdi.
    expect(run).toContain('needs-human');
    expect(run).toContain('REDFLAG_BODY_DEADLOCK');
    expect(run.trimEnd().endsWith('exit 1')).toBe(true);
    // E il modello non deve pushare un secondo commit vuoto per la stessa cosa.
    const prompt = String(stepOf('redflag-fix', 'Run Codex Luna Max')?.with?.prompt || '');
    expect(prompt).toContain('Advance HEAD after a PR-body fix');
    expect(prompt).toContain('Non pushare tu un commit vuoto');
  });

  it('`Classify outcome` non può uscire verde su un body cambiato con la HEAD ferma', () => {
    const classify = stepOf('redflag-fix', 'Classify outcome');
    const run = classify?.run || '';
    expect(run).toContain('NOW_BODY_DIGEST');
    const branch = run.slice(run.indexOf('NOW_BODY_DIGEST'));
    const guard = branch.slice(0, branch.indexOf('NOW_COMMENTS'));
    expect(guard).toContain('::error::');
    expect(guard).toContain('exit 1');
    expect(guard).not.toContain('exit 0');
    // `Classify outcome` usava `$TRUSTED_GH_BIN` sotto `set -u` senza
    // dichiararlo: la command substitution moriva e il conteggio commenti
    // tornava vuoto, cioè RED su ogni terminale legittimo senza push.
    expect(classify?.env?.TRUSTED_GH_BIN).toBeTruthy();
  });
});
