import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildComuneEvergreenTopics } from '../scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from '../data/municipalities';

const PUBLISHED = path.resolve(__dirname, '../public/evergreen-comune-topics.json');

/**
 * public/evergreen-comune-topics.json is precomputed and committed so the
 * article generator can stop importing site data (#4974 item 3). A committed
 * derivative goes stale the moment its source changes, and a stale one here is
 * invisible: the generator keeps producing topics, just the wrong ones, for
 * comuni that may no longer exist.
 */
describe('published evergreen comune topics', () => {
  it('matches what the municipality dataset produces now', () => {
    const published = JSON.parse(fs.readFileSync(PUBLISHED, 'utf-8'));
    const computed = buildComuneEvergreenTopics(MUNICIPALITIES as never);

    expect(published.topics).toEqual(computed);
    expect(published.count).toBe(computed.length);
  });

  it('carries a real pool, not a collapsed one', () => {
    const published = JSON.parse(fs.readFileSync(PUBLISHED, 'utf-8'));

    // The reader treats anything under its floor as unusable and recomputes; a
    // file that trips its own floor would be silently ignored in production.
    // Keep in step with readPublishedComuneTopics() in
    // scripts/lib/evergreen-topic-generator.mjs and with the writer's refusal
    // in scripts/build-evergreen-comune-topics.mjs — all three were 50, which
    // covered 59% of the old 85-topic file and only 11% of today's 437.
    expect(published.topics.length).toBeGreaterThanOrEqual(300);
    for (const t of published.topics) {
      expect(typeof t.keyword).toBe('string');
      expect(t.keyword.length).toBeGreaterThan(0);
    }
  });

  it('is preferred over recomputation when present', () => {
    // Called with no argument, the builder must return the published list —
    // that is the whole point of publishing it. Passing data explicitly must
    // still compute, so tests can exercise a specific dataset.
    const fromFile = buildComuneEvergreenTopics();
    const published = JSON.parse(fs.readFileSync(PUBLISHED, 'utf-8'));

    expect(fromFile).toEqual(published.topics);
  });
});
