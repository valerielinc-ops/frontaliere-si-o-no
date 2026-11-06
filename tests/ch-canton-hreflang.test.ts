/**
 * Regression test for issue #2177 — SSR hreflang on the CH-wide per-canton
 * staticOverlay families.
 *
 * Background
 * ----------
 * PR #2164 made the SPA runtime `updateHreflangTags` skip `staticOverlay`
 * routes so the server-rendered hreflang block survives hydration. That fix
 * only holds if the build plugin for each staticOverlay family actually
 * EMITS a server-rendered hreflang block. The audit found two emitters that
 * called `buildSeoPageHtml` WITHOUT `hreflangHtml`:
 *
 *   - build-plugins/weeklyEmployersChCantonPages.ts  (per-canton companies-hiring hub)
 *   - build-plugins/jobMarketSnapshotChCantonPages.ts (per-canton job-market snapshot)
 *
 * Post-#2164 those pages would have shipped ZERO hreflang (pre-#2164 they at
 * least had the collapsed-root block from the SPA). This test locks in that
 * every emitted CH-canton page now carries a complete, self-referential
 * hreflang block: the page's own URL, all 4 locales, and x-default.
 *
 * Drives the real emit functions against a tmp dist with a synthetic ZH
 * job bucket above MIN_JOBS_FOR_CANTON_PAGE, then reads the emitted HTML.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitChCantonEmployersPages } from '../build-plugins/weeklyEmployersChCantonPages';
import { emitChCantonSnapshotPages } from '../build-plugins/jobMarketSnapshotChCantonPages';

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://frontaliereticino.ch';

// 50+ word IT description so jobIsActive() / word-count gates pass.
const DESC =
  'Posizione aperta a tempo pieno presso una primaria azienda con sede ' +
  'nel cantone di Zurigo. Il candidato ideale possiede esperienza nel ' +
  'settore di riferimento, ottime capacita organizzative e di lavoro in ' +
  'team, conoscenza delle lingue e disponibilita immediata. Offriamo un ' +
  'contratto stabile, formazione continua, ambiente dinamico e prospettive ' +
  'di crescita professionale concrete per chi vuole costruire una carriera ' +
  'duratura in Svizzera con condizioni economiche competitive e benefit.';

/** Six distinct ZH employers — above the 5-job MIN_JOBS_FOR_CANTON_PAGE gate. */
function syntheticZhJobs(): Array<Record<string, unknown>> {
  return Array.from({ length: 6 }, (_, i) => ({
    slug: `zh-job-${i}`,
    title: `Impiegato ${i}`,
    company: `Azienda Zurigo ${i}`,
    companyKey: `azienda-zurigo-${i}`,
    canton: 'ZH',
    location: 'Zürich',
    addressLocality: 'Zürich',
    description: DESC,
    descriptionByLocale: { it: DESC, en: DESC, de: DESC, fr: DESC },
  }));
}

/**
 * Collect every emitted `<link rel="alternate" hreflang>` from a dist tree.
 * Returns a map of file → array of {locale, href}.
 */
function readHreflangByFile(distDir: string): Map<string, Array<{ locale: string; href: string }>> {
  // Tolerate minified output: attribute values may be unquoted (rel=alternate)
  // while href stays quoted. Match both quoted and unquoted rel/hreflang.
  const RX =
    /<link\s+rel=(?:"alternate"|alternate)\s+hreflang=(?:"([^"]+)"|([^\s>]+))\s+href="([^"]+)"\s*\/?>/g;
  const out = new Map<string, Array<{ locale: string; href: string }>>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.html')) {
        const html = fs.readFileSync(p, 'utf-8');
        const tags: Array<{ locale: string; href: string }> = [];
        RX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RX.exec(html)) !== null) {
          tags.push({ locale: m[1] ?? m[2], href: m[3] });
        }
        out.set(p, tags);
      }
    }
  };
  walk(distDir);
  return out;
}

function assertCompleteHreflang(
  byFile: Map<string, Array<{ locale: string; href: string }>>,
): void {
  expect(byFile.size).toBeGreaterThan(0);
  for (const [file, tags] of byFile) {
    const locales = tags.map((t) => t.locale);
    // 4 locales + x-default.
    for (const expected of ['it', 'en', 'de', 'fr', 'x-default']) {
      expect(locales, `${file} must emit hreflang="${expected}"`).toContain(expected);
    }
    // Every href is absolute on the canonical host (trailing-slash policy).
    for (const t of tags) {
      expect(t.href.startsWith(`${BASE}/`), `${file} hreflang href absolute: ${t.href}`).toBe(true);
      expect(t.href.endsWith('/'), `${file} hreflang href trailing slash: ${t.href}`).toBe(true);
    }
    // x-default must mirror the IT href byte-for-byte (shared-helper invariant).
    const xDefault = tags.find((t) => t.locale === 'x-default');
    const itTag = tags.find((t) => t.locale === 'it');
    expect(xDefault?.href, `${file} x-default mirrors IT`).toBe(itTag?.href);
  }
}

describe('CH-canton staticOverlay families emit SSR hreflang (#2177)', () => {
  let distEmployers: string;
  let distSnapshot: string;

  beforeAll(async () => {
    distEmployers = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-emp-'));
    distSnapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-snap-'));
    await emitChCantonEmployersPages({
      rootDir: ROOT,
      distDir: distEmployers,
      jobs: syntheticZhJobs() as never,
    });
    await emitChCantonSnapshotPages({
      rootDir: ROOT,
      distDir: distSnapshot,
      jobs: syntheticZhJobs() as never,
    });
  });

  afterAll(() => {
    fs.rmSync(distEmployers, { recursive: true, force: true });
    fs.rmSync(distSnapshot, { recursive: true, force: true });
  });

  it('weeklyEmployersChCantonPages: every page has self-ref + 4 locales + x-default', () => {
    const byFile = readHreflangByFile(distEmployers);
    assertCompleteHreflang(byFile);
  });

  it('jobMarketSnapshotChCantonPages: every page has self-ref + 4 locales + x-default', () => {
    const byFile = readHreflangByFile(distSnapshot);
    assertCompleteHreflang(byFile);
  });
});
