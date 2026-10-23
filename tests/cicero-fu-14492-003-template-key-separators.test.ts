import { describe, expect, it } from 'vitest';

import {
  findTopLevelObjects,
  parseStaticSource,
  readStaticObjectProperties,
  staticPropertyName,
} from '../packages/articles/engine/shared/staticSourceAst.mjs';

describe('FU-2026-10-22-003 — static template-key normalization', () => {
  it('preserves Unicode line separators when rewriting template keys', () => {
    const source = [
      'const translations = {',
      '  `before\u2028after`: "first",',
      '  `next\u2029key`: "second",',
      '};',
      'export default translations;',
    ].join('\n');

    const parsed = parseStaticSource(source, 'static-template-separators.ts', {
      normalizeTemplatePropertyNames: true,
    });
    const properties = readStaticObjectProperties(findTopLevelObjects(parsed)[0]);

    expect(properties.map((property) => staticPropertyName(property.name))).toEqual([
      'before\u2028after',
      'next\u2029key',
    ]);
  });
});
