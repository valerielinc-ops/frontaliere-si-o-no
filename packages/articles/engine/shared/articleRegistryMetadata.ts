import {
  findTopLevelStaticObjectLiterals,
  parseStaticSource,
  readStaticObjectProperties,
  readStaticBoolean,
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
  aiAssisted?: boolean;
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
  const stringFields = new Set(['id', 'category', 'date', 'image', 'updatedAt', 'authorSlug', 'authorName']);
  const fields = new Set([...stringFields, 'aiAssisted']);
  const seen = new Set<string>();
  for (const object of objects) {
    const values: Record<string, string | boolean> = {};
    for (const property of readStaticObjectProperties(object, 'article registry entry')) {
      const key = staticPropertyName(property.name);
      if (!key || !fields.has(key)) continue;
      values[key] = key === 'aiAssisted'
        ? readStaticBoolean(property.initializer, sourceFile, {
          label: `${key} in article registry entry`,
          errorPrefix: '[article-registry]',
        })
        : readStaticString(property.initializer, sourceFile, {
          label: `${key} in article registry entry`,
          errorPrefix: '[article-registry]',
        });
    }
    const id = values.id;
    if (typeof id !== 'string' || !id) continue;
    if (seen.has(id)) throw new SyntaxError(`Duplicate article registry id: ${id}`);
    seen.add(id);
    records.push({
      id,
      ...(typeof values.category === 'string' ? { category: values.category } : {}),
      ...(typeof values.date === 'string' ? { date: values.date } : {}),
      ...(typeof values.image === 'string' ? { image: values.image } : {}),
      ...(typeof values.updatedAt === 'string' ? { updatedAt: values.updatedAt } : {}),
      ...(typeof values.authorSlug === 'string' ? { authorSlug: values.authorSlug } : {}),
      ...(typeof values.authorName === 'string' ? { authorName: values.authorName } : {}),
      ...(typeof values.aiAssisted === 'boolean' ? { aiAssisted: values.aiAssisted } : {}),
    });
  }
  return records;
}
