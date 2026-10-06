import ts from 'typescript';

/**
 * The article registries mirrored from the corpus. Keep this list next to the
 * generic transformer so the pull and its invariant test share one source of
 * truth about which growing arrays need the TypeScript-safe representation.
 */
export const ARTICLE_REGISTRY_CHUNK_CONFIGS = [
  {
    file: 'blog-articles-data.ts',
    declarationName: 'RAW_ARTICLES',
    chunkPrefix: 'RAW_ARTICLES_CHUNK',
  },
  {
    file: 'swiss-articles-data.ts',
    declarationName: 'RAW_SWISS_ARTICLES',
    chunkPrefix: 'RAW_SWISS_ARTICLES_CHUNK',
  },
];

/**
 * Bound TypeScript's inferred union when the article corpus is mirrored into
 * the site. The chunks retain the same literal values, but each array is
 * contextually typed before the aggregate spreads them together.
 */
export function chunkArticleRegistry(
  source,
  {
    fileName,
    declarationName,
    chunkPrefix,
    chunkSize = 250,
  } = {},
) {
  if (typeof source !== 'string') {
    throw new TypeError('source must be a string');
  }
  for (const [label, value] of [
    ['fileName', fileName],
    ['declarationName', declarationName],
    ['chunkPrefix', chunkPrefix],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError('chunkSize must be a positive integer');
  }
  if (source.includes(`const ${chunkPrefix}_01`)) {
    return { source, chunkCount: 0 };
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === declarationName) {
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
    throw new Error(
      `[pull-articles-corpus] ${declarationName} array not found in ${fileName}`,
    );
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
    const name = `${chunkPrefix}_${String(index + 1).padStart(2, '0')}`;
    return [
      `const ${name}: Article[] = [`,
      ...items.map(({ text, indent }) => `${indent}${text},`),
      '];',
    ].join('\n');
  }).join('\n\n');
  const aggregate = [
    `const ${declarationName}: Article[] = [`,
    ...chunks.map((_, index) =>
      ` ...${chunkPrefix}_${String(index + 1).padStart(2, '0')},`),
    '] satisfies Article[];',
  ].join('\n');

  const statement = declaration.parent?.parent;
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error(
      `[pull-articles-corpus] ${declarationName} declaration has no variable statement`,
    );
  }
  const replacement = `${declarations}\n\n${aggregate}`;
  return {
    source: source.slice(0, statement.getStart(sourceFile))
      + replacement
      + source.slice(statement.end),
    chunkCount: chunks.length,
  };
}
