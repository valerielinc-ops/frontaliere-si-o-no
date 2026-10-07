import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  ARTICLE_SYNC_ISSUE_TITLE,
  PUBLISHER_REPOSITORY,
  PUBLISHER_WORKFLOW,
  REPLAY_MARKER,
  findRecentReplayMarker,
  findSyncIssue,
  hasWorkflowDispatch,
  requestPublisherReplay,
} from '../../scripts/ci/request-article-publisher-replay.mjs';

const NOW = Date.parse('2026-10-06T22:00:00.000Z');
const ISSUE = { number: 5618, title: ARTICLE_SYNC_ISSUE_TITLE };
const WORKFLOW = new URL('../../.github/workflows/sync-articles-sitemaps.yml', import.meta.url);

describe('article publisher replay guard', () => {
  it('selects only the exact open sync issue', () => {
    expect(findSyncIssue([ISSUE])).toEqual(ISSUE);
    expect(findSyncIssue([{ number: 9, title: 'other' }])).toBeNull();
    expect(findSyncIssue([ISSUE, { number: 10, title: ARTICLE_SYNC_ISSUE_TITLE }])).toBeNull();
  });

  it('does not suppress recovery for malformed or future marker timestamps', () => {
    expect(findRecentReplayMarker([
      { body: REPLAY_MARKER, createdAt: 'not-a-date' },
      { body: REPLAY_MARKER, createdAt: '2026-10-06T22:01:00.000Z' },
    ], { now: NOW })).toBeNull();
  });

  it('recognises only markers inside the 36-hour cooldown', () => {
    const recent = {
      body: REPLAY_MARKER,
      createdAt: '2026-10-06T10:00:00.000Z',
    };
    expect(findRecentReplayMarker([recent], { now: NOW })?.comment).toBe(recent);
    expect(findRecentReplayMarker([
      { body: REPLAY_MARKER, createdAt: '2026-10-04T09:00:00.000Z' },
    ], { now: NOW })).toBeNull();
  });

  it('requires a workflow_dispatch trigger before dispatching the publisher', () => {
    expect(hasWorkflowDispatch('name: x\non:\n  workflow_dispatch: {}\n')).toBe(true);
    expect(hasWorkflowDispatch('name: x\non: workflow_dispatch\n')).toBe(true);
    expect(hasWorkflowDispatch('name: x\non: [workflow_dispatch]\n')).toBe(true);
    expect(hasWorkflowDispatch('name: x\non:\n  push:\n    branches: [main]\n')).toBe(false);
    expect(hasWorkflowDispatch('not: [yaml')).toBe(false);
  });

  it('claims the cooldown before dispatching after the issue threshold', () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const runGh = (args: string[], options: Record<string, unknown>) => {
      calls.push({ args, options });
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([ISSUE]);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] });
      if (args[0] === 'workflow' && args[1] === 'view') {
        return 'name: Publish article data API\non:\n  workflow_dispatch: {}\n';
      }
      return '';
    };

    const result = requestPublisherReplay({
      now: NOW,
      runGh,
      env: {
        GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
        GH_TOKEN: 'site-token',
        PUBLISHER_GH_TOKEN: 'publisher-token',
        RUN_URL: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/1',
        GATE_REASON: 'published API is behind',
      },
    });

    expect(result).toEqual({ requested: true, issueNumber: 5618 });
    const dispatch = calls.find(({ args }) => args[0] === 'workflow' && args[1] === 'run');
    expect(dispatch?.args).toEqual([
      'workflow', 'run', PUBLISHER_WORKFLOW,
      '--repo', PUBLISHER_REPOSITORY,
      '--ref', 'main',
    ]);
    expect(dispatch?.options.token).toBe('publisher-token');
    const comment = calls.find(({ args }) => args[0] === 'issue' && args[1] === 'comment');
    expect(comment?.args).toContain('--body-file');
    expect(comment?.options.input).toContain(REPLAY_MARKER);
    expect(comment?.options.input).toContain('published API is behind');
    expect(calls.indexOf(comment!)).toBeLessThan(calls.indexOf(dispatch!));
  });

  it('keeps the durable cooldown when the dispatch response is lost', () => {
    const comments: Array<{ body: string; createdAt: string }> = [];
    let dispatches = 0;
    const runGh = (args: string[], options: Record<string, unknown>) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([ISSUE]);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
      if (args[0] === 'workflow' && args[1] === 'view') {
        return 'name: Publish article data API\non:\n  workflow_dispatch: {}\n';
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        comments.push({ body: String(options.input), createdAt: new Date(NOW).toISOString() });
        return '';
      }
      if (args[0] === 'workflow' && args[1] === 'run') {
        dispatches += 1;
        throw new Error('workflow accepted, response lost');
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const env = {
      GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
      GH_TOKEN: 'site-token',
      PUBLISHER_GH_TOKEN: 'publisher-token',
    };

    expect(() => requestPublisherReplay({ now: NOW, runGh, env })).toThrow('response lost');
    expect(dispatches).toBe(1);
    expect(requestPublisherReplay({ now: NOW + 1, runGh, env })).toMatchObject({
      requested: false,
      reason: 'cooldown',
      issueNumber: 5618,
    });
    expect(dispatches).toBe(1);
  });

  it('does not dispatch while the replay cooldown is active', () => {
    const calls: string[][] = [];
    const runGh = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([ISSUE]);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ comments: [{ body: REPLAY_MARKER, createdAt: '2026-10-06T10:00:00.000Z' }] });
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };

    expect(requestPublisherReplay({
      now: NOW,
      runGh,
      env: {
        GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
        GH_TOKEN: 'site-token',
        PUBLISHER_GH_TOKEN: 'publisher-token',
      },
    })).toMatchObject({ requested: false, reason: 'cooldown', issueNumber: 5618 });
    expect(calls.some((args) => args[0] === 'workflow')).toBe(false);
  });

  it('wires the replay after escalation without changing the sync gate', () => {
    const raw = readFileSync(WORKFLOW, 'utf8');
    const document = parseYaml(raw) as {
      jobs: { sync: { steps: Array<{ name?: string; if?: string; run?: string }> } };
    };
    const recovery = document.jobs.sync.steps.find((step) =>
      step.name?.includes('Request bounded publisher recovery after persistent skip'));
    expect(recovery?.if).toContain("steps.gate.outputs.skipped == 'true'");
    expect(recovery?.if).toContain("github.event_name != 'workflow_dispatch'");
    expect(recovery?.run).toContain('request-article-publisher-replay.mjs');
    expect(recovery?.run).toContain('GITHUB_PAT_NANAKO');
    expect(raw).toContain('continue-on-error: true');
  });
});
