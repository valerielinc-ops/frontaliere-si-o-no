import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FUNCTIONS_SRC = resolve('functions/src');

function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && path.endsWith('.js') ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('firebase-admin v14 Cloud Functions imports', () => {
  it('does not use the removed root namespace service accessors', () => {
    const offenders = javascriptFiles(FUNCTIONS_SRC)
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        const code = stripComments(source);
        return /import\s+admin\s+from\s+['"]firebase-admin['"]/u.test(code)
          || /\badmin\.(?:apps|credential|firestore|auth|storage)\b/u.test(code);
      })
      .map((path) => relative(resolve('.'), path));

    expect(offenders).toEqual([]);
  });
});
