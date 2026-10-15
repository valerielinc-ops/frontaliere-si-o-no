/**
 * Regression test for the AE-3 profession-links injection determinism fix
 * (build-plugins/professionLandingsLinksPlugin.ts).
 *
 * Background: under heavy CI builds, the linker plugin used to silently
 * inject 0/5 hubs because Vite/Rollup runs `closeBundle` hooks in parallel
 * and the WriteCollector auto-flush would overwrite the patch. The fix
 * (a) extracts a pure injector function (`injectAe3Block`) so the plugin
 * does no I/O at the patch step, and (b) waits on explicit signals from
 * each producer before patching. This test guards (a) — exhaustively —
 * so a future refactor can't reintroduce the silent-no-anchor bug.
 */
import { describe, it, expect } from 'vitest';
import { injectAe3Block } from '../../build-plugins/professionLandingsLinksPlugin';

const MARKER = 'data-ae3-profession-links';
const BLOCK = `<aside ${MARKER} data-test-block><p>links</p></aside>`;

describe('injectAe3Block — pure AE-3 profession-links injector', () => {
  it('inserts the block immediately after <main …> when present', () => {
    const html =
      '<!doctype html><html><head></head><body><main id="main-content"></main></body></html>';
    const { html: out, outcome } = injectAe3Block(html, BLOCK);

    expect(outcome).toBe('inserted');
    expect(out).toContain(MARKER);

    const mainOpen = out.indexOf('<main id="main-content">');
    const blockAt = out.indexOf(MARKER);
    const mainClose = out.indexOf('</main>');

    // Block must sit AFTER the opening <main> tag and BEFORE </main>.
    expect(mainOpen).toBeGreaterThan(-1);
    expect(blockAt).toBeGreaterThan(mainOpen);
    expect(blockAt).toBeLessThan(mainClose);
  });

  it('preserves <main> attributes when injecting (regex must not eat them)', () => {
    const html =
      '<body><main id="main-content" class="hub" data-foo="bar"></main></body>';
    const { html: out, outcome } = injectAe3Block(html, BLOCK);

    expect(outcome).toBe('inserted');
    expect(out).toContain('<main id="main-content" class="hub" data-foo="bar">');
    // Block sits right after the closing `>` of the opening <main> tag.
    expect(out).toMatch(
      /<main id="main-content" class="hub" data-foo="bar"><aside data-ae3-profession-links/,
    );
  });

  it('falls back to inserting before </main> when no <main …> match (defensive)', () => {
    // This synthetic case has </main> but the regex above would already match
    // any opening <main> — so we exercise the fallback by passing HTML that
    // only contains </main>. Real production HTML always has both, so this
    // path mainly defends against pre-rendered fragments.
    const html = '<body>existing markup</main></body>';
    const { html: out, outcome } = injectAe3Block(html, BLOCK);

    expect(outcome).toBe('inserted');
    expect(out).toContain(MARKER);
    expect(out.indexOf(MARKER)).toBeLessThan(out.indexOf('</main>'));
  });

  it('falls back to inserting before </body> when no <main> at all', () => {
    const html = '<html><head></head><body>plain page</body></html>';
    const { html: out, outcome } = injectAe3Block(html, BLOCK);

    expect(outcome).toBe('inserted');
    expect(out).toContain(MARKER);
    expect(out.indexOf(MARKER)).toBeLessThan(out.indexOf('</body>'));
  });

  it('returns "duplicate" and leaves HTML untouched when marker already present', () => {
    const original =
      '<body><main><aside data-ae3-profession-links>old</aside></main></body>';
    const { html: out, outcome } = injectAe3Block(original, BLOCK);

    expect(outcome).toBe('duplicate');
    expect(out).toBe(original);
  });

  it('returns "no-anchor" when there is nowhere to insert (plugin must hard-fail)', () => {
    const html = '<div>just a fragment</div>';
    const { html: out, outcome } = injectAe3Block(html, BLOCK);

    expect(outcome).toBe('no-anchor');
    expect(out).toBe(html);
  });

  it('is deterministic: identical input always produces identical output', () => {
    const html =
      '<body><main id="main-content"><h1>Hub</h1></main></body>';
    const a = injectAe3Block(html, BLOCK);
    const b = injectAe3Block(html, BLOCK);
    expect(a).toEqual(b);
  });
});
