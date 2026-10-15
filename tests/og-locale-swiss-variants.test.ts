/**
 * og:locale Swiss-market variant gate (Issue #3471).
 *
 * The site targets the Swiss market (frontaliereticino.ch), so every
 * `og:locale` emitter must use the Swiss variants (`it_CH`, `de_CH`,
 * `fr_CH`) instead of the generic country variants (`it_IT`, `de_DE`,
 * `fr_FR`). English keeps `en_US`/`en_GB` — there is no recognized
 * Swiss OG variant for English.
 *
 * The OG locale map is (pre-existing) duplicated across ~35 build
 * plugins plus the runtime SPA updaters, and it had already drifted
 * (runtime emitted `de_CH`/`fr_CH` while the SSG plugins emitted
 * `de_DE`/`fr_FR`). This test is structural: it scans every emitting
 * source file and fails on any reintroduction of a generic variant,
 * making silent drift impossible without touching the plugin import
 * graph (several plugins run inside build worker threads).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

/** Generic country variants that have a Swiss-market OG equivalent. */
const FORBIDDEN_OG_VARIANTS = ['it_IT', 'de_DE', 'fr_FR'] as const;

function listFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('og:locale uses Swiss-market variants (Issue #3471)', () => {
  it('no build plugin emits a generic og:locale country variant', () => {
    const offenders: string[] = [];
    for (const file of listFilesRecursive(join(ROOT, 'build-plugins'))) {
      const src = readFileSync(file, 'utf-8');
      for (const variant of FORBIDDEN_OG_VARIANTS) {
        if (src.includes(variant)) offenders.push(`${file}: ${variant}`);
      }
    }
    expect(offenders, 'generic og:locale variants found (use it_CH/de_CH/fr_CH)').toEqual([]);
  });

  it('runtime SPA og:locale updaters use Swiss variants', () => {
    for (const rel of ['services/seoService.ts', 'components/community/JobBoard.tsx']) {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      for (const variant of FORBIDDEN_OG_VARIANTS) {
        expect(src.includes(variant), `${rel} contains generic og:locale variant ${variant}`).toBe(
          false,
        );
      }
    }
  });

  it('index.html SPA shell declares the Swiss Italian og:locale', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf-8');
    expect(html).toContain('<meta property="og:locale" content="it_CH" />');
    for (const variant of FORBIDDEN_OG_VARIANTS) {
      expect(html.includes(variant), `index.html contains generic og:locale ${variant}`).toBe(
        false,
      );
    }
  });

  it('shared htmlTemplate default map covers all Swiss variants', () => {
    const src = readFileSync(join(ROOT, 'build-plugins', 'htmlTemplate.ts'), 'utf-8');
    expect(src).toMatch(/it:\s*'it_CH'/);
    expect(src).toMatch(/de:\s*'de_CH'/);
    expect(src).toMatch(/fr:\s*'fr_CH'/);
  });
});
