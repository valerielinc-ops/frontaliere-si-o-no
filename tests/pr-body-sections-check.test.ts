/**
 * pr-body-sections-check — regression tests for the deterministic validator of
 * PR body section CONTENT quality (scripts/lib/pr-body-sections-check.mjs).
 *
 * Guards the escalation bucket `reviewer-finding/pr-body-contract` (#3250):
 * pr-body-contract.yml checks header PRESENCE only; this module checks whether
 * the sections have substantive content vs bare `- ` placeholder bullets.
 */

import { describe, it, expect } from 'vitest';
import {
  checkPrBodySections,
  extractSection,
  stripNonContent,
  isSubstantiveBullet,
  hasMeaningfulContent,
  hasOnlyBareBullets,
  hasNessuno,
} from '../scripts/lib/pr-body-sections-check.mjs';

// ---------------------------------------------------------------------------
// Helper to build a minimal valid PR body
// ---------------------------------------------------------------------------
function makeBody({
  implHeader = '## Implementato',
  implContent = '- Fixed the foo in bar.mjs\n',
  nonImplHeader = '## Non implementato (ancora)',
  nonImplContent = 'Nessuno.',
} = {}) {
  return `${implHeader}\n\n${implContent}\n${nonImplHeader}\n\n${nonImplContent}\n`;
}

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------
describe('extractSection', () => {
  it('returns content between the matched header and the next heading', () => {
    const body = '## Implementato\n- foo\n## Non implementato (ancora)\nNessuno.\n';
    const re = /^#{2,3}\s+Implementato\b/im;
    const result = extractSection(body, re);
    expect(result).toContain('- foo');
    expect(result).not.toContain('Non implementato');
  });

  it('returns everything to EoF when there is no next heading', () => {
    const body = '## Implementato\n- foo\n- bar\n';
    const re = /^#{2,3}\s+Implementato\b/im;
    const result = extractSection(body, re);
    expect(result).toBe('\n- foo\n- bar\n');
  });

  it('returns null when header is absent', () => {
    expect(extractSection('no headers here', /^## Implementato/im)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripNonContent
// ---------------------------------------------------------------------------
describe('stripNonContent', () => {
  it('removes HTML comments', () => {
    const result = stripNonContent('hello <!-- comment --> world');
    expect(result).not.toContain('comment');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('removes fenced code blocks', () => {
    const result = stripNonContent('before\n```\nsome code\n```\nafter');
    expect(result).not.toContain('some code');
    expect(result).toContain('after');
  });

  it('leaves normal text unchanged', () => {
    expect(stripNonContent('- Fixed the bug')).toBe('- Fixed the bug');
  });
});

// ---------------------------------------------------------------------------
// isSubstantiveBullet
// ---------------------------------------------------------------------------
describe('isSubstantiveBullet', () => {
  it('returns true for bullets with content', () => {
    expect(isSubstantiveBullet('- Fixed the foo')).toBe(true);
    expect(isSubstantiveBullet('* Added bar')).toBe(true);
    expect(isSubstantiveBullet('+ Updated baz')).toBe(true);
    expect(isSubstantiveBullet('  - Indented bullet with text')).toBe(true);
  });

  it('returns false for bare placeholder bullets', () => {
    expect(isSubstantiveBullet('- ')).toBe(false);
    expect(isSubstantiveBullet('-')).toBe(false);
    expect(isSubstantiveBullet('*')).toBe(false);
    expect(isSubstantiveBullet('  - ')).toBe(false);
    expect(isSubstantiveBullet('- \t')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasMeaningfulContent
// ---------------------------------------------------------------------------
describe('hasMeaningfulContent', () => {
  it('returns true when there is a substantive bullet', () => {
    expect(hasMeaningfulContent('\n- Fixed the foo\n')).toBe(true);
  });

  it('returns true when there is non-bullet prose', () => {
    expect(hasMeaningfulContent('\nNessuno.\n')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasMeaningfulContent('')).toBe(false);
  });

  it('returns false for only whitespace', () => {
    expect(hasMeaningfulContent('   \n\n   ')).toBe(false);
  });

  it('returns false for only HTML comments', () => {
    expect(hasMeaningfulContent('<!-- fill this in -->')).toBe(false);
  });

  it('returns false for only bare placeholder bullets', () => {
    expect(hasMeaningfulContent('\n- \n- \n')).toBe(false);
  });

  it('returns true even if some bullets are bare but one has content', () => {
    expect(hasMeaningfulContent('\n- \n- actual content\n- \n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasOnlyBareBullets
// ---------------------------------------------------------------------------
describe('hasOnlyBareBullets', () => {
  it('returns true when all bullets are bare placeholders', () => {
    expect(hasOnlyBareBullets('\n- \n- \n')).toBe(true);
  });

  it('returns false when there is at least one substantive bullet', () => {
    expect(hasOnlyBareBullets('\n- \n- content\n')).toBe(false);
  });

  it('returns false for empty content (distinct from "only bare")', () => {
    expect(hasOnlyBareBullets('')).toBe(false);
  });

  it('ignores HTML comments in judgment', () => {
    expect(hasOnlyBareBullets('\n<!-- comment -->\n- \n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasNessuno
// ---------------------------------------------------------------------------
describe('hasNessuno', () => {
  it('detects "Nessuno"', () => {
    expect(hasNessuno('Nessuno.')).toBe(true);
    expect(hasNessuno('nessuno')).toBe(true);
    expect(hasNessuno('Nessuna.')).toBe(true);
    expect(hasNessuno('NESSUNO')).toBe(true);
  });

  it('returns false for content without Nessuno', () => {
    expect(hasNessuno('- Some deferred scope')).toBe(false);
    expect(hasNessuno('')).toBe(false);
  });

  it('ignores Nessuno inside HTML comments', () => {
    expect(hasNessuno('<!-- Nessuno -->')).toBe(false);
  });

  it('detects Nessuno when alongside other text', () => {
    expect(hasNessuno('- Nessuno — task completo\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkPrBodySections — valid bodies
// ---------------------------------------------------------------------------
describe('checkPrBodySections — accepts valid bodies', () => {
  it('accepts the canonical minimal body', () => {
    const body = makeBody();
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('accepts ## Non implementato (ancora) with "Nessuno"', () => {
    expect(checkPrBodySections(makeBody({ nonImplContent: 'Nessuno.' })).ok).toBe(true);
    expect(checkPrBodySections(makeBody({ nonImplContent: 'Nessuno' })).ok).toBe(true);
    expect(checkPrBodySections(makeBody({ nonImplContent: 'Nessuna.' })).ok).toBe(true);
  });

  it('accepts ## Non implementato (ancora) with substantive bullets', () => {
    const body = makeBody({
      nonImplContent: '- Wiring into pr-body-contract.yml — blocked: requires workflow scope\n',
    });
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('accepts multiple bullets in ## Implementato', () => {
    const body = makeBody({
      implContent: '- Fixed foo.ts\n- Updated bar.mjs\n- Added tests\n',
    });
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('accepts ### (h3) header variants', () => {
    const body = '### Implementato\n\n- Fixed foo\n\n### Non implementato (ancora)\n\nNessuno.\n';
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('accepts body with HTML comments in template (comments stripped)', () => {
    const body =
      '## Implementato\n' +
      '<!-- Cosa fa la PR. Bullet concreti: file/comportamento cambiato. -->\n' +
      '- Fixed the selector in foo-parser.mjs\n\n' +
      '## Non implementato (ancora)\n' +
      '<!-- PIANO DI COMPLETAMENTO -->\n' +
      'Nessuno.\n';
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('accepts ## Non implementato (ancora) with trailing text on header line', () => {
    const body =
      '## Implementato\n\n- foo\n\n## Non implementato (ancora) — piano di completamento\n\nNessuno.\n';
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('returns empty violations array when ok', () => {
    const res = checkPrBodySections(makeBody());
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkPrBodySections — violations: missing headers
// ---------------------------------------------------------------------------
describe('checkPrBodySections — missing headers', () => {
  it('flags missing ## Implementato', () => {
    const body = '## Summary\n\n- foo\n\n## Non implementato (ancora)\n\nNessuno.\n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-implementato')).toBe(true);
  });

  it('flags ## Fix instead of ## Implementato', () => {
    const body = '## Fix\n\n- foo\n\n## Non implementato (ancora)\n\nNessuno.\n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-implementato')).toBe(true);
  });

  it('flags ## Verify instead of ## Implementato', () => {
    const body = '## Verify\n\n- foo\n\n## Non implementato (ancora)\n\nNessuno.\n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-implementato')).toBe(true);
  });

  it('flags missing ## Non implementato (ancora) entirely', () => {
    const body = '## Implementato\n\n- foo\n\nSome other content.\n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-non-implementato')).toBe(true);
  });

  it('flags ## Non implementato without (ancora) — wrong canonical name', () => {
    const body = '## Implementato\n\n- foo\n\n## Non implementato\n\nNessuno.\n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-ancora')).toBe(true);
  });

  it('flags both sections missing', () => {
    const res = checkPrBodySections('Just plain text with no sections.');
    expect(res.ok).toBe(false);
    const types = res.violations.map((v) => v.type);
    expect(types).toContain('missing-implementato');
    expect(types).toContain('missing-non-implementato');
  });

  it('flags empty string', () => {
    const res = checkPrBodySections('');
    expect(res.ok).toBe(false);
  });

  it('flags null/undefined gracefully', () => {
    expect(checkPrBodySections(null as unknown as string).ok).toBe(false);
    expect(checkPrBodySections(undefined as unknown as string).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkPrBodySections — violations: empty / placeholder content
// ---------------------------------------------------------------------------
describe('checkPrBodySections — empty/placeholder content', () => {
  it('flags ## Implementato with only bare `- ` template placeholder', () => {
    const body = makeBody({ implContent: '-\n' });
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-implementato')).toBe(true);
  });

  it('flags ## Implementato with multiple bare bullet placeholders', () => {
    const body = makeBody({ implContent: '- \n- \n- \n' });
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-implementato')).toBe(true);
  });

  it('flags ## Implementato with only HTML comments', () => {
    const body = makeBody({ implContent: '<!-- Cosa fa la PR -->\n' });
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-implementato')).toBe(true);
  });

  it('flags ## Non implementato (ancora) with only bare `- ` placeholder', () => {
    const body = makeBody({ nonImplContent: '-\n' });
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-non-implementato')).toBe(true);
  });

  it('flags ## Non implementato (ancora) with only HTML template comment', () => {
    const body = makeBody({
      nonImplContent:
        '<!-- PIANO DI COMPLETAMENTO del task. "Nessuno" = task completo e live. -->\n-\n',
    });
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-non-implementato')).toBe(true);
  });

  it('does NOT flag when ## Implementato has one real bullet and some bare ones', () => {
    const body = makeBody({ implContent: '- Real content here\n- \n- \n' });
    expect(checkPrBodySections(body).ok).toBe(true);
  });

  it('does NOT flag ## Non implementato (ancora) with "Nessuno" even with surrounding bare bullets', () => {
    const body = makeBody({ nonImplContent: '- \nNessuno.\n- \n' });
    expect(checkPrBodySections(body).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-world PR body patterns from failing examples (#3191, #3240)
// ---------------------------------------------------------------------------
describe('checkPrBodySections — real-world violation patterns', () => {
  it('#3191 pattern: body opened with ## Summary instead of ## Implementato', () => {
    const body =
      '## Summary\n' +
      '- Added missing sitemap entry for /autori/samuele-valente/\n\n' +
      '## Implementato\n' +
      '- `public/sitemap-pages.xml`: added missing url block\n\n' +
      '## Non implementato\n' +
      '- No change needed for the author photo\n';
    const res = checkPrBodySections(body);
    // ## Implementato IS present so missing-implementato won't fire, but
    // ## Non implementato without "(ancora)" WILL fire.
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'missing-ancora')).toBe(true);
  });

  it('#3240 pattern: body with ## Non implementato content that has bare placeholder', () => {
    const body =
      '## Implementato\n' +
      '- `post-merge-followup.yml` switched to `--dangerously-skip-permissions`.\n\n' +
      '## Non implementato (ancora)\n' +
      '- \n';
    const res = checkPrBodySections(body);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.type === 'empty-non-implementato')).toBe(true);
  });

  it('accepts the current correct PR body format', () => {
    const body =
      '## Implementato\n' +
      '- `scripts/lib/pr-body-sections-check.mjs`: new zero-Claude deterministic validator\n' +
      '  for PR body section content quality.\n' +
      '- `tests/pr-body-sections-check.test.ts`: unit tests.\n\n' +
      'Closes #3250\n\n' +
      '## Non implementato (ancora)\n' +
      '- Wiring the check into `pr-body-contract.yml` as a CI step — blocked: ' +
      'requires PAT with `workflows` scope (separate PR).\n';
    expect(checkPrBodySections(body).ok).toBe(true);
  });
});
