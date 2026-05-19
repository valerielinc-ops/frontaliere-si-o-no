import { describe, it, expect } from 'vitest';
import {
  HERO_BADGES,
  renderLandingHero,
  type HeroVars,
} from '../../build-plugins/shared/landingHeroPersonality';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('HERO_BADGES coverage', () => {
  it('includes all 10 profession ids', () => {
    const required = [
      'infermiere', 'operaio', 'impiegato', 'ingegnere', 'educatore',
      'autista', 'muratore', 'cuoco', 'cameriere', 'elettricista',
    ];
    for (const id of required) {
      expect(HERO_BADGES, `missing badge for ${id}`).toHaveProperty(id);
    }
  });

  it('every badge has emoji + all 4 locale eyebrows + all 4 locale taglines', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      expect(badge.emoji.length, `${id} emoji empty`).toBeGreaterThan(0);
      for (const loc of LOCALES) {
        expect(badge.eyebrowLabel[loc], `${id}.eyebrowLabel.${loc}`).toBeTruthy();
        expect(badge.taglineTemplate[loc], `${id}.taglineTemplate.${loc}`).toBeTypeOf('function');
      }
    }
  });
});

describe('tagline length budget', () => {
  const realisticVars: HeroVars = { openings: 47, medianSalary: 65000, city: 'Lugano' };

  it('every tagline is ≤120 chars in every locale', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      for (const loc of LOCALES) {
        const out = badge.taglineTemplate[loc](realisticVars);
        expect(
          out.length,
          `${id}/${loc} tagline >120 chars: "${out}" (${out.length})`,
        ).toBeLessThanOrEqual(120);
      }
    }
  });

  it('survives missing medianSalary', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      for (const loc of LOCALES) {
        const out = badge.taglineTemplate[loc]({ openings: 5 });
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe('renderLandingHero', () => {
  it('emits eyebrow + h1 + tagline in mobile-first order', () => {
    const html = renderLandingHero(
      'educatore',
      'it',
      { openings: 47, medianSalary: 65000 },
      'Lavoro come educatore in Ticino',
    );
    const eyebrowIdx = html.indexOf('Educatore');
    const h1Idx = html.indexOf('<h1');
    const taglineIdx = html.indexOf('bambini');
    expect(eyebrowIdx).toBeGreaterThan(-1);
    expect(h1Idx).toBeGreaterThan(eyebrowIdx);
    expect(taglineIdx).toBeGreaterThan(h1Idx);
  });

  it('uses semantic colour tokens (no inline hex)', () => {
    const html = renderLandingHero('educatore', 'it', { openings: 5 }, 'X');
    expect(html).toContain('text-accent');
    expect(html).not.toMatch(/style="[^"]*color:\s*#/);
  });

  it('renders eyebrow emoji aria-hidden', () => {
    const html = renderLandingHero('educatore', 'it', { openings: 5 }, 'X');
    expect(html).toMatch(/<span aria-hidden="true">🎓<\/span>/);
  });
});
