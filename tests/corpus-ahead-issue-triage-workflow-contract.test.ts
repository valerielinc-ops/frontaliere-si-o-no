import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/issue-triage.yml"), 'utf8');

describe("issue-triage-workflow contract", () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Issue triage (deterministic classify + route)");
    expect(SOURCE).toContain("types: [opened]");
  });
});
