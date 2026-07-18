import { describe, expect, it } from 'vitest';
import {
  buildProfessionEvergreenTopics,
  buildComuneEvergreenTopics,
  buildStructuralEvergreenTopics,
} from '../scripts/lib/evergreen-topic-generator.mjs';

describe('buildProfessionEvergreenTopics', () => {
  const topics = buildProfessionEvergreenTopics();

  it('produces two candidates per profession, all shaped {keyword, angle}', () => {
    expect(topics.length).toBeGreaterThan(100);
    for (const t of topics) {
      expect(typeof t.keyword).toBe('string');
      expect(t.keyword.length).toBeGreaterThan(0);
      expect(typeof t.angle).toBe('string');
      expect(t.angle.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keywords', () => {
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('never leaks a raw slash or trailing parenthetical into the keyword', () => {
    for (const t of topics) {
      expect(t.keyword).not.toMatch(/\//);
      expect(t.keyword).not.toMatch(/[()]/);
    }
  });

  it('does not trip the permesso-g-b saturated family (no bare "b" token alongside permesso+g)', () => {
    for (const t of topics) {
      const text = `${t.keyword} ${t.angle}`.toLowerCase();
      const hasPermessoAndG = /\bpermess[oi]\b/.test(text) && /\bg\b/.test(text);
      const hasBareB = /\bb\b/.test(text);
      expect(hasPermessoAndG && hasBareB).toBe(false);
    }
  });
});

describe('buildComuneEvergreenTopics', () => {
  const topics = buildComuneEvergreenTopics();

  it('produces two candidates per selected comune, all shaped {keyword, angle}', () => {
    expect(topics.length).toBeGreaterThan(50);
    for (const t of topics) {
      expect(typeof t.keyword).toBe('string');
      expect(t.keyword.length).toBeGreaterThan(0);
      expect(typeof t.angle).toBe('string');
      expect(t.angle.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keywords', () => {
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('only assigns a canton for comuni from an unambiguous province', () => {
    for (const t of topics) {
      expect(t.keyword).toMatch(/lavorare in (Ticino|Grigioni|Vallese)|^trasferirsi a /);
    }
  });

  it('caps candidates per canton bucket instead of exploding to all 518 comuni', () => {
    // 40 Ticino + 25 Grigioni + 20 Vallese, × 2 templates each = 170 max
    expect(topics.length).toBeLessThanOrEqual(170);
  });
});

describe('buildStructuralEvergreenTopics', () => {
  it('merges profession + comune candidates with no cross-source duplicate keywords', () => {
    const topics = buildStructuralEvergreenTopics();
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(topics.length).toBe(
      buildProfessionEvergreenTopics().length + buildComuneEvergreenTopics().length
    );
  });
});
