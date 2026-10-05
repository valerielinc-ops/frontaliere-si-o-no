import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// Lint su TUTTI i workflow: chi pusha o apre una PR con un token preso da
// APP_TOKEN lo sceglie solo se `mint-app-token.mjs` ha verificato la capacita'
// (`APP_TOKEN_DATA_REFRESH`: `contents: write` e `pull_requests: write` nella
// risposta del conio). Il conio scrive APP_TOKEN appena il token esiste, anche
// quando l'installazione non concede quei permessi: con
// `env.APP_TOKEN || env.GITHUB_PAT` il PAT capace perde contro un token che il
// push o `gh pr create` rifiutano. Fino a questo test la forma condizionata era
// fissata solo per alcuni workflow nominati in data-refresh-pr-wiring.test.ts,
// e ogni workflow nuovo o non elencato tornava alla forma nuda (review delle
// PR 10569, 10596, 10687, 11283; issue 10114).

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

const GUARDED = /env\.APP_TOKEN_DATA_REFRESH\s*==\s*'true'\s*&&\s*env\.APP_TOKEN(?![A-Za-z0-9_])/g;
// Altre capacita' verificate dal conio: valgono per chi NON pubblica (per
// esempio un dispatch che vuole `actions: write`), non per un push.
const OTHER_CAPABILITY = /env\.APP_TOKEN_(?:ACTIONS|WORKFLOWS)\s*==\s*'true'\s*&&\s*env\.APP_TOKEN(?![A-Za-z0-9_])/g;
const BRIDGE_ACTION = './.github/actions/claude-codex-fallback';
const APP_TOKEN_REF = /env\.APP_TOKEN(?![A-Za-z0-9_])/;
const SHELL_APP_TOKEN = /\$\{?APP_TOKEN(?![A-Za-z0-9_])/;
// Uno script lanciato dallo step che legge APP_TOKEN dall'ambiente (per
// esempio `restorePromotionAppRemote()` di prospect-promote.mjs).
const SCRIPT_APP_TOKEN = /process\.env\.APP_TOKEN(?![A-Za-z0-9_])|\$\{?APP_TOKEN(?![A-Za-z0-9_])/;

// Cosa conta come pubblicare: push di git (anche nascosto negli helper), un
// remote riscritto con la credenziale, `gh pr create`, scritture di ref via API.
const PUBLISH_IN_STEP = [
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+create\b/,
  /open-data-refresh-pr\.sh/,
  /git-push-with-retry\.sh/,
  /git-commit-data\.sh/,
  /x-access-token:/,
  /-X\s+(?:POST|PATCH|PUT|DELETE)\s+["']?repos\/[^\s"']*\/git\/refs/,
  /create-pull-request/,
];
// Gli stessi segnali dentro gli script che lo step lancia (un livello): e' la
// strada per cui un `node scripts/ci/pr-autorebase.mjs` pusha senza che lo
// step lo dica.
const PUBLISH_IN_SCRIPT = [
  ...PUBLISH_IN_STEP,
  /['"]push['"]\s*,/,
  /\bupdate-branch\b/,
];

type StepFinding = {
  key: string;
  file: string;
  job: string;
  step: string;
  uses: string;
  /** espressioni `${{ }}` che scelgono APP_TOKEN senza una capacita' verificata */
  unguarded: string[];
  /** espressioni che scelgono APP_TOKEN con `APP_TOKEN_DATA_REFRESH` */
  guarded: number;
  /** lo script dello step legge `$APP_TOKEN` senza rimapparlo nell'env dello step */
  shellReadsUnmapped: boolean;
  publishes: string[];
  mintedBefore: boolean;
  /** `codex_github_token` delle corsie agente nello stesso job */
  bridgeTokens: string[];
};

const stripCommentLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(?:#|\/\/|\*|\/\*)/.test(line))
    .join('\n');

const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
};

const expressionsOf = (text: string) => [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1].trim());

const scriptCache = new Map<string, string>();
function readScript(root: string, rel: string): string {
  if (!scriptCache.has(rel)) {
    const abs = path.join(root, rel);
    scriptCache.set(rel, fs.existsSync(abs) ? stripCommentLines(fs.readFileSync(abs, 'utf8')) : '');
  }
  return scriptCache.get(rel) ?? '';
}

export function scanWorkflow(file: string, source: string, root = ROOT): StepFinding[] {
  const doc = parse(source) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> } | null;
  const findings: StepFinding[] = [];
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    let minted = false;
    const steps = def?.steps ?? [];
    const bridgeTokens = steps
      .filter((st) => st.uses === BRIDGE_ACTION)
      .map((st) => String((st.with as Record<string, unknown> | undefined)?.codex_github_token ?? ''))
      .flatMap(expressionsOf);
    steps.forEach((step, index) => {
      const run = typeof step.run === 'string' ? stripCommentLines(step.run) : '';
      const withScript = typeof (step.with as Record<string, unknown> | undefined)?.script === 'string'
        ? stripCommentLines(String((step.with as Record<string, unknown>).script))
        : '';
      const body = `${run}\n${withScript}`;
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const name = typeof step.name === 'string' ? step.name : uses || `#${index}`;

      const exprs = collectStrings({ env: step.env, with: step.with }).flatMap(expressionsOf);
      const appExprs = exprs.filter((e) => APP_TOKEN_REF.test(e));
      const unguarded = appExprs.filter(
        (e) => APP_TOKEN_REF.test(e.replace(GUARDED, '').replace(OTHER_CAPABILITY, '')),
      );
      const guarded = appExprs.filter((e) => e.replace(GUARDED, '') !== e).length;

      const envMap = (step.env ?? {}) as Record<string, unknown>;
      const scripts = [...new Set(body.match(/scripts\/[\w./-]+\.(?:mjs|cjs|js|sh|ts)/g) ?? [])];
      const readsAppToken =
        SHELL_APP_TOKEN.test(body) || scripts.some((rel) => SCRIPT_APP_TOKEN.test(readScript(root, rel)));
      // APP_TOKEN arriva nell'ambiente solo dal conio (GITHUB_ENV) di uno step
      // precedente dello stesso job: prima, o senza conio, la lettura e' vuota.
      const shellReadsUnmapped = readsAppToken && minted && !('APP_TOKEN' in envMap);

      const publishes = PUBLISH_IN_STEP.filter((re) => re.test(body) || re.test(uses)).map(String);
      for (const rel of scripts) {
        const script = readScript(root, rel);
        for (const re of PUBLISH_IN_SCRIPT) if (re.test(script)) publishes.push(`${rel}: ${re}`);
      }

      if (appExprs.length || shellReadsUnmapped) {
        findings.push({
          key: `${file} :: ${job} :: ${name}`,
          file,
          job,
          step: name,
          uses,
          unguarded,
          guarded,
          shellReadsUnmapped,
          publishes,
          mintedBefore: minted,
          bridgeTokens,
        });
      }
      if (/mint-app-token\.mjs/.test(run)) minted = true;
    });
  }
  return findings;
}

// Usi di APP_TOKEN senza capacita' verificata ammessi, ciascuno col suo perche'.
// `no-publish`: lo step (e gli script che lancia) non pusha e non apre PR: legge,
//   etichetta, commenta, chiude o fa dispatch, e il fallback serve solo per
//   l'identita' (`<app>[bot]` ri-triggera i workflow a valle).
// `agent-bridge`: corsia agente di `claude-codex-fallback`; la credenziale del
//   push sta nel bridge host-side e il suo contratto e' fissato da
//   tests/claude-codex-fallback.test.ts, uguale su tutte le corsie.
// `agent-lane`: il push remote deterministico di un fixer che DEVE avere la
//   stessa identita' del bridge dello stesso job (issue-fix-app-token-wiring:
//   «la STESSA identita' del suo push remote»). Pubblica, quindi resta ammesso
//   solo finche' la sua espressione coincide con il `codex_github_token` del job:
//   il bridge e il remote cambiano insieme o nessuno dei due.
type AllowReason = 'no-publish' | 'agent-bridge' | 'agent-lane';
const ALLOWED: Record<string, { reason: AllowReason; why: string }> = {
  'campaign-goal-check.yml :: check :: Run campaign goal check': { reason: 'no-publish', why: 'legge metriche e apre/aggiorna issue' },
  'crawler-content-plausibility-audit.yml :: verify :: Verify shortlist and open issues': { reason: 'agent-bridge', why: 'corsia agente che apre issue' },
  'deploy-publish.yml :: recover-legacy-publish-contract :: Dispatch a current build': { reason: 'no-publish', why: 'dispatch del deploy di recovery dopo guardia actions: write' },
  'followup-drainer.yml :: drain :: Probe capacità workflow del token di push (zero-Claude)': { reason: 'no-publish', why: 'sonda in sola lettura dello scope del token' },
  'followup-drainer.yml :: drain :: Drain follow-up queue (deterministic, no Claude)': { reason: 'no-publish', why: 'etichetta e smista issue, non pusha' },
  'generate-article.yml :: generate :: Self-trigger next run': { reason: 'no-publish', why: 'dispatch del run successivo' },
  'growth-report.yml :: report :: Run Codex Luna Max growth report': { reason: 'agent-bridge', why: 'corsia agente del report' },
  'issue-decompose.yml :: decompose :: Run Codex Luna Max decompose': { reason: 'agent-bridge', why: 'corsia agente che scompone issue' },
  'issue-fix.yml :: fix :: Run Codex Luna Max fix': { reason: 'agent-bridge', why: 'corsia agente del fixer' },
  'issue-fix.yml :: fix :: Mark autonomous PR provenance (zero-Claude)': { reason: 'no-publish', why: 'aggiunge una label alla PR' },
  'issue-fix.yml :: fix :: Close the PR a conflict hand-off supersedes (zero-Claude)': { reason: 'no-publish', why: 'chiude la PR superata con un commento' },
  'issue-triage.yml :: triage :: Classify and route (deterministic, no Claude)': { reason: 'no-publish', why: 'etichetta la issue' },
  'lessons-harvester.yml :: harvest :: Draft doc-rule proposal (Codex Luna Max — only if NOVEL patterns)': { reason: 'agent-bridge', why: 'corsia agente della proposta di regola' },
  'monitor-gsc-seo.yml :: monitor :: Run GSC Job Indexation Monitor': { reason: 'no-publish', why: 'apre issue e fa dispatch del deploy' },
  'monitor-seo-ctr-by-template.yml :: monitor :: Run SEO CTR-by-template monitor': { reason: 'no-publish', why: 'apre issue' },
  'needs-human-sweep.yml :: sweep :: Run Codex Luna Max sweep': { reason: 'agent-bridge', why: 'corsia agente dello sweep' },
  'post-merge-followup.yml :: followup :: Run Codex Luna Max follow-up triage (batch)': { reason: 'agent-bridge', why: 'corsia agente del triage' },
  'pr-collision-detector.yml :: detect :: Detect funnel-critical collisions (deterministic, no Claude)': { reason: 'no-publish', why: 'commenta ed etichetta le PR' },
  'pr-redcheck-fixer.yml :: redcheck-fix :: Run Codex Luna Max ❌-check-fix': { reason: 'agent-bridge', why: 'corsia agente; il push deterministico passa da Configure push remote' },
  'pr-redflag-fixer.yml :: redflag-fix :: Run Codex Luna Max 🔴-fix': { reason: 'agent-bridge', why: 'corsia agente; il push deterministico passa da Configure push remote' },
  'pr-redcheck-fixer.yml :: redcheck-fix :: Configure push remote (App token / PAT)': { reason: 'agent-lane', why: 'remote del ❌-fixer, stessa identita del bridge' },
  'pr-redflag-fixer.yml :: redflag-fix :: Configure push remote (App token / PAT)': { reason: 'agent-lane', why: 'remote del 🔴-fixer, stessa identita del bridge' },
  'refresh-keyword-config.yml :: refresh :: Trigger deploy if config changed': { reason: 'no-publish', why: 'dispatch del deploy' },
  'refresh-search-cluster-301-map.yml :: refresh :: Trigger deploy if compat store changed': { reason: 'no-publish', why: 'dispatch del deploy' },
  'retry-code-check-after-body-edit.yml :: recover :: Retry a failed body or review gate on the current head': { reason: 'no-publish', why: 'rilancia una run' },
  'seo-health-loop.yml :: health :: Trigger deploy for live compat correction': { reason: 'no-publish', why: 'dispatch del deploy' },
  'stale-pr-rescuer.yml :: rescue :: Scan open PRs and flag stalled ones': { reason: 'no-publish', why: 'etichetta e commenta le PR ferme' },
  'stale-pr-rescuer.yml :: rescue :: Orphan PR custodian': { reason: 'no-publish', why: 'commenta ed etichetta le PR orfane' },
  'sync-gsc-orphans.yml :: sync-orphans :: Trigger deploy if data changed': { reason: 'no-publish', why: 'dispatch del deploy' },
  'tests.yml :: vitest :: Run Codex Luna Max review': { reason: 'agent-bridge', why: 'corsia agente della review' },
  'tests.yml :: vitest :: Repair missing Codex review marker (zero-agent)': { reason: 'no-publish', why: 'ripara il marker della review' },
  'tests.yml :: vitest :: Publish bounded ledger-only automatic LGTM': { reason: 'no-publish', why: 'pubblica una review LGTM sulla PR' },
  'tests.yml :: vitest :: Publish automatic LGTM for a tests-only PR': { reason: 'no-publish', why: 'pubblica una review LGTM sulla PR' },
  'tests.yml :: vitest :: Publish carry-forward LGTM (code contribution unchanged)': { reason: 'no-publish', why: 'pubblica una review LGTM sulla PR' },
  'tests.yml :: post-review :: Enable native auto-merge after the required job': { reason: 'no-publish', why: "attiva l'auto-merge nativo, non pusha" },
  'traffic-data-freshness.yml :: freshness-check :: Verify token loaded (fail-loud guard)': { reason: 'no-publish', why: 'controlla solo la presenza di un token' },
  'traffic-data-freshness.yml :: freshness-check :: Self-heal — dispatch traffic-scheduler (via App token/PAT)': { reason: 'no-publish', why: 'dispatch dello scheduler' },
};

function scanAll(): StepFinding[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .flatMap((f) => scanWorkflow(f, fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')));
}

const describeViolation = (f: StepFinding) =>
  `${f.key} -> ${[...f.unguarded, ...(f.shellReadsUnmapped ? ['$APP_TOKEN letto dallo script'] : [])].join(' | ')}`;

describe('workflow App token capability lint', () => {
  const findings = scanAll();

  it("Workflow: push o PR con un token da APP_TOKEN senza la forma condizionata, fuori dall'elenco pinnato", () => {
    const violations = findings
      .filter((f) => f.publishes.length > 0 && (f.unguarded.length > 0 || f.shellReadsUnmapped))
      .filter((f) => ALLOWED[f.key]?.reason !== 'agent-lane')
      .map(describeViolation);
    expect(violations).toEqual([]);
  });

  it('classifica ogni altro uso di APP_TOKEN senza capacita verificata', () => {
    const unclassified = findings
      .filter((f) => f.publishes.length === 0 && (f.unguarded.length > 0 || f.shellReadsUnmapped))
      .filter((f) => !ALLOWED[f.key])
      .map(describeViolation);
    expect(unclassified).toEqual([]);
  });

  it("tiene l'elenco ammesso vivo e onesto", () => {
    const byKey = new Map(findings.map((f) => [f.key, f]));
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(ALLOWED)) {
      const f = byKey.get(key);
      if (!f || (f.unguarded.length === 0 && !f.shellReadsUnmapped)) {
        problems.push(`${key}: voce morta, lo step non usa piu' APP_TOKEN senza capacita'`);
        continue;
      }
      if (entry.reason === 'no-publish' && f.publishes.length > 0) {
        problems.push(`${key}: dichiarato no-publish ma pubblica (${f.publishes.join(', ')})`);
      }
      if (entry.reason === 'agent-bridge' && f.uses !== BRIDGE_ACTION) {
        problems.push(`${key}: dichiarato agent-bridge ma lo step usa ${f.uses || 'run:'}`);
      }
      if (entry.reason === 'agent-lane') {
        const same = f.unguarded.length > 0 && f.unguarded.every((e) => f.bridgeTokens.includes(e));
        if (!same) {
          problems.push(
            `${key}: agent-lane con token ${JSON.stringify(f.unguarded)} diverso dal bridge del job ${JSON.stringify(f.bridgeTokens)}`,
          );
        }
      }
      if (entry.why.trim().length < 8) problems.push(`${key}: motivo troppo corto`);
    }
    expect(problems).toEqual([]);
  });

  it('usa la forma condizionata solo dopo il conio, nello stesso job', () => {
    const blind = findings.filter((f) => f.guarded > 0 && !f.mintedBefore).map((f) => f.key);
    expect(blind).toEqual([]);
  });
});

describe('scanWorkflow (rilevatore)', () => {
  const wf = (steps: string) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  const mint = '      - name: Mint\n        run: node scripts/ci/mint-app-token.mjs\n';

  it('segnala un push con il fallback nudo', () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Publish\n        env:\n          GH_TOKEN: \${{ env.APP_TOKEN || env.GITHUB_PAT }}\n        run: bash scripts/lib/open-data-refresh-pr.sh --branch b\n`),
    );
    expect(f.publishes.length).toBeGreaterThan(0);
    expect(f.unguarded).toEqual(['env.APP_TOKEN || env.GITHUB_PAT']);
  });

  it('accetta la forma condizionata dopo il conio', () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Publish\n        env:\n          GH_TOKEN: \${{ env.APP_TOKEN_DATA_REFRESH == 'true' && env.APP_TOKEN || env.GITHUB_PAT }}\n        run: git push origin HEAD:refs/heads/b\n`),
    );
    expect(f.unguarded).toEqual([]);
    expect(f.guarded).toBe(1);
    expect(f.mintedBefore).toBe(true);
  });

  it('non accetta una capacita diversa per un push', () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Publish\n        env:\n          GH_TOKEN: \${{ env.APP_TOKEN_ACTIONS == 'true' && env.APP_TOKEN || env.GITHUB_PAT }}\n        run: git push origin HEAD\n`),
    );
    // ACTIONS non dice nulla su contents/pull_requests: per il push resta un
    // uso da classificare, e il lint lo tratta come pubblicazione non coperta.
    expect(f.guarded).toBe(0);
    expect(f.publishes.length).toBeGreaterThan(0);
  });

  it("segnala lo script che legge $APP_TOKEN senza rimapparlo", () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Persist\n        run: |\n          t="\${APP_TOKEN:-\${GITHUB_PAT:-}}"\n          git push "https://x-access-token:$t@github.com/o/r.git" HEAD:b\n`),
    );
    expect(f.shellReadsUnmapped).toBe(true);
    expect(f.publishes.length).toBeGreaterThan(0);
  });

  it('non conta la lettura di $APP_TOKEN in un job senza conio', () => {
    const found = scanWorkflow(
      'x.yml',
      wf(`      - name: Persist\n        run: |\n          t="\${GITHUB_PAT:-\${APP_TOKEN:-}}"\n          git push "https://x-access-token:$t@github.com/o/r.git" HEAD:b\n`),
    );
    expect(found).toEqual([]);
  });

  it('ignora un push citato solo in un commento', () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Label\n        env:\n          GH_TOKEN: \${{ env.APP_TOKEN || env.GITHUB_PAT }}\n        run: |\n          # non fa git push\n          gh issue edit 1 --add-label x\n`),
    );
    expect(f.publishes).toEqual([]);
  });

  it('vede il push dentro lo script lanciato dallo step', () => {
    const [f] = scanWorkflow(
      'x.yml',
      wf(`${mint}      - name: Rebase\n        env:\n          GH_TOKEN: \${{ env.APP_TOKEN || secrets.GITHUB_TOKEN }}\n        run: node scripts/ci/pr-autorebase.mjs\n`),
    );
    expect(f.publishes.some((p) => p.startsWith('scripts/ci/pr-autorebase.mjs'))).toBe(true);
  });
});
