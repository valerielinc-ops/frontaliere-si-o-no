import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const runtimeModuleUrl = pathToFileURL(
  path.resolve('packages/articles/engine/shared/typescriptRuntime.mjs'),
).href;
const staticSourceAstPath = path.resolve('packages/articles/engine/shared/staticSourceAst.mjs');
const typescriptRuntimePath = path.resolve('packages/articles/engine/shared/typescriptRuntime.mjs');

function runLoader(compilerEntry: string | undefined, tempDir: string): string {
  const source = [
    `import { loadArticleSourceTypeScript } from ${JSON.stringify(runtimeModuleUrl)};`,
    'try {',
    '  const ts = loadArticleSourceTypeScript();',
    '  process.stdout.write(JSON.stringify({ version: ts.version, marker: ts.marker ?? null }));',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ error: error.message }));',
  '}',
  ].join('\n');
  const env = { ...process.env };
  if (compilerEntry === undefined) delete env.ARTICLE_SOURCE_TYPESCRIPT;
  else env.ARTICLE_SOURCE_TYPESCRIPT = compilerEntry;

  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tempDir,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runCopiedStaticParser(parserPath: string, compilerEntry: string, tempDir: string): string {
  const source = [
    `import { parseStaticSource } from ${JSON.stringify(pathToFileURL(parserPath).href)};`,
    "const parsed = parseStaticSource(\"const article: Record<string, string> = { 'blog.article.demo.body1': 'text' };\\nexport default article;\\n\", 'mirror-check.ts');",
    'process.stdout.write(JSON.stringify({',
    '  statements: parsed.statements.length,',
    '  diagnostics: parsed.parseDiagnostics.length,',
    '  declarationName: parsed.statements[0]?.declarationList?.declarations[0]?.name?.text,',
    '}));',
  ].join('\n');

  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tempDir,
    env: { ...process.env, ARTICLE_SOURCE_TYPESCRIPT: compilerEntry },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('article source TypeScript runtime loader', () => {
  it('loads the explicitly configured absolute compiler entry before package resolution', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-source-ts-runtime-'));
    try {
      const compilerStub = path.join(tempDir, 'compiler.cjs');
      fs.writeFileSync(compilerStub, [
        'module.exports = {',
        "  version: '5.8.3',",
        "  marker: 'from-explicit-entry',",
        '  createSourceFile() {},',
        '  forEachChild() {},',
        '  createScanner() {},',
        '};',
      ].join('\n'));

      expect(JSON.parse(runLoader(compilerStub, tempDir))).toEqual({
        version: '5.8.3',
        marker: 'from-explicit-entry',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects relative paths, an absent compiler entry, and a different compiler version', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-source-ts-runtime-'));
    try {
      const wrongVersion = path.join(tempDir, 'wrong-version.cjs');
      fs.writeFileSync(wrongVersion, "module.exports = { version: '5.8.2' };\n");

      expect(JSON.parse(runLoader('./typescript.cjs', tempDir)).error)
        .toMatch(/must be an absolute path/u);
      expect(JSON.parse(runLoader(path.join(tempDir, 'missing.cjs'), tempDir)).error)
        .toMatch(/Cannot find module/u);
      expect(JSON.parse(runLoader(wrongVersion, tempDir)).error)
        .toMatch(/requires TypeScript 5\.8\.3; received 5\.8\.2/u);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves the pinned package when no isolated entry is configured', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-source-ts-runtime-'));
    try {
      expect(JSON.parse(runLoader(undefined, tempDir))).toEqual({
        version: '5.8.3',
        marker: null,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('parses copied engine code without a local node_modules directory when CI pins TypeScript', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-source-ts-mirror-'));
    try {
      const sharedDir = path.join(tempDir, 'engine', 'shared');
      fs.mkdirSync(sharedDir, { recursive: true });
      const copiedParser = path.join(sharedDir, 'staticSourceAst.mjs');
      fs.copyFileSync(staticSourceAstPath, copiedParser);
      fs.copyFileSync(typescriptRuntimePath, path.join(sharedDir, 'typescriptRuntime.mjs'));

      expect(fs.existsSync(path.join(tempDir, 'node_modules'))).toBe(false);
      expect(JSON.parse(runCopiedStaticParser(copiedParser, require.resolve('typescript'), tempDir))).toEqual({
        statements: 2,
        diagnostics: 0,
        declarationName: 'article',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
