/**
 * Shared freshness-bump helpers for EVERGREEN blog articles (stable id, body
 * rewritten periodically instead of a new article per run — see AGENTS.md §6:
 * a construct duplicated across ≥2 scripts must live in one module).
 *
 * Extracted from generate-events-digest-article.mjs (issue #2963) so the
 * dogane-ranking digest (and any future evergreen digest) reuses the exact
 * same structural rewrite logic instead of a copy-pasted sibling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');
let writeTmpSeq = 0;

function assertRefreshText(content, file) {
  const invalid = [];
  const loneSurrogates = [];
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      invalid.push({ index, code });
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else loneSurrogates.push({ index, code });
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      loneSurrogates.push({ index, code });
    }
  }
  if (invalid.length > 0) {
    const detail = invalid.slice(0, 5)
      .map(({ index, code }) => `0x${code.toString(16).padStart(2, '0')}@${index}`)
      .join(', ');
    throw new Error(
      `${file}: ${invalid.length} XML-invalid control character(s) (${detail}); refresh rifiutato prima della scrittura.`,
    );
  }
  if (loneSurrogates.length > 0) {
    const detail = loneSurrogates.slice(0, 5)
      .map(({ index, code }) => `0x${code.toString(16).padStart(4, '0')}@${index}`)
      .join(', ');
    throw new Error(
      `${file}: ${loneSurrogates.length} lone surrogate(s) (${detail}); refresh rifiutato prima della scrittura.`,
    );
  }
}

function writeRefreshFile(file, content) {
  assertRefreshText(content, file);
  // data/blog-articles-data.ts is a symlink in the site checkout. Renaming on
  // the public path would replace the symlink itself, so stage beside the
  // canonical target and atomically replace that target instead.
  const target = fs.realpathSync(file);
  const temporary = `${target}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf-8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function parseTypeScript(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = parsed.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const detail = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    throw new Error(`${file}: sorgente TypeScript non valida a offset ${first.start ?? 'sconosciuto'}: ${detail}`);
  }
  return parsed;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function stringLiteralValue(property) {
  if (!property || !ts.isPropertyAssignment(property)) return null;
  return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
}

function directProperties(object, name) {
  return object.properties.filter(
    (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function articleRecords(sourceFile) {
  const records = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const first = node.properties[0];
      if (ts.isPropertyAssignment(first) && propertyName(first.name) === 'id') {
        const id = stringLiteralValue(first);
        if (id !== null) {
          records.push({ id, node });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return records;
}

function uniqueArticleRecord(sourceFile, id, operation) {
  const matches = articleRecords(sourceFile).filter((record) => record.id === id);
  if (matches.length > 1) {
    throw new Error(
      `${operation}: entry '${id}' duplicata (${matches.length} occorrenze); refresh rifiutato prima della scrittura.`,
    );
  }
  return matches[0] ?? null;
}

function uniqueProperty(object, name, operation) {
  const matches = directProperties(object, name);
  if (matches.length > 1) {
    throw new Error(
      `${operation}: proprietà '${name}' duplicata (${matches.length} occorrenze); refresh rifiutato prima della scrittura.`,
    );
  }
  return matches[0] ?? null;
}

function nestedProperties(object, name) {
  const matches = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(object);
  return matches;
}

function seoEntryObjects(source, file, id) {
  const key = `blog-${id}`;
  const collect = (sourceFile, sourceOffset) => {
    const matches = [];
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node)
        && propertyName(node.name) === key
        && ts.isObjectLiteralExpression(node.initializer)
      ) {
        matches.push({ object: node.initializer, sourceFile, sourceOffset });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return matches;
  };

  const direct = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((direct.parseDiagnostics ?? []).length === 0) return collect(direct, 0);

  // Focused fixtures may contain only SEO property fragments. Wrapping them
  // in one object preserves every original offset through `sourceOffset` and
  // still requires the fragment itself to parse structurally.
  const prefix = 'const __seo = {\n';
  const wrapped = `${prefix}${source}\n};`;
  const wrappedFile = parseTypeScript(wrapped, file);
  return collect(wrappedFile, -prefix.length);
}

function uniqueNestedProperty(object, name, operation) {
  const matches = nestedProperties(object, name);
  if (matches.length > 1) {
    throw new Error(
      `${operation}: proprietà '${name}' duplicata (${matches.length} occorrenze); refresh rifiutato prima della scrittura.`,
    );
  }
  return matches[0] ?? null;
}

function replaceInitializer(source, sourceFile, property, nextLiteral, sourceOffset = 0) {
  const start = property.initializer.getStart(sourceFile) + sourceOffset;
  const end = property.initializer.end + sourceOffset;
  return source.slice(0, start) + nextLiteral + source.slice(end);
}

function insertUpdatedAt(source, sourceFile, record, dateProperty, todayIso) {
  const close = record.node.end - 1;
  const newline = source.indexOf('\n', dateProperty.end);
  const lineStart = source.lastIndexOf('\n', dateProperty.getStart(sourceFile) - 1) + 1;
  const indent = source.slice(lineStart, dateProperty.getStart(sourceFile)).match(/^[ \t]*/u)?.[0] ?? '';
  if (newline >= 0 && newline < close) {
    const breakEnd = newline + 1;
    const lineBreak = newline > 0 && source[newline - 1] === '\r' ? '\r\n' : '\n';
    return source.slice(0, breakEnd)
      + `${indent}updatedAt: '${todayIso}',${lineBreak}`
      + source.slice(breakEnd);
  }

  const trailing = source.slice(0, close).match(/[ \t]*$/u)?.[0] ?? '';
  const insertAt = close - trailing.length;
  const separator = source.slice(0, insertAt).trimEnd().endsWith(',') ? ' ' : ', ';
  return source.slice(0, insertAt)
    + `${separator}updatedAt: '${todayIso}'`
    + source.slice(insertAt);
}

function isAtOrAfter(stored, candidate) {
  const storedMs = Date.parse(stored);
  const candidateMs = Date.parse(candidate);
  return !Number.isNaN(storedMs) && !Number.isNaN(candidateMs) && storedMs >= candidateMs;
}

/** Bump (or insert) `updatedAt` on the ARTICLES entry so sitemap lastmod reflects the refresh. */
export function bumpUpdatedAt(
  id,
  todayIso,
  repoRoot = DEFAULT_REPO_ROOT,
  registryFile = 'data/blog-articles-data.ts',
  writeFile = writeRefreshFile,
  readFile = fs.readFileSync,
) {
  const file = path.join(repoRoot, registryFile);
  const source = readFile(file, 'utf-8');
  const sourceFile = parseTypeScript(source, file);
  const record = uniqueArticleRecord(sourceFile, id, 'bumpUpdatedAt');
  if (!record) return false;

  const dateProperty = uniqueProperty(record.node, 'date', 'bumpUpdatedAt');
  const date = stringLiteralValue(dateProperty);
  // updatedAt is stored date-only (no time-of-day); if the entry's original
  // `date` timestamp falls later the same calendar day (article registered
  // earlier today), a midnight-anchored updatedAt would parse as *before* it —
  // an incoherent freshness signal. Skip instead of writing that regression.
  if (date !== null && Date.parse(`${todayIso}T00:00:00Z`) < Date.parse(date)) return true;

  const updatedAtProperty = uniqueProperty(record.node, 'updatedAt', 'bumpUpdatedAt');
  if (updatedAtProperty) {
    const current = stringLiteralValue(updatedAtProperty);
    if (current === null) return false;
    if (isAtOrAfter(current, todayIso)) return true;
    writeFile(file, replaceInitializer(source, sourceFile, updatedAtProperty, `'${todayIso}'`));
    return true;
  }

  if (!dateProperty || date === null) return false;
  writeFile(file, insertUpdatedAt(source, sourceFile, record, dateProperty, todayIso));
  return true;
}

/**
 * Bump the NewsArticle `dateModified` on the article's blog-SEO entry so the
 * freshness signal tracks the periodic body refresh (datePublished is left at
 * the original publish date). Scoped to this article's unique balanced object.
 */
export function bumpDateModified(
  id,
  isoDateTime,
  repoRoot = DEFAULT_REPO_ROOT,
  seoFile = 'services/seo/seo-blog-5.ts',
  writeFile = writeRefreshFile,
  readFile = fs.readFileSync,
) {
  const file = path.join(repoRoot, seoFile);
  const source = readFile(file, 'utf-8');
  const entries = seoEntryObjects(source, file, id);
  if (entries.length > 1) {
    throw new Error(
      `bumpDateModified: entry 'blog-${id}' duplicata (${entries.length} occorrenze); ` +
      'refresh rifiutato prima della scrittura.',
    );
  }
  const entry = entries[0];
  if (!entry) return false;
  const { object, sourceFile, sourceOffset } = entry;

  const modifiedProperty = uniqueNestedProperty(object, 'dateModified', 'bumpDateModified');
  const current = stringLiteralValue(modifiedProperty);
  if (current === null) return false;
  const publishedProperty = uniqueNestedProperty(object, 'datePublished', 'bumpDateModified');
  const published = stringLiteralValue(publishedProperty);
  const effective = published && Date.parse(published) > Date.parse(isoDateTime) ? published : isoDateTime;
  if (isAtOrAfter(current, effective)) return true;

  writeFile(file, replaceInitializer(source, sourceFile, modifiedProperty, `"${effective}"`, sourceOffset));
  return true;
}

function xmlElementBlocks(source, tag) {
  const blocks = [];
  const closeTag = `</${tag}>`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(`<${tag}`, cursor);
    if (start < 0) break;
    const nameEnd = start + tag.length + 1;
    if (!/[\s>]/u.test(source[nameEnd] ?? '')) {
      cursor = nameEnd;
      continue;
    }
    const openEnd = source.indexOf('>', nameEnd);
    if (openEnd < 0) throw new Error(`XML: tag <${tag}> non chiuso`);
    const close = source.indexOf(closeTag, openEnd + 1);
    if (close < 0) throw new Error(`XML: tag ${closeTag} mancante`);
    blocks.push({ start, contentStart: openEnd + 1, contentEnd: close, end: close + closeTag.length });
    cursor = close + closeTag.length;
  }
  return blocks;
}

function childElements(source, block, tag) {
  return xmlElementBlocks(source.slice(block.contentStart, block.contentEnd), tag).map((child) => ({
    start: block.contentStart + child.start,
    contentStart: block.contentStart + child.contentStart,
    contentEnd: block.contentStart + child.contentEnd,
    end: block.contentStart + child.end,
  }));
}

/** Bump the `<lastmod>` on the article's sitemap-blog.xml entry to match the refresh date. */
export function bumpSitemapLastmod(
  slug,
  isoDate,
  repoRoot = DEFAULT_REPO_ROOT,
  sitemapFile = 'public/sitemap-blog.xml',
  writeFile = writeRefreshFile,
  readFile = fs.readFileSync,
) {
  const file = path.join(repoRoot, sitemapFile);
  const source = readFile(file, 'utf-8');
  const suffix = `/${slug}/`;
  const matches = xmlElementBlocks(source, 'url').filter((url) => {
    const locs = childElements(source, url, 'loc');
    return locs.length === 1 && source.slice(locs[0].contentStart, locs[0].contentEnd).trim().endsWith(suffix);
  });
  if (matches.length > 1) {
    throw new Error(
      `bumpSitemapLastmod: URL '${suffix}' duplicata (${matches.length} occorrenze); ` +
      'refresh rifiutato prima della scrittura.',
    );
  }
  const url = matches[0];
  if (!url) return false;
  const lastmods = childElements(source, url, 'lastmod');
  if (lastmods.length > 1) {
    throw new Error(
      `bumpSitemapLastmod: <lastmod> duplicato (${lastmods.length} occorrenze) per '${suffix}'; ` +
      'refresh rifiutato prima della scrittura.',
    );
  }
  const lastmod = lastmods[0];
  if (!lastmod) return false;
  const current = source.slice(lastmod.contentStart, lastmod.contentEnd).trim();
  if (isAtOrAfter(current, isoDate)) return true;
  writeFile(file, source.slice(0, lastmod.contentStart) + isoDate + source.slice(lastmod.contentEnd));
  return true;
}
