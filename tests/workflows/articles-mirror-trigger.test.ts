import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The corpus mirror must have a trigger that actually fires (issue #4974).
 *
 * `mirror-articles-corpus.yml` shipped with `on: push` filtered to
 * `packages/articles/**`, which reads like the obvious trigger and never fires
 * for the commits that matter. Every workflow that writes the corpus pushes
 * with the default `GITHUB_TOKEN`, and GitHub's anti-recursion rule means a
 * `GITHUB_TOKEN` push does not trigger another workflow — the same constraint
 * `generate-article.yml` already works around for deploy and fast-publish, and
 * the same one documented in AGENTS.md for the triage→fix label handoff.
 *
 * The failure is silent and total: the mirror simply never runs, the articles
 * repo stays frozen at the snapshot it was extracted at, and everything it
 * publishes from that corpus — sitemaps, the ten RSS feeds, the news-ticker
 * payload — quietly ages out while every workflow involved still reports
 * success. It had already happened: corpus commits landed on main after the
 * first mirror and none of them reached the articles repo.
 *
 * So the mirror needs a trigger that does not depend on the push event, and the
 * article generator needs to dispatch it explicitly so a new article does not
 * wait for the next scheduled slot.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WF = (name: string) =>
  fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf-8');

describe('article corpus mirror has a trigger that fires (#4974)', () => {
  it('mirror-articles-corpus.yml is scheduled, not only push-triggered', () => {
    const src = WF('mirror-articles-corpus.yml');

    // The `on:` block, up to the next top-level key.
    const onBlock = src.match(/^on:\n(?:[ \t].*\n|\n)*/m)?.[0] ?? '';
    expect(onBlock, 'no `on:` block found').not.toBe('');

    expect(
      /^\s+schedule:/m.test(onBlock),
      'mirror-articles-corpus.yml must keep a `schedule:` trigger — the `push` ' +
        'trigger never fires, because corpus commits are pushed with GITHUB_TOKEN ' +
        'and GitHub does not trigger workflows from those pushes. Without it the ' +
        'mirror only runs when a human dispatches it, and the published article ' +
        'API silently freezes.',
    ).toBe(true);

    expect(/^\s+- cron:/m.test(onBlock), 'schedule: present but carries no cron entry').toBe(true);
  });

  it('generate-article.yml dispatches the mirror after committing the corpus', () => {
    const src = WF('generate-article.yml');

    expect(
      src.includes('mirror-articles-corpus.yml'),
      'generate-article.yml must dispatch mirror-articles-corpus.yml after its ' +
        'commit — its own push cannot trigger it (GITHUB_TOKEN anti-recursion), ' +
        'so without this a new article waits for the next scheduled mirror before ' +
        'it can reach the sitemaps, feeds and ticker the articles repo publishes.',
    ).toBe(true);

    // Dispatched through the shared engine, like the deploy and fast-publish
    // triggers — not a hand-rolled curl loop (AGENTS.md #6).
    const step = src.slice(src.indexOf('mirror-articles-corpus.yml') - 800);
    expect(step).toContain('scripts/lib/trigger-workflow.sh');
  });
});
