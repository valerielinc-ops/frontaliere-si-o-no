import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isCrawlerGenerationToken } from '../scripts/lib/crawler-generation-token.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN_GRAMMAR_FRAGMENT = '[1-9][0-9]*-[1-9][0-9]*';

function productionModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionModules(absolute);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [absolute] : [];
  });
}

describe('crawler generation token SSOT', () => {
  it('owns the generation-token grammar in one leaf module', () => {
    const owners = productionModules(path.join(ROOT, 'scripts'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(TOKEN_GRAMMAR_FRAGMENT))
      .map((file) => path.relative(ROOT, file));

    expect(owners).toEqual(['scripts/lib/crawler-generation-token.mjs']);
  });

  it('keeps producer, finalizer and manifest validation on the same grammar', () => {
    for (const token of ['1-1', '9001-2', '18446744073709551616-42']) {
      expect(isCrawlerGenerationToken(token)).toBe(true);
    }
    for (const token of [null, undefined, 1, '', '0-1', '1-0', '01-1', '1-01', '1', '1-1-1']) {
      expect(isCrawlerGenerationToken(token)).toBe(false);
    }
  });

  it('routes generation-ref parsing through the leaf validator without a numeric regex owner', () => {
    const dispatchPath = path.join(ROOT, 'scripts/crawler-generation-dispatch.mjs');
    const source = fs.readFileSync(dispatchPath, 'utf8');
    const file = ts.createSourceFile(dispatchPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let parser: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseGenerationRef') parser = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(parser).toBeDefined();

    const validatorCalls: string[] = [];
    const numericRegexOwners: string[] = [];
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'isCrawlerGenerationToken') {
        validatorCalls.push(node.getText(file));
      }
      const regexText = ts.isRegularExpressionLiteral(node)
        ? node.getText(file)
        : ts.isNewExpression(node) && node.expression.getText(file) === 'RegExp'
          ? node.arguments?.map((argument) => argument.getText(file)).join(' ') ?? ''
          : '';
      if (regexText && /(\\d|\[[^\]]*[0-9][^\]]*\])/.test(regexText)) {
        numericRegexOwners.push(regexText);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parser!);

    expect(validatorCalls).toHaveLength(1);
    expect(numericRegexOwners).toEqual([]);
  });
});
