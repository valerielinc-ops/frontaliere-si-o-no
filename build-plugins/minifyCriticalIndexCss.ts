import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const { minify } = require('html-minifier-terser') as {
  minify: (html: string, options: { minifyCSS: boolean }) => Promise<string>;
};

/**
 * The root document keeps one small synchronous style block for fonts and
 * first-paint layout reservations. Minify that block in the built HTML while
 * leaving the source readable and keeping every other inline block untouched.
 */
const ROOT_CRITICAL_STYLE_RE = /<style data-clarity-unmask="true">[\s\S]*?<\/style>/;

export async function minifyRootCriticalIndexCss(html: string): Promise<string> {
  const match = html.match(ROOT_CRITICAL_STYLE_RE);
  if (!match) return html;

  const compact = await minify(match[0], { minifyCSS: true });
  return html.replace(match[0], compact);
}

export function minifyCriticalIndexCssPlugin(): Plugin {
  return {
    name: 'minify-critical-index-css',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        return minifyRootCriticalIndexCss(html);
      },
    },
  };
}
