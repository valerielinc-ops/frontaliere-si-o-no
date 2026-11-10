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

export function metaPixelBaseCodePlugin(rootDir: string): Plugin {
  // `rootDir` stays in the signature for the config/test contract. The plugin
  // no longer needs it: static HTML shells carry the snippet at emission time,
  // and Vite's transform hook handles the one Rollup-owned index document.
  void rootDir;
  return {
    name: 'meta-pixel-base-code-sitewide',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return injectMetaPixelBaseCode(html);
      },
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        // staticScriptsPlugin owns the loader asset. This fingerprint is the
        // only final-output bookkeeping still needed by the deploy manifest.
        recordFinalOutputManifestFingerprint(META_PIXEL_MANIFEST_FINGERPRINT);
        console.log('[meta-pixel-base-code] source shells covered; manifest fingerprint registered');
      },
    },
  };
}
