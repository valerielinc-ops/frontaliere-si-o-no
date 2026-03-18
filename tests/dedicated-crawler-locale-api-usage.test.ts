import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const UPDATE_SCRIPT_NAMES = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((name) => /^update-.*-jobs\.mjs$/.test(name))
  .sort();

function collectLegacyCalls(pattern: RegExp) {
  const matches: string[] = [];
  for (const name of UPDATE_SCRIPT_NAMES) {
    const filePath = path.join(SCRIPTS_DIR, name);
    const source = fs.readFileSync(filePath, 'utf-8');
    if (pattern.test(source)) {
      matches.push(name);
    }
  }
  return matches;
}

describe('dedicated crawler locale api usage', () => {
  it('does not call translateMissingJobLocales with the legacy positional signature', () => {
    const offenders = collectLegacyCalls(/\btranslateMissingJobLocales\s*\(\s*jobs\b/);
    expect(
      offenders,
      `Legacy translateMissingJobLocales(jobs, ...) usage found in:\n${offenders.join('\n')}`,
    ).toHaveLength(0);
  });

  it('does not call validateDedicatedLocaleCoverage with the legacy positional signature', () => {
    const offenders = collectLegacyCalls(/\bvalidateDedicatedLocaleCoverage\s*\(\s*jobs\b/);
    expect(
      offenders,
      `Legacy validateDedicatedLocaleCoverage(jobs, ...) usage found in:\n${offenders.join('\n')}`,
    ).toHaveLength(0);
  });
});
