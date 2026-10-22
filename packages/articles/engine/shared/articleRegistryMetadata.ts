import {
  findTopLevelStaticObjectLiterals,
  parseStaticSource,
  readStaticObjectProperties,
  readStaticString,
  staticPropertyName,
} from './staticSourceAst.mjs';

export interface ArticleRegistryMetadata {
  id: string;
  category?: string;
  /** `''` means the registry does not document an editorial publication date. */
  date?: string;
  image?: string;
  updatedAt?: string;
  authorSlug?: string;
  authorName?: string;
}

/**
 * Read direct string fields from generated top-level registry array entries,
 * without importing/evaluating the registry. Compiler AST nodes keep strings
 * and comments inert and keep optional fields inside their own entry. The
 * generated registry uses identifier property keys (id, updatedAt, etc.).
 */
export function readArticleRegistryMetadata(source: string): ArticleRegistryMetadata[] {
  let sourceFile;
  try {
    sourceFile = parseStaticSource(source, 'article-registry.ts', {
      errorPrefix: '[article-registry]',
    });
  } catch {
    throw new SyntaxError('Unbalanced article registry');
  }
  const objects = findTopLevelStaticObjectLiterals(sourceFile);
  if (objects.length === 0) return [];
  const records: ArticleRegistryMetadata[] = [];
  const fields = new Set(['id', 'category', 'date', 'image', 'updatedAt', 'authorSlug', 'authorName']);
  const seen = new Set<string>();
  for (const object of objects) {
    const values: Record<string, string> = {};
    for (const property of readStaticObjectProperties(object, 'article registry entry')) {
      const key = staticPropertyName(property.name);
      if (!key || !fields.has(key)) continue;
      values[key] = readStaticString(property.initializer, sourceFile, {
        label: `${key} in article registry entry`,
        errorPrefix: '[article-registry]',
      });
    }
    if (!values.id) continue;
    if (seen.has(values.id)) throw new SyntaxError(`Duplicate article registry id: ${values.id}`);
    seen.add(values.id);
    records.push({ ...values, id: values.id });
  }
  return records;
}
