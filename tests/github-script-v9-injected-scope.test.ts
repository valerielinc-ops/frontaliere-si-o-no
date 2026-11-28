import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// actions/github-script v9 is ESM-only: `require('@actions/github')` throws
// MODULE_NOT_FOUND and the injected names (github, context, core, glob, io,
// exec, require, getOctokit, __original_require__) are function parameters, so
// redeclaring them with const/let is a SyntaxError. Recover Cloud Functions
// failed on 2026-11-27 (run 46000246752) because of the first; #19407 hit the
// second. Use the injected `getOctokit(token)` instead.
const WORKFLOWS_DIR = path.resolve(__dirname, '../.github/workflows');
const INJECTED = ['github', 'context', 'core', 'glob', 'io', 'exec', 'require', 'getOctokit', '__original_require__'];

interface ScriptStep {
  file: string;
  jobId: string;
  name: string;
  script: string;
}

function collectGithubScriptSteps(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')) as any;
    for (const [jobId, job] of Object.entries<any>(workflow?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const uses = String(step?.uses ?? '');
        if (!uses.startsWith('actions/github-script@')) continue;
        const major = uses.match(/@v(\d+)/)?.[1];
        if (major !== undefined && Number(major) < 9) continue;
        if (typeof step?.with?.script !== 'string') continue;
        steps.push({ file, jobId, name: String(step.name ?? ''), script: step.with.script });
      }
    }
  }
  return steps;
}

describe('actions/github-script v9+ scripts', () => {
  const steps = collectGithubScriptSteps();

  it('finds the github-script steps it is supposed to guard', () => {
    expect(steps.length).toBeGreaterThan(5);
  });

  it('never require() @actions/github (ESM-only since v9)', () => {
    const offenders = steps
      .filter((s) => /require\(\s*['"`]@actions\/github['"`]\s*\)/.test(s.script))
      .map((s) => `${s.file}#${s.jobId}: ${s.name}`);
    expect(offenders).toEqual([]);
  });

  it('never redeclares a name injected into the script scope', () => {
    const names = INJECTED.join('|');
    const decl = new RegExp(`(?:^|[\\n;{(,])\\s*(?:const|let|class|function)\\s+(?:${names})\\b`);
    const destructured = new RegExp(`(?:const|let)\\s*\\{[^}]*\\b(?:${names})\\b\\s*[,}][^}]*\\}\\s*=`);
    const offenders = steps
      .filter((s) => decl.test(s.script) || destructured.test(s.script))
      .map((s) => `${s.file}#${s.jobId}: ${s.name}`);
    expect(offenders).toEqual([]);
  });

  it('compiles with the injected names as parameters', () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const offenders: string[] = [];
    for (const s of steps) {
      // Scripts with ${{ }} expressions are only valid after Actions substitution.
      if (s.script.includes('${{')) continue;
      try {
        new AsyncFunction(...INJECTED, s.script);
      } catch (error) {
        offenders.push(`${s.file}#${s.jobId}: ${(error as Error).message}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
