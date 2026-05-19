import { describe, it, expect } from 'vitest';
import { renderLandingHero, HERO_BADGES } from '../../build-plugins/shared/landingHeroPersonality';

describe('renderLandingHero — full rendering', () => {
  it('renders eyebrow with emoji, h1, and tagline for educatore', () => {
    const html = renderLandingHero(
      'educatore',
      'it',
      { openings: 47, medianSalary: 65000 },
      'Lavoro come educatore in Ticino',
    );
    expect(html).toMatch(/<span aria-hidden="true">🎓<\/span>/);
    expect(html).toContain('Professione · Educatore in Ticino');
    expect(html).toContain('<h1');
    expect(html).toContain('Lavoro come educatore in Ticino');
    expect(html).toContain('bambini');           // tagline mentions kids
    expect(html).toContain('~CHF 65k');           // median salary in tagline
    expect(html).toContain('text-accent');        // semantic token, no hex
  });

  it('renders eyebrow + tagline for all 4 locales of educatore', () => {
    const locales = ['it', 'en', 'de', 'fr'] as const;
    for (const loc of locales) {
      const html = renderLandingHero('educatore', loc, { openings: 5 }, 'X');
      expect(html, `${loc} missing eyebrow`).toMatch(/<span aria-hidden="true">🎓<\/span>/);
      expect(html, `${loc} missing h1`).toContain('<h1');
    }
  });

  it('falls back to fallbackTagline when id is unknown', () => {
    const html = renderLandingHero(
      'NONEXISTENT_ID',
      'it',
      { openings: 1 },
      'Test page',
      'Custom fallback tagline here',
    );
    expect(html).toContain('Custom fallback tagline here');
    expect(html).toContain('Test page');
    expect(html).not.toMatch(/<span aria-hidden="true">/);  // no emoji for unknown id
  });

  it('omits tagline when no badge AND no fallback', () => {
    const html = renderLandingHero('NONEXISTENT_ID', 'it', { openings: 1 }, 'Just title');
    expect(html).toContain('Just title');
    // No tagline paragraph after the h1
    expect(html.match(/<p[^>]*>/g)?.length ?? 0).toBe(0);
  });

  it('escapes HTML in title to prevent injection', () => {
    const html = renderLandingHero('educatore', 'it', { openings: 5 }, '<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script>/);
  });
});

describe('HERO_BADGES total count after extension', () => {
  it('has at least 23 entries (10 professions + 4 careers + 3 nursing + 6 cities)', () => {
    expect(Object.keys(HERO_BADGES).length).toBeGreaterThanOrEqual(23);
  });
});
