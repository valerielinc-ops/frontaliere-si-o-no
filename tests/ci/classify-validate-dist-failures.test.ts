import { describe, expect, it } from 'vitest';
import {
  evaluateIntegrity,
  formatIntegrityAnnotation,
} from '../../scripts/ci/classify-validate-dist-failures.mjs';

describe('validate-dist integrity annotation', () => {
  it('states that publish is blocked when an integrity gate fails', () => {
    // An unclassified validator: the class A SEO gates (validate:sitemap-pages
    // among them) open a P1 issue and no longer block, owner 2026-10-03.
    const verdict = evaluateIntegrity([
      'validate:crawler-summaries',
      'audit:all/text-html-ratio',
    ]);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(false);
    expect(annotation).toContain('blocked publish');
    expect(annotation).toContain('validate:crawler-summaries');
    expect(annotation).toContain('Quality gate(s) also failed');
    expect(annotation).not.toContain('Publish is not sequestered');
  });

  it('keeps the non-sequestering message for quality-only failures', () => {
    const verdict = evaluateIntegrity(['audit:all/text-html-ratio']);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(true);
    expect(annotation).toContain('Publish is not sequestered');
    expect(annotation).toContain('audit:all/text-html-ratio');
  });
});
