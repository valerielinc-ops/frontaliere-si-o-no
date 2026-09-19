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
  pendingBySection: { frontaliere: 18, svizzera: 37 },
  skipReason: 'the side-effect gate withheld write permission (publisher-source-run-unverified)',
};

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
  });

  it('passes a dispatch that genuinely had nothing new to fetch', () => {
    // A no-op dispatch must stay green: this is why the guard keys on the
    // residue and not on whether the commit step ran.
    expect(deliveryVerdict({ pendingBySection: { frontaliere: 0, svizzera: 0 } }).ok).toBe(true);
  });

  it('passes a delivered sync even when rows were REMOVED', () => {
    // A retirement that committed leaves the working tree BEHIND HEAD. Negative
    // is not a delivery failure.
    expect(deliveryVerdict({ pendingBySection: { frontaliere: 0, svizzera: -3 } }).ok).toBe(true);
  });

  it('names the commit step when no gate reason was recorded', () => {
    // Residue with `skipped=false` means the gate allowed the write and the
    // commit/push path still delivered nothing — a different bug, and the
    // message must not blame the gate for it.
    const verdict = deliveryVerdict({ pendingBySection: { svizzera: 12 }, skipReason: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('Commit if changed');
    expect(verdict.message).toContain('git-push-with-retry.sh');
  });

  it('measures the residue with the same parser on both sides', () => {
    // Guards the one way this check could lie: if HEAD and the working tree
    // were counted by different parsers, the difference would measure the
    // parser rather than the delivery. Two rows in the tree, one in HEAD.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delivered-test-'));
    try {
      const dir = path.join(tmp, 'packages/articles/content');
      fs.mkdirSync(dir, { recursive: true });
      const row = (id: string) => `  '${id}': { it: '${id}', en: '${id}', de: '${id}', fr: '${id}' },`;
      const registry = (constName: string, ids: string[]) =>
        `export const ${constName} = {\n${ids.map(row).join('\n')}\n};\n`;

      // Only svizzera moves; frontaliere is identical on both sides.
      fs.writeFileSync(path.join(dir, 'routerSwissData.ts'), registry('SWISS_SLUGS', ['a', 'b']));
      fs.writeFileSync(path.join(dir, 'routerBlogData.ts'), registry('BLOG_SLUGS', ['x']));

      const residue = measureResidue({
        root: tmp,
        git: (rel: string, dest: string) =>
          fs.writeFileSync(
            dest,
            rel.endsWith('routerSwissData.ts')
              ? registry('SWISS_SLUGS', ['a'])
              : registry('BLOG_SLUGS', ['x']),
          ),
      });

      expect(residue.svizzera).toBe(1);
      expect(residue.frontaliere).toBe(0);
      expect(deliveryVerdict({ pendingBySection: residue }).ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to measure an absent working-tree registry instead of reading it as delivered', () => {
    // The fail-OPEN hole this guard could have shipped with, caught on its first
    // local run: `readSlugRegistryWithRows` returns 0 rows for a missing file,
    // 0 - 2194 is negative, and a negative residue reads as "delivered". A
    // sparse checkout, a renamed const or a moved path would each have produced
    // a permanently green guard measuring nothing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delivered-missing-'));
    try {
      expect(() =>
        measureResidue({
          root: tmp, // no packages/articles/content/ at all
          git: (_rel: string, dest: string) =>
            fs.writeFileSync(dest, "export const SWISS_SLUGS = {\n  'a': { it: 'a' },\n};\n"),
        }),
      ).toThrow(/never legitimately empty/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is the LAST step of the sync job, so its verdict decides the conclusion', () => {
    // A verdict in a middle step is worth nothing: a later step's success does
    // not undo it, but a later step is where a future edit would put a
    // `continue-on-error` and quietly restore the green.
    const doc = YAML.parse(fs.readFileSync(WORKFLOW, 'utf-8'));
    const steps = doc.jobs.sync.steps;
    const last = steps[steps.length - 1];
    expect(last.run).toContain('scripts/ci/assert-articles-sync-delivered.mjs');
    expect(last['continue-on-error']).toBeUndefined();
    // Previews pull without committing on purpose and must not go red.
    expect(last.if).toBe("github.event_name != 'workflow_dispatch'");
  });
});
