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

  it('candidate-only parsing keeps only facts needed by the changed symbols', () => {
    const changed = collectAstFacts(
      'services/guard.ts',
      'export function guardSession() { return true; }',
      { files: new Set(['services/guard.ts', 'components/Panel.tsx']) },
    );
    const changedFacts = factsContainingToken(changed, 'guardSession');
    const factKeys = new Set([
      'identifier|guardSession|declaration',
      'identifier|guardSession|call',
      'identifier|guardSession|reference',
    ]);
    const candidate = collectAstFacts(
      'components/Panel.tsx',
      [
        'const unrelated = noisyHelper(value);',
        'const allowed = guardSession();',
        'function noisyHelper(value) { return value; }',
      ].join('\n'),
      {
        files: new Set(['services/guard.ts', 'components/Panel.tsx']),
        candidateOnly: true,
        factKeys,
      },
    );

    expect(candidate.some((fact) => fact.key === 'guardSession')).toBe(true);
    expect(candidate.some((fact) => fact.key === 'noisyHelper')).toBe(false);
    expect(matchAstFacts(changedFacts, candidate).length).toBeGreaterThan(0);
  });

  it('recognizes exported variable declarations and surfaces their consumers', () => {
    const changed = collectAstFacts(
      'services/guard.ts',
      [
        'export const guardSession = () => true;',
        'export let alternateGuard = guardSession;',
        'export var legacyGuard = guardSession;',
      ].join('\n'),
      { files: new Set(['services/guard.ts', 'components/Panel.tsx']) },
    );
    const declarations = ['guardSession', 'alternateGuard', 'legacyGuard'].map((name) =>
      changed.find((fact) =>
        fact.kind === 'identifier' && fact.role === 'declaration' && fact.key === name));
    const candidate = collectAstFacts(
      'components/Panel.tsx',
      'const allowed = guardSession();',
      { files: new Set(['services/guard.ts', 'components/Panel.tsx']) },
    );

    expect(declarations.every((declaration) => declaration?.exported === true)).toBe(true);
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

  it('does not promote directly imported package calls to sibling evidence', () => {
    const changed = collectAstFacts(
      'scripts/parser.mjs',
      [
        "import { createSourceFile } from 'typescript';",
        'const source = createSourceFile(name, text, target);',
      ].join('\n'),
      { files: new Set(['scripts/parser.mjs', 'scripts/other-parser.mjs']) },
    );
    const candidate = collectAstFacts(
      'scripts/other-parser.mjs',
      [
        "import { createSourceFile } from 'typescript';",
        'const source = createSourceFile(other, text, target);',
      ].join('\n'),
      { files: new Set(['scripts/parser.mjs', 'scripts/other-parser.mjs']) },
    );
    const changedCalls = factsContainingToken(changed, 'createSourceFile');

    expect(changedCalls.some((fact) => fact.kind === 'identifier' && fact.role === 'call')).toBe(true);
    expect(changedCalls.some(isActionableAstFact)).toBe(false);
    expect(matchAstFacts(changedCalls, candidate)).toEqual([]);
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
  it.each([
    'Buffer.isBuffer(input)',
    'globalThis.Buffer.isBuffer(input)',
    'Array.isArray(input)',
    'Object.fromEntries(input)',
    'JSON.stringify(input)',
    'URL.createObjectURL(input)',
    'structuredClone(input)',
    'process.memoryUsage()',
  ])('does not turn runtime API %s into a project relationship', (expression) => {
    const facts = collectAstFacts('scripts/global.mjs', `const value = ${expression};`);
    expect(facts.filter(isActionableAstFact)).toEqual([]);
  });

  it('filters runtime aliases and destructured package APIs', () => {
    const facts = collectAstFacts('scripts/aliases.mjs', [
      "import * as fs from 'node:fs';",
      'const { readFileSync: readContents } = fs;',
      'const { isBuffer: isBytes } = Buffer;',
      'const Bytes = Buffer;',
      'readContents(input); isBytes(input); Bytes.isBuffer(input);',
    ].join('\n'));
    expect(facts.filter(isActionableAstFact)).toEqual([]);
  });

  it('resolves project symbols before globals, without leaking shadows between scopes', () => {
    const facts = collectAstFacts('scripts/local.mjs', [
      "import { Buffer } from './byte-domain.mjs';",
      'Buffer.isBuffer(input);',
      'function unrelated(Buffer) { return Buffer.isBuffer(other); }',
    ].join('\n'), { files: new Set(['scripts/local.mjs', 'scripts/byte-domain.mjs']) });
    const calls = facts.filter((fact) => fact.kind === 'call' && fact.key === 'Buffer.isBuffer');
    expect(calls).toHaveLength(2);
    expect(calls[0].binding.module).toBe('scripts/byte-domain.mjs');
    expect(calls[1].binding.module).toBe('local:scripts/local.mjs');
    expect(calls.every(isActionableAstFact)).toBe(true);
    const globals = collectAstFacts('scripts/global.mjs', [
      'Buffer.isBuffer(input);',
      'function unrelated(Buffer) { return Buffer.isBuffer(other); }',
    ].join('\n'));
    expect(globals.find((fact) => fact.kind === 'call')?.binding.module).toBe('external:runtime');
  });

  it('does not match imports alone or unrelated exported declarations', () => {
    const files = new Set(['scripts/one.mjs', 'scripts/two.mjs', 'scripts/shared.mjs']);
    const changed = collectAstFacts('scripts/one.mjs', [
      "import { normalizeText } from './shared.mjs';",
      'export function readZipEntry() { return 1; }',
    ].join('\n'), { files });
    const candidate = collectAstFacts('scripts/two.mjs', [
      "import { normalizeText } from './shared.mjs';",
      'export function readZipEntry() { return 2; }',
    ].join('\n'), { files });
    expect(matchAstFacts(changed, candidate)).toEqual([]);
  });

  it('retains graph evidence for consumers of a changed exported helper', () => {
    const files = new Set(['scripts/one.mjs', 'scripts/two.mjs']);
    const changed = collectAstFacts('scripts/one.mjs', 'export function normalizeText(value) { return value.trim(); }', { files });
    const candidate = collectAstFacts('scripts/two.mjs', "import { normalizeText } from './one.mjs';\nnormalizeText(input);", { files });
    expect(astMatchLabels(matchAstFacts(changed, candidate)))
      .toContain('graph:scripts/one.mjs#normalizeText');
  });

  it('retains different call occurrences so a later changed argument is not lost', () => {
    const facts = collectAstFacts('scripts/one.mjs', 'domainGuard(first); domainGuard(second);');
    expect(facts.filter((fact) => fact.kind === 'call').map((fact) => fact.fingerprint))
      .toEqual(['domainGuard(first)', 'domainGuard(second)']);
  });

  it('retains project hooks installed on a global container', () => {
    const changed = collectAstFacts('scripts/one.mjs', 'globalThis.validateDomainJob(input);');
    const candidate = collectAstFacts('scripts/two.mjs', 'globalThis.validateDomainJob(other);');
    expect(matchAstFacts(changed, candidate).some((match) => match.key === 'globalThis.validateDomainJob')).toBe(true);
  });

  it('keeps global-container aliases precise and does not classify local require as a package', () => {
    const facts = collectAstFacts('scripts/one.mjs', [
      'const runtime = globalThis;',
      'runtime.Buffer.isBuffer(input);',
      'runtime.validateDomainJob(input);',
      "const project = require('./project.mjs');",
      'project.validateDomainJob(input);',
    ].join('\n'));
    const calls = facts.filter((fact) => fact.kind === 'call');
    expect(calls.find((fact) => fact.key === 'runtime.Buffer.isBuffer')?.binding.module).toBe('external:runtime');
    expect(calls.filter(isActionableAstFact).map((fact) => fact.key))
      .toContain('runtime.validateDomainJob');
    expect(calls.filter(isActionableAstFact).map((fact) => fact.key))
      .toContain('project.validateDomainJob');
  });

  it('leaves workflow and shell sources to the lexical checker instead of binding them as JS', () => {
    const yaml = 'jobs:\n  check:\n    steps:\n      - run: |\n          const values = paths.map((item) => item.name).join("/");';
    expect(collectAstFacts('.github/workflows/check.yml', yaml)).toEqual([]);
    expect(collectAstFacts('scripts/check.sh', 'echo "$HOME"')).toEqual([]);
  });

  it('does not confuse an export-list binding with a shadowing parameter', () => {
    const files = new Set(['scripts/one.mjs', 'scripts/consumer.mjs']);
    const source = 'const Buffer = {}; export { Buffer }; function wrapper(Buffer) { return Buffer.isBuffer(value); }';
    const facts = collectAstFacts('scripts/one.mjs', source, { files });
    const calls = facts.filter((fact) => fact.kind === 'call');
    expect(calls[0].binding.module).toBe('local:scripts/one.mjs');
    const consumer = collectAstFacts('scripts/consumer.mjs', "import { Buffer } from './one.mjs'; Buffer.isBuffer(value);", { files });
    expect(matchAstFacts(calls, consumer)).toEqual([]);
    const exported = facts.filter((fact) => fact.kind === 'identifier' && fact.role === 'declaration' && fact.exported);
    expect(exported.map((fact) => fact.key)).toEqual(['Buffer']);
  });

  it('does not export a private same-named binding through a reexport', () => {
    const facts = collectAstFacts('scripts/one.mjs', "export { guardSession } from './shared.mjs'; function guardSession() {}", {
      files: new Set(['scripts/one.mjs', 'scripts/shared.mjs']),
    });
    expect(facts.filter((fact) => fact.kind === 'identifier' && fact.role === 'declaration' && fact.exported)).toEqual([]);
  });

  it('retains an aliased project consumer in candidate-only parsing', () => {
    const files = new Set(['scripts/provider.mjs', 'scripts/consumer.mjs', 'scripts/other.mjs']);
    const changed = collectAstFacts('scripts/provider.mjs', 'export function guardSession() { return true; }', { files });
    const options = { files, candidateOnly: true,
      factKeys: new Set(['identifier|guardSession|call', 'identifier|guardSession|declaration']),
      bindingKeys: new Set(['scripts/provider.mjs#guardSession']),
    };
    const consumer = collectAstFacts('scripts/consumer.mjs', "import { guardSession as runGuard } from './provider.mjs'; runGuard();", options);
    expect(consumer.some((fact) => fact.key === 'runGuard' && fact.role === 'call')).toBe(true);
    expect(astMatchLabels(matchAstFacts(changed, consumer))).toContain('graph:scripts/provider.mjs#guardSession');
    const unrelated = collectAstFacts('scripts/consumer.mjs', "import { guardSession as runGuard } from './other.mjs'; runGuard();", options);
    expect(matchAstFacts(changed, unrelated)).toEqual([]);
  });

  it('does not equate different methods on aliases of the same imported object', () => {
    const files = new Set(['scripts/provider.mjs', 'scripts/one.mjs', 'scripts/two.mjs']);
    const one = collectAstFacts('scripts/one.mjs', "import { client } from './provider.mjs'; client.readSession();", { files });
    const two = collectAstFacts('scripts/two.mjs', "import { client as other } from './provider.mjs'; other.clearSession();", { files });
    expect(matchAstFacts(one, two)).toEqual([]);
  });

  it('filters changed lines before aggregating identical call evidence', () => {
    const facts = collectAstFacts('scripts/one.mjs', 'guardSession(value);\nguardSession(value);', {
      lineRanges: [{ start: 2, end: 2 }],
    });
    expect(facts.filter((fact) => fact.kind === 'call').map((fact) => fact.fingerprint)).toEqual(['guardSession(value)']);
    const candidate = collectAstFacts('scripts/two.mjs', 'guardSession(value);');
    expect(matchAstFacts(facts, candidate).some((match) => match.key === 'guardSession')).toBe(true);
  });

});
