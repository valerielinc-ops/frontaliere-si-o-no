import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  TITLE_PREFIX,
  LEGACY_TITLE,
  DEDUP_TITLE_PREFIX_LEN,
} = await import('../../scripts/ci/report-validate-dist-failure.mjs');

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

describe('buildIssuePayloads — una issue per gate, fallback legacy', () => {
  it('1 gate → titolo per-gate, label Bug + ci-gate:<slug>', () => {
    const payloads = buildIssuePayloads(bfsInput());
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe('Validation Failure (dist): audit:max-bfs-depth');
    expect(payloads[0].labels).toEqual(['Bug', 'ci-gate:audit-max-bfs-depth']);
  });

  it('>3 gate → una sola issue riassuntiva col titolo legacy', () => {
    const gates = ['audit:hreflang', 'audit:page-weight', 'audit:text-html-ratio', 'validate:sitemap'].map((gate) => ({
      gate, seconds: 1, rc: 1, line: `❌ FAIL  ${gate}  1.00 rc=1`,
    }));
    const payloads = buildIssuePayloads(bfsInput({
      failedJobs: [{ name: 'validate-dist / validate-dist-postbuild', gates, summaryLines: [], excerpt: '' }],
    }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe(LEGACY_TITLE);
    for (const g of gates) expect(payloads[0].body).toContain(g.line);
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
    const [payload] = buildIssuePayloads(bfsInput());
    expect(payload.body).toContain('## Suggested action');
    // Path del gate derivati da package.json (audit:max-bfs-depth).
    expect(payload.body).toContain('scripts/audit-bfs-depth.mjs');
    expect(payload.body).toContain('data/bfs-depth-baseline.json');
    // Il capability guard del fixer (check-workflows-scope.mjs) blocca a zero
    // token qualunque body che citi un path .github/workflows/**.
    expect(payload.body).not.toContain('.github/workflows/');
  });

  it('body: Build SHA = deploy_ref (mai github.sha), job/step, gate verbatim, estratto', () => {
    const [payload] = buildIssuePayloads(bfsInput());
    expect(payload.body).toContain('`abc1234def5678`');
    expect(payload.body).toContain('deploy_ref');
    expect(payload.body).toContain('validate-dist / validate-dist-postbuild-bfs');
    expect(payload.body).toContain('BFS-depth + orphan-sitemap-pages audits (serial chain)');
    expect(payload.body).toMatch(/❌ FAIL\s+audit:max-bfs-depth\s+756\.85 rc=1/);
    expect(payload.body).toContain('BFS-chain summary: 1 passed, 1 failed');
    expect(payload.body).toContain('How to fix');
    // Riproduzione locale: comando npm + artifact con gli offender completi.
    expect(payload.body).toContain('npm run audit:max-bfs-depth');
    expect(payload.body).toContain('audit-reports*-31259344953-1');
    expect(payload.body).toContain('byFeature');
  });

  it('senza deploy_ref il body lo dice e NON ripiega su github.sha', () => {
    const [payload] = buildIssuePayloads(bfsInput({ deployRef: '' }));
    expect(payload.body).toContain('deploy_ref non passato');
    expect(payload.body).not.toContain('abc1234def5678');
  });

  it('replay: deploy_run_id della BUILD, non del run di validazione', () => {
    const [payload] = buildIssuePayloads(bfsInput());
    expect(payload.body).toContain(
      'gh workflow run audit-dist-from-run.yml -f deploy_run_id=31250000000 -f audits=max-bfs-depth',
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
