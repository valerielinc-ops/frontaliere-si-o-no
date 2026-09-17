import { describe, expect, it } from 'vitest';

import {
  inferKnowledgeLabCanton,
  isKnowledgeLabSwissRelevant,
  parseKnowledgeLabListingJson,
} from '../scripts/lib/knowledge-lab-job-parser.mjs';

describe('Knowledge Lab nationwide location filtering', () => {
  it('keeps Swiss branch cities and rejects foreign cities even with a Swiss state', () => {
    const { items } = parseKnowledgeLabListingJson([
      { id: 1, title: 'Engineer Zurich', branch: { city: 'Zurich', state: 'ZH', country_code: 'CH' } },
      { id: 2, title: 'Engineer abroad', branch: { city: 'Madrid', state: 'ZH', country_code: 'ES' } },
    ]);

    expect(items).toHaveLength(2);
    expect(isKnowledgeLabSwissRelevant(items[0])).toBe(true);
    expect(inferKnowledgeLabCanton(items[0])).toBe('ZH');
    expect(isKnowledgeLabSwissRelevant(items[1])).toBe(false);
    expect(inferKnowledgeLabCanton(items[1])).toBe('');
  });
});
