/**
 * gsc-keyword-title-fallback.test.ts
 *
 * Item 3 of issue #1095. The Italian GSC-keyword landing in
 * build-plugins/jobsSeoPagesPlugin.ts builds its <title> as:
 *
 *   curated = buildTitleWithBrand(itCopy.title without brand)
 *   if norm(curated) !== norm(itCopy.heading) → use curated
 *   else → fall back to buildRoleHubTitle({ count, year, … })
 *
 * The PR #1085 claim is "title can never equal h1 for any future data". This
 * test asserts the fallback actually fires AND produces a title structurally
 * distinct from the heading when a long `itCopy.title` collapses to the bare
 * heading (brand dropped at the 66-char cap → title === h1 → would trip the
 * 0-tolerance audit:h1-title-duplicates ratchet).
 *
 * It also guards the orphan-`**` nuke (`/\*{2,}/g` in stripLiteralMarkdown):
 * a legitimate corpus title with no markdown survives byte-identical, so the
 * nuke can't silently mangle real titles.
 *
 * These helpers are pure and exported; the test mirrors the plugin's exact
 * fallback expression rather than crawling dist (so it gates pre-build).
 */
import { describe, expect, it } from 'vitest';
import { buildRoleHubTitle } from '../../services/seo/job-board-titles';
import { buildTitleWithBrand } from '../../build-plugins/shared/titleSuffix';
import { stripLiteralMarkdown } from '../../build-plugins/shared/stripLiteralMarkdown';

const norm = (s: string) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Exact replica of the IT GSC-keyword title expression (jobsSeoPagesPlugin). */
function buildItKwTitle(itCopy: { title: string; heading: string }, kwQueryDisplay: string, count: number, year: number): string {
  const curated = buildTitleWithBrand(String(itCopy.title || '').replace(/\s*\|\s*Frontaliere Ticino\s*$/i, ''));
  if (norm(curated) !== norm(String(itCopy.heading || ''))) return curated;
  return buildRoleHubTitle({ locale: 'it', roleDisplay: kwQueryDisplay || 'Jobs', count, year });
}

describe('IT GSC-keyword <title> fallback (#1095 item 3)', () => {
  it('long itCopy.title that collapses to the bare heading → fallback ≠ heading', () => {
    // A heading just over the brand-drop boundary: heading + " | Frontaliere
    // Ticino" (21 chars) exceeds the 66-char cap, so buildTitleWithBrand drops
    // the brand and `curated` becomes byte-identical to the heading.
    const heading = 'Lavoro infermiere a domicilio Lugano Mendrisio Chiasso turni';
    expect(heading.length + ' | Frontaliere Ticino'.length).toBeGreaterThan(66);
    const itCopy = { title: heading, heading };

    // Sanity: the curated path WOULD collide (this is the case the fallback exists for).
    const curated = buildTitleWithBrand(heading);
    expect(norm(curated)).toBe(norm(heading));

    const title = buildItKwTitle(itCopy, 'Infermiere', 42, 2026);
    // Fallback fired → role-hub title, structurally distinct from the heading.
    expect(norm(title)).not.toBe(norm(heading));
    // It is the count+year role-hub form.
    expect(title).toContain('2026');
    expect(title).toContain('42');
  });

  it('the role-hub fallback itself is never equal to a degenerate role-hub heading', () => {
    // Even if the heading happens to look like a role-hub phrase, the count+year
    // title carries a distinct numeric/temporal structure → no collision.
    const roleHub = buildRoleHubTitle({ locale: 'it', roleDisplay: 'Infermiere', count: 42, year: 2026 });
    const headingLookalike = 'Infermiere in Ticino';
    expect(norm(roleHub)).not.toBe(norm(headingLookalike));
  });

  it('short itCopy.title keeps its curated brand suffix (no needless fallback)', () => {
    const itCopy = { title: 'Lavoro infermiere Lugano', heading: 'Offerte infermiere a Lugano' };
    const title = buildItKwTitle(itCopy, 'Infermiere', 12, 2026);
    expect(title).toBe('Lavoro infermiere Lugano | Frontaliere Ticino');
    expect(norm(title)).not.toBe(norm(itCopy.heading));
  });
});

describe('stripLiteralMarkdown — no collateral damage to legit titles (#1095 item 3)', () => {
  it('a plain corpus title with no markdown survives byte-identical', () => {
    const legit = 'Lavoro infermiere a Lugano — turni diurni e notturni';
    expect(stripLiteralMarkdown(legit)).toBe(legit);
  });

  it('titles with a single literal `*` (not a 2+ run) are not nuked mid-string', () => {
    // The `/\*{2,}/g` nuke targets only runs of 2+ asterisks. A lone `*` between
    // words is left in place by rule 2 (rules 4/5 only trim leading/trailing).
    const s = 'Lavoro 5 * stelle a Lugano';
    expect(stripLiteralMarkdown(s)).toBe('Lavoro 5 * stelle a Lugano');
  });

  it('orphan `**` runs ARE stripped (the gate this nuke exists for)', () => {
    expect(stripLiteralMarkdown('Requisiti:** svizzera')).toBe('Requisiti: svizzera');
  });
});
