import { describe, expect, it } from 'vitest';
import {
  astMatchLabels,
  collectAstFacts,
  diffLineRanges,
  factsContainingToken,
  isActionableAstFact,
  isAstSourceFile,
  matchAstFacts,
  resolveRelativeModule,
} from '../scripts/ci/lib/sibling-ast-graph.mjs';

describe('sibling AST layer', () => {
  it('parses changed-side hunk ranges without treating deleted lines as new code', () => {
    const diff = [
      '@@ -4,2 +4,3 @@ function demo() {',
      ' context',
      '+  const result = call();',
      ' context',
    ].join('\n');

    expect(diffLineRanges(diff, 'new')).toEqual([{ start: 4, end: 6 }]);
    expect(diffLineRanges(diff, 'old')).toEqual([{ start: 4, end: 5 }]);
  });

  it('resolves a relative import against the files in the inspected revision', () => {
    const files = new Set(['components/Widget.tsx', 'services/adsConsent.ts']);
    expect(resolveRelativeModule('components/Widget.tsx', '../services/adsConsent', files))
      .toBe('services/adsConsent.ts');
    expect(resolveRelativeModule('components/Widget.tsx', '@/services/adsConsent', files))
      .toBe('services/adsConsent.ts');
    expect(resolveRelativeModule('components/Widget.tsx', 'typescript', files)).toBeNull();
  });

  it('matches calls structurally and ignores comments and string contents', () => {
    const changed = collectAstFacts(
      'components/Widget.tsx',
      [
        "import { isAdsConsentGranted as granted } from '../services/adsConsent';",
        'const allowed = granted();',
        "const text = 'granted()'; // granted()",
      ].join('\n'),
      {
        lineRanges: [{ start: 2, end: 2 }],
        files: new Set(['components/Widget.tsx', 'services/adsConsent.ts']),
      },
    );
    const candidate = collectAstFacts(
      'components/OtherWidget.tsx',
      [
        "import { isAdsConsentGranted as granted } from '../services/adsConsent';",
        'const allowed = granted();',
        "const text = 'granted()'; // granted()",
      ].join('\n'),
      { files: new Set(['components/OtherWidget.tsx', 'services/adsConsent.ts']) },
    );

    const changedFacts = factsContainingToken(changed, 'granted');
    const matches = matchAstFacts(changedFacts, candidate);
    expect(matches.some((match) => match.kind === 'call' && match.key === 'granted')).toBe(true);
    expect(astMatchLabels(matches)).toContain('graph:services/adsConsent.ts#isAdsConsentGranted');

    const commentAndStringOnly = collectAstFacts(
      'components/Noise.tsx',
      "const text = 'granted()'; // granted()",
      { files: new Set(['components/Noise.tsx']) },
    );
    expect(matchAstFacts(changedFacts, commentAndStringOnly)).toEqual([]);
  });

  it('rejects the same local name when it resolves to a different module', () => {
    const changed = collectAstFacts(
      'components/Widget.tsx',
      [
        "import { isAdsConsentGranted as granted } from '../services/adsConsent';",
        'const allowed = granted();',
      ].join('\n'),
      { files: new Set(['components/Widget.tsx', 'services/adsConsent.ts']) },
    );
    const candidate = collectAstFacts(
      'components/OtherWidget.tsx',
      [
        "import { isAdsConsentGranted as granted } from '../services/otherConsent';",
        'const allowed = granted();',
      ].join('\n'),
      {
        files: new Set([
          'components/OtherWidget.tsx',
          'services/adsConsent.ts',
          'services/otherConsent.ts',
        ]),
      },
    );

    expect(matchAstFacts(factsContainingToken(changed, 'granted'), candidate)).toEqual([]);
  });

  it('lets a changed declaration surface consumers of that declaration', () => {
    const changed = collectAstFacts(
      'services/guard.ts',
      'export function guardSession() { return true; }',
      { files: new Set(['services/guard.ts', 'components/Panel.tsx']) },
    );
    const candidate = collectAstFacts(
      'components/Panel.tsx',
      'const allowed = guardSession();',
      { files: new Set(['services/guard.ts', 'components/Panel.tsx']) },
    );

    expect(matchAstFacts(factsContainingToken(changed, 'guardSession'), candidate).length)
      .toBeGreaterThan(0);
  });

  it('does not promote package APIs or generic property names to sibling evidence', () => {
    const changed = collectAstFacts(
      'scripts/parser.mjs',
      [
        "import ts from 'typescript';",
        'const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest);',
        'const propertyName = node.propertyName;',
      ].join('\n'),
      { files: new Set(['scripts/parser.mjs', 'scripts/other-parser.mjs']) },
    );
    const candidate = collectAstFacts(
      'scripts/other-parser.mjs',
      [
        "import ts from 'typescript';",
        'const sourceFile = ts.createSourceFile(other, text, ts.ScriptTarget.Latest);',
        'const propertyName = otherNode.propertyName;',
      ].join('\n'),
      { files: new Set(['scripts/parser.mjs', 'scripts/other-parser.mjs']) },
    );

    expect(factsContainingToken(changed, 'createSourceFile').some(isActionableAstFact)).toBe(false);
    expect(matchAstFacts(factsContainingToken(changed, 'createSourceFile'), candidate)).toEqual([]);
    expect(matchAstFacts(factsContainingToken(changed, 'propertyName'), candidate)).toEqual([]);
  });

  it('does not match same-named private helpers from different files', () => {
    const changed = collectAstFacts(
      'scripts/one.mjs',
      [
        'function shellQuote(value) { return value; }',
        'const command = shellQuote(value);',
      ].join('\n'),
      { files: new Set(['scripts/one.mjs', 'scripts/two.mjs']) },
    );
    const candidate = collectAstFacts(
      'scripts/two.mjs',
      [
        'function shellQuote(value) { return value; }',
        'const command = shellQuote(value);',
      ].join('\n'),
      { files: new Set(['scripts/one.mjs', 'scripts/two.mjs']) },
    );

    expect(matchAstFacts(factsContainingToken(changed, 'shellQuote'), candidate)).toEqual([]);
    expect(isAstSourceFile('scripts/one.mjs')).toBe(true);
    expect(isAstSourceFile('scripts/tool.sh')).toBe(false);
  });
});
