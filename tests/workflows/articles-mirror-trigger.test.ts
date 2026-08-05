import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The corpus mirror must NOT be able to fire on its own (issue #4974 item 3).
 *
 * This file used to assert the opposite, and was right at the time: while this
 * repo was the only writer and the articles repo a read-only copy, the mirror
 * needed a `schedule:`, because a `GITHUB_TOKEN` push never triggers another
 * workflow — so `on: push` silently never fired and the published API froze at
 * the extraction snapshot.
 *
 * The cutover reversed the direction. nanako GENERATES articles now, and
 * `scripts/pull-articles-corpus.mjs` (run by sync-articles-sitemaps.yml) pulls
 * its `content/` back into `packages/articles/content/`. The mirror still does
 * `rm -rf content && cp -R packages/articles/content`, so anything that fires
 * it now DELETES every article generated in nanako since the last pull — and
 * reports success while doing it. `mirror-articles-corpus.yml` disabled its
 * `push` and `schedule` triggers for exactly that reason.
 *
 * The dispatch in `generate-article.yml` outlived that change: it was the one
 * remaining path that could still fire the mirror, and nothing tested for it.
 * This file was still asserting the pre-cutover invariant, so it failed on
 * `main` for days and its failure read as noise.
 *
 * Hence the inversion. `workflow_dispatch` stays — a human may still need it,
 * e.g. to seed a fresh corpus — but nothing may fire it automatically.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WF = (name: string) =>
  fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf-8');

/** The `on:` block, up to the next top-level key. */
function onBlock(src: string): string {
  return src.match(/^on:\n(?:[ \t].*\n|\n)*/m)?.[0] ?? '';
}

/** The disabled triggers are kept as comments on purpose — ignore those. */
function withoutComments(text: string): string {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('the corpus mirror cannot fire on its own (#4974 item 3)', () => {
  it('mirror-articles-corpus.yml is dispatch-only', () => {
    const block = onBlock(WF('mirror-articles-corpus.yml'));
    expect(block, 'no `on:` block found').not.toBe('');

    const live = withoutComments(block);
    expect(
      /^\s+workflow_dispatch:/m.test(live),
      'workflow_dispatch must stay — the mirror is still how a corpus gets seeded by hand',
    ).toBe(true);

    for (const trigger of ['push', 'schedule'] as const) {
      expect(
        new RegExp(`^\\s+${trigger}:`, 'm').test(live),
        `mirror-articles-corpus.yml must NOT be ${trigger}-triggered: it does ` +
          '`rm -rf content && cp -R packages/articles/content`, so an automatic run ' +
          'deletes every article generated in nanako since the last pull and reports ' +
          'success. Direction reversed at cutover — nanako writes, this repo pulls ' +
          '(scripts/pull-articles-corpus.mjs).',
      ).toBe(false);
    }
  });

  it('no workflow dispatches the mirror', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      if (file === 'mirror-articles-corpus.yml') continue;
      const live = withoutComments(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (live.includes('mirror-articles-corpus.yml')) offenders.push(file);
    }

    expect(
      offenders,
      `these workflows still dispatch the mirror: ${offenders.join(', ')}. Each ` +
        'dispatch is a path to deleting nanako-generated articles — the mirror ' +
        'replaces its content/ wholesale from this repo.',
    ).toEqual([]);
  });
});
