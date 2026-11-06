import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import type { Plugin, ResolvedConfig } from 'vite';

export const SEO_STATIC_CSS_MAX_BYTES = 150_000;

export async function minifySeoStaticCss(source: string): Promise<string> {
  const { code } = await transform(source, { loader: 'css', minify: true });
  return code.trimEnd();
}

/** Minify Vite's copied public stylesheet after the build has written it. */
export async function minifySeoStaticCssFile(distDir: string, sourcePath?: string): Promise<number> {
  const cssPath = path.join(distDir, 'assets', 'seo-static.css');
  let source: string;
  try {
    source = await readFile(cssPath, 'utf8');
  } catch (error) {
    // Vite normally copies public/ before closeBundle. Incremental builds can
    // leave that copy out when the output directory was prepared by a custom
    // build-start plugin, so restore this stable public asset explicitly.
    if (!sourcePath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path.dirname(cssPath), { recursive: true });
    await copyFile(sourcePath, cssPath);
    source = await readFile(cssPath, 'utf8');
  }
  const minified = await minifySeoStaticCss(source);
  const byteLength = Buffer.byteLength(minified);

  if (byteLength >= SEO_STATIC_CSS_MAX_BYTES) {
    throw new Error(
      `[minify-seo-static-css] ${path.relative(distDir, cssPath)} is ${byteLength} bytes after minification; expected under ${SEO_STATIC_CSS_MAX_BYTES}.`,
    );
  }

  if (minified !== source) await writeFile(cssPath, minified, 'utf8');
  return byteLength;
}

export function minifySeoStaticCssPlugin(): Plugin {
  let distDir = path.resolve('dist');
  let sourcePath: string | undefined;

  return {
    name: 'minify-seo-static-css',
    apply: 'build',
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      distDir = path.resolve(config.root, config.build.outDir);
      sourcePath = path.resolve(config.root, 'public', 'assets', 'seo-static.css');
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        await minifySeoStaticCssFile(distDir, sourcePath);
      },
    },
  };
}
