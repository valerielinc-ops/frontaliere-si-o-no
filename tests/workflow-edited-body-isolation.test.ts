import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { latestCompletedRunByName } from '../scripts/ci/lib/vitestCheck.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: { script?: string };
};

type WorkflowJob = {
  name?: string;
  if?: string;
  steps?: WorkflowStep[];
};

const workflowText = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(workflowText) as {
  concurrency?: { group?: string };
  jobs?: Record<string, WorkflowJob>;
};
const jobs = workflow.jobs ?? {};
const codeJob = jobs.vitest;
const bodyJob = jobs['body-contract'];

const contractStep = (job: WorkflowJob | undefined) =>
  job?.steps?.find((step) => step.name?.startsWith('PR-body completeness + multi-issue Closes'));

/** Extract the action predicate that controls whether a job is reachable. */
function actionPredicate(condition: string | undefined): 'edited' | 'not-edited' | null {
  const match = String(condition ?? '').match(/github\.event\.action\s*(==|!=)\s*'edited'/);
  if (!match) return null;
  return match[1] === '==' ? 'edited' : 'not-edited';
}

function runsForAction(condition: string | undefined, action: 'edited' | 'synchronize'): boolean {
  const predicate = actionPredicate(condition);
  if (predicate === 'edited') return action === 'edited';
  if (predicate === 'not-edited') return action !== 'edited';
  return false;
}

describe('tests.yml: body edit isolation', () => {
  it('keeps edited reachable and partitions its concurrency from synchronize', () => {
    const types = workflowText.match(/^[ \t]+types:\s*\[([^\]]+)\]/m)?.[1]
      ?.split(',')
      .map((type) => type.trim());
    expect(types).toContain('edited');
    expect(types).toContain('synchronize');

    const group = workflow.concurrency?.group ?? '';
    const lane = group.match(
      /\$\{\{\s*github\.event\.action\s*==\s*'edited'\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}/,
    );
    expect(lane, 'concurrency.group must assign edited and code events to different lanes').toBeTruthy();
    if (!lane) return;

    const renderGroup = (action: 'edited' | 'synchronize') =>
      group.replace(lane[0], action === 'edited' ? lane[1] : lane[2]);
    expect(lane[1]).toBe('body');
    expect(lane[2]).toBe('code');
    expect(renderGroup('edited')).not.toBe(renderGroup('synchronize'));
  });

  it('routes edited to the contract-only job and synchronize to the heavy job', () => {
    expect(codeJob?.name).toBe(VITEST_CHECK_NAME);
    expect(bodyJob?.name).toBe('PR body contract');
    expect(bodyJob?.name).not.toBe(VITEST_CHECK_NAME);

    expect(runsForAction(codeJob?.if, 'edited')).toBe(false);
    expect(runsForAction(codeJob?.if, 'synchronize')).toBe(true);
    expect(runsForAction(bodyJob?.if, 'edited')).toBe(true);
    expect(runsForAction(bodyJob?.if, 'synchronize')).toBe(false);
    expect(bodyJob?.if).toContain("github.event_name == 'pull_request'");
    expect(codeJob?.if).toMatch(
      /github\.event\.action != 'edited'\s*&&\s*\(github\.event\.action != 'labeled' \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'stale-review'\)\)/,
    );

    const heavyContract = contractStep(codeJob);
    const editedContract = contractStep(bodyJob);
    expect(heavyContract?.uses).toBe('actions/github-script@v8');
    expect(editedContract?.uses).toBe('actions/github-script@v8');
    expect(editedContract?.with?.script).toBe(heavyContract?.with?.script);
    expect(bodyJob?.steps).toHaveLength(1);
    expect(bodyJob?.steps?.[0]?.name).toContain('PR-body completeness');
    expect(bodyJob?.steps?.[0]?.if).toContain('github.event_name ==');
    expect(bodyJob?.steps?.[0]?.if).not.toContain("github.event.action != 'edited'");

    expect(codeJob?.steps?.some((step) => step.name === 'Require approving Claude review')).toBe(true);
    expect(codeJob?.steps?.some((step) => step.name === 'Rebase near-merge PRs after review or stale rescue')).toBe(true);
  });

  it('does not let the edited body check replace a code verdict', () => {
    const completed = latestCompletedRunByName(
      [
        {
          name: codeJob?.name,
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-09-08T08:20:00Z',
        },
        {
          name: bodyJob?.name,
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-09-08T08:20:05Z',
        },
        {
          name: codeJob?.name,
          status: 'completed',
          conclusion: 'skipped',
          completed_at: '2026-09-08T08:20:10Z',
        },
      ],
      VITEST_CHECK_NAME,
    );
    expect(completed?.conclusion).toBe('failure');
  });
});
