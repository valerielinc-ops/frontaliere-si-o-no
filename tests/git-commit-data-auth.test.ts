// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GIT_COMMIT_DATA = readFileSync(resolve(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf-8');

// These 3 crawlers explicitly pass `github.token` (rather than the corpus-
// standard `secrets.GITHUB_TOKEN`) to their Commit-and-push step's GH_TOKEN.
// Since the 2026-07 consolidation they no longer have their own
// .github/workflows/update-jobs-{slug}.yml — each crawler's own bespoke
// steps (including this auth choice) were preserved verbatim as its
// `background: true` composite step inside whichever crawler-group-NN.yml
// scripts/generate-crawler-group-workflows.mjs's bin-packing placed it in.
// data/crawler-manifest.json is the durable per-crawler source (parsed from
// the original workflows at consolidation time); we assert against it
// directly rather than hard-coding which group file each slug landed in
// (bin-packing group assignment is a duration-based implementation detail,
// not something this auth-hardening test should be coupled to).
const DEDICATED_CRAWLER_SLUGS = ['spital-lachen', 'hopital-de-lavaux', 'hoch-health'] as const;

interface ManifestStep {
  name?: string;
  env?: Record<string, string>;
}
interface ManifestEntry {
  crawlerSlug: string;
  bespokeSteps: ManifestStep[];
}

const CRAWLER_MANIFEST: ManifestEntry[] = JSON.parse(
  readFileSync(resolve(ROOT, 'data/crawler-manifest.json'), 'utf-8'),
);

describe('git-commit-data.sh GitHub auth hardening', () => {
  it('prefers workflow/checkout auth over stale Remote Config GITHUB_PAT values', () => {
    expect(GIT_COMMIT_DATA).toContain('local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
    expect(GIT_COMMIT_DATA).toContain('CHECKOUT_GIT_EXTRAHEADER=');
    expect(GIT_COMMIT_DATA).not.toContain('GITHUB_PAT:-');
    expect(GIT_COMMIT_DATA).toContain('git config --local http.https://github.com/.extraheader');
  });

  it('refreshes git auth before every network operation in the retry loop', () => {
    const networkOps = [...GIT_COMMIT_DATA.matchAll(/^\s*git (fetch|pull|push)\b/gm)];
    expect(networkOps.length).toBeGreaterThan(0);

    for (const match of networkOps) {
      const before = GIT_COMMIT_DATA.slice(Math.max(0, match.index - 160), match.index);
      expect(before, `missing ensure_git_auth before: ${match[0]}`).toMatch(/ensure_git_auth\s*$/m);
    }
  });
});

describe('dedicated crawler workflows using git-commit-data.sh', () => {
  it('pass github.token explicitly to the commit step for affected crawlers', () => {
    for (const slug of DEDICATED_CRAWLER_SLUGS) {
      const entry = CRAWLER_MANIFEST.find((e) => e.crawlerSlug === slug);
      expect(entry, `manifest entry missing for crawler '${slug}'`).toBeDefined();
      const commitStep = entry!.bespokeSteps.find((s) => s.name === 'Commit and push');
      expect(commitStep, `'Commit and push' step missing for crawler '${slug}'`).toBeDefined();
      expect(commitStep!.env?.GH_TOKEN, `GH_TOKEN env missing for crawler '${slug}'`).toBe('${{ github.token }}');
    }
  });
});
