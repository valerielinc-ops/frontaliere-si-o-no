import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import type { Plugin, ResolvedConfig } from 'vite';

export const SEO_STATIC_CSS_MAX_BYTES = 150_000;

export async function minifySeoStaticCss(source: string): Promise<string> {
  const { code } = await transform(source, { loader: 'css', minify: true });
  return code;
}

/** Minify Vite's copied public stylesheet after the build has written it. */
export async function minifySeoStaticCssFile(distDir: string): Promise<number> {
  const cssPath = path.join(distDir, 'assets', 'seo-static.css');
  const source = await readFile(cssPath, 'utf8');
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

  return {
    name: 'minify-seo-static-css',
    apply: 'build',
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      distDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        await minifySeoStaticCssFile(distDir);
      },
    },
  };
}
