import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Hand-rolled staticOverlay emitters must wrap their `<main class="seo-static-content">`
 * in the shared side-rail gutters.
 *
 * Several build plugins hand-roll their own `<div id="root"></div> … <main
 * class="seo-static-content"> … <div id="footer-root">` body instead of going
 * through buildSimplePage / seoPageShell (which already emits the rails via
 * htmlTemplate.ts). PR #2592 added the rails only to the buildSimplePage path,
 * so each hand-rolled emitter is a SILENT monetisation gap: its pages are
 * `staticOverlay: true` (App.tsx portals <ArticleRailAdStack> into
 * #rail-left-root / #rail-right-root — App.tsx:2673, activeTab-agnostic) but
 * render NO rails when the DOM targets are missing.
 *
 * This source-level gate is deterministic (no build needed) and catches a
 * regression that a path-scoped dist test can't cleanly isolate: the fixed
 * emitters (sector / recency / hub) and the deferred jobsSeoPagesPlugin share
 * the same `/cerca-lavoro-ticino/` URL prefix, so they can only be told apart
 * by emitter, not by path.
 *
 * Invariant: every `<main class="seo-static-content"` in these files must be
 * matched by a rail-gutter opening insertion (`railGridOpen` for the
 * destructured form, or `railGutters(true).open` for the inline form), and the
 * file must import the shared helper.
 *
 * jobsSeoPagesPlugin.ts is intentionally NOT in this strict list: it emits BOTH
 * job-collection/canton landings (staticOverlay=true → wrapped by #2811) AND a
 * job-detail `<main class="seo-static-content static-job-page">` that is
 * staticOverlay=false (App.tsx job-board excluded → portal never fires), so the
 * `opens >= mains` invariant can't hold for it while job-detail stays unwrapped.
 * Its collection mains get their own focused gate below; job-detail rails remain
 * a separate deferred decision (see #2811 `## Non implementato`).
 */
const ROOT = resolve(__dirname, '..', '..');

const HAND_ROLLED_EMITTERS: readonly string[] = [
  'build-plugins/staticPagesPlugin.ts',
  'build-plugins/jobRecencyPagesPlugin.ts',
  'build-plugins/jobSectorPagesPlugin.ts',
  'build-plugins/seoHubsPlugin.ts',
];

describe('hand-rolled staticOverlay emitters wrap seo-static-content in side-rail gutters', () => {
  for (const rel of HAND_ROLLED_EMITTERS) {
    it(`${rel} imports railGutters and wraps every seo-static-content <main>`, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf-8');

      // Count only REAL emitted <main> tags — skip comment lines that merely
      // reference the markup (`// <main class="seo-static-content">`, JSDoc `*`).
      const isComment = (line: string): boolean => {
        const t = line.trimStart();
        return t.startsWith('//') || t.startsWith('*');
      };
      const mains = src
        .split('\n')
        .filter((line) => !isComment(line))
        .filter((line) => line.includes('<main class="seo-static-content')).length;
      expect(mains, `${rel} should emit at least one seo-static-content <main>`).toBeGreaterThan(0);

      expect(src, `${rel} must import the shared railGutters helper`).toContain(
        "from './shared/railGutters'",
      );

      const opens =
        (src.match(/railGutters\(true\)\.open/g) ?? []).length +
        (src.match(/\$\{railGridOpen\}/g) ?? []).length;

      expect(
        opens,
        `${rel}: ${mains} seo-static-content <main> but only ${opens} rail-gutter opening(s). ` +
          `Each staticOverlay <main> must be wrapped so App.tsx can portal the side-rail ads in.`,
      ).toBeGreaterThanOrEqual(mains);
    });
  }
});

/**
 * jobsSeoPagesPlugin emits a mix of staticOverlay states in one file, so it
 * can't use the strict `opens >= mains` gate above. #2811 wraps only its
 * job-collection/canton landings (the `s-xzWvwM` / `s-it71Rt` mains, all
 * staticOverlay=true); the job-detail `static-job-page` main is staticOverlay
 * =false and stays unwrapped on purpose. This gate locks in the collection
 * wrapping without falsely demanding rails on job-detail.
 */
describe('jobsSeoPagesPlugin job-collection/canton landings wrap their <main> in side-rail gutters', () => {
  const rel = 'build-plugins/jobsSeoPagesPlugin.ts';
  const src = readFileSync(resolve(ROOT, rel), 'utf-8');

  const isComment = (line: string): boolean => {
    const t = line.trimStart();
    return t.startsWith('//') || t.startsWith('*');
  };
  const collectionMains = src
    .split('\n')
    .filter((line) => !isComment(line))
    .filter((line) => /<main class="seo-static-content (s-xzWvwM|s-it71Rt)">/.test(line)).length;

  it('imports the shared railGutters helper', () => {
    expect(src).toContain("from './shared/railGutters'");
  });

  it('wraps every job-collection/canton <main> with a rail-gutter opening', () => {
    expect(collectionMains, `${rel} should emit job-collection/canton mains`).toBeGreaterThan(0);
    const opens = (src.match(/railGutters\(true\)\.open/g) ?? []).length;
    expect(
      opens,
      `${rel}: ${collectionMains} job-collection/canton <main> but only ${opens} rail-gutter ` +
        `opening(s). Each staticOverlay collection landing must be wrapped so App.tsx can portal ` +
        `the side-rail ads in.`,
    ).toBeGreaterThanOrEqual(collectionMains);
  });
});
