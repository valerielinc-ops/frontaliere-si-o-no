import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FUNCTIONS_SRC = resolve('functions/src');
const FIREBASE_CONFIG = JSON.parse(readFileSync(resolve('firebase.json'), 'utf8')) as {
  functions?: Array<{ source?: string; runtime?: string }>;
};
const FUNCTIONS_PACKAGE = JSON.parse(readFileSync(resolve('functions/package.json'), 'utf8')) as {
  engines?: { node?: string };
};

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

  it('deploys Functions with the Node runtime required by their package', () => {
    const functionsConfig = FIREBASE_CONFIG.functions?.find(({ source }) => source === 'functions');
    const packageMajor = String(FUNCTIONS_PACKAGE.engines?.node || '').match(/\d+/u)?.[0];
    const runtimeMajor = functionsConfig?.runtime?.match(/^nodejs(\d+)$/u)?.[1];

    expect(packageMajor, 'functions/package.json must declare a Node engine').toBeDefined();
    expect(runtimeMajor, 'firebase.json must declare a concrete Node runtime').toBeDefined();
    expect(runtimeMajor).toBe(packageMajor);
  });
});
