import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
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
  // 10,000+ files. esbuild's async transform runs on its background service,
  // which parses concurrently across cores — ~2.3x faster here than the
  // single-threaded ts.transpileModule loop this replaced, for the same
  // syntax-only (no type-check) validation.
  it('parse as valid TypeScript modules', async () => {
    const files = collectTypeScriptFiles(BLOG_BODY_ROOT);

    const results = await Promise.all(files.map(async (filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      try {
        await esbuild.transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
        return null;
      } catch (err) {
        const messages = (err as { errors?: Array<{ text: string }> }).errors
          ?.map((e) => e.text)
          .join('\n') || String(err);
        return `${path.relative(process.cwd(), filePath)}\n${messages}`;
      }
    }));
    const failures = results.filter((f): f is string => f !== null);

    expect(
      failures,
      `Invalid blog body TypeScript files:\n\n${failures.slice(0, 10).join('\n\n')}`,
    ).toHaveLength(0);
  }, 60_000);
});
