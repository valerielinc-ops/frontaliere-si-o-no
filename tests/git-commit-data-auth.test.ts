// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GIT_COMMIT_DATA = readFileSync(resolve(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf-8');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

// Consolidation (2026-07): these 3 crawlers no longer have their own
// `.github/workflows/update-jobs-{slug}.yml` — they were folded into grouped
// `crawler-group-*.yml` workflows as `background: true` steps (see
// scripts/generate-crawler-group-workflows.mjs). Each crawler's entire
// original step sequence (including its own env values) is inlined verbatim
// as shell `export KEY="value"` lines inside that step's `run:` body. Rather
// than hardcode which group each crawler currently lands in (bin-packing can
// reassign groups whenever the generator re-runs), locate the crawler's own
// background step by its stable `name: Run <slug>` marker in whichever
// group file currently contains it.
const DEDICATED_CRAWLER_SLUGS = ['spital-lachen', 'hopital-de-lavaux', 'hoch-health'] as const;

function findCrawlerBlock(slug: string): string {
  const groupFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /^crawler-group-\d+\.yml$/.test(f));
  for (const file of groupFiles) {
    const content = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8');
    const stepStart = content.indexOf(`- name: Run ${slug}\n`);
    if (stepStart === -1) continue;
    // The next background step (or the final `wait-all` step) starts the
    // next `- name:` at the same indentation — slice up to there, or to EOF.
    const nextStepIdx = content.indexOf('\n      - name:', stepStart + 1);
    return content.slice(stepStart, nextStepIdx === -1 ? undefined : nextStepIdx);
  }
  throw new Error(`Crawler '${slug}' not found as a background step in any crawler-group-*.yml`);
}

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

describe('dedicated crawlers using git-commit-data.sh (now inlined in crawler-group-*.yml)', () => {
  it('pass github.token explicitly for the commit-and-push phase of affected crawlers', () => {
    for (const slug of DEDICATED_CRAWLER_SLUGS) {
      const block = findCrawlerBlock(slug);
      // Verbatim per-crawler shell body: `export GH_TOKEN="${{ github.token }}"`
      // set right before the `flock ... git-commit-data.sh` invocation in the
      // "Commit and push" phase (see buildCrawlerShellBody in
      // scripts/generate-crawler-group-workflows.mjs).
      expect(block, `crawler '${slug}' missing GH_TOKEN=github.token before commit-and-push`).toMatch(
        /Commit and push[\s\S]*?export GH_TOKEN="\$\{\{ github\.token \}\}"[\s\S]*?git-commit-data\.sh/,
      );
    }
  });
});
