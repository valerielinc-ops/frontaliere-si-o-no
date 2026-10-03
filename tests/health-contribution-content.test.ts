import { describe, expect, it } from 'vitest';
import metadata from '../services/seo/seo-pages';
import { FAQ_TRANSLATIONS } from '../services/seo/faq-translations';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';

// Legal source: DM 14 November 2025, GU 18 December 2025, 25A06706,
// Articles 1 (net salary and regional determination) and 2 (direct payment).
// This contract deliberately does not assert an unverified regional 2026 rate.
const page = metadata['tassa-salute-frontalieri'];
const blocks = page.structuredData as Array<Record<string, unknown>>;
const faq = blocks.find(block => block['@type'] === 'FAQPage')!;
const questions = faq.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
const editorial = SECTION_EDITORIAL['/guida-frontaliere/tassa-salute-frontalieri'];

describe('health contribution factual consistency', () => {
  it('does not emit the obsolete Swiss withholding calculation procedure', () => {
    expect(blocks.some(block => block['@type'] === 'HowTo')).toBe(false);
    expect(page.description).toContain('salario netto');
    expect(page.description).not.toContain('Cantone Ticino');
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('keeps %s FAQ and visible body aligned', locale => {
    const answers = questions.map(question => locale === 'it'
      ? question.acceptedAnswer.text
      : FAQ_TRANSLATIONS[question.name][locale].a);
    expect(answers).toHaveLength(6);
    const visible = editorial[locale].join('\n');
    for (const answer of answers) expect(visible).toContain(answer);
    expect(answers[0]).toContain('213/2023');
    expect(answers[1]).toContain('3–6%');
    expect(answers[1]).toContain('30–200');
    expect(visible).toContain('25A06706');
  });

  it('does not exempt old workers or promise an automatic foreign-tax credit', () => {
    const oldWorkers = questions.find(question => question.name.startsWith('I vecchi'))!.acceptedAnswer.text;
    expect(oldWorkers).toContain('non sono esclusi');
    expect(oldWorkers).toContain("diritto d'opzione");
    const deduction = questions.find(question => question.name.startsWith('La tassa salute è detraibile'))!.acceptedAnswer.text;
    expect(deduction).toContain('Non va inserito automaticamente');
  });
});
