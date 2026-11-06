/**
 * TDZ (Temporal Dead Zone) safety test.
 *
 * Detects `const` arrow functions used inside useMemo/useCallback BEFORE
 * they are defined in the source. In production builds, Vite minifies these
 * into single-letter variables. Unlike `function` declarations (which are
 * hoisted), `const` arrow functions throw "Cannot access 'X' before
 * initialization" at runtime — a ReferenceError that crashes the page.
 *
 * This test prevents regressions like:
 *  - REF 1xknza7: React#310 (useMemo after early return)
 *  - REF 1dm8t7w: "Cannot access 'Ct' before initialization"
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Recursively find all .tsx files under a directory */
function findTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTsxFiles(full));
    } else if (entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

describe('TDZ safety — no const functions used before definition in hooks', () => {
  const componentsDir = path.resolve(__dirname, '..', 'components');
  const files = findTsxFiles(componentsDir);

  it('should find component files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('should not have useMemo/useCallback referencing a const function defined later', () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const lines = source.split('\n');
      const relPath = path.relative(path.resolve(__dirname, '..'), file);

      // Pass 1: Collect all `const fn = (...)  =>` and `const fn = useCallback(` definitions
      const fnDefs = new Map<string, number>(); // name → line number (1-based)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match: const functionName = ( ... ) => or const functionName = useCallback(
        const m = line.match(/^\s+const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*(?::\s*\w[^=]*)?=>|useCallback\()/);
        if (m) {
          fnDefs.set(m[1], i + 1);
        }
      }

      // Pass 2: Find useMemo/useCallback calls and check if they reference functions defined later
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('useMemo(') && !line.includes('useCallback(')) continue;
        const hookLine = i + 1;

        for (const [fnName, defLine] of fnDefs) {
          // Check if the function name appears as a call in this hook line
          if (line.includes(fnName + '(') && hookLine < defLine) {
            violations.push(
              `${relPath}:${hookLine} — useMemo/useCallback calls ${fnName}() which is defined later at line ${defLine} (TDZ risk)`
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} TDZ violation(s) — const functions used in hooks before their definition:\n` +
        violations.map(v => `  ⚠️  ${v}`).join('\n') +
        '\n\nFix: Move the function definition ABOVE the useMemo/useCallback that uses it, ' +
        'or convert it to a `function` declaration (which is hoisted).'
      );
    }
  });
});
