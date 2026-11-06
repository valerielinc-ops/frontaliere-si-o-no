import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

import {
  META_PIXEL_BASE_CODE,
  META_PIXEL_LOADER_CONTENT,
  META_PIXEL_LOADER_FILENAME,
  META_PIXEL_MANIFEST_FINGERPRINT,
  META_PIXEL_MARKER,
} from './constants';
import { recordFinalOutputManifestFingerprint } from './sharedWriteRegistry';

export {
  META_PIXEL_BASE_CODE,
  META_PIXEL_LOADER_CONTENT,
  META_PIXEL_LOADER_FILENAME,
  META_PIXEL_MANIFEST_FINGERPRINT,
  META_PIXEL_MARKER,
};

const HTML_HEAD_END = /<\/head\s*>/i;

/** Insert the supplied Meta base code immediately before a page's closing head. */
export function injectMetaPixelBaseCode(html: string): string {
  if (html.includes(META_PIXEL_MARKER)) return html;

  const headEnd = HTML_HEAD_END.exec(html);
  if (!headEnd || headEnd.index === undefined) {
    throw new Error('Cannot install Meta Pixel: HTML page has no closing </head> tag');
  }

  return `${html.slice(0, headEnd.index)}${META_PIXEL_BASE_CODE}\n${html.slice(headEnd.index)}`;
}

async function walkHtml(dir: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkHtml(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(fullPath);
    }
  }));
}

export interface MetaPixelInjectionSummary {
  htmlFiles: number;
  injected: number;
  alreadyPresent: number;
}

/** Apply the base code to every HTML page emitted into the production dist. */
export async function injectMetaPixelIntoDist(distDir: string): Promise<MetaPixelInjectionSummary> {
  if (!fs.existsSync(distDir)) return { htmlFiles: 0, injected: 0, alreadyPresent: 0 };

  const assetsDir = path.join(distDir, 'assets');
  await fs.promises.mkdir(assetsDir, { recursive: true });
  await fs.promises.writeFile(path.join(assetsDir, META_PIXEL_LOADER_FILENAME), META_PIXEL_LOADER_CONTENT, 'utf8');
  recordFinalOutputManifestFingerprint(META_PIXEL_MANIFEST_FINGERPRINT);

  const files: string[] = [];
  await walkHtml(distDir, files);
  files.sort();

  let injected = 0;
  let alreadyPresent = 0;
  const concurrency = 16;

  for (let start = 0; start < files.length; start += concurrency) {
    await Promise.all(files.slice(start, start + concurrency).map(async (file) => {
      const original = await fs.promises.readFile(file, 'utf8');
      try {
        const updated = injectMetaPixelBaseCode(original);
        if (updated === original) {
          alreadyPresent++;
        } else {
          await fs.promises.writeFile(file, updated, 'utf8');
          injected++;
        }
      } catch (error) {
        throw new Error(`Cannot install Meta Pixel in ${file}`, { cause: error });
      }
    }));
  }

  return { htmlFiles: files.length, injected, alreadyPresent };
}

export function metaPixelBaseCodePlugin(rootDir: string): Plugin {
  return {
    name: 'meta-pixel-base-code-sitewide',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        const distDir = path.resolve(rootDir, 'dist');
        const summary = await injectMetaPixelIntoDist(distDir);
        console.log(
          `[meta-pixel-base-code] injected on ${summary.injected}/${summary.htmlFiles} HTML pages `
          + `(${summary.alreadyPresent} already had the code)`,
        );
      },
    },
  };
}
