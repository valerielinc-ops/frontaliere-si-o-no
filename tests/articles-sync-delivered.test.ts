import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// @ts-expect-error — the delivery assertion is a dependency-free ESM CI script.
import {
  deliveryVerdict,
  measureResidue,
} from '../scripts/ci/assert-articles-sync-delivered.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/sync-articles-sitemaps.yml');

/**
 * The state of run 35420916144 (2026-09-19T04:18Z), read off its own log:
 *
 *   [pull-articles-corpus] frontaliere: 3903 → 3921 articles (+18 new)
 *   [pull-articles-corpus] svizzera: 2157 → 2194 articles (+37 new)
 *   human-side-effect-gate: DENY (publisher-source-run-unverified)
 *
 * The job reported `success`. rerender-article-hubs run 35423187532 then went
 * red with `37 behind, tolerance 25` — the consumer discovering the producer's
 * silence.
 */
const RUN_35420916144 = {
  pendingBySection: {
    frontaliere: Array.from({ length: 18 }, (_, i) => `fr-new-${i}`),
    svizzera: Array.from({ length: 37 }, (_, i) => `sv-new-${i}`),
  },
  skipReason: 'the side-effect gate withheld write permission (publisher-source-run-unverified)',
};

const registrySrc = (constName: string, ids: string[]) =>
  `export const ${constName} = {\n`
  + ids.map((id) => `  '${id}': { it: '${id}', en: '${id}', de: '${id}', fr: '${id}' },`).join('\n')
  + '\n};\n';

/** A tree with both registries written, so `measureResidue` has two real sides. */
function withTree(
  worktree: { blog: string[]; swiss: string[] },
  committed: { blog: string[]; swiss: string[] },
  run: (residue: Record<string, string[]>) => void,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delivered-test-'));
  try {
    const dir = path.join(tmp, 'packages/articles/content');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'routerSwissData.ts'), registrySrc('SWISS_SLUGS', worktree.swiss));
    fs.writeFileSync(path.join(dir, 'routerBlogData.ts'), registrySrc('BLOG_SLUGS', worktree.blog));
    run(
      measureResidue({
        root: tmp,
        git: (rel: string, dest: string) =>
          fs.writeFileSync(
            dest,
            rel.endsWith('routerSwissData.ts')
              ? registrySrc('SWISS_SLUGS', committed.swiss)
              : registrySrc('BLOG_SLUGS', committed.blog),
          ),
      }),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('assert-articles-sync-delivered', () => {
  it('refuses to call run 35420916144 delivered', () => {
    const verdict = deliveryVerdict(RUN_35420916144);
    expect(verdict.ok).toBe(false);
    // The residue, per section, in articles — the same unit the pull's log and
    // the rerender guard use, so the three numbers are comparable in triage.
    expect(verdict.message).toContain('svizzera +37');
    expect(verdict.message).toContain('frontaliere +18');
    expect(verdict.message).toContain('55 article(s)');
    expect(verdict.message).toContain('publisher-source-run-unverified');
    // Naming ids, not just a count, so triage can grep one of them in the pull log.
    expect(verdict.message).toContain('sv-new-0');
  });

  it('passes a dispatch that genuinely had nothing new to fetch', () => {
    // A no-op dispatch must stay green: this is why the guard keys on the
    // residue and not on whether the commit step ran.
    expect(deliveryVerdict({ pendingBySection: { frontaliere: [], svizzera: [] } }).ok).toBe(true);
  });

  it('names the commit step when no gate reason was recorded', () => {
    // Residue with `skipped=false` means the gate allowed the write and the
    // commit/push path still delivered nothing — a different bug, and the
    // message must not blame the gate for it.
    const verdict = deliveryVerdict({ pendingBySection: { svizzera: ['a'] }, skipReason: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('Commit if changed');
    expect(verdict.message).toContain('git-push-with-retry.sh');
  });

  it('sees a new article that a retirement nets out, and a replacement', () => {
    // The hole review found in the first draft: it subtracted row COUNTS and
    // ignored negatives, so one arrival plus one retirement netted to zero and
    // a replacement netted to zero — both green with the new article absent
    // from `main`. The corpus really does retire articles
    // (`pinRetiredLocaleGroups`, scripts/lib/corpus-removal-guard.mjs), so this
    // is a live path, not a hypothetical one. A set difference cannot net out.
    withTree(
      { blog: ['keep'], swiss: ['keep', 'arrived'] }, // 'retired' gone, 'arrived' new
      { blog: ['keep'], swiss: ['keep', 'retired'] },
      (residue) => {
        expect(residue.svizzera).toEqual(['arrived']);
        expect(residue.frontaliere).toEqual([]);
        expect(deliveryVerdict({ pendingBySection: residue }).ok).toBe(false);
      },
    );
    // Pure replacement: same row count on both sides, different identity.
    withTree(
      { blog: ['x'], swiss: ['new-id'] },
      { blog: ['x'], swiss: ['old-id'] },
      (residue) => {
        expect(residue.svizzera).toEqual(['new-id']);
        expect(deliveryVerdict({ pendingBySection: residue }).ok).toBe(false);
      },
    );
  });

  it('passes a delivered sync whose net was a REMOVAL', () => {
    // A retirement that committed leaves the working tree with fewer ids than
    // HEAD and nothing new. Not a delivery failure.
    withTree({ blog: ['x'], swiss: ['a'] }, { blog: ['x'], swiss: ['a', 'b'] }, (residue) => {
      expect(residue.svizzera).toEqual([]);
      expect(deliveryVerdict({ pendingBySection: residue }).ok).toBe(true);
    });
  });

  it('measures both sides with the same parser', () => {
    // Guards the one way this check could lie: if HEAD and the working tree
    // were parsed differently, the difference would measure the parser.
    withTree({ blog: ['x'], swiss: ['a', 'b'] }, { blog: ['x'], swiss: ['a'] }, (residue) => {
      expect(residue.svizzera).toEqual(['b']);
      expect(residue.frontaliere).toEqual([]);
    });
  });

  it('refuses to measure an absent working-tree registry instead of reading it as delivered', () => {
    // The fail-OPEN hole this guard could have shipped with, caught on its first
    // local run: `readSlugRegistryWithRows` returns an empty registry for a
    // missing file, an empty set has no difference, and "no residue" reads as
    // delivered. A sparse checkout, a renamed const or a moved path would each
    // have produced a permanently green guard measuring nothing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delivered-missing-'));
    try {
      expect(() =>
        measureResidue({
          root: tmp, // no packages/articles/content/ at all
          git: (_rel: string, dest: string) =>
            fs.writeFileSync(dest, registrySrc('SWISS_SLUGS', ['a'])),
        }),
      ).toThrow(/never legitimately empty/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is the LAST step of the sync job and skips only a human-declared preview', () => {
    // A verdict in a middle step is worth nothing: a later step's success does
    // not undo it, but a later step is where a future edit would put a
    // `continue-on-error` and quietly restore the green.
    const doc = YAML.parse(fs.readFileSync(WORKFLOW, 'utf-8'));
    const steps = doc.jobs.sync.steps;
    const last = steps[steps.length - 1];
    expect(last.run).toContain('scripts/ci/assert-articles-sync-delivered.mjs');
    expect(last['continue-on-error']).toBeUndefined();

    // Keyed on the human's STATED intent. Not `github.event_name`, which would
    // excuse an approved `dry_run: false` manual sync, and NOT
    // `effective_dry_run`, which human-side-effect-gate.mjs forces true on a
    // DENIAL — the one case the guard exists for.
    expect(last.if).toBe("github.event.inputs.dry_run != 'true'");
    expect(last.if).not.toContain('event_name');
    expect(last.if).not.toContain('effective_dry_run');
  });
});
