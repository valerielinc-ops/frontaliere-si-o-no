import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SPA-parity regression gate for the static job-detail template.
 *
 * The full HTML for a job-detail page is assembled inside a closure in
 * `build-plugins/jobsSeoPagesPlugin.ts` and only flushed during a real Vite
 * build (which OOMs locally — see CLAUDE.md FAST_BUILD trap). So we assert
 * against the plugin source itself: the new SPA-parity blocks must remain
 * present, and the CSS classes they reference must exist in seo-static.css.
 *
 * Backport context: `components/community/JobBoard.tsx` (the React view)
 * had drifted past the static template — featured/new/salary badges, the
 * highlights chip row under "Panoramica", and the desktop sticky sidebar
 * were all missing from the crawler-facing HTML. See the commit body of
 * the PR that introduced this test for the original drift report.
 *
 * Source scope (L3 refactor): individual SPA-parity blocks were extracted
 * out of jobsSeoPagesPlugin.ts into pure-TS emitters under
 * `build-plugins/shared/jobDetailHtml/`. The assertions below are
 * path-agnostic — they concatenate the plugin file with every `.ts` file
 * under the emitters directory before matching, so they survive the
 * extraction without weakening intent: the blocks must still exist
 * *somewhere* in the static-emit pipeline.
 */
describe('static job-detail page SPA alignment', () => {
  function collectTsFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...collectTsFiles(full));
      else if (st.isFile() && /\.ts$/.test(name)) out.push(full);
    }
    return out;
  }
  const pluginPath = path.resolve(
    __dirname,
    '..',
    '..',
    'build-plugins',
    'jobsSeoPagesPlugin.ts',
  );
  const emittersDir = path.resolve(
    __dirname,
    '..',
    '..',
    'build-plugins',
    'shared',
    'jobDetailHtml',
  );
  const sourceFiles = [pluginPath, ...collectTsFiles(emittersDir)];
  const pluginSource = sourceFiles
    .map((p) => readFileSync(p, 'utf-8'))
    .join('\n');
  const cssSource = readFileSync(
    path.resolve(__dirname, '..', '..', 'public', 'assets', 'seo-static.css'),
    'utf-8',
  );

  describe('hero badges block', () => {
    it('emits a hero-badges wrapper inside the hero section', () => {
      expect(pluginSource).toContain('class="hero-badges"');
    });

    it('gates the Featured badge on job.featured === true', () => {
      expect(pluginSource).toMatch(/const isFeatured = job\.featured === true/);
      expect(pluginSource).toContain('class="badge badge-featured"');
    });

    it('gates the "New" badge on a <7d postedDate window', () => {
      // 7 * 86400000 ms = one week in ms.
      expect(pluginSource).toMatch(/7\s*\*\s*86400000/);
      expect(pluginSource).toContain('class="badge badge-new"');
    });

    it('renders the salary pill only when salaryMin is a finite number', () => {
      expect(pluginSource).toMatch(/hasSalaryPill = Number\.isFinite\(salaryMin\)/);
      expect(pluginSource).toContain('class="badge badge-salary"');
    });

    it('returns an empty string when no badge condition is true', () => {
      // The guard avoids emitting an empty wrapper that would still take
      // vertical space in the rendered hero.
      expect(pluginSource).toMatch(/if \(!isFeatured && !isNew && !hasSalaryPill\) return ''/);
    });
  });

  describe('highlights chips below Panoramica', () => {
    it('sources from canonicalLocale.highlights when present, falling back to canonicalKeywords', () => {
      expect(pluginSource).toMatch(/canonicalLocale as \{ highlights\?: unknown \}/);
      expect(pluginSource).toMatch(/source\.slice\(0, 6\)/);
    });

    it('emits a <ul class="highlights"> with chip items', () => {
      expect(pluginSource).toContain('class="highlights"');
      expect(pluginSource).toMatch(/class="chip"/);
    });

    it('returns an empty string when there are no highlights and no keywords', () => {
      expect(pluginSource).toMatch(/if \(chips\.length === 0\) return ''/);
    });
  });

  describe('desktop right rail sidebar', () => {
    it('emits an <aside class="job-detail-rail"> after the proposal article', () => {
      expect(pluginSource).toContain('class="job-detail-rail"');
      // The aside must come after the closing </article> tag — i.e. the
      // company card / related / footer order is preserved.
      const articleClose = pluginSource.indexOf('</article>');
      const railOpen = pluginSource.indexOf('class="job-detail-rail"');
      expect(articleClose).toBeGreaterThan(-1);
      expect(railOpen).toBeGreaterThan(articleClose);
    });

    it('renders a location rail-card with localised labels', () => {
      expect(pluginSource).toContain('class="rail-card"');
      // Italian labels — the rail is the same in every locale; spot-check IT.
      expect(pluginSource).toContain("location: 'Posizione'");
      expect(pluginSource).toContain("city: 'Città'");
      expect(pluginSource).toContain("canton: 'Cantone'");
      expect(pluginSource).toContain("postal: 'CAP'");
    });

    it('renders a salary card only when salaryMin is finite', () => {
      expect(pluginSource).toMatch(/const salaryCard = Number\.isFinite\(salaryMin\)/);
      expect(pluginSource).toContain('class="rail-salary"');
    });

    it('renders a sector card derived from job.category via the locale map', () => {
      expect(pluginSource).toContain('class="rail-sector"');
      expect(pluginSource).toMatch(/railSectorMap\[locale\]\?\.\[railCat\]/);
    });

    it('renders related-search chips when canonicalKeywords is non-empty', () => {
      expect(pluginSource).toContain('class="rail-chips"');
      expect(pluginSource).toMatch(/canonicalKeywords\.slice\(0, 6\)/);
    });

    it('emits nothing when all rail cards would be empty', () => {
      expect(pluginSource).toMatch(/if \(!cards\) return ''/);
    });
  });

  describe('seo-static.css carries the new classes', () => {
    it('defines .hero-badges + badge variants', () => {
      expect(cssSource).toMatch(/\.hero-badges\s*\{/);
      expect(cssSource).toMatch(/\.badge\s*\{/);
      expect(cssSource).toMatch(/\.badge-featured\s*\{/);
      expect(cssSource).toMatch(/\.badge-new\s*\{/);
      expect(cssSource).toMatch(/\.badge-salary\s*\{/);
    });

    it('defines .highlights + .chip', () => {
      expect(cssSource).toMatch(/\.highlights\s*\{/);
      expect(cssSource).toMatch(/\.chip\s*\{/);
    });

    it('defines .job-detail-rail hidden by default, shown ≥1024px', () => {
      expect(cssSource).toMatch(/\.job-detail-rail\s*\{[\s\S]*?display:\s*none/);
      expect(cssSource).toMatch(/@media \(min-width: 1024px\)\s*\{[\s\S]*?\.job-detail-rail/);
    });

    it('defines the rail-card / rail-dl / rail-salary / rail-sector / rail-chips classes', () => {
      expect(cssSource).toMatch(/\.rail-card\s*\{/);
      expect(cssSource).toMatch(/\.rail-dl\s*\{/);
      expect(cssSource).toMatch(/\.rail-salary\s*\{/);
      expect(cssSource).toMatch(/\.rail-sector\s*\{/);
      expect(cssSource).toMatch(/\.rail-chips\s*\{/);
    });

    it('uses only semantic --color-* tokens for the new rules (no hex)', () => {
      // Slice from .hero-badges to the canton-hub section.
      const start = cssSource.indexOf('/* ── SPA-parity additions');
      const end = cssSource.indexOf('/* ── Canton-hub template', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const section = cssSource.slice(start, end);
      // No raw hex literals — only var(--color-*) references.
      expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });
});
