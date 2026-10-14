import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootShell } from '../../build-plugins/htmlTemplate';

const ROOT = resolve(__dirname, '..', '..');

/**
 * `rootShell(hasSpaBundle)` gates the `.ft-hdr-reserve` first-paint header-height
 * spacer on the presence of the SPA bundle (PR #2808 / #2775).
 *
 * The spacer only reserves the sticky-nav header height correctly when React
 * actually mounts (createRoot replaces it with the real header). `hasSpaBundle`
 * is a defensive flag: `resolveEntryAssets` always returns the fixed entry
 * filenames now (no disk check, can't degrade to ''), but if a future
 * regression genuinely drops the entry chunk, an unconditional spacer would
 * sit as a PERMANENT empty band above the indexed SEO content. The gate makes
 * that impossible by construction: no bundle → plain empty `#root`.
 */
describe('rootShell — header-reserve spacer is gated on the SPA bundle', () => {
  it('emits the .ft-hdr-reserve spacer when a bundle is present', () => {
    const html = rootShell(true);
    expect(html).toBe('<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div></div>');
    // spacer is the SOLE child of #root — no SEO content nested (bait-and-switch safe)
    expect(html).not.toMatch(/<main/);
  });

  it('keeps supplied static content inside the root after the reserve', () => {
    const html = rootShell(true, '<main class="seo-static-content job-board-static-hub"></main>');
    expect(html).toBe(
      '<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div>'
      + '<main class="seo-static-content job-board-static-hub"></main></div>',
    );
  });

  it('emits a plain empty #root when there is NO bundle (no permanent gap)', () => {
    const html = rootShell(false);
    expect(html).toBe('<div id="root"></div>');
    // critically: NO spacer, so a never-mounting page degrades to 0px #root,
    // not a permanent header-height empty band.
    expect(html).not.toContain('ft-hdr-reserve');
  });

  it('keeps supplied static content when no bundle is available', () => {
    const html = rootShell(false, '<main class="seo-static-content job-board-static-hub"></main>');
    expect(html).toBe('<div id="root"><main class="seo-static-content job-board-static-hub"></main></div>');
    expect(html).not.toContain('ft-hdr-reserve');
  });
});

describe('SPA-takeover generators — static main ownership', () => {
  const generators = [
    {
      sourcePath: 'build-plugins/staticPagesPlugin.ts',
      mainVariable: 'staticHubMainHtml',
      mainClass: 'job-board-static-hub',
    },
    {
      sourcePath: 'build-plugins/jobsSeoPagesPlugin.ts',
      mainVariable: 'staticJobMainHtml',
      mainClass: 'static-job-page',
    },
  ] as const;

  for (const generator of generators) {
    it(`${generator.sourcePath} emits its SPA-takeover main inside #root`, () => {
      const source = readFileSync(resolve(ROOT, generator.sourcePath), 'utf-8');

      // The full pages are assembled inside closeBundle. Keep the observer
      // tied to each exact emitter while using the pure rootShell renderer
      // for the minimal HTML fixture.
      const main = `<main class="seo-static-content ${generator.mainClass}"><h1>Page</h1></main>`;
      const html = rootShell(true, main);

      expect(source).toContain(`const ${generator.mainVariable} =`);
      expect(source).toContain(`rootShell(hasSpaBundle, ${generator.mainVariable})`);
      expect(html).toMatch(
        new RegExp(`^<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"><\\/div>${main}<\\/div>$`),
      );
    });
  }
});
