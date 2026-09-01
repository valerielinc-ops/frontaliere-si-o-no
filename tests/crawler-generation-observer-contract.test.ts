import { describe, expect, it } from 'vitest';
import {
  GROUP_IDS,
  createCrawlerGenerationSentinel,
  crawlerGenerationSentinelWorkflowIdentity,
  deriveCrawlerGenerationSourceCommit,
  parseCrawlerGenerationRunName,
  resolveCrawlerGenerationSentinels,
  validateCrawlerGenerationSentinel,
} from '../scripts/lib/crawler-generation-contract.mjs';

const SITE_CODE_COMMIT = 'a'.repeat(40);
const CORPUS_CODE_COMMIT = 'b'.repeat(40);

function runIds(offset = 10_000) {
  return Object.fromEntries(GROUP_IDS.map((group, index) => [group, String(offset + index)]));
}

function sentinel(offset = 10_000) {
  return createCrawlerGenerationSentinel({
    generationToken: '9001-2',
    siteCodeCommit: SITE_CODE_COMMIT,
    corpusCodeCommit: CORPUS_CODE_COMMIT,
    groupRunIds: runIds(offset),
  });
}

function manifests(commits: Record<string, string>) {
  return Object.fromEntries(GROUP_IDS.map((group) => [group, {
    group,
    remote: { commit: commits[group] },
  }]));
}

describe('crawler generation sentinel contract', () => {
  it('parses only the complete generation run-name grammar and exports sentinel identity', () => {
    expect(parseCrawlerGenerationRunName('crawler-generation-9001-2-group-01')).toEqual({
      generationToken: '9001-2', group: '01',
    });
    expect(parseCrawlerGenerationRunName('crawler-generation--group-01')).toBeNull();
    expect(parseCrawlerGenerationRunName('crawler-generation-9001-2-group-24')).toBeNull();
    expect(parseCrawlerGenerationRunName('crawler-generation-09001-2-group-01')).toBeNull();
    expect(crawlerGenerationSentinelWorkflowIdentity('9001-2', '777', CORPUS_CODE_COMMIT)).toMatchObject({
      workflowFile: 'crawler-generation-observer-shadow.yml',
      workflowName: 'Crawler Generation Observer (shadow)',
      runId: '777',
      runName: 'crawler-generation-sentinel-9001-2',
      corpusCodeCommit: CORPUS_CODE_COMMIT,
    });
  });

  it('binds the immutable site code pin to exactly 23 canonical workflow/run/artifact identities', () => {
    const value = sentinel();
    expect(validateCrawlerGenerationSentinel(value)).toEqual({ valid: true, errors: [] });
    expect(Object.keys(value.groups).sort()).toEqual(GROUP_IDS);
    for (const group of GROUP_IDS) {
      const entry = value.groups[group];
      expect(entry).toEqual({
        workflowFile: `crawler-group-${group}.yml`,
        workflowName: `Crawler Group ${group} (sparse cross-repo execution)`,
        runId: runIds()[group],
        runName: `crawler-generation-9001-2-group-${group}`,
        generationToken: '9001-2',
        artifactName: `crawler-group-${group}-terminal-${runIds()[group]}`,
        corpusCodeCommit: CORPUS_CODE_COMMIT,
      });
    }
    expect(value).not.toHaveProperty('sourceCommit');
    expect(value.dispatchDiagnostics['01']).toEqual({ status: 'direct', runId: runIds()['01'] });
    expect(value.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts byte-equivalent replay and fails closed on two divergent sentinels for one generation', () => {
    const first = sentinel();
    const replay = structuredClone(first);
    expect(resolveCrawlerGenerationSentinels([first, replay])).toMatchObject({
      status: 'accepted',
      replayCount: 2,
      sentinel: first,
    });

    const conflicting = sentinel(20_000);
    expect(resolveCrawlerGenerationSentinels([first, conflicting])).toEqual({
      status: 'blocked',
      reason: 'sentinel_conflict',
      sentinel: null,
      replayCount: 2,
    });
  });

  it('rejects missing, malformed, duplicate and non-canonical run bindings', () => {
    expect(resolveCrawlerGenerationSentinels([])).toEqual({
      status: 'blocked', reason: 'sentinel_missing', sentinel: null, replayCount: 0,
    });
    const malformed = structuredClone(sentinel());
    malformed.groups['02'].runId = malformed.groups['01'].runId;
    expect(validateCrawlerGenerationSentinel(malformed).valid).toBe(false);
    expect(resolveCrawlerGenerationSentinels([malformed])).toMatchObject({
      status: 'blocked', reason: 'sentinel_invalid', sentinel: null,
    });
  });

  it('keeps all 23 identities when up to two dispatches are missing', () => {
    const missing = runIds();
    missing['07'] = null as any;
    missing['19'] = null as any;
    const value = createCrawlerGenerationSentinel({
      generationToken: '9001-2', siteCodeCommit: SITE_CODE_COMMIT, corpusCodeCommit: CORPUS_CODE_COMMIT, groupRunIds: missing,
    });
    expect(validateCrawlerGenerationSentinel(value)).toEqual({ valid: true, errors: [] });
    expect(value.groups['07']).toMatchObject({ runId: null, artifactName: null });
    expect(value.groups['19']).toMatchObject({ runId: null, artifactName: null });
    expect(value.dispatchDiagnostics['07']).toEqual({ status: 'missing', runId: null });
  });

  it('retains a rejected reconciliation candidate as diagnostic evidence without binding it', () => {
    const ids = runIds();
    ids['07'] = null as any;
    const diagnostics = Object.fromEntries(GROUP_IDS.map((group) => [group, {
      status: ids[group] === null ? 'missing' : 'direct',
      runId: ids[group],
    }]));
    diagnostics['07'] = { status: 'reconciled_protocol_mismatch', runId: '77777' };
    const value = createCrawlerGenerationSentinel({
      generationToken: '9001-2',
      siteCodeCommit: SITE_CODE_COMMIT,
      corpusCodeCommit: CORPUS_CODE_COMMIT,
      groupRunIds: ids,
      dispatchDiagnostics: diagnostics,
    });
    expect(validateCrawlerGenerationSentinel(value)).toEqual({ valid: true, errors: [] });
    expect(value.groups['07'].runId).toBeNull();
    expect(value.dispatchDiagnostics['07']).toEqual({
      status: 'reconciled_protocol_mismatch', runId: '77777',
    });
  });
});

describe('terminal source commit derivation', () => {
  it('selects the unique manifest tip that descends from every other group tip', () => {
    const early = '1'.repeat(40);
    const middle = '2'.repeat(40);
    const latest = '3'.repeat(40);
    const commits = Object.fromEntries(GROUP_IDS.map((group, index) => [
      group,
      index < 8 ? early : index < 16 ? middle : latest,
    ]));
    const ancestry = new Set([
      `${early}:${early}`, `${middle}:${middle}`, `${latest}:${latest}`,
      `${early}:${middle}`, `${early}:${latest}`, `${middle}:${latest}`,
      `${SITE_CODE_COMMIT}:${early}`, `${SITE_CODE_COMMIT}:${middle}`, `${SITE_CODE_COMMIT}:${latest}`,
    ]);
    expect(deriveCrawlerGenerationSourceCommit({
      manifests: manifests(commits),
      siteCodeCommit: SITE_CODE_COMMIT,
      isAncestor: (ancestor: string, descendant: string) => ancestry.has(`${ancestor}:${descendant}`),
    })).toEqual({ status: 'ready', sourceCommit: latest, reason: null });
  });

  it('bounds ancestry checks linearly for 23 distinct terminal tips', () => {
    const ordered = GROUP_IDS.map((_, index) => (index + 1).toString(16).padStart(40, '0'));
    const rank = new Map(ordered.map((commit, index) => [commit, index]));
    let calls = 0;
    const result = deriveCrawlerGenerationSourceCommit({
      manifests: manifests(Object.fromEntries(GROUP_IDS.map((group, index) => [group, ordered[index]]))),
      siteCodeCommit: SITE_CODE_COMMIT,
      isAncestor: (ancestor: string, descendant: string) => {
        calls += 1;
        if (ancestor === SITE_CODE_COMMIT) return true;
        return rank.get(ancestor)! <= rank.get(descendant)!;
      },
    });
    expect(result).toEqual({ status: 'ready', sourceCommit: ordered.at(-1), reason: null });
    expect(calls).toBeLessThanOrEqual((GROUP_IDS.length - 1) * 2 + 1);
  });

  it('fails closed on incomparable terminal tips or a history rewrite before the site code pin', () => {
    const left = '4'.repeat(40);
    const right = '5'.repeat(40);
    const commits = Object.fromEntries(GROUP_IDS.map((group, index) => [group, index === 22 ? right : left]));
    const sameOnly = (ancestor: string, descendant: string) => ancestor === descendant;
    expect(deriveCrawlerGenerationSourceCommit({
      manifests: manifests(commits), siteCodeCommit: SITE_CODE_COMMIT, isAncestor: sameOnly,
    })).toEqual({ status: 'blocked', sourceCommit: null, reason: 'source_history_incomparable' });

    const oneTip = manifests(Object.fromEntries(GROUP_IDS.map((group) => [group, left])));
    expect(deriveCrawlerGenerationSourceCommit({
      manifests: oneTip, siteCodeCommit: SITE_CODE_COMMIT, isAncestor: sameOnly,
    })).toEqual({ status: 'blocked', sourceCommit: null, reason: 'source_history_rewritten' });
  });

  it('distinguishes invalid terminal data from an ancestry oracle infrastructure failure', () => {
    const value = manifests(Object.fromEntries(GROUP_IDS.map((group) => [group, '6'.repeat(40)])));
    delete value['23'];
    expect(deriveCrawlerGenerationSourceCommit({
      manifests: value, siteCodeCommit: SITE_CODE_COMMIT, isAncestor: () => true,
    })).toEqual({ status: 'blocked', sourceCommit: null, reason: 'terminal_manifest_set_invalid' });

    expect(deriveCrawlerGenerationSourceCommit({
      manifests: manifests(Object.fromEntries(GROUP_IDS.map((group) => [group, '6'.repeat(40)]))),
      siteCodeCommit: SITE_CODE_COMMIT,
      isAncestor: () => { throw new Error('git unavailable'); },
    })).toEqual({ status: 'infrastructure_error', sourceCommit: null, reason: 'source_history_check_failed' });
  });
});
