import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  minifySeoStaticCss,
  minifySeoStaticCssFile,
  SEO_STATIC_CSS_MAX_BYTES,
} from '../../build-plugins/minifySeoStaticCss';

describe('minifySeoStaticCss', () => {
  it('writes the minified public CSS into the build output', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'seo-static-css-'));
    const assetsDir = path.join(root, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, 'seo-static.css'), '.probe { margin: 0px; padding: 0px; }');

    try {
      const size = await minifySeoStaticCssFile(root);
      const output = readFileSync(path.join(assetsDir, 'seo-static.css'), 'utf8');
      expect(output).toBe('.probe{margin:0;padding:0}');
      expect(size).toBe(Buffer.byteLength(output));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('brings the shipped SEO stylesheet below the audit 150 KB threshold', async () => {
    const source = readFileSync(new URL('../../public/assets/seo-static.css', import.meta.url), 'utf8');
    const minified = await minifySeoStaticCss(source);

    expect(Buffer.byteLength(minified)).toBeLessThan(SEO_STATIC_CSS_MAX_BYTES);
    expect(minified.length).toBeLessThan(source.length);
  });
});
