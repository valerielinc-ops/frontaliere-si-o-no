import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyFaqSearchCategory } from '../services/privacy/faqSearchCategory';

describe('FAQ search demand categories', () => {
  it.each([
    ['come funzionano le tasse in Svizzera', 'taxes'],
    ['permesso di soggiorno', 'permits'],
    ['cassa malati e franchigia', 'health'],
    ['pensione secondo pilastro', 'pension'],
    ['traffico e dogana per andare al lavoro', 'daily'],
    ['assegni familiari', 'family'],
  ])('maps a search to the existing closed FAQ topic for %s', (query, category) => {
    expect(classifyFaqSearchCategory(query)).toBe(category);
  });

  it('never returns a substring of unknown or personal search text', () => {
    const query = 'Mario Rossi CH9300762011623852957';
    const category = classifyFaqSearchCategory(query);
    expect(category).toBe('other');
    expect(category).not.toContain('Mario');
    expect(category).not.toContain('9300762011623852957');
  });

  it.each(['constructor', 'toString', '__proto__'])('keeps prototype-shaped input in the closed fallback for %s', query => {
    expect(classifyFaqSearchCategory(query)).toBe('other');
  });

  it('sends closed-category demand and outcomes without the submitted search text', () => {
    const component = readFileSync(resolve(process.cwd(), 'components/pages/FaqSection.tsx'), 'utf8');
    expect(component).toContain("Analytics.trackExperimentEvent('faq_search_category'");
    expect(component).toContain("Analytics.trackExperimentEvent('faq_search_no_results', { faq_category: category })");
    expect(component).toContain("Analytics.trackExperimentEvent('faq_search_answer_opened', {");
    expect(component).toContain('faq_category: classifyFaqSearchCategory(searchTerm.trim())');
    expect(component).toContain('faq_category: category');
    expect(component).toContain('const matchingQuestions = allQuestions.filter(matchesSearch);');
    expect(component).toContain('if (matchingQuestions.length === 0)');
    expect(component).not.toContain('if (filteredQuestions.length === 0)');
    expect(component).not.toContain('searchTerm:');
    expect(component).not.toContain('query:');
    expect(component).not.toContain('Analytics.trackExperimentUIInteraction(');
    expect(component).toContain('classifyFaqSearchCategory(query)');
    expect(component).not.toContain('Analytics.trackSearch(value.trim())');
    expect(component).not.toContain("Analytics.trackUIInteraction('faq', 'search', 'faq_search', 'input'");
  });
});
