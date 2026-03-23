import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BLOG_BODY_ROOT = path.resolve(__dirname, '..', 'services', 'locales', 'blog-body');

function collectTypeScriptFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('blog body locale files', () => {
  // 1700+ files transpiled via ts.transpileModule; under full-suite parallel load
  // this regularly exceeds the default 5 s — raised to 30 s to prevent flakiness.
  it('parse as valid TypeScript modules', async () => {
    const files = collectTypeScriptFiles(BLOG_BODY_ROOT);
    const failures: string[] = [];

    for (const filePath of files) {
      const source = fs.readFileSync(filePath, 'utf8');
      const result = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: filePath,
        reportDiagnostics: true,
      });

      const diagnostics = (result.diagnostics || [])
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

      if (diagnostics.length > 0) {
        const message = diagnostics
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
          .join('\n');
        failures.push(`${path.relative(process.cwd(), filePath)}\n${message}`);
      }
    }

    expect(
      failures,
      `Invalid blog body TypeScript files:\n\n${failures.slice(0, 10).join('\n\n')}`,
    ).toHaveLength(0);
  }, 120_000);
});
