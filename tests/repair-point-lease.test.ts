/**
 * Contratto del gate `repair-point-lease`: un punto di riparazione, un fixer.
 * Il CLI parla con `gh`: un fake con stato tiene il test deterministico.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildLeaseComment,
  crawlerRepairPoints,
  decideLease,
  extractDeclaredRepairPoints,
  extractRegionPaths,
  extractRepairPoints,
  leaseCommentAlreadyPosted,
} from '../scripts/ci/repair-point-lease.mjs';

const SCRIPT = join(process.cwd(), 'scripts/ci/repair-point-lease.mjs');
const LIB = 'scripts/lib/ats-clients/workday-client.mjs';
const tempDirs: string[] = [];

const FAKE_GH = `#!/usr/bin/env node
import fs from 'node:fs';
const statePath = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const val = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === 'issue' && args[1] === 'view') {
  const i = state.issues.find((x) => String(x.number) === args[2]);
  console.log(JSON.stringify(i)); process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'list') {
  const label = val('--label');
  console.log(JSON.stringify(state.issues.filter((x) => x.labels.some((l) => l.name === label)))); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify(state.prs)); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'comment') {
  const i = state.issues.find((x) => String(x.number) === args[2]);
  i.comments.push({ body: val('--body') }); state.commentCalls = (state.commentCalls || 0) + 1; save(); process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'edit') {
  const i = state.issues.find((x) => String(x.number) === args[2]);
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === '--add-label') i.labels.push({ name: args[k + 1] });
    if (args[k] === '--remove-label') i.labels = i.labels.filter((l) => l.name !== args[k + 1]);
  }
  save(); process.exit(0);
}
process.exit(1);
`;

afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

const issue = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
  number, title: `[crawler-health] acme-${number}`, body,
  labels: [{ name: 'agent:fix' }], comments: [] as { body: string }[], ...extra,
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'rpl-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const manifest = [101, 102, 103].map((n) => ({ slug: `acme-${n}`, runStep: { run: `node scripts/update-acme-${n}-jobs.mjs` } }));
  writeFileSync(join(dir, 'data/crawler-manifest.json'), JSON.stringify({ manifest }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
  for (const n of [101, 102]) {
    writeFileSync(join(dir, `scripts/update-acme-${n}-jobs.mjs`), `import { fetchWorkdayJobs } from './lib/ats-clients/workday-client.mjs';\n`);
  }
  writeFileSync(join(dir, 'scripts/update-acme-103-jobs.mjs'), `import x from './lib/other.mjs';\n`);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  return dir;
}

function run(dir: string, state: any, n: number) {
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  const out = join(dir, `out-${n}.txt`);
  writeFileSync(out, '');
  const log = execFileSync('node', [SCRIPT], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: statePath, ISSUE_NUMBER: String(n), GITHUB_OUTPUT: out },
  });
  return { log, outputs: readFileSync(out, 'utf8'), state: JSON.parse(readFileSync(statePath, 'utf8')) };
}

const labelsOf = (s: any, n: number) => s.issues.find((i: any) => i.number === n).labels.map((l: any) => l.name);

describe('estrazione dei path target', () => {
  it('Repair point ha la precedenza e rifiuta path non sicuri', () => {
    const body = `Repair point: \`${LIB}\`\n- **Repair point**: \`../etc/passwd\`\n## Suggested action\nscripts/other.mjs`;
    expect(extractDeclaredRepairPoints(body)).toEqual([LIB]);
    expect(extractRepairPoints({ title: 'x', body }).paths).toEqual([LIB]);
  });
  it('file alla radice e prefisso ./ sono path validi (review 🔴 su App.tsx)', () => {
    expect(extractDeclaredRepairPoints('Repair point: `App.tsx`')).toEqual(['App.tsx']);
    expect(extractRegionPaths('## Suggested action\nModifica `./scripts/a.mjs`.')).toEqual(['scripts/a.mjs']);
    expect(decideLease({
      issueNumber: 5, paths: ['App.tsx'],
      openPrs: [{ number: 9, labels: ['agent:autofix'], headRefName: 'fix/issue-1', files: ['App.tsx'] }],
    })).toMatchObject({ blocked: true, number: 9 });
  });
  it('sezioni e blocchi di codice, non la prosa', () => {
    const body = 'Vedi scripts/prosa.mjs\n## Suggested action\nModifica `scripts/a.mjs`.\n## Altro\nscripts/b.mjs\n```\ntests/c.test.ts\n```';
    expect(extractRegionPaths(body).sort()).toEqual(['scripts/a.mjs', 'tests/c.test.ts']);
  });
  it('famiglia crawler dagli import dello script', () => {
    const deps = {
      manifest: { manifest: [{ slug: 'hamilton', runStep: { run: 'npm run jobs:update:hamilton' } }] },
      packageScripts: { 'jobs:update:hamilton': 'node scripts/update-hamilton-jobs.mjs' },
      readText: () => `import { a } from './lib/ats-clients/workday-client.mjs';`,
      exists: () => true,
    };
    expect(crawlerRepairPoints('hamilton', deps)).toEqual([LIB]);
    expect(extractRepairPoints({ title: '[crawler-health] hamilton: x', body: '' }, deps).source).toBe('crawler-family');
  });
});

describe('decideLease', () => {
  const pr = (over: any = {}) => ({ number: 7, labels: ['agent:autofix'], headRefName: 'fix/issue-1', files: [LIB], ...over });
  it('PR del ciclo su un path target blocca; PR altrui o ferme no', () => {
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [pr()] })).toMatchObject({ blocked: true, kind: 'pr', number: 7 });
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [pr({ labels: [], headRefName: 'feat/x' })] }).blocked).toBe(false);
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [pr({ labels: ['agent:autofix', 'has-conflicts'] })] }).blocked).toBe(false);
  });
  it('la PR della issue stessa e la PR da riapplicare non bloccano', () => {
    expect(decideLease({ issueNumber: 1, paths: [LIB], openPrs: [pr()] }).blocked).toBe(false);
    expect(decideLease({ issueNumber: 9, title: 'Conflitto con main: riapplicare la PR #7 su main', paths: [LIB], openPrs: [pr()] }).blocked).toBe(false);
  });
  it('peer: claim vince sempre, agent:fix vince solo col numero piu basso', () => {
    const peers = [{ number: 3, claimed: false, paths: [LIB] }, { number: 8, claimed: false, paths: [LIB] }, { number: 9, claimed: true, paths: [LIB] }];
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [], peers: [peers[1]] }).blocked).toBe(false);
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [], peers: [peers[0]] })).toMatchObject({ kind: 'issue', number: 3 });
    expect(decideLease({ issueNumber: 5, paths: [LIB], openPrs: [], peers: [peers[2]] })).toMatchObject({ number: 9 });
  });
  it('il marker e idempotente per lo stesso blocco', () => {
    const d = decideLease({ issueNumber: 5, paths: [LIB], openPrs: [pr()] }) as any;
    const body = buildLeaseComment(d);
    expect(body).toContain('in volo nella PR #7');
    expect(leaseCommentAlreadyPosted([{ body }], d)).toBe(true);
    expect(leaseCommentAlreadyPosted([{ body }], { ...d, number: 8 })).toBe(false);
  });
});

describe('CLI', () => {
  it('PR del ciclo su workday-client: la issue della PR parte, l altra va in coda, il marker non si ripete', () => {
    const dir = repo();
    const state = {
      prs: [{ number: 50, title: 'fix workday egress', labels: [{ name: 'agent:autofix' }], headRefName: 'fix/issue-101', files: [{ path: LIB }] }],
      issues: [issue(101, ''), issue(102, '')],
    };
    const a = run(dir, state, 101);
    expect(a.outputs).toContain('repair_point_blocked=false');
    expect(labelsOf(a.state, 101)).toContain('agent:fix');

    const b = run(dir, a.state, 102);
    expect(b.outputs).toContain('repair_point_blocked=true');
    expect(labelsOf(b.state, 102)).toEqual(['agent:fix-queued']);
    expect(b.state.commentCalls).toBe(1);
    expect(b.state.issues[1].comments[0].body).toContain('PR #50');

    // giro successivo (ripromossa dal drainer): stesso blocco, nessun secondo commento
    const again = JSON.parse(JSON.stringify(b.state));
    again.issues[1].labels = [{ name: 'agent:fix' }];
    const c = run(dir, again, 102);
    expect(c.outputs).toContain('repair_point_blocked=true');
    expect(c.state.commentCalls).toBe(1);
  });

  it('due issue sulla stessa libreria senza PR: parte la piu bassa', () => {
    const dir = repo();
    const state = { prs: [], issues: [issue(101, ''), issue(102, '')] };
    expect(run(dir, state, 101).outputs).toContain('repair_point_blocked=false');
    const b = run(dir, state, 102);
    expect(b.outputs).toContain('repair_point_blocked=true');
    expect(b.state.issues[1].comments[0].body).toContain('issue #101');
  });

  it('una PR che tocca solo contract.json non blocca', () => {
    const dir = repo();
    const state = {
      prs: [{ number: 51, title: 'regen', labels: [{ name: 'agent:autofix' }], headRefName: 'fix/issue-9', files: [{ path: '.github/corpus-workflows/contract.json' }] }],
      issues: [issue(102, 'Repair point: `.github/corpus-workflows/contract.json`')],
    };
    const r = run(dir, state, 102);
    expect(r.outputs).toContain('repair_point_blocked=false');
    expect(r.log).toContain('nessun punto di riparazione');
  });

  it('issue senza path: parte, con log esplicito', () => {
    const dir = repo();
    const state = { prs: [], issues: [{ ...issue(103, 'niente di utile'), title: 'Altro' }] };
    const r = run(dir, state, 103);
    expect(r.outputs).toContain('repair_point_blocked=false');
    expect(r.log).toContain('nessun punto di riparazione ricavabile');
  });
});
