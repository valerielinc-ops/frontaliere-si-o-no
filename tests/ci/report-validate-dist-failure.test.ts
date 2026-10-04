import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reporter diagnostico dei fallimenti validate-dist (issue #5414, Parte B).
 *
 * Fixture: log REALI trimmati (timestamp GitHub Actions conservati, ANSI
 * rimosso, dump `env:` degli step sostituito da righe FAKE_* — i nomi dei
 * secret mascherati non vanno nel repo):
 *   - job-validate-dist-bfs-31259344953.txt — run 31259344953, job
 *     "validate-dist / validate-dist-postbuild-bfs": ❌ FAIL audit:max-bfs-depth
 *     756.85 rc=1 + coda dello step (offender + "How to fix").
 *   - job-build-locale-en-31247086904.txt — run 31247086904, job
 *     "build-locale (en)": `filter leak` di validate-locale-shard-build.mjs.
 */

// Mock di `gh` (stesso approccio di github-issue-resolve.test.ts): serve SOLO
// ai test di resolveMode; le funzioni pure non toccano child_process.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const {
  parseGateLines,
  extractStepExcerpt,
  buildIssuePayloads,
  gateToRepro,
  replayAuditsArg,
  titleForGate,
  gateLabel,
  selectResolvableTitles,
  redactWorkflowPaths,
  resolveMode,
  reportDist,
  measureBuildFreshness,
  releaseParkedRecurrences,
  parseValidatedBuildMarker,
  parkedReleaseDecision,
  shouldParkNewIssue,
  PARK_LABELS,
  PARK_CREATE_LABELS,
  TITLE_PREFIX,
  LEGACY_TITLE,
  DEDUP_TITLE_PREFIX_LEN,
  MAX_PER_GATE_ISSUES,
  CATHEDRAL_OWNED_GATES,
  gatesToResolve,
} = await import('../../scripts/ci/report-validate-dist-failure.mjs');
// Moduli del ciclo che leggono le label di parcheggio: il test di contratto
// sotto verifica il parcheggio contro i loro predicati veri, non contro una copia.
const { isTriagedButNotRouted } = await import('../../scripts/ci/triage-sweep.mjs');
const { isReparkableCandidate } = await import('../../scripts/ci/followup-drainer.mjs');

const ROOT = resolve(import.meta.dirname, '..', '..');
const FX = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
const BFS_LOG = FX('job-validate-dist-bfs-31259344953.txt');
const SHARD_LOG = FX('job-build-locale-en-31247086904.txt');
const PKG_SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
).scripts;

function ghCalls(): string[][] {
  return execFileSync.mock.calls.filter((c) => c[0] === 'gh').map((c) => c[1] as string[]);
}

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
  delete process.env.ENABLE_FAILURE_REPORT;
});

/** Input di buildIssuePayloads per lo scenario BFS reale (run 31259344953). */
function bfsInput(overrides: Record<string, unknown> = {}) {
  const parsed = parseGateLines(BFS_LOG);
  return {
    repo: 'valerielinc-ops/frontaliere-si-o-no',
    runId: '31259344953',
    runAttempt: '1',
    deployRunId: '31250000000', // run della BUILD (sintetico nel test)
    deployRef: 'abc1234def5678',
    deployEvent: 'workflow_run',
    results: { source: 'success', postbuild: 'success', bfs: 'failure' },
    failedJobs: [{
      name: 'validate-dist / validate-dist-postbuild-bfs',
      htmlUrl: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/31259344953/job/93107610821',
      failedStep: 'BFS-depth + orphan-sitemap-pages audits (serial chain)',
      gates: parsed.failedGates,
      summaryLines: parsed.summaryLines,
      excerpt: extractStepExcerpt(BFS_LOG),
      logNote: '',
    }],
    pkgScripts: PKG_SCRIPTS,
    ...overrides,
  };
}

describe('parseGateLines — righe ❌ FAIL dal log BFS reale', () => {
  it('estrae gate, secondi e rc dalla riga FAIL, ignorando le PASS', () => {
    const { failedGates, summaryLines } = parseGateLines(BFS_LOG);
    expect(failedGates).toHaveLength(1);
    expect(failedGates[0].gate).toBe('audit:max-bfs-depth');
    expect(failedGates[0].rc).toBe(1);
    expect(failedGates[0].seconds).toBeCloseTo(756.85, 2);
    // La riga verbatim (senza timestamp) finisce nel body della issue.
    expect(failedGates[0].line).toMatch(/^❌ FAIL\s+audit:max-bfs-depth\s+756\.85 rc=1$/);
    // audit:orphan-sitemap-pages è PASS rc=0: non deve comparire tra i falliti.
    expect(failedGates.some((g) => g.gate === 'audit:orphan-sitemap-pages')).toBe(false);
    expect(summaryLines).toContain('BFS-chain summary: 1 passed, 1 failed');
  });
});

describe('extractStepExcerpt — ultime righe utili, senza dump env', () => {
  it('dal log shard-en esce la riga filter leak e NON il dump env', () => {
    const excerpt = extractStepExcerpt(SHARD_LOG);
    expect(excerpt).toContain("locale 'it' was NOT in the shard set but emitted 1 pages (filter leak)");
    expect(excerpt).toContain('✖ Locale shard validation FAILED:');
    // Il dump env vive nel blocco ##[group]…##[endgroup]: mai nell'estratto.
    expect(excerpt).not.toContain('FAKE_API_KEY');
    expect(excerpt).not.toContain('***');
    expect(excerpt).not.toMatch(/^env:$/m);
    // La finestra termina all'ultimo ##[error] (coda dello step fallito): gli
    // step successivi (reporter) non devono entrarci.
    expect(excerpt.trimEnd()).toMatch(/##\[error\]Process completed with exit code 1\.$/);
    expect(excerpt).not.toContain('github-issue-creator');
  });

  it('dal log BFS tiene la coda diagnostica dello step fallito', () => {
    const excerpt = extractStepExcerpt(BFS_LOG);
    expect(excerpt).toContain('How to fix');
    expect(excerpt).toContain('depth=unreachable');
    // Il group successivo (Publish gate results) e il suo dump env restano fuori.
    expect(excerpt).not.toContain('GEMINI_API_KEY');
    expect(excerpt).not.toContain('failed_gates=__UNKNOWN__');
    // Timestamp ISO rimossi.
    expect(excerpt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('titleForGate — sempre dentro la finestra di dedup (60 char)', () => {
  it('gate corto → titolo pieno', () => {
    expect(titleForGate('audit:max-bfs-depth')).toBe('Validation Failure (dist): audit:max-bfs-depth');
  });

  it('gate lungo → troncatura deterministica a token intero, mai oltre 60', () => {
    const t = titleForGate('validate:structured-data-completeness');
    expect(t.length).toBeLessThanOrEqual(DEDUP_TITLE_PREFIX_LEN);
    expect(t).toBe('Validation Failure (dist): validate:structured-data');
  });

  it('ogni gate REALE di package.json produce un titolo ≤ 60 a token interi', () => {
    const gates = Object.keys(PKG_SCRIPTS).filter(
      (k) => k.startsWith('audit:') || k.startsWith('validate:'),
    );
    expect(gates.length).toBeGreaterThan(20);
    for (const gate of gates) {
      const t = titleForGate(gate);
      expect(t.length, `titolo per ${gate}`).toBeLessThanOrEqual(DEDUP_TITLE_PREFIX_LEN);
      expect(t.startsWith(TITLE_PREFIX)).toBe(true);
      // Mai un separatore penzolante o un token spezzato a fine titolo.
      expect(t).not.toMatch(/[:/\-]$/);
      if ((TITLE_PREFIX + gate).length <= DEDUP_TITLE_PREFIX_LEN) {
        expect(t).toBe(TITLE_PREFIX + gate);
      } else {
        // il prefisso troncato deve restare un prefisso a token intero del gate
        const cut = t.slice(TITLE_PREFIX.length);
        expect(gate.startsWith(cut)).toBe(true);
        expect(/[:/\-]/.test(gate[cut.length] ?? '')).toBe(true);
      }
    }
  });
});

/**
 * Lo scenario BFS reale con il gate rinominato `audit:hreflang`: dal
 * 2026-10-02 `audit:max-bfs-depth` ha la sua issue in cathedral (vedi
 * CATHEDRAL_OWNED_GATES), quindi i test sulla composizione del body usano un
 * gate B che solo validate-dist misura. Log, estratto e riassunto restano
 * quelli veri.
 */
function hreflangInput(overrides: Record<string, unknown> = {}) {
  const base = bfsInput();
  const job = base.failedJobs[0];
  return {
    ...base,
    failedJobs: [{
      ...job,
      gates: [{ gate: 'audit:hreflang', seconds: 756.85, rc: 1, line: '❌ FAIL  audit:hreflang                           756.85 rc=1' }],
    }],
    ...overrides,
  };
}

describe('buildIssuePayloads — una issue per gate, fallback legacy', () => {
  it('1 gate → titolo per-gate, label Bug + ci-gate:<slug>, priorità dalla classe', () => {
    const payloads = buildIssuePayloads(hreflangInput());
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe('Validation Failure (dist): audit:hreflang');
    expect(payloads[0].labels).toEqual(['Bug', 'ci-gate:audit-hreflang']);
    expect(payloads[0].priority).toBe(2); // classe B
    expect(payloads[0].gate).toBe('audit:hreflang');
  });

  it('gate misurato da cathedral (max-bfs-depth) → nessuna issue qui, nemmeno la riassuntiva', () => {
    expect(CATHEDRAL_OWNED_GATES.has('audit:max-bfs-depth')).toBe(true);
    expect(buildIssuePayloads(bfsInput())).toEqual([]);
  });

  it('run 36922718485: 4 gate rossi → 4 issue, non una riassuntiva', () => {
    const gates = ['gate:seo-source', 'audit:all/h1-title-duplicates', 'audit:all/page-weight', 'validate:sitemap'].map((gate) => ({
      gate, seconds: 1, rc: 1, line: `❌ FAIL  ${gate}  1.00 rc=1`,
    }));
    const payloads = buildIssuePayloads(bfsInput({
      failedJobs: [{ name: 'validate-dist / validate-dist-postbuild', gates, summaryLines: [], excerpt: '' }],
    }));
    expect(payloads.map((p: { title: string }) => p.title)).toEqual(gates.map((g) => titleForGate(g.gate)));
    expect(payloads.map((p: { priority: number }) => p.priority)).toEqual([1, 3, 2, 1]);
  });

  it('>MAX_PER_GATE_ISSUES gate → una sola issue riassuntiva col titolo legacy', () => {
    const gates = Array.from({ length: MAX_PER_GATE_ISSUES + 1 }, (_, i) => `validate:synthetic-${i}`).map((gate) => ({
      gate, seconds: 1, rc: 1, line: `❌ FAIL  ${gate}  1.00 rc=1`,
    }));
    const payloads = buildIssuePayloads(bfsInput({
      failedJobs: [{ name: 'validate-dist / validate-dist-postbuild', gates, summaryLines: [], excerpt: '' }],
    }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe(LEGACY_TITLE);
    for (const g of gates) expect(payloads[0].body).toContain(g.line);
  });

  it('body: sezione Offender dal report JSON del gate', () => {
    const report = {
      audit: 'hreflang', passed: false, offendersTotal: 2, ranAt: '2026-10-02T00:00:00Z',
      byFeature: { 'job-board': 2 },
      topOffenders: [{ path: 'dist/en/find-jobs-zurich/x/index.html', feature: 'job-board', metric: 1 }],
    };
    const [payload] = buildIssuePayloads(hreflangInput({
      reports: { 'audit:hreflang': { report, source: '`audit-reports/hreflang.json`' } },
    }));
    expect(payload.body).toContain('## Offender');
    expect(payload.body).toContain('`dist/en/find-jobs-zurich/x/index.html`');
    expect(payload.body).toContain('`job-board`: 2');
    // Senza report il body lo dice, non tace.
    const [bare] = buildIssuePayloads(hreflangInput());
    expect(bare.body).toContain('non disponibile');
  });

  it('0 gate riconosciuti (fallimento infra) → issue legacy, mai zero issue', () => {
    const payloads = buildIssuePayloads(bfsInput({
      failedJobs: [{ name: 'validate-dist / validate-dist-source', failedStep: 'Rehydrate locale then section shards into dist/ (when sharding active)', gates: [], summaryLines: [], excerpt: 'boom' }],
    }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe(LEGACY_TITLE);
    expect(payloads[0].body).toContain('fallimento infra');
  });

  it('body: Suggested action con path scripts/, MAI path .github/workflows/', () => {
    const [payload] = buildIssuePayloads(hreflangInput());
    expect(payload.body).toContain('## Suggested action');
    // Path del gate derivati da package.json (audit:hreflang).
    expect(payload.body).toContain('scripts/audit-hreflang.mjs');
    // Il capability guard del fixer (check-workflows-scope.mjs) blocca a zero
    // token qualunque body che citi un path .github/workflows/**.
    expect(payload.body).not.toContain('.github/workflows/');
  });

  it('body: Build SHA = deploy_ref (mai github.sha), job/step, gate verbatim, estratto', () => {
    const [payload] = buildIssuePayloads(hreflangInput());
    expect(payload.body).toContain('`abc1234def5678`');
    expect(payload.body).toContain('deploy_ref');
    expect(payload.body).toContain('validate-dist / validate-dist-postbuild-bfs');
    expect(payload.body).toContain('BFS-depth + orphan-sitemap-pages audits (serial chain)');
    expect(payload.body).toMatch(/❌ FAIL\s+audit:hreflang\s+756\.85 rc=1/);
    expect(payload.body).toContain('BFS-chain summary: 1 passed, 1 failed');
    expect(payload.body).toContain('How to fix');
    // Riproduzione locale: comando npm + artifact con gli offender completi.
    expect(payload.body).toContain('npm run audit:hreflang');
    expect(payload.body).toContain('audit-reports*-31259344953-1');
    expect(payload.body).toContain('byFeature');
  });

  it('body: il workflow accorpato riporta il risultato del solo job dist', () => {
    const [payload] = buildIssuePayloads(hreflangInput({
      results: { dist: 'failure' },
      failedJobs: [],
    }));
    expect(payload.body).toContain('- **Job results:** dist=failure');
    expect(payload.body).not.toContain('source=');
  });

  it('senza deploy_ref il body lo dice e NON ripiega su github.sha', () => {
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: '' }));
    expect(payload.body).toContain('deploy_ref non passato');
    expect(payload.body).not.toContain('abc1234def5678');
  });

  it('replay: deploy_run_id della BUILD, non del run di validazione', () => {
    const [payload] = buildIssuePayloads(hreflangInput());
    expect(payload.body).toContain(
      'gh workflow run audit-dist-from-run.yml -f deploy_run_id=31250000000 -f audits=hreflang',
    );
    expect(payload.body).not.toContain('deploy_run_id=31259344953');
  });

  it('gate non-audit → niente comando replay (serve una rebuild)', () => {
    const gates = [{ gate: 'validate:sitemap', seconds: 2, rc: 1, line: '❌ FAIL  validate:sitemap  2.00 rc=1' }];
    const [payload] = buildIssuePayloads(bfsInput({
      failedJobs: [{ name: 'validate-dist / validate-dist-source', gates, summaryLines: [], excerpt: '' }],
    }));
    expect(payload.title).toBe('Validation Failure (dist): validate:sitemap');
    expect(payload.body).not.toContain('gh workflow run audit-dist-from-run.yml');
    expect(payload.body).toContain('rebuild');
  });
});

describe('gateToRepro / replayAuditsArg — mappature da package.json', () => {
  it('audit:max-bfs-depth → script e baseline reali', () => {
    const { npmScript, paths } = gateToRepro('audit:max-bfs-depth', PKG_SCRIPTS);
    expect(npmScript).toBe('audit:max-bfs-depth');
    expect(paths).toContain('scripts/audit-bfs-depth.mjs');
    expect(paths).toContain('data/bfs-depth-baseline.json');
  });

  it('audit:all/<sub> → npm script del sub-audit quando esiste', () => {
    expect(gateToRepro('audit:all/text-html-ratio', PKG_SCRIPTS).npmScript).toBe('audit:text-html-ratio');
    expect(replayAuditsArg('audit:all/text-html-ratio', PKG_SCRIPTS)).toBe('text-html-ratio');
  });

  it('replayAuditsArg: audit → nome senza prefisso; validate → null', () => {
    expect(replayAuditsArg('audit:max-bfs-depth', PKG_SCRIPTS)).toBe('max-bfs-depth');
    expect(replayAuditsArg('validate:sitemap', PKG_SCRIPTS)).toBeNull();
  });

  it('replayAuditsArg: gate:* → nome INTERO (audit-dist-from-run lo invoca letteralmente)', () => {
    // Il produttore del body taceva sui `gate:*` mentre il replay li accettava:
    // la issue auto-aperta per gate:dist-quality stampava «serve una rebuild»
    // e chi la leggeva pagava 40 minuti di build per niente (#5918). Il nome va
    // passato intero — il workflow prefissa `audit:` SOLO ai nomi nudi.
    expect(replayAuditsArg('gate:dist-quality', PKG_SCRIPTS)).toBe('gate:dist-quality');
    expect(replayAuditsArg('gate:seo-source', PKG_SCRIPTS)).toBe('gate:seo-source');
    // Un `gate:` inventato non è annunciabile: nel replay sarebbe `Missing script`.
    expect(replayAuditsArg('gate:non-esiste', PKG_SCRIPTS)).toBeNull();
  });

  it('la sezione Replay annuncia il comando per un gate:, non la rebuild', () => {
    const base = bfsInput();
    const job = { ...base.failedJobs[0], gates: [{ gate: 'gate:dist-quality', rc: 1, seconds: 12 }] };
    const [payload] = buildIssuePayloads({ ...base, failedJobs: [job] });
    expect(payload.body).toMatch(/-f audits=gate:dist-quality/);
    expect(payload.body).not.toMatch(/non è rieseguibile dall'artifact/);
  });

  it('gateLabel: slug kebab-case sanitizzato', () => {
    expect(gateLabel('audit:max-bfs-depth')).toBe('ci-gate:audit-max-bfs-depth');
    expect(gateLabel('audit:all/text-html-ratio')).toBe('ci-gate:audit-all-text-html-ratio');
  });
});

describe('resolve — chiude sia il titolo legacy sia i per-gate', () => {
  it('selectResolvableTitles filtra solo i titoli del reporter', () => {
    const titles = [
      LEGACY_TITLE,
      'Validation Failure (dist): audit:max-bfs-depth',
      'Validation Failure (live): post-deploy', // altro flusso: NON nostro
      'CI Failure (build): Deploy to GitHub Pages',
      'Crawler Failure: Run coop',
      LEGACY_TITLE, // duplicato → dedup
    ];
    expect(selectResolvableTitles(titles)).toEqual([
      LEGACY_TITLE,
      'Validation Failure (dist): audit:max-bfs-depth',
    ]);
  });

  it('resolveMode chiude ogni issue aperta (legacy + per-gate) via gh', () => {
    const open = [
      { number: 100, title: LEGACY_TITLE, url: 'u', state: 'OPEN' },
      { number: 101, title: 'Validation Failure (dist): audit:max-bfs-depth', url: 'u', state: 'OPEN' },
      { number: 102, title: 'Validation Failure (live): post-deploy', url: 'u', state: 'OPEN' },
    ];
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED' });
      return '';
    });
    process.env.GH_REPO = 'valerielinc-ops/frontaliere-si-o-no';
    process.env.RUN_ID = '31259344953';

    resolveMode({ dryRun: false });

    const closes = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'close');
    expect(closes.map((a) => a[2]).sort()).toEqual(['100', '101']);
    // La issue (live) appartiene a un altro flusso: mai toccata.
    expect(closes.some((a) => a[2] === '102')).toBe(false);
  });
});

describe('redazione dei path .github/workflows/** (capability guard del fixer)', () => {
  // La riga esiste DAVVERO nei log: ogni job di un reusable workflow apre con
  // `Uses: <owner>/<repo>/.github/workflows/<file>.yml@<ref>` (misurata alla
  // riga 34 del log del job 93107610821). Finisce nell'estratto ogni volta che
  // il job muore presto — e un body che la contiene fa terminare issue-fix.yml
  // prima di Claude, senza PR. Il test la inietta ESPLICITAMENTE: senza, il
  // `not.toContain` altrove è vacuo perché la fixture non la contiene.
  const USES_LINE = 'Uses: valerielinc-ops/frontaliere-si-o-no/.github/workflows/post-deploy-validate-dist.yml@refs/heads/main (ed06b384)';
  const EARLY_FAILURE_LOG = [
    '2026-08-08T13:21:22.3066091Z ' + USES_LINE,
    '2026-08-08T13:21:23.0000000Z Rehydrate section shards into dist/',
    '2026-08-08T13:21:24.0000000Z tar: dist/sitemap.xml: Cannot open: No such file or directory',
    '2026-08-08T13:21:25.0000000Z ##[error]Process completed with exit code 2.',
  ].join('\n');

  // Il regex del guard, verbatim da scripts/lib/workflow-scope-detect.mjs.
  const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/;

  it('la riga Uses reale sarebbe raccolta, ma esce redatta e il nome resta leggibile', () => {
    expect(EARLY_FAILURE_LOG).toMatch(WORKFLOW_PATH_RE); // il log grezzo la contiene
    const excerpt = extractStepExcerpt(EARLY_FAILURE_LOG);
    expect(excerpt).toContain('Cannot open'); // l'errore vero è conservato
    expect(excerpt).not.toMatch(WORKFLOW_PATH_RE); // il guard non matcha più
    expect(excerpt).toContain('post-deploy-validate-dist.yml'); // il nome resta
  });

  it('redactWorkflowPaths neutralizza ogni forma e lascia intatto il resto', () => {
    expect(redactWorkflowPaths('vedi .github/workflows/deploy.yml e .github/workflows/a/b.yaml'))
      .toBe('vedi «workflow deploy.yml» e «workflow a/b.yaml»');
    expect(redactWorkflowPaths('scripts/audit-bfs-depth.mjs')).toBe('scripts/audit-bfs-depth.mjs');
    expect(redactWorkflowPaths('gh workflow run audit-dist-from-run.yml -f x=1'))
      .toBe('gh workflow run audit-dist-from-run.yml -f x=1'); // bare .yml: il guard non ci matcha
  });

  it('il body finale è redatto anche quando il path arriva da un excerpt già composto', () => {
    const [payload] = buildIssuePayloads(bfsInput({
      failedJobs: [{
        name: 'validate-dist / validate-dist-postbuild-bfs',
        failedStep: 'Rehydrate',
        gates: [],
        summaryLines: [],
        excerpt: USES_LINE,
        logNote: '',
      }],
    }));
    expect(payload.body).not.toMatch(WORKFLOW_PATH_RE);
  });
});

describe('titoli per-gate: distinti e non prefisso l\'uno dell\'altro (dedup startsWith)', () => {
  // github-issue-creator deduplica con `title.startsWith(searchSafePrefix)`:
  // due gate i cui titoli collidono nei primi DEDUP_TITLE_PREFIX_LEN char, o
  // uno prefisso dell'altro, finirebbero sulla STESSA issue canonica — due
  // difetti diversi che si sovrascrivono a vicenda. Pin sui gate CI reali.
  const REAL_GATES = [
    'audit:max-bfs-depth', 'audit:orphan-sitemap-pages', 'audit:all',
    'validate:translation-completeness', 'validate:crawler-summaries',
    'validate:third-party-secrets', 'gate:seo-source', 'audit:page-weight',
  ];

  it('nessuna coppia collide né è prefisso dell\'altra entro la finestra di dedup', () => {
    const titles = REAL_GATES.map(titleForGate);
    expect(new Set(titles).size).toBe(titles.length);
    for (const a of titles) {
      for (const b of titles) {
        if (a === b) continue;
        expect(b.slice(0, DEDUP_TITLE_PREFIX_LEN).startsWith(a.slice(0, DEDUP_TITLE_PREFIX_LEN))).toBe(false);
      }
    }
  });

  it('ogni titolo reale sta dentro la finestra di dedup senza troncamento', () => {
    for (const g of REAL_GATES) expect(titleForGate(g)).toBe(TITLE_PREFIX + g);
  });
});

describe('ciclo di vita per gate (owner 2026-10-02: ogni errore una issue)', () => {
  // Righe nella forma del log reale del run 36922718485.
  const LOG = [
    '2026-10-01T23:57:00.4932966Z ❌ FAIL  audit:all                                2262.07 rc=1',
    '2026-10-01T23:57:00.4932966Z ❌ FAIL  gate:seo-source                            97.55 rc=1',
    '2026-10-01T23:57:00.4932966Z ✅ PASS  audit:hreflang                            960.28 rc=0',
    '2026-10-01T23:57:00.4932966Z ✅ PASS  audit:job-title-locale(report-only)        25.31 rc=0',
    '2026-10-01T23:57:00.5340149Z audit-all: failed-audits=h1-title-duplicates,text-html-ratio,page-weight',
  ].join('\n');

  it('audit:all si espande nei sotto-auditor falliti, come failed_gates', () => {
    const { failedGates, passedGates } = parseGateLines(LOG);
    expect(failedGates.map((g: { gate: string }) => g.gate)).toEqual([
      'gate:seo-source',
      'audit:all/h1-title-duplicates',
      'audit:all/text-html-ratio',
      'audit:all/page-weight',
    ]);
    expect(passedGates).toContain('audit:hreflang');
    expect(passedGates).toContain('audit:all/faqpage-validity');
    expect(passedGates).not.toContain('audit:all/page-weight');
  });

  it('senza marker audit:all resta opaco (fail-closed)', () => {
    const { failedGates } = parseGateLines(LOG.split('\n').slice(0, 2).join('\n'));
    expect(failedGates.map((g: { gate: string }) => g.gate)).toEqual(['audit:all', 'gate:seo-source']);
  });

  it('si chiudono le issue dei soli gate rientrati in questo run', () => {
    const { failedGates, passedGates } = parseGateLines(LOG);
    const resolvable = gatesToResolve(passedGates, failedGates.map((g: { gate: string }) => g.gate));
    expect(resolvable).toContain('audit:hreflang');
    expect(resolvable).toContain('audit:all/title-length');
    expect(resolvable).not.toContain('audit:all/page-weight');
    expect(resolvable).not.toContain('gate:seo-source');
    expect(resolvable).not.toContain('audit:all'); // il bundle non è passato per intero
    expect(resolvable.some((g: string) => g.includes('('))).toBe(false); // righe report-only
  });

  it('resolveMode chiude a titolo esatto: «…audit:all» non chiude «…audit:all/page-weight»', () => {
    const open = [
      { number: 200, title: 'Validation Failure (dist): audit:all/page-weight', url: 'u', state: 'OPEN' },
      { number: 201, title: 'Validation Failure (dist): audit:all', url: 'u', state: 'OPEN' },
    ];
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED' });
      return '';
    });
    process.env.GH_REPO = 'valerielinc-ops/frontaliere-si-o-no';
    resolveMode({ dryRun: false });
    const closes = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'close').map((a) => a[2]);
    expect(closes.sort()).toEqual(['200', '201']);
  });
});

/**
 * LC-09 — freschezza della build validata. Caso misurato: 11117/11118 aperte
 * alle 13:38Z del 2026-10-03 sul build 5121254f5 (run 37099011095, creata alle
 * 05:11:15Z), con le fix su `main` dalle 05:46Z/05:59Z e la build successiva
 * 37107091990 già riuscita alle 11:35Z: issue nuove, subito in triage, su un
 * difetto già corretto.
 */
describe('freschezza della build validata (LC-09)', () => {
  const REPO = 'valerielinc-ops/frontaliere-si-o-no';
  const STALE_REF = '5121254f5c491ebeb5c475926b81f3c06553bffc';
  const MAIN_SHA = '7acf7f1c854aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const NEWER_REF = '1cc0b46716bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const HREFLANG_TITLE = 'Validation Failure (dist): audit:hreflang';
  const STALE = { mainSha: MAIN_SHA, mainAhead: 14, newerBuild: true, newerRunId: '37107091990' };

  type Route = (args: string[]) => string | undefined;
  /** Mock di `gh` per argomenti: la prima route che risponde vince; il resto è ''. */
  function routeGh(...routes: Route[]) {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      for (const r of routes) {
        const out = r(args);
        if (out !== undefined) return out;
      }
      return '';
    });
  }
  const failing: Route = (a) => (a[0] === 'api' && /\/compare\//.test(a[1]) ? (() => { throw new Error('HTTP 502'); })() : undefined);
  const mainHead: Route = (a) => (a[0] === 'api' && a[1].endsWith('/commits/main') ? `${MAIN_SHA}\n` : undefined);
  const compareAhead = (n: number): Route => (a) => (a[0] === 'api' && /\/compare\//.test(a[1]) ? JSON.stringify({ status: 'ahead', ahead_by: n }) : undefined);
  const deployRun: Route = (a) => (a[0] === 'api' && /\/actions\/runs\/37099011095$/.test(a[1])
    ? JSON.stringify({ workflow_id: 233284293, created_at: '2026-10-03T05:11:15Z' }) : undefined);
  const deployRuns = (rows: unknown[]): Route => (a) => (a[0] === 'api' && /\/actions\/workflows\/233284293\/runs\?/.test(a[1])
    ? JSON.stringify(rows) : undefined);
  const REAL_ROWS = [
    { id: 37120074315, head_sha: 'ac5bf7c0e0fcccccccccccccccccccccccccccccc', created_at: '2026-10-03T11:34:13Z' },
    { id: 37107091990, head_sha: NEWER_REF, created_at: '2026-10-03T07:39:57Z' },
    { id: 37099011095, head_sha: STALE_REF, created_at: '2026-10-03T05:11:15Z' },
  ];

  it('issue nuova, main avanti di 14 e build più recente riuscita → fu-parked + fu-data-pending e marker', () => {
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: STALE }));
    expect(payload.labels).toEqual(['Bug', 'ci-gate:audit-hreflang', ...PARK_CREATE_LABELS]);
    expect(PARK_LABELS).toEqual(['fu-parked', 'fu-data-pending']);
    expect(PARK_CREATE_LABELS).toEqual(['agent:triaged', ...PARK_LABELS]);
    expect(payload.body).toContain(`<!-- VALIDATED_BUILD: sha=${STALE_REF} main_ahead=14 newer_build=true main=${MAIN_SHA} -->`);
    // Il marker sta sotto «Build SHA», non in coda: un body troncato lo conserva.
    expect(payload.body.indexOf('VALIDATED_BUILD')).toBeGreaterThan(payload.body.indexOf('## Build SHA'));
    expect(payload.body.indexOf('VALIDATED_BUILD')).toBeLessThan(payload.body.indexOf('## Job/step falliti'));
    expect(payload.body).toContain('https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/37107091990');
  });

  it('issue nuova, main_ahead = 0 → instradamento normale (nessuna label di parcheggio)', () => {
    const fresh = { ...STALE, mainAhead: 0 };
    expect(shouldParkNewIssue(fresh)).toBe(false);
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: fresh }));
    expect(payload.labels).toEqual(['Bug', 'ci-gate:audit-hreflang']);
    expect(payload.body).toContain('main_ahead=0 newer_build=true');
  });

  it('main avanti ma nessuna build più recente → instradamento normale', () => {
    expect(shouldParkNewIssue({ ...STALE, newerBuild: false })).toBe(false);
    expect(shouldParkNewIssue({ ...STALE, newerBuild: null })).toBe(false);
  });

  it('compare che fallisce → main_ahead=unknown, instradamento normale (mai un numero inventato)', () => {
    routeGh(mainHead, failing, deployRun, deployRuns(REAL_ROWS));
    const f = measureBuildFreshness({ repo: REPO, deployRef: STALE_REF, deployRunId: '37099011095' });
    expect(f.mainAhead).toBeNull();
    expect(f.newerBuild).toBe(true);
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: f }));
    expect(payload.labels).toEqual(['Bug', 'ci-gate:audit-hreflang']);
    expect(payload.body).toContain(`main_ahead=unknown newer_build=true main=${MAIN_SHA}`);
  });

  it('misura sul caso reale: build successiva dallo stesso workflow della run di build, run vecchie scartate', () => {
    routeGh(mainHead, compareAhead(289), deployRun, deployRuns([
      ...REAL_ROWS,
      // il listato `branch=…&status=success` a volte restituisce run vecchie
      { id: 31930304228, head_sha: 'dddddddddddddddddddddddddddddddddddddddd', created_at: '2026-08-16T00:00:00Z' },
    ]));
    const f = measureBuildFreshness({ repo: REPO, deployRef: STALE_REF, deployRunId: '37099011095' });
    expect(f).toEqual({ mainSha: MAIN_SHA, mainAhead: 289, newerBuild: true, newerRunId: '37120074315' });
    const listCall = ghCalls().find((a) => /\/actions\/workflows\/233284293\/runs\?/.test(a[1]))!;
    expect(listCall[1]).toContain('branch=main');
    expect(listCall[1]).toContain('status=success');
    expect(listCall[1]).toContain(`created=${encodeURIComponent('>=2026-10-03T05:11:15Z')}`);
    // Solo la build validata stessa e run vecchie → nessuna build successiva.
    routeGh(mainHead, compareAhead(289), deployRun, deployRuns([REAL_ROWS[2]]));
    expect(measureBuildFreshness({ repo: REPO, deployRef: STALE_REF, deployRunId: '37099011095' }).newerBuild).toBe(false);
    // Senza deploy_run_id la seconda prova non è misurabile.
    expect(measureBuildFreshness({ repo: REPO, deployRef: STALE_REF, deployRunId: '' }).newerBuild).toBeNull();
  });

  it('contratto col ciclo: la issue parcheggiata non la instrada nessun passaggio del triage e resta nel pool PARKED-RETRY', () => {
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: STALE }));
    const asIssue = (names: string[]) => ({ number: 11200, title: payload.title, body: payload.body, labels: names.map((name) => ({ name })) });
    const parked = asIssue(payload.labels);
    // Primo passaggio di triage-sweep: prende le open SENZA agent:triaged e le
    // instrada col solo classifyIssue, che per questo titolo dice queue.
    expect(parked.labels.some((l) => l.name === 'agent:triaged')).toBe(true);
    // Secondo passaggio: rispetta fu-parked (ROUTING_LABELS).
    expect(isTriagedButNotRouted(parked)).toBe(false);
    // Il fallback promesso esiste: il PARKED-RETRY del drainer la vede.
    expect(isReparkableCandidate(parked)).toBe(true);
    // Sbloccata dal reporter (tolte le due label): il secondo passaggio la instrada.
    const released = asIssue(payload.labels.filter((l: string) => !PARK_LABELS.includes(l)));
    expect(isTriagedButNotRouted(released)).toBe(true);
    // Controprova: queued+parked (ciò che il primo passaggio produceva senza
    // agent:triaged) è fuori dal PARKED-RETRY, cioè un limbo.
    expect(isReparkableCandidate(asIssue([...payload.labels, 'agent:fix-queued']))).toBe(false);
  });

  it('marker: il parse rilegge ciò che il body scrive', () => {
    const [payload] = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: STALE }));
    expect(parseValidatedBuildMarker(payload.body)).toEqual({
      sha: STALE_REF, mainAhead: 14, newerBuild: true, mainSha: MAIN_SHA,
    });
    expect(parseValidatedBuildMarker('nessun marker')).toBeNull();
  });

  describe('validazione successiva', () => {
    const parkedBody = buildIssuePayloads(hreflangInput({ deployRef: STALE_REF, freshness: STALE }))[0].body;
    const parkedList: Route = (a) => (a[0] === 'issue' && a[1] === 'list' && a.includes('fu-parked')
      ? JSON.stringify([{ number: 11118, title: HREFLANG_TITLE, body: parkedBody }]) : undefined);
    const behind = (n: number): Route => (a) => (a[0] === 'api' && a[1].includes(`/compare/${MAIN_SHA}...`)
      ? JSON.stringify({ status: n === 0 ? 'ahead' : 'diverged', behind_by: n }) : undefined);
    const edits = () => ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'edit');

    it('gate ancora rosso su una build che contiene il main di allora → le due label vengono tolte', () => {
      routeGh(parkedList, behind(0));
      const out = releaseParkedRecurrences({ repo: REPO, runId: '37120125747', deployRef: NEWER_REF, failingTitles: [HREFLANG_TITLE] });
      expect(out).toEqual([{ number: 11118, decision: 'release' }]);
      const [edit] = edits();
      expect(edit.slice(0, 3)).toEqual(['issue', 'edit', '11118']);
      expect(edit).toEqual(expect.arrayContaining(['--remove-label', 'fu-parked', 'fu-data-pending']));
      expect(ghCalls().some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '11118')).toBe(true);
    });

    it('build che ancora non contiene il main di allora, o stessa build rivalidata → resta parcheggiata', () => {
      routeGh(parkedList, behind(3));
      expect(releaseParkedRecurrences({ repo: REPO, deployRef: NEWER_REF, failingTitles: [HREFLANG_TITLE] }))
        .toEqual([{ number: 11118, decision: 'keep' }]);
      routeGh(parkedList, behind(0));
      expect(releaseParkedRecurrences({ repo: REPO, deployRef: STALE_REF, failingTitles: [HREFLANG_TITLE] }))
        .toEqual([{ number: 11118, decision: 'keep' }]);
      expect(edits()).toHaveLength(0);
    });

    it('contenimento non misurabile → sblocco (fail-closed verso il fixer); gate non rosso → nessun tocco', () => {
      routeGh(parkedList, failing);
      expect(releaseParkedRecurrences({ repo: REPO, deployRef: NEWER_REF, failingTitles: [HREFLANG_TITLE] }))
        .toEqual([{ number: 11118, decision: 'release' }]);
      execFileSync.mockReset();
      routeGh(parkedList, behind(0));
      expect(releaseParkedRecurrences({ repo: REPO, deployRef: NEWER_REF, failingTitles: ['Validation Failure (dist): gate:seo-source'] }))
        .toEqual([]);
      expect(edits()).toHaveLength(0);
    });

    it('issue con fu-data-pending ma senza le due prove nel marker non è un parcheggio del reporter', () => {
      const marker = parseValidatedBuildMarker(`<!-- VALIDATED_BUILD: sha=${STALE_REF} main_ahead=0 newer_build=true main=${MAIN_SHA} -->`);
      expect(parkedReleaseDecision({ marker, deployRef: NEWER_REF, contains: true })).toBe('skip');
      expect(parkedReleaseDecision({ marker: null, deployRef: NEWER_REF, contains: null })).toBe('skip');
    });
  });

  describe('reportDist end-to-end (gh simulato)', () => {
    const LOG = '2026-10-03T13:30:00.0000000Z ❌ FAIL  audit:hreflang                             12.00 rc=1\n';
    const jobs: Route = (a) => (a[0] === 'api' && /\/actions\/runs\/37120000000\/jobs/.test(a[1])
      ? JSON.stringify({ jobs: [{ id: 1, name: 'validate-dist / validate-dist-postbuild', conclusion: 'failure', html_url: 'u', steps: [] }] })
      : undefined);
    const log: Route = (a) => (a[0] === 'api' && /\/actions\/jobs\/1\/logs$/.test(a[1]) ? LOG : undefined);
    const openIssues = (rows: unknown[]): Route => (a) => (a[0] === 'issue' && a[1] === 'list' && !a.includes('fu-parked')
      ? JSON.stringify(a[a.indexOf('--state') + 1] === 'open' ? rows : []) : undefined);
    const created: Route = (a) => (a[0] === 'issue' && a[1] === 'create' ? 'https://github.com/x/y/issues/11200' : undefined);

    beforeEach(() => {
      Object.assign(process.env, {
        GH_REPO: REPO, RUN_ID: '37120000000', RUN_ATTEMPT: '1',
        INPUT_DEPLOY_RUN_ID: '37099011095', INPUT_DEPLOY_REF: STALE_REF, DIST_RESULT: 'failure',
      });
    });
    afterEach(() => {
      for (const k of ['RUN_ID', 'RUN_ATTEMPT', 'INPUT_DEPLOY_RUN_ID', 'INPUT_DEPLOY_REF', 'DIST_RESULT']) delete process.env[k];
    });

    it('issue nuova su build arretrata → creata con fu-parked + fu-data-pending', async () => {
      routeGh(jobs, log, mainHead, compareAhead(14), deployRun, deployRuns(REAL_ROWS), openIssues([]), created);
      await reportDist({ dryRun: false });
      const create = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'create')!;
      expect(create).toBeDefined();
      expect(create).toEqual(expect.arrayContaining(['--label', 'agent:triaged', 'fu-parked', 'fu-data-pending']));
      expect(create[create.indexOf('--body') + 1]).toContain('VALIDATED_BUILD: sha=' + STALE_REF + ' main_ahead=14 newer_build=true');
    });

    it('ricorrenza su issue già aperta e instradata → solo commento, nessun parcheggio', async () => {
      const open = [{ number: 11000, title: HREFLANG_TITLE, url: 'u', state: 'OPEN', labels: [{ name: 'agent:fix-queued' }] }];
      routeGh(jobs, log, mainHead, compareAhead(14), deployRun, deployRuns(REAL_ROWS), openIssues(open), created);
      await reportDist({ dryRun: false });
      const calls = ghCalls();
      expect(calls.some((a) => a[0] === 'issue' && a[1] === 'create')).toBe(false);
      expect(calls.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '11000')).toBe(true);
      // Nessuna scrittura porta le label di parcheggio (l'unica menzione è la lettura dei parcheggiati).
      const writes = calls.filter((a) => !(a[0] === 'issue' && a[1] === 'list'));
      expect(writes.some((a) => a.includes('fu-parked') || a.includes('fu-data-pending') || a.includes('agent:triaged'))).toBe(false);
    });

    it('misure fallite → issue nuova creata e instradata come prima', async () => {
      routeGh(jobs, log, openIssues([]), created); // commits/main, compare, runs: tutte ''
      await reportDist({ dryRun: false });
      const create = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'create')!;
      expect(create.includes('fu-parked')).toBe(false);
      expect(create.includes('agent:triaged')).toBe(false);
      expect(create[create.indexOf('--body') + 1]).toContain('main_ahead=unknown newer_build=unknown main=unknown');
    });
  });
});
