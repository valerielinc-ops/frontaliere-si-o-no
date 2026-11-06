import { describe, expect, it } from 'vitest';
import {
  evaluateIntegrity,
  formatIntegrityAnnotation,
} from '../../scripts/ci/classify-validate-dist-failures.mjs';

describe('validate-dist integrity annotation', () => {
  it('states that publish is blocked only when the verdict is undetermined', () => {
    // A sentinel, not a gate: the job died before its gate step.
    const verdict = evaluateIntegrity(['__UNKNOWN__:postbuild', 'audit:all/text-html-ratio']);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(false);
    expect(annotation).toContain('blocked publish');
    expect(annotation).toContain('__UNKNOWN__:postbuild');
    expect(annotation).toContain('Quality gate(s) also failed');
    expect(annotation).not.toContain('Publish is not sequestered');
  });

  it('names an unclassified gate without sequestering publish (owner 2026-10-07)', () => {
    const verdict = evaluateIntegrity([
      'validate:crawler-summaries',
      'audit:all/text-html-ratio',
    ]);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(true);
    expect(annotation).toContain('unclassified gate(s) validate:crawler-summaries');
    expect(annotation).toContain('Classified gate(s) also failed: audit:all/text-html-ratio');
    expect(annotation).toContain('Publish is not');
    expect(annotation).not.toContain('blocked publish');
  });

  it('keeps the non-sequestering message for quality-only failures', () => {
    const verdict = evaluateIntegrity(['audit:all/text-html-ratio']);
    const annotation = formatIntegrityAnnotation(verdict);

    expect(verdict.integrityOk).toBe(true);
    expect(annotation).toContain('Publish is not sequestered');
    expect(annotation).toContain('audit:all/text-html-ratio');
  });
});
