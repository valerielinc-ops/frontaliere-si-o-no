import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = path.join(ROOT, 'tests');
const THIS_FILE = path.resolve(__filename);
const READS_SCRIPT_SOURCE = /readFileSync[\s\S]{0,800}scripts[\\/]/;
const PINS_FOUR_LITERAL = /\.toContain\(\s*(['"`]),\s*4\1\s*\)/;

function collectTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(fullPath);
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  });
}

describe('test assertions are behavior-based', () => {
  it('does not pin a scripts source read to the newsletter literal ", 4"', () => {
    const offenders = collectTestFiles(TESTS_ROOT)
      .filter((file) => path.resolve(file) !== THIS_FILE)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return READS_SCRIPT_SOURCE.test(source) && PINS_FOUR_LITERAL.test(source);
      })
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });
});
