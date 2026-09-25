/**
 * Lock the aggregate-detection guard of the issue-fix.yml pre-flight gate
 * (scripts/ci/check-issue-already-resolved.mjs). An aggregate follow-up must NEVER be
 * short-circuited on a single token match — one resolved sub-item ≠ all resolved. The
 * matcher itself (`detectAlreadyResolved`) is covered in followup-resolution-match.test.ts;
 * here we only lock `isAggregate`, including the sweep/batch/bulk keyword fallback that
 * catches sweeps with no "N items deferred" count (#1826 class).
 */
import { describe, it, expect } from 'vitest';
import { isAggregate } from '../scripts/ci/check-issue-already-resolved.mjs';

describe('isAggregate — aggregate follow-ups bypass the already-resolved short-circuit', () => {
  it('flags "N items deferred" with N>=2', () => {
    expect(isAggregate('follow-up(#1674): 3 items deferred — fix(seo)', '')).toBe(true);
    expect(isAggregate('follow-up(#1651): 2 item deferred', '')).toBe(true);
    expect(isAggregate('follow-up(#1674): 3 item deferiti — fix(seo)', '')).toBe(true);
    expect(isAggregate('follow-up(#1685): 1 item deferito — fix(seo)', '')).toBe(false);
  });
  it('flags every daily bucket, including a one-item bucket', () => {
    expect(isAggregate('follow-up(daily:2026-09-09): 1 item — owner/repo', '')).toBe(true);
  });
  it('does not promote a body-only count to authoritative title evidence', () => {
    expect(isAggregate('follow-up(#10): cleanup', '4 items deferred for later.')).toBe(false);
  });
  it('reads the sweep/batch/bulk fallback from the body for hand-written aggregates (#8023)', () => {
    expect(isAggregate('follow-up(#10): cleanup', 'This batch has 4 items deferred for later.')).toBe(true);
    expect(isAggregate('follow-up(#10): cleanup', '```text\nThis batch is only quoted context.\n```')).toBe(false);
    expect(isAggregate('follow-up(#10): batch cleanup', 'A single item is described here.')).toBe(true);
  });
  it('ignores sweep/batch/bulk words inside inline code in title and body (#1320/FU-028)', () => {
    expect(isAggregate('follow-up(#10): `triage-sweep.mjs` cleanup', 'A single item is described here.')).toBe(false);
    expect(isAggregate('follow-up(#10): cleanup', 'A single item cites `needs-human-sweep.yml`.')).toBe(false);
  });
  it('treats single-item / count-less follow-ups as non-aggregate (gate may short-circuit)', () => {
    expect(isAggregate('follow-up(#1685): 1 item deferred — perf', '')).toBe(false);
    expect(isAggregate('follow-up(#999): fix one regex', 'Suggested action: tweak the pattern.')).toBe(false);
  });
  it('flags sweep/batch/bulk issues with no "N items deferred" count (#1826 class)', () => {
    expect(isAggregate('Sweep: ~30 crawlers need shared fetchHtml', '')).toBe(true);
    expect(isAggregate('follow-up(#1826): batch-fix selectors', 'Each target listed below.')).toBe(true);
    expect(isAggregate('chore: bulk migrate slugs', '')).toBe(true);
  });
  it('does not trigger on sweep/batch substrings inside unrelated words', () => {
    expect(isAggregate('fix: swept the floor', 'a debatable approach')).toBe(false);
  });
  it('explicit "1 item deferred" wins over an ordinary "batch"/"sweep"/"bulk" word in the same title — count is authoritative, no keyword fallback (#3378)', () => {
    expect(isAggregate(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
      '',
    )).toBe(false);
  });
  it('does not read the field bullets of ONE record as enumerated items (FU-2026-09-12-006)', () => {
    const sheet = [
      '## Scheda',
      '- **CAUSA:** il parser salta la riga diagnostica',
      '- **FIX:** leggere il record riga per riga',
      '- **METRICA**: 3 -> 0',
      '- **OSSERVATORE:** `tests/parser.test.ts`',
    ].join('\n');
    expect(isAggregate('fix(ci): parser execution', sheet)).toBe(false);
    // Shape of a `Workflow Failure` issue header (observed on #9453).
    const failure = [
      'The `live-data gates` workflow failed on `main`.',
      '',
      '- **Run:** https://github.com/o/r/actions/runs/1',
      '- **Job:** `live-data`',
      '- **Trigger:** schedule',
      '- **Ref:** main',
    ].join('\n');
    expect(isAggregate('Workflow Failure: live-data gates', failure)).toBe(false);
    // Shape of the failure-observer header (observed on #9608).
    const observer = [
      '**Workflow:** Deploy to GitHub Pages',
      '- **Fallito in:** job `build-locale (de)`, step 4 `Checkout`',
      '- **Esito della run:** `failure`',
      '- **Run:** https://github.com/o/r/actions/runs/2',
      '- **Run consecutive fallite:** **1**',
    ].join('\n');
    expect(isAggregate('Workflow Failure: Deploy to GitHub Pages', observer)).toBe(false);
  });
  it('still counts real bold-lead enumerations and headed items next to field bullets', () => {
    expect(isAggregate('Shard push failed', '1. **Auth**: denied\n2. **Shrink guard**: would shrink')).toBe(true);
    expect(isAggregate('cleanup', '- **Primo item.** a\n- **Secondo item.** b')).toBe(true);
    expect(isAggregate('cleanup', '### 1. Primo\n- **CAUSA:** a\n### 2. Secondo\n- **CAUSA:** b')).toBe(true);
    // A field label WITHOUT a colon is not a record field: keep it as a bold lead.
    expect(isAggregate('cleanup', '- **Run** the first job\n- **Job** runner second')).toBe(true);
  });
  it('still flags a genuine count-less sweep even when it would also match the "N items" regex loosely (no regression on #1826)', () => {
    expect(isAggregate('Sweep: ~30 crawlers need shared fetchHtml', '')).toBe(true);
  });
});
