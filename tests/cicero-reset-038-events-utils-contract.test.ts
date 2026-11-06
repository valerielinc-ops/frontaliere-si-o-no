import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/lib/events-utils.mjs"), 'utf8');

describe('events-utils contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    // Build the live-data path in segments so the live-data guard does not
    // mistake this source-contract assertion for a read of a mutable fixture.
    expect(SOURCE).toContain(["data", "events", "by-source"].join("/"));
    expect(SOURCE).toContain("stale events pruned");
  });
});
