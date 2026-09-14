import { describe, expect, it } from 'vitest';
import {
  evaluateIntegrity,
  formatIntegrityAnnotation,
} from '../../scripts/ci/classify-validate-dist-failures.mjs';

describe('validate-dist integrity annotation', () => {
  it('states that publish is blocked when an integrity gate fails', () => {
    const verdict = evaluateIntegrity([
      'validate:sitemap-pages',
      'audit:all/page-weight',
    ]);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(false);
    expect(annotation).toContain('blocked publish');
    expect(annotation).toContain('validate:sitemap-pages');
    expect(annotation).toContain('Quality gate(s) also failed');
    expect(annotation).not.toContain('Publish is not sequestered');
  });

  it('keeps the non-sequestering message for quality-only failures', () => {
    const verdict = evaluateIntegrity(['audit:all/page-weight']);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(true);
    expect(annotation).toContain('Publish is not sequestered');
    expect(annotation).toContain('audit:all/page-weight');
  });
});
