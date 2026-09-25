/**
 * Unit test for the $dead_click fix on salaryHubPlugin landings.
 *
 * Context: PostHog `$dead_click` events spiked on
 * `/calcola-stipendio/nuovi-frontalieri-oltre-20-km` (24×, 7d). Root cause:
 * the first (accent) stat tile was an inert `<div>` styled as a card — users
 * tapped it expecting interaction. Fix: the salaryLandingShell now wires
 * `ctaPrimary.href` into the first `accent`-toned tile so the entire tile
 * becomes a single tap target (`<a data-tile-cta="1">`).
 */

import { describe, it, expect, vi } from 'vitest';

// salaryLandingShell pulls Node-only build-time imports (fs/path); vi.importActual
// keeps them available without any global mock interference.
let renderSalaryLandingShell: typeof import('@/build-plugins/shared/salaryLandingShell').renderSalaryLandingShell;
let HUB_DATA: typeof import('@/build-plugins/shared/salaryLandingShell');

it('loads salaryLandingShell module', async () => {
  HUB_DATA = await vi.importActual<typeof import('@/build-plugins/shared/salaryLandingShell')>(
    '@/build-plugins/shared/salaryLandingShell',
  );
  renderSalaryLandingShell = HUB_DATA.renderSalaryLandingShell;
  expect(renderSalaryLandingShell).toBeTypeOf('function');
});

describe('renderSalaryLandingShell — accent tile becomes a tap target', () => {
  it('wraps the first accent tile as <a> pointing at ctaPrimary.href', async () => {
    const mod = await vi.importActual<typeof import('@/build-plugins/shared/salaryLandingShell')>(
      '@/build-plugins/shared/salaryLandingShell',
    );

    const data = {
      eyebrow: 'Test eyebrow',
      tagline: 'Test tagline',
      tiles: [
        { label: 'Headline metric', value: '100%', tone: 'accent' as const },
        { label: 'Secondary', value: '0%', tone: 'neutral' as const },
        { label: 'Cost', value: '~EUR 3.000/anno', tone: 'warning' as const },
      ],
      ctaPrimary: { label: 'Calcola', href: '/calcola-stipendio/?tipo=NEW&zona=OVER_20KM' },
    };

    const html = mod.renderSalaryLandingShell(data, 'it', { h1Text: 'Test H1' });

    // Accent tile (first one) MUST be wrapped as <a data-tile-cta="1">
    expect(html).toContain('data-tile-cta="1"');
    expect(html).toMatch(/<a href="\/calcola-stipendio\/\?tipo=NEW&amp;zona=OVER_20KM"[^>]*data-tile-cta="1"/);
    // The label must be inside the anchor
    const accentMatch = html.match(/<a[^>]*data-tile-cta="1"[^>]*>([\s\S]*?)<\/a>/);
    expect(accentMatch?.[1]).toContain('Headline metric');
    expect(accentMatch?.[1]).toContain('100%');
  });

  it('does not wrap non-accent tiles when there is no accent tile present', async () => {
    const mod = await vi.importActual<typeof import('@/build-plugins/shared/salaryLandingShell')>(
      '@/build-plugins/shared/salaryLandingShell',
    );

    const data = {
      eyebrow: 'Test',
      tagline: 'Test tagline',
      tiles: [
        { label: 'Warning', value: 'X', tone: 'warning' as const },
        { label: 'Danger', value: 'Y', tone: 'danger' as const },
      ],
      ctaPrimary: { label: 'Calcola', href: '/calcola-stipendio/' },
    };

    const html = mod.renderSalaryLandingShell(data, 'it', { h1Text: 'Test H1' });
    // No tile should be wrapped (no accent tile to link)
    expect(html).not.toContain('data-tile-cta="1"');
  });

  it('only wraps the FIRST accent tile, not subsequent ones', async () => {
    const mod = await vi.importActual<typeof import('@/build-plugins/shared/salaryLandingShell')>(
      '@/build-plugins/shared/salaryLandingShell',
    );

    const data = {
      eyebrow: 'Test',
      tagline: 'Test tagline',
      tiles: [
        { label: 'First accent', value: '100%', tone: 'accent' as const },
        { label: 'Second accent', value: '200%', tone: 'accent' as const },
      ],
      ctaPrimary: { label: 'Calcola', href: '/calcola-stipendio/' },
    };

    const html = mod.renderSalaryLandingShell(data, 'it', { h1Text: 'Test H1' });
    const matches = html.match(/data-tile-cta="1"/g);
    expect(matches).toHaveLength(1);
    // The wrapped tile must contain "First accent"
    const accentMatch = html.match(/<a[^>]*data-tile-cta="1"[^>]*>([\s\S]*?)<\/a>/);
    expect(accentMatch?.[1]).toContain('First accent');
  });

  it('default tone is accent — first tile is still wrapped even when tone is omitted', async () => {
    const mod = await vi.importActual<typeof import('@/build-plugins/shared/salaryLandingShell')>(
      '@/build-plugins/shared/salaryLandingShell',
    );

    const data = {
      eyebrow: 'Test',
      tagline: 'Test tagline',
      tiles: [
        { label: 'Default tone', value: '100%' }, // no tone → defaults to accent
        { label: 'Neutral', value: '0%', tone: 'neutral' as const },
      ],
      ctaPrimary: { label: 'Calcola', href: '/calcola-stipendio/' },
    };

    const html = mod.renderSalaryLandingShell(data, 'it', { h1Text: 'Test H1' });
    expect(html).toContain('data-tile-cta="1"');
  });
});
