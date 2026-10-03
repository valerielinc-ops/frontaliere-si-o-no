import { maskSeoSource } from './seo-entry.mjs';
import { decodeTsStringEscapes } from './tsStringEscapes';

export interface ArticleRegistryMetadata {
  id: string;
  category?: string;
  image?: string;
  updatedAt?: string;
  authorSlug?: string;
  authorName?: string;
}

/**
 * Read direct string fields from generated top-level registry array entries, without
 * importing/evaluating the registry. The source mask makes strings/comments
 * inert, and the delimiter stack keeps optional fields inside their own entry.
 * The generated registry uses identifier property keys (id, updatedAt, etc.).
 */
export function readArticleRegistryMetadata(source: string): ArticleRegistryMetadata[] {
  const masked = maskSeoSource(source, 'article registry');
  type Frame = { delimiter: string; directArrayEntry: boolean; fields: Record<string, string> };
  const stack: Frame[] = [];
  const records: ArticleRegistryMetadata[] = [];
  const fields = new Set(['id', 'category', 'image', 'updatedAt', 'authorSlug', 'authorName']);
  const seen = new Set<string>();
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if ('{[('.includes(char)) {
      stack.push({ delimiter: char, directArrayEntry: char === '{' && stack.length === 1 && stack.at(-1)?.delimiter === '[', fields: {} });
      continue;
    }
    if ('}])'.includes(char)) {
      const frame = stack.pop();
      if (!frame || '{[('.indexOf(frame.delimiter) !== '}])'.indexOf(char)) {
        throw new SyntaxError('Unbalanced article registry');
      }
      if (frame.directArrayEntry && frame.fields.id) {
        if (seen.has(frame.fields.id)) throw new SyntaxError(`Duplicate article registry id: ${frame.fields.id}`);
        seen.add(frame.fields.id);
        records.push({ ...frame.fields, id: frame.fields.id });
      }
      continue;
    }
    const frame = stack.at(-1);
    if (!frame?.directArrayEntry || !/[A-Za-z_$]/.test(char)) continue;
    let end = index + 1;
    while (/[\w$]/.test(masked[end] ?? '')) end++;
    const key = masked.slice(index, end);
    index = end - 1;
    if (!fields.has(key)) continue;
    while (/\s/.test(masked[end] ?? '')) end++;
    if (masked[end] !== ':') continue;
    let valueStart = end + 1;
    // Skip whitespace and comments without skipping the masked string value.
    while (valueStart < source.length) {
      if (/\s/.test(source[valueStart])) { valueStart++; continue; }
      if (source.startsWith('//', valueStart)) {
        const newline = source.indexOf('\n', valueStart + 2);
        valueStart = newline < 0 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith('/*', valueStart)) {
        const close = source.indexOf('*/', valueStart + 2);
        if (close < 0) throw new SyntaxError('Unclosed article registry comment');
        valueStart = close + 2;
        continue;
      }
      break;
    }
    const quote = source[valueStart];
    if (quote !== "'" && quote !== '"') continue;
    let valueEnd = valueStart + 1;
    while (valueEnd < source.length && source[valueEnd] !== quote) {
      if (source[valueEnd] === '\\') valueEnd++;
      valueEnd++;
    }
    if (valueEnd === source.length) throw new SyntaxError('Unclosed article registry string');
    frame.fields[key] = decodeTsStringEscapes(source.slice(valueStart + 1, valueEnd));
    index = valueEnd;
  }
  if (stack.length) throw new SyntaxError('Unbalanced article registry');
  return records;
}
