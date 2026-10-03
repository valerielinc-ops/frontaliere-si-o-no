import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  MAX_REJECTS_PER_RUN,
  REJECT_MARKER,
  VERIFY_LABEL,
  classifyMaybeResolved,
  evidenceBinding,
  findObjection,
  isTrustedAuthor,
  lastVerifyLabeledAt,
  openPrIssueRefs,
  rejectCommentBody,
  routedRunId,
  runRecheck,
  staticClass,
} from '../scripts/ci/maybe-resolved-recheck.mjs';
import { validateWorkflowText } from '../scripts/ci/validate-modified-workflows.mjs';
import { RECURRENCE_MARKER, countRecurrences } from '../scripts/ci/close-recovered-failure-issues.mjs';

const SCRIPT = readFileSync(new URL('../scripts/ci/maybe-resolved-recheck.mjs', import.meta.url), 'utf8');
const WORKFLOW_PATH = '.github/workflows/maybe-resolved-recheck.yml';
const WORKFLOW = readFileSync(new URL(`../${WORKFLOW_PATH}`, import.meta.url), 'utf8');

// Forme REST reali (issues/<n>/events e issues/<n>/comments).
const labeled = (at: string, id = 1) => ({ id, event: 'labeled', label: { name: VERIFY_LABEL }, created_at: at });
const reopened = (at: string, id = 2) => ({ id, event: 'reopened', created_at: at });
const comment = (body: string, at: string, login = 'github-actions[bot]', assoc = 'CONTRIBUTOR', type = 'Bot') => ({
  id: Date.parse(at),
  body,
  created_at: at,
  html_url: `https://github.com/o/r/issues/1#issuecomment-${Date.parse(at)}`,
  user: { login, type },
  author_association: assoc,
});
const issue = (number: number, title: string, labels: string[] = []) => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  labels: [VERIFY_LABEL, ...labels].map((name) => ({ name })),
});

const RECURRENCE = '🔁 Recurrence on workflow run.\n\n**Workflow:** cathedral-seo-gates-check';
const LABEL_AT = '2026-10-01T10:00:00Z';

const classify = (iss: ReturnType<typeof issue>, comments: unknown[], extra: Record<string, unknown> = {}) =>
  classifyMaybeResolved({
    issue: iss,
    events: [labeled(LABEL_AT)],
    comments,
    openPrRefs: new Set<number>(),
    binding: null,
    ...extra,
  });

describe('rigetto di maybe-resolved smentita da una ricorrenza', () => {
  it('label alle 10:00 e 🔁 del bot alle 12:00 → reject (recurrence)', () => {
    const row = classify(issue(1, 'CI Failure: x'), [comment(RECURRENCE, '2026-10-01T12:00:00Z')]);
    expect(row.cls).toBe('reject');
    expect(row.objection?.reason).toBe('recurrence');
    expect(row.objection?.url).toContain('#issuecomment-');
  });

  it('🔁 PRECEDENTE alla label non è un\'obiezione → awaiting-metric', () => {
    const row = classify(issue(1, 'CI Failure: x'), [comment(RECURRENCE, '2026-10-01T09:00:00Z')]);
    expect(row.cls).toBe('awaiting-metric');
  });

  it('🔁 di un autore non fidato → awaiting-metric', () => {
    const row = classify(issue(1, 'CI Failure: x'), [
      comment(RECURRENCE, '2026-10-01T12:00:00Z', 'drive-by', 'NONE', 'User'),
    ]);
    expect(row.cls).toBe('awaiting-metric');
  });

  it('un 🔁 in mezzo al testo non è un commento di ricorrenza', () => {
    const row = classify(issue(1, 'CI Failure: x'), [comment(`nota: ${RECURRENCE}`, '2026-10-01T12:00:00Z')]);
    expect(row.cls).toBe('awaiting-metric');
  });

  it('riapertura successiva alla label → reject (reopened)', () => {
    const row = classifyMaybeResolved({
      issue: issue(1, 'Workflow Failure: x'),
      events: [labeled(LABEL_AT), reopened('2026-10-02T08:00:00Z', 77)],
      comments: [],
      openPrRefs: new Set<number>(),
      binding: null,
    });
    expect(row.cls).toBe('reject');
    expect(row.objection?.reason).toBe('reopened');
    expect(row.objection?.url).toBe('https://github.com/o/r/issues/1#event-77');
  });

  it('conta solo l\'ULTIMO evento labeled: una ricorrenza fra due applicazioni non vale', () => {
    const row = classifyMaybeResolved({
      issue: issue(1, 'CI Failure: x'),
      events: [labeled('2026-09-01T00:00:00Z', 1), labeled('2026-10-01T10:00:00Z', 3)],
      comments: [comment(RECURRENCE, '2026-09-15T00:00:00Z')],
      openPrRefs: new Set<number>(),
      binding: null,
    });
    expect(row.cls).toBe('awaiting-metric');
    expect(lastVerifyLabeledAt([labeled('2026-09-01T00:00:00Z'), labeled('2026-10-01T10:00:00Z')])).toBe(Date.parse('2026-10-01T10:00:00Z'));
  });

  it('il proprietario (OWNER) e i bot del repo sono fidati, in forma REST e GraphQL', () => {
    expect(isTrustedAuthor({ user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'CONTRIBUTOR' })).toBe(true);
    expect(isTrustedAuthor({ author: { login: 'frontaliere-automation' }, authorAssociation: 'CONTRIBUTOR' })).toBe(true);
    expect(isTrustedAuthor({ user: { login: 'someone', type: 'User' }, author_association: 'OWNER' })).toBe(true);
    expect(isTrustedAuthor({ user: { login: 'github-actions', type: 'User' }, author_association: 'NONE' })).toBe(false);
    expect(isTrustedAuthor({ user: { login: 'drive-by', type: 'User' }, author_association: 'NONE' })).toBe(false);
  });
});

describe('le issue con un proprietario della prova non si rigettano mai', () => {
  const recurrenceAfter = [comment(RECURRENCE, '2026-10-01T12:00:00Z')];
  const cases: Array<[string, ReturnType<typeof issue>, string]> = [
    ['follow-up', issue(1, 'follow-up(daily:2026-10-03): 4 items', ['follow-up']), 'bucket'],
    ['keep-open', issue(1, 'CI Failure: x', ['keep-open']), 'pinned'],
    ['revenue', issue(1, 'CI Failure: x', ['revenue']), 'pinned'],
    ['agent:in-progress', issue(1, 'CI Failure: x', ['agent:in-progress']), 'claimed'],
    ['[crawler-health]', issue(1, '[crawler-health] kone: crawler unhealthy'), 'owned'],
    ['CWV Regression', issue(1, 'CWV Regression (CLS): /x/'), 'owned'],
    ['CF 5xx', issue(1, 'CF 5xx: host/path'), 'owned'],
    ['loop-l4', issue(1, 'CI Failure: x', ['loop-l4']), 'owned'],
  ];
  for (const [name, iss, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      const row = classify(iss, recurrenceAfter);
      expect(row.cls).toBe(expected);
      expect(row.cls).not.toBe('reject');
      expect(row.owner).toBeTruthy();
    });
  }

  it('una PR aperta che cita la issue la rende claimed', () => {
    const refs = openPrIssueRefs([
      { number: 9, title: 'fix', body: 'Addresses #7421\nvedi anche #74210' },
    ]);
    expect(refs.has(7421)).toBe(true);
    expect(refs.has(742)).toBe(false);
    expect(staticClass(issue(7421, 'CI Failure: x'), refs)?.cls).toBe('claimed');
    expect(staticClass(issue(7422, 'CI Failure: x'), refs)).toBeNull();
  });

  it('lista PR illeggibile → unreadable, non reject', () => {
    const row = classify(issue(1, 'CI Failure: x'), recurrenceAfter, { openPrRefs: null });
    expect(row.cls).toBe('unreadable');
  });
});

describe('evidence-unbound: la prova del marker non è del workflow del guasto (replay 7421)', () => {
  const workflows = [
    { name: 'cathedral-seo-gates-check', path: '.github/workflows/cathedral-seo-gates-check.yml' },
    { name: 'Code checks and review', path: '.github/workflows/tests.yml' },
  ];
  const marker = '<!-- ALREADY_FIXED_ROUTED: pr=10727 commit=f44c0bb2fb691b84d3a75e4f0d48dfb3b5cf0dde run=36841197125 -->\n🔎 Instradata';
  const title = 'CI Failure: cathedral-seo-gates-check';

  it('legge il run= dell\'ultimo marker fidato', () => {
    expect(routedRunId([comment(marker, '2026-10-01T10:07:36Z')])).toBe(36841197125);
    expect(routedRunId([comment(marker, '2026-10-01T10:07:36Z', 'drive-by', 'NONE', 'User')])).toBeNull();
  });

  it('run di tests.yml per una issue di cathedral → unbound', () => {
    expect(evidenceBinding({ title, runPath: '.github/workflows/tests.yml', workflows })).toBe('unbound');
    const row = classify(issue(7421, title), [comment(marker, '2026-10-01T10:07:36Z')], { binding: 'unbound' });
    expect(row.cls).toBe('evidence-unbound');
  });

  it('run di cathedral-seo-gates-check.yml → bound, nessuna classe evidence-unbound', () => {
    expect(evidenceBinding({ title, runPath: '.github/workflows/cathedral-seo-gates-check.yml', workflows })).toBe('bound');
    const row = classify(issue(7421, title), [], { binding: 'bound' });
    expect(row.cls).toBe('awaiting-metric');
  });

  it('lettura fallita o nome non risolvibile → la classe NON si assegna', () => {
    expect(evidenceBinding({ title, runPath: null, workflows })).toBeNull();
    expect(evidenceBinding({ title, runPath: '.github/workflows/tests.yml', workflows: null })).toBeNull();
    expect(evidenceBinding({ title: 'CI Failure: workflow-sconosciuto', runPath: '.github/workflows/tests.yml', workflows })).toBeNull();
    expect(evidenceBinding({ title: 'SEO CTR sotto soglia', runPath: '.github/workflows/tests.yml', workflows })).toBeNull();
  });

  it('con una ricorrenza la classe resta reject e la prova slegata resta visibile', () => {
    const row = classify(issue(7421, title), [comment(marker, '2026-10-01T10:07:36Z'), comment(RECURRENCE, '2026-10-01T15:41:38Z', 'valerielinc-ops', 'OWNER', 'User')], { binding: 'unbound' });
    expect(row.cls).toBe('reject');
    expect(row.binding).toBe('unbound');
  });
});

type Fake = {
  issues: ReturnType<typeof issue>[];
  events?: (n: number) => unknown[] | null;
  comments?: (n: number) => unknown[] | null;
};

function fakeDeps({ issues, events, comments }: Fake) {
  const writes: Array<[string, number, string?]> = [];
  const logs: string[] = [];
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const deps = {
    openPrs: () => [],
    events: events ?? (() => [labeled(LABEL_AT)]),
    comments: comments ?? (() => [comment(RECURRENCE, '2026-10-01T12:00:00Z')]),
    runPath: () => null,
    workflows: () => [],
    readIssue: (n: number) => ({ state: 'open', labels: byNumber.get(n)!.labels }),
    removeLabel: (n: number) => { writes.push(['remove-label', n]); },
    comment: (n: number, body: string) => { writes.push(['comment', n, body]); },
    log: (line: string) => { logs.push(line); },
  };
  return { deps, writes, logs };
}

describe('runRecheck: mutazioni, tetto e fail-closed', () => {
  it('eventi illeggibili → unreadable, zero scritture', () => {
    const { deps, writes } = fakeDeps({ issues: [issue(1, 'CI Failure: x')], events: () => null });
    const result = runRecheck({ issues: [issue(1, 'CI Failure: x')], deps, dryRun: false });
    expect(result.rows[0].cls).toBe('unreadable');
    expect(writes).toEqual([]);
  });

  it('commenti illeggibili → unreadable, zero scritture', () => {
    const { deps, writes } = fakeDeps({ issues: [issue(1, 'CI Failure: x')], comments: () => null });
    const result = runRecheck({ issues: [issue(1, 'CI Failure: x')], deps, dryRun: false });
    expect(result.rows[0].cls).toBe('unreadable');
    expect(writes).toEqual([]);
  });

  it('label presente ma nessun evento labeled → unreadable', () => {
    const { deps, writes } = fakeDeps({ issues: [issue(1, 'CI Failure: x')], events: () => [] });
    const result = runRecheck({ issues: [issue(1, 'CI Failure: x')], deps, dryRun: false });
    expect(result.rows[0].cls).toBe('unreadable');
    expect(writes).toEqual([]);
  });

  it('reject → toglie solo maybe-resolved e posta il marker col link all\'evento', () => {
    const iss = issue(8591, 'Workflow Failure: SEO closed-loop health and recovery', ['fu-parked']);
    const { deps, writes } = fakeDeps({ issues: [iss] });
    runRecheck({ issues: [iss], deps, dryRun: false });
    expect(writes.map((w) => w.slice(0, 2))).toEqual([['remove-label', 8591], ['comment', 8591]]);
    const body = writes[1][2]!;
    expect(body).toMatch(new RegExp(`<!-- ${REJECT_MARKER}: reason=recurrence at=2026-10-01T12:00:00\\.000Z -->`));
    expect(body).toContain('#issuecomment-');
  });

  it('--dry-run stampa la stessa classe senza scrivere', () => {
    const iss = issue(1, 'CI Failure: x');
    const { deps, writes } = fakeDeps({ issues: [iss] });
    const result = runRecheck({ issues: [iss], deps, dryRun: true });
    expect(result.rows[0].cls).toBe('reject');
    expect(writes).toEqual([]);
  });

  it('rilettura prima di scrivere: label già tolta o issue claimed → nessuna scrittura', () => {
    const iss = issue(1, 'CI Failure: x');
    const { deps, writes } = fakeDeps({ issues: [iss] });
    runRecheck({ issues: [iss], deps: { ...deps, readIssue: () => ({ state: 'open', labels: [{ name: 'agent:fix' }] }) }, dryRun: false });
    runRecheck({ issues: [iss], deps: { ...deps, readIssue: () => ({ state: 'open', labels: [{ name: VERIFY_LABEL }, { name: 'agent:in-progress' }] }) }, dryRun: false });
    runRecheck({ issues: [iss], deps: { ...deps, readIssue: () => null }, dryRun: false });
    expect(writes).toEqual([]);
  });

  it(`undici reject → ${MAX_REJECTS_PER_RUN} scritture e una riga di eccedenza`, () => {
    const issues = Array.from({ length: MAX_REJECTS_PER_RUN + 1 }, (_, i) => issue(100 + i, `CI Failure: w${i}`));
    const { deps, writes, logs } = fakeDeps({ issues });
    const result = runRecheck({ issues, deps, dryRun: false });
    expect(writes.filter((w) => w[0] === 'remove-label')).toHaveLength(MAX_REJECTS_PER_RUN);
    expect(result.overflow).toEqual([issues[issues.length - 1].number]);
    expect(logs.filter((l) => l.includes('eccedenza'))).toHaveLength(1);
  });

  it('il corpo del rigetto porta il marker e non promette una chiusura', () => {
    const body = rejectCommentBody({ reason: 'reopened', at: Date.parse('2026-10-02T08:00:00Z'), url: 'https://x/1#event-2', labeledAt: Date.parse(LABEL_AT) });
    expect(body.startsWith(`<!-- ${REJECT_MARKER}: reason=reopened at=2026-10-02T08:00:00.000Z -->`)).toBe(true);
    expect(body).toContain('https://x/1#event-2');
  });

  it('il corpo del rigetto non conta come ricorrenza per close-recovered (nessun 🔁)', () => {
    for (const reason of ['recurrence', 'reopened'] as const) {
      const body = rejectCommentBody({ reason, at: Date.parse('2026-10-02T08:00:00Z'), url: 'https://x/1#issuecomment-9', labeledAt: Date.parse(LABEL_AT) });
      expect(body).not.toContain(RECURRENCE_MARKER);
      expect(countRecurrences([{ body, created_at: '2026-10-02T08:00:00Z' }], { now: Date.parse('2026-10-02T09:00:00Z') })).toBe(0);
    }
  });

  it('una scrittura fallita emette un ::warning:: visibile nel run', () => {
    const issues = [issue(1, 'CI Failure: x')];
    const { deps, logs } = fakeDeps({ issues });
    deps.removeLabel = () => { throw new Error('HTTP 403'); };
    const result = runRecheck({ issues, deps, dryRun: false });
    expect(result.applied).toEqual([]);
    expect(logs.some((l) => l.startsWith('::warning::#1: rimozione label fallita'))).toBe(true);
  });
});

describe('contratto: script e workflow', () => {
  it('lo script non chiude MAI una issue', () => {
    expect(SCRIPT).not.toMatch(/['"]close['"]/);
    expect(SCRIPT).not.toMatch(/issue\s+close/);
    expect(SCRIPT).not.toMatch(/state['"]?\s*[:=]\s*['"]closed['"]/);
  });

  it('il workflow usa solo GITHUB_TOKEN, cabla --dry-run sull\'input e ha permessi minimi', () => {
    const wf = YAML.parse(WORKFLOW);
    expect(WORKFLOW).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)/);
    expect(WORKFLOW).toMatch(/github\.token|secrets\.GITHUB_TOKEN/);
    expect(wf.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read', 'pull-requests': 'read' });
    expect(wf.on.workflow_dispatch.inputs.dry_run.type).toBe('boolean');
    const run = JSON.stringify(wf.jobs);
    expect(run).toContain('inputs.dry_run');
    expect(run).toContain('--dry-run');
    expect(run).toContain('scripts/ci/maybe-resolved-recheck.mjs');
    expect(wf.on.schedule[0].cron).toMatch(/\*\/6/);
    expect(validateWorkflowText(WORKFLOW_PATH, WORKFLOW)).toEqual([]);
  });
});
