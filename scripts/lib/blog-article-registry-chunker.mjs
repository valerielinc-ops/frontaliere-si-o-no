import ts from 'typescript';

/**
 * Bound TypeScript's inferred union when the article corpus is mirrored into
 * the site. The chunks retain the same literal values, but each array is
 * contextually typed before the aggregate spreads them together.
 */
export function chunkBlogArticleRegistry(source, chunkSize = 250) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError('chunkSize must be a positive integer');
  }
  if (source.includes('const RAW_ARTICLES_CHUNK_01')) {
    return { source, chunkCount: 0 };
  }

  const sourceFile = ts.createSourceFile(
    'blog-articles-data.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'RAW_ARTICLES') {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let initializer = declaration?.initializer;
  while (
    initializer
    && (ts.isSatisfiesExpression(initializer)
      || ts.isAsExpression(initializer)
      || ts.isParenthesizedExpression(initializer))
  ) {
    initializer = initializer.expression;
  }
  if (!declaration || !initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error('[pull-articles-corpus] RAW_ARTICLES array not found in blog registry');
  }

  const elements = initializer.elements.map((element) => {
    const fullText = source.slice(element.getFullStart(), element.end);
    const indent = fullText.match(/^(?:\r?\n)([\t ]*)/)?.[1] ?? ' ';
    return { text: fullText.trim(), indent };
  });
  const chunks = [];
  for (let i = 0; i < elements.length; i += chunkSize) {
    chunks.push(elements.slice(i, i + chunkSize));
  }

  const declarations = chunks.map((items, index) => {
    const name = `RAW_ARTICLES_CHUNK_${String(index + 1).padStart(2, '0')}`;
    return [
      `const ${name}: Article[] = [`,
      ...items.map(({ text, indent }) => `${indent}${text},`),
      '];',
    ].join('\n');
  }).join('\n\n');
  const aggregate = [
    'const RAW_ARTICLES: Article[] = [',
    ...chunks.map((_, index) =>
      ` ...RAW_ARTICLES_CHUNK_${String(index + 1).padStart(2, '0')},`),
    '] satisfies Article[];',
  ].join('\n');

  const statement = declaration.parent?.parent;
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error('[pull-articles-corpus] RAW_ARTICLES declaration has no variable statement');
  }
  const replacement = `${declarations}\n\n${aggregate}`;
  return {
    source: source.slice(0, statement.getStart(sourceFile))
      + replacement
      + source.slice(statement.end),
    chunkCount: chunks.length,
  };
}
