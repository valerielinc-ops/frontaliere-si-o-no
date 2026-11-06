/**
 * Ogni gate SEO non bloccante diventa una issue che un autofixer può risolvere.
 *
 * Decisione del proprietario (2026-10-02): «Nessuno blocca la pubblicazione:
 * apriamo solo issue per gli errori riscontrati e poi saranno gli autofixer a
 * sistemarle». Per OGNI gate B o C, di validate-dist e di cathedral, la
 * catena è verificata anello per anello:
 *   1. si apre una issue a titolo stabile, tramite github-issue-creator, una
 *      sola per difetto (un gate che cathedral misura sul corpus intero non
 *      ne apre una seconda in validate-dist);
 *   2. il body porta gli offender (sezione `## Offender` dal report JSON) e la
 *      riproduzione;
 *   3. issue-triage la instrada in coda (`agent:fix-queued`), senza label o
 *      titoli che la escludano;
 *   4. nessuno la chiude prima che il gate rientri: non l'age-out del
 *      followup-drainer, non il recovered-closer, non il needs-human sweep; la
 *      chiude il suo workflow, per gate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SEO_GATE_CLASSES, bareGateName, isPublishBlocking } from '../scripts/ci/lib/seo-gate-classes.mjs';
import {
  CATHEDRAL_OWNED_GATES,
  buildIssuePayloads,
  gateLabel,
  gatesToResolve,
  titleForGate,
} from '../scripts/ci/report-validate-dist-failure.mjs';
import { GATES as CATHEDRAL_GATES } from '../scripts/cathedral-seo-gates-check.mjs';
import { classifyIssue } from '../scripts/lib/classify-issue.mjs';
import { isAgeOutCandidate, isOwnerClosedFailureAlarm } from '../scripts/ci/followup-drainer.mjs';
import { TITLE_RE as RECOVERED_CLOSER_TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import { inventory } from '../scripts/ci/failure-issue-inventory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const PKG_SCRIPTS: Record<string, string> = JSON.parse(read('package.json')).scripts;
const PRIORITY_LABEL: Record<number, string> = { 1: 'priority:urgent', 2: 'priority:high', 3: 'priority:medium' };
const DAY = 86_400_000;

const NON_BLOCKING = Object.keys(SEO_GATE_CLASSES).filter((key) => !isPublishBlocking(key));
const CATHEDRAL_BY_KEY = new Map(CATHEDRAL_GATES.map((g: { gateKey: string; name: string }) => [g.gateKey, g.name]));

type Issue = { owner: 'validate-dist' | 'cathedral'; title: string; labels: string[]; body: string };

/** La issue che il gate apre oggi, con il body che il suo opener scrive. */
function issueFor(gate: string): Issue {
  if (CATHEDRAL_OWNED_GATES.has(gate)) {
    const name = CATHEDRAL_BY_KEY.get(gate)!;
    // Stesse righe che scrive lo step "Open issue + fail workflow on regression".
    const body = [
      `Automated check detected a REGRESSION on the **${name}** gate.`,
      '',
      '- Current:  **12**',
      '- Baseline: 3',
      '- Delta:    9',
      `- Reproduce locally: \`npm run audit:${name}\``,
      '- Notes: ratchet',
      `- Class: **${SEO_GATE_CLASSES[gate].class}** (mode \`x\`, scripts/ci/lib/seo-gate-classes.mjs)`,
      '',
      '## Offender',
      '- Campione di offender (1 di 12):',
      '  - `dist/cerca-lavoro-zurigo/x/index.html`',
      '',
      'Per CLAUDE.md non-negotiables #1 + #5, the fix is to ELIMINATE the new',
      'offenders — do NOT widen the baseline as a workaround.',
    ].join('\n');
    const prio = SEO_GATE_CLASSES[gate].class === 'B' ? 2 : 3;
    return { owner: 'cathedral', title: `SEO gates regression: ${name} above baseline`, labels: ['seo-gates', 'regression', PRIORITY_LABEL[prio]], body };
  }
  const [payload] = buildIssuePayloads({
    repo: 'valerielinc-ops/frontaliere-si-o-no',
    runId: '36922718485',
    runAttempt: '1',
    deployRunId: '36921000000',
    deployRef: 'f64b396c',
    results: { dist: 'failure' },
    failedJobs: [{
      name: 'validate-dist / validate-dist-postbuild',
      gates: [{ gate, seconds: 1, rc: 1, line: `❌ FAIL  ${gate}  1.00 rc=1` }],
      summaryLines: [],
      excerpt: '',
    }],
    pkgScripts: PKG_SCRIPTS,
    reports: {
      [gate]: {
        report: { audit: bareGateName(gate), passed: false, offendersTotal: 1, topOffenders: [{ path: 'dist/cerca-lavoro-zurigo/x/index.html', metric: 1 }] },
        source: '`audit-reports/x.json`',
      },
    },
  });
  return { owner: 'validate-dist', title: payload.title, labels: [...payload.labels, PRIORITY_LABEL[payload.priority]], body: payload.body };
}

describe.each(NON_BLOCKING)('%s', (gate) => {
  const issue = issueFor(gate);

  it('1. titolo stabile, nessun token del run, dentro la finestra di dedup', () => {
    expect(issue.title.length).toBeLessThanOrEqual(60);
    expect(issue.title).not.toMatch(/\d{6,}/);
    if (issue.owner === 'validate-dist') {
      expect(issue.title).toBe(titleForGate(gate));
      expect(issue.labels).toContain(gateLabel(gate));
    }
  });

  it('2. il body porta offender e riproduzione', () => {
    expect(issue.body).toContain('## Offender');
    expect(issue.body).toContain('dist/cerca-lavoro-zurigo/x/index.html');
    expect(issue.body).toMatch(/Riproduzione locale|Reproduce locally/);
    expect(issue.body).not.toContain('.github/workflows/');
  });

  it('3. issue-triage la mette in coda per issue-fix', () => {
    const decision = classifyIssue(issue.title, issue.labels, issue.body, { repository: 'valerielinc-ops/frontaliere-si-o-no' });
    expect(decision.route, decision.riskReason).toBe('queue');
    expect(decision.autofix).toBe(true);
    expect(decision.riskBlocked).toBe(false);
  });

  it('4. nessuno la chiude prima che il gate rientri', () => {
    // followup-drainer: mai candidata all'age-out, a qualunque età.
    const old = { title: issue.title, labels: issue.labels.map((name) => ({ name })), createdAt: new Date(Date.now() - 400 * DAY).toISOString(), updatedAt: new Date(Date.now() - 300 * DAY).toISOString() };
    expect(isOwnerClosedFailureAlarm(old)).toBe(true);
    expect(isAgeOutCandidate(old, { now: Date.now(), ageOutDays: 10 })).toBe(false);
    // close-recovered-failure-issues: titolo fuori dalla sua famiglia.
    expect(RECOVERED_CLOSER_TITLE_RE.test(issue.title)).toBe(false);
    // Il suo workflow la chiude per gate, quando il gate passa.
    if (issue.owner === 'validate-dist') {
      expect(gatesToResolve([gate], [])).toEqual([gate]);
      expect(gatesToResolve([gate], [gate])).toEqual([]);
    } else {
      const closers = inventory().flatMap((rec: { closers: Array<{ title: string }> }) => rec.closers.map((c) => c.title));
      expect(closers).toContain('SEO gates regression: ${name} above baseline');
    }
  });
});

describe('anelli comuni', () => {
  it('validate-dist crea e chiude le issue per gate a titolo esatto, con la priorità della classe', () => {
    const src = read('scripts/ci/report-validate-dist-failure.mjs');
    expect(src).toContain('priority: payload.priority,');
    expect(src).toContain('exactTitle: payload.gate !== null,');
    expect(src).toMatch(/resolveGithubIssue\(title, \{[\s\S]{0,200}exactTitle: true,/);
  });

  it('il job di report scarica i report JSON del run per la sezione Offender', () => {
    const wf = read('.github/workflows/post-deploy-validate-dist.yml');
    const job = wf.slice(wf.indexOf('  validate-dist-report:'));
    expect(job).toContain('pattern: audit-reports*-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(job).toContain('VALIDATE_DIST_REPORTS_DIR: ${{ runner.temp }}/validate-dist-artifacts/audit-reports');
  });

  it('cathedral apre la issue con github-issue-creator e ci mette gli offender', () => {
    const wf = read('.github/workflows/cathedral-seo-gates-check.yml');
    const step = wf.slice(wf.indexOf('- name: Open issue + fail workflow on regression'));
    expect(step).toContain('node scripts/lib/github-issue-creator.mjs');
    expect(step).toContain('.offenderSection // ""');
    expect(step).toContain('echo "$offenders"');
    const checker = read('scripts/cathedral-seo-gates-check.mjs');
    expect(checker).toContain("if (r.status === 'regressed') r.offenderSection = offenderSectionForGate(gate);");
  });

  it('il needs-human sweep non chiude le issue dei gate', () => {
    const wf = read('.github/workflows/needs-human-sweep.yml');
    expect(wf).toContain('`Validation Failure (dist): <gate>` e `SEO gates regression: <gate> above baseline` NON si chiudono qui');
  });

  it('una sola issue per difetto: i gate di cathedral non hanno un gemello in validate-dist', () => {
    for (const g of CATHEDRAL_GATES as Array<{ gateKey: string }>) {
      expect(CATHEDRAL_OWNED_GATES.has(g.gateKey), g.gateKey).toBe(!isPublishBlocking(g.gateKey));
    }
  });
});
