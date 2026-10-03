/**
 * decompose-route-check — osservatore del routing delle figlie del decompose.
 *
 * Il 02-10 il decompose ha aperto nel sito la 10925 e la 10923: le schede
 * nominavano `scripts/ci/generator-ci-gate.mjs` e `scripts/lib/corpus-floors.mjs`,
 * file che esistono solo nel corpus (e lì erano già corretti). I due corpi
 * reali sono le fixture: devono uscire `misrouted`, mentre un file nuovo
 * (assente ovunque) o un file del sito non devono produrre scritture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  CORPUS_PROBE_PATH,
  CORPUS_REPOSITORY,
  OWNER_DIGEST_TITLE,
  PIN_LABEL,
  classifyChildRoute,
  extractRepoPaths,
  runRouteCheck,
} from '../scripts/ci/decompose-route-check.mjs';
import { FIXER_EXEMPT_LABELS } from '../scripts/lib/classify-issue.mjs';

// Corpo della issue 10925 (sito, 02-10), copiato verbatim.
const BODY_10925 = `## Scheda
- CAUSA: L'item FU-2026-09-22-015 punta a \`scripts/ci/generator-ci-gate.mjs\`, ma nel checkout del sito non esistono né il file né \`generatorCiVerdict\` o \`GENERATOR_CI_JOB_NAME\`; la sequenza \`cancelled\` → nuovo run non è quindi riproducibile né correggibile in questo repository.
- FIX: Ritargettare questo item al checkout/repository che possiede \`scripts/ci/generator-ci-gate.mjs\`; lì rendere il polling fail-closed quando il run osservato è cancellato e un nuovo run sulla stessa HEAD prende il suo posto, senza concedere l'esenzione a una generazione stantia.
- METRICA: prima=file=0, verdict=0, jobName=0 nel checkout sito atteso=file=1, verdict=1, jobName=1 nel checkout owner-correct | COMANDO: \`node --input-type=module -e "import fs from 'node:fs'; const p='scripts/ci/generator-ci-gate.mjs'; const exists=fs.existsSync(p); const s=exists?fs.readFileSync(p,'utf8'):''; console.log(JSON.stringify({file:Number(exists),verdict:Number(s.includes('generatorCiVerdict')),jobName:Number(s.includes('GENERATOR_CI_JOB_NAME'))}));"\`
- OSSERVATORE: il test/gate del repository owner deve simulare \`cancelled\` seguito da un nuovo run sulla stessa HEAD e verificare che \`generatorCiVerdict(checkRuns, GENERATOR_CI_JOB_NAME)\` resti deny/pending finché il nuovo check-run esatto non è osservato.

## Origine
Parent: #9508 — FU-2026-09-22-015, gestione del polling del generator CI dopo cancellazione e sostituzione del run.`;

// Corpo della issue 10923 (sito, 02-10), copiato verbatim.
const BODY_10923 = `## Scheda
- CAUSA: L'item FU-2026-09-22-009 punta a \`scripts/lib/corpus-floors.mjs\`, ma il checkout del sito target della issue non contiene quel file né \`historyRevisionFromEnv\` o \`PREFLIGHT_PR_BASE_REVISION\`; il fixer non può quindi riprodurre o correggere il contesto push/PR senza agire sul repository sbagliato.
- FIX: Ritargettare questo item al checkout/repository corpus che contiene \`scripts/lib/corpus-floors.mjs\`; lì verificare che \`historyRevisionFromEnv()\` privilegi \`PREFLIGHT_PR_BASE_REVISION\` nel contesto \`pull_request\` del branch mirror e mantenga il percorso push coerente. Il repository owner-correct resta da risolvere perché la fonte non lo nomina.
- METRICA: prima=file=0, historyRevision=0, preflight=0 nel checkout sito atteso=file=1, historyRevision=1, preflight=1 nel checkout owner-correct | COMANDO: \`node --input-type=module -e "import fs from 'node:fs'; const p='scripts/lib/corpus-floors.mjs'; const exists=fs.existsSync(p); const s=exists?fs.readFileSync(p,'utf8'):''; console.log(JSON.stringify({file:Number(exists),historyRevision:Number(s.includes('historyRevisionFromEnv')),preflight:Number(s.includes('PREFLIGHT_PR_BASE_REVISION'))}));"\`
- OSSERVATORE: il test/gate del repository owner deve esercitare sia \`push\` sia \`pull_request\` sul branch mirror e fallire chiuso quando la base PR manca o non coincide; l'assenza del file nel checkout sito non va risolta creando un omonimo speculativo.

## Origine
Parent: #9508 — FU-2026-09-22-009, verifica della precedenza della revisione PR nel mirror corpus.`;

const PARENT = 9508;
const DIGEST = 777;

type Child = { number: number; state: string; body: string; labels: { name: string }[]; comments: { body: string }[] };

function fakeIo({
  children,
  site = new Set<string>(),
  corpus = new Set<string>([CORPUS_PROBE_PATH]),
  corpusReadable = true,
  digest = DIGEST as number | null,
}: {
  children: Child[];
  site?: Set<string>;
  corpus?: Set<string>;
  corpusReadable?: boolean;
  digest?: number | null;
}) {
  const writes: { kind: string; n: number; body?: string; add?: string[]; remove?: string[] }[] = [];
  const corpusReads: string[] = [];
  const logs: string[] = [];
  const io = {
    parentComments: () => [
      { body: 'riepilogo' },
      { body: `- [ ] #${children.map((c) => c.number).join(' #')}\n<!-- DECOMPOSED_INTO: ${children.map((c) => c.number).join(' ')} -->\n<!-- DECOMPOSE_OUTCOME: decomposed-${children.length} -->` },
    ],
    child: (n: number) => children.find((c) => c.number === n) ?? null,
    siteHas: (p: string) => site.has(p),
    corpusHas: (p: string) => {
      corpusReads.push(p);
      return corpusReadable ? corpus.has(p) : null;
    },
    findDigest: () => digest,
    comment: (n: number, body: string) => { writes.push({ kind: 'comment', n, body }); },
    editLabels: (n: number, { add, remove }: { add: string[]; remove: string[] }) => {
      writes.push({ kind: 'labels', n, add, remove });
    },
    log: (line: string) => { logs.push(line); },
  };
  return { io, writes, corpusReads, logs };
}

const child = (number: number, body: string, labels: string[] = [], comments: string[] = []): Child => ({
  number,
  state: 'OPEN',
  body,
  labels: labels.map((name) => ({ name })),
  comments: comments.map((body) => ({ body })),
});

describe('extractRepoPaths', () => {
  it('estrae il path dai corpi reali di 10925 e 10923', () => {
    expect(extractRepoPaths(BODY_10925)).toEqual(['scripts/ci/generator-ci-gate.mjs']);
    expect(extractRepoPaths(BODY_10923)).toEqual(['scripts/lib/corpus-floors.mjs']);
  });

  it('taglia riga e punteggiatura, ignora URL, glob e prefissi estranei', () => {
    const body = [
      'vedi scripts/ci/generator-ci-gate.mjs:100-135 e generator/tests/x-y.test.mjs.',
      'https://github.com/o/r/blob/main/scripts/lib/nascosto.mjs',
      'glob scripts/**/*.mjs, cartella scripts/ci/ e src/app.ts',
      '`.github/workflows/issue-decompose.yml` (packages/articles/src/a.ts)',
    ].join('\n');
    expect(extractRepoPaths(body)).toEqual([
      '.github/workflows/issue-decompose.yml',
      'generator/tests/x-y.test.mjs',
      'packages/articles/src/a.ts',
      'scripts/ci/generator-ci-gate.mjs',
    ]);
  });
});

describe('classifyChildRoute', () => {
  it('misrouted solo se un path è assente nel sito e presente nel corpus', () => {
    const p = 'scripts/lib/corpus-floors.mjs';
    expect(classifyChildRoute([p], { [p]: false }, { [p]: true })).toEqual({ verdict: 'misrouted', corpusOnly: [p] });
    expect(classifyChildRoute([p], { [p]: false }, { [p]: false }).verdict).toBe('ok');
    expect(classifyChildRoute([p], { [p]: true }, { [p]: null }).verdict).toBe('ok');
    expect(classifyChildRoute([p], { [p]: false }, { [p]: null }).verdict).toBe('ok');
    expect(classifyChildRoute([], {}, {}).verdict).toBe('no-paths');
  });
});

describe('runRouteCheck', () => {
  it('10925 e 10923: misrouted, pinnate keep-open, routing tolto, una richiesta sul digest ciascuna', () => {
    const corpus = new Set([CORPUS_PROBE_PATH, 'scripts/ci/generator-ci-gate.mjs', 'scripts/lib/corpus-floors.mjs']);
    const { io, writes } = fakeIo({
      children: [
        child(10925, BODY_10925, ['from-decompose', 'agent:fix-queued', 'fu-prio:high']),
        child(10923, BODY_10923, ['from-decompose', 'agent:fix']),
      ],
      corpus,
    });
    const result = runRouteCheck({ parentNumber: PARENT, io });
    expect(result.misrouted.map((m) => m.number).sort()).toEqual([10923, 10925]);

    const labelWrites = writes.filter((w) => w.kind === 'labels');
    expect(labelWrites).toEqual([
      { kind: 'labels', n: 10923, add: [PIN_LABEL], remove: ['agent:fix'] },
      { kind: 'labels', n: 10925, add: [PIN_LABEL], remove: ['agent:fix-queued'] },
    ]);
    // `keep-open` è la label che fixer e triage saltano davvero.
    expect(FIXER_EXEMPT_LABELS).toContain(PIN_LABEL);
    for (const w of writes) {
      expect(JSON.stringify(w)).not.toContain('automation-deferred');
    }

    const digestComments = writes.filter((w) => w.kind === 'comment' && w.n === DIGEST);
    expect(digestComments.map((w) => w.body?.match(/DECOMPOSE_MIGRATION_REQUEST: issue=(\d+)/)?.[1]).sort())
      .toEqual(['10923', '10925']);

    const marker = writes.find((w) => w.kind === 'comment' && w.n === 10925)?.body ?? '';
    expect(marker).toContain(`<!-- DECOMPOSE_MISROUTED: paths=scripts/ci/generator-ci-gate.mjs repo=${CORPUS_REPOSITORY} -->`);
    // Il marker sulla figlia è l'ultima scrittura per figlia (record di idempotenza).
    const forChild = writes.filter((w) => w.n === 10925 || (w.n === DIGEST && w.body?.includes('issue=10925')));
    expect(forChild.at(-1)).toMatchObject({ kind: 'comment', n: 10925 });
  });

  it('file nuovo (assente in entrambi): nessuna decisione, zero scritture', () => {
    const { io, writes } = fakeIo({ children: [child(1, 'FIX: crea `scripts/ci/nuovo-gate.mjs`', ['agent:fix-queued'])] });
    const result = runRouteCheck({ parentNumber: PARENT, io });
    expect(result.misrouted).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('file presente nel sito: ok, il corpus non viene nemmeno interrogato per quel path', () => {
    const p = 'scripts/ci/followup-drainer.mjs';
    const { io, writes, corpusReads } = fakeIo({
      children: [child(2, `FIX: \`${p}\``)],
      site: new Set([p]),
      corpus: new Set([CORPUS_PROBE_PATH, p]),
    });
    expect(runRouteCheck({ parentNumber: PARENT, io }).misrouted).toEqual([]);
    expect(writes).toEqual([]);
    expect(corpusReads).toEqual([CORPUS_PROBE_PATH]);
  });

  it('sonda del corpus fallita: nessuna decisione per la run, zero scritture', () => {
    const { io, writes, corpusReads } = fakeIo({
      children: [child(10925, BODY_10925, ['agent:fix'])],
      corpusReadable: false,
    });
    const result = runRouteCheck({ parentNumber: PARENT, io });
    expect(result.undecided).toBe(true);
    expect(result.misrouted).toEqual([]);
    expect(writes).toEqual([]);
    expect(corpusReads).toEqual([CORPUS_PROBE_PATH]);
  });

  it('idempotente: una figlia già marcata non riceve nuove scritture', () => {
    const corpus = new Set([CORPUS_PROBE_PATH, 'scripts/ci/generator-ci-gate.mjs']);
    const { io, writes } = fakeIo({
      children: [child(10925, BODY_10925, [PIN_LABEL], ['<!-- DECOMPOSE_MISROUTED: paths=x repo=y -->'])],
      corpus,
    });
    expect(runRouteCheck({ parentNumber: PARENT, io }).misrouted).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('digest assente: figlia comunque pinnata e marcata, nessun commento altrove', () => {
    const corpus = new Set([CORPUS_PROBE_PATH, 'scripts/ci/generator-ci-gate.mjs']);
    const { io, writes, logs } = fakeIo({ children: [child(10925, BODY_10925)], corpus, digest: null });
    runRouteCheck({ parentNumber: PARENT, io });
    expect(writes.map((w) => `${w.kind}:${w.n}`)).toEqual(['labels:10925', 'comment:10925']);
    expect(logs.some((l) => l.includes(OWNER_DIGEST_TITLE))).toBe(true);
  });

  it('dry run: verdetto senza scritture', () => {
    const corpus = new Set([CORPUS_PROBE_PATH, 'scripts/ci/generator-ci-gate.mjs']);
    const { io, writes } = fakeIo({ children: [child(10925, BODY_10925)], corpus });
    expect(runRouteCheck({ parentNumber: PARENT, io, dryRun: true }).misrouted).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

describe('contratto di issue-decompose.yml', () => {
  const workflowText = readFileSync(resolve(import.meta.dirname, '..', '.github', 'workflows', 'issue-decompose.yml'), 'utf8');
  const workflow = YAML.parse(workflowText) as {
    jobs: { decompose: { steps: { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: boolean }[] } };
  };
  const steps = workflow.jobs.decompose.steps;
  const idx = (pred: (s: (typeof steps)[number]) => boolean) => steps.findIndex(pred);

  it('il passo di route check sta dopo l\'agente e prima della telemetria, ed è if: always()', () => {
    const agent = idx((s) => s.id === 'codex_decompose');
    const check = idx((s) => s.run === 'node scripts/ci/decompose-route-check.mjs');
    const telemetry = idx((s) => /DECOMPOSE_OUTCOME telemetry/.test(s.name ?? ''));
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(agent);
    expect(telemetry).toBeGreaterThan(check);
    const step = steps[check];
    expect(step.if).toBe('always()');
    expect(step['continue-on-error']).toBe(true);
    expect(step.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(step.env?.ISSUE_NUMBER).toBe('${{ github.event.issue.number }}');
  });

  it('il prompt instrada nel corpus e vieta le schede «ritargettare»; il bridge ha lo scope del corpus', () => {
    const agent = steps[idx((s) => s.id === 'codex_decompose')];
    expect(agent.with?.codex_corpus_github_token).toBe('${{ env.GITHUB_PAT_NANAKO || env.GITHUB_PAT }}');
    const prompt = String(agent.with?.prompt ?? '');
    expect(prompt).toContain('gh issue create --repo nanakokyobashi-rgb/frontaliere-articles');
    expect(prompt).toContain('git ls-tree --name-only HEAD -- <path>');
    expect(prompt).toMatch(/MAI una scheda il cui FIX è «ritargettare»/);
    expect(prompt).toContain('NON ripiegare sul sito');
    // La credenziale del corpus (Remote Config) si carica prima dell'agente.
    const load = idx((s) => s.run === 'node scripts/load-rc-env.mjs');
    expect(load).toBeGreaterThanOrEqual(0);
    expect(load).toBeLessThan(idx((s) => s.id === 'codex_decompose'));
  });
});
