#!/usr/bin/env node

/**
 * L6 producer: daily automated source-check verdicts for the most recent news
 * articles (category `novita`), in the `automated-source-check` row format of
 * `scripts/ci/export-l6-factuality-outcomes.mjs`.
 *
 * For each selected article it reads the four body files, takes the source
 * the Italian body cites (`*Fonte: [host](https://...)*`), downloads that one
 * page, and compares the figures of `## Fatti chiave` / `## In breve` with
 * the page text and with each translation (`scripts/lib/l6-source-check.mjs`).
 * Deterministic: no model, no other download than the cited source.
 *
 *   --select [--limit N] [--json]   print the body paths to materialise (one
 *                                   per line, for `git sparse-checkout add`);
 *                                   with --json, `{ ids, paths }`.
 *   --limit N --out F.jsonl --summary F.json [--root DIR]
 *                                   produce: append rows to --out, write the
 *                                   run summary to --summary.
 *
 * The output is a run file: it never writes the committed ledger
 * `data/editorial-factuality-verdicts.jsonl`. No row is better than a false
 * one, so an article without citation or figures, a source that cannot be
 * downloaded or read, and a missing locale body produce no row and are
 * counted in `skipped` by reason. Exit 0 also with `rowsWritten: 0` (the L6
 * loop judges `reviewedArticles`); non-zero only for program errors.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractBodies } from '../lib/blog-body-io.mjs';
import {
  AUTOMATED_METHOD,
  L6_LOCALES,
  buildVerdictRows,
  extractKeyFigures,
  extractSourceCitation,
  htmlToText,
} from '../lib/l6-source-check.mjs';
import { independentSourceUrlIssue } from './export-l6-factuality-outcomes.mjs';
import { articleRegistryObjectBodies, articleRegistryObjectFields } from '../../packages/articles/engine/shared/articleRegistryObjectBodies.mjs';

export const ARTICLES_DATA_PATH = path.join('packages', 'articles', 'content', 'blog-articles-data.ts');
export const BODY_ROOT = path.join('packages', 'articles', 'content', 'blog-body');
export const DEFAULT_LIMIT = 20;
export const NEWS_CATEGORY = 'novita';
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MIN_SOURCE_TEXT_CHARS = 200;
export const USER_AGENT = 'frontaliereticino-l6-source-check/1.0 (+https://frontaliereticino.ch/; deterministic figure check of a cited source)';
export const SKIP_REASONS = ['no-citation', 'no-figures', 'fetch-failed', 'source-unreadable', 'locale-missing'];

const RAW_ARTICLES_START = /const\s+(RAW_ARTICLES(?:_CHUNK_\d+)?)\s*(?:\s*:\s*Article\[\])?\s*=\s*\[/g;

function matchingArrayEnd(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function field(objectText, name) {
  // Top-level members only (shared tokenizer): a field name inside another
  // quoted value is data, not the field.
  return articleRegistryObjectFields(objectText).get(name) ?? null;
}

/** The RAW_ARTICLES array literal of blog-articles-data.ts, as text. */
export function rawArticlesBlock(dataText) {
  const text = String(dataText ?? '');
  const declarations = [...text.matchAll(RAW_ARTICLES_START)];
  const chunks = declarations.filter((match) => match[1].startsWith('RAW_ARTICLES_CHUNK_'));
  const aggregates = declarations.filter((match) => match[1] === 'RAW_ARTICLES');
  const arrays = chunks.length ? [...chunks, ...aggregates] : aggregates;
  if (arrays.length === 0) throw new Error('RAW_ARTICLES not found in blog-articles-data.ts');

  return arrays.map((match) => {
    const open = match.index + match[0].lastIndexOf('[');
    const end = matchingArrayEnd(text, open);
    if (end === -1) throw new Error('end of RAW_ARTICLES not found in blog-articles-data.ts');
    return text.slice(open + 1, end);
  }).join('\n');
}

/** `{ id, category, date, updatedAt }` of every RAW_ARTICLES entry, in file order. */
export function parseRawArticles(dataText) {
  const entries = [];
  for (const body of articleRegistryObjectBodies(rawArticlesBlock(dataText))) {
    const id = field(body, 'id');
    if (!id) continue;
    entries.push({
      id,
      category: field(body, 'category'),
      date: field(body, 'date'),
      updatedAt: field(body, 'updatedAt'),
    });
  }
  return entries;
}

function latestTime(entry) {
  const times = [entry.date, entry.updatedAt].map((value) => Date.parse(value ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NEGATIVE_INFINITY;
}

/** Most recent news articles first (by max(date, updatedAt)), then by id. */
export function selectArticles(entries, { limit = DEFAULT_LIMIT } = {}) {
  return entries
    .filter((entry) => entry.category === NEWS_CATEGORY)
    .map((entry) => ({ ...entry, latest: latestTime(entry) }))
    .sort((a, b) => (b.latest - a.latest) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ latest, ...entry }) => entry);
}

export function bodyPath(locale, id) {
  return path.posix.join(BODY_ROOT.split(path.sep).join('/'), locale, `${id}.ts`);
}

export function bodyPathsFor(ids) {
  return ids.flatMap((id) => L6_LOCALES.map((locale) => bodyPath(locale, id)));
}

/** Plain text of every body segment of one locale file, or null when absent. */
export function readLocaleBody(root, locale, id) {
  let content;
  try {
    content = fs.readFileSync(path.join(root, bodyPath(locale, id)), 'utf8');
  } catch {
    return null;
  }
  const bodies = extractBodies(content, id);
  const segments = Object.keys(bodies)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((key) => bodies[key]);
  return segments.length ? segments.join('\n\n') : null;
}

class SourceError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

/**
 * A network failure at any stage of one download (request, redirect target,
 * body stream) is a `fetch-failed` skip, not a program error: one slow or
 * unstable site must not abort the run and lose the rows already computed.
 */
function asFetchFailed(error, url, timeoutMs) {
  if (error instanceof SourceError) return error;
  const detail = error?.name === 'AbortError'
    ? `timeout after ${timeoutMs}ms`
    : error?.message || String(error);
  return new SourceError('fetch-failed', `${url}: ${detail}`);
}

async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The connection is being dropped anyway.
  }
}

async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new SourceError('fetch-failed', `source larger than ${maxBytes} bytes`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SourceError('fetch-failed', `source larger than ${maxBytes} bytes`);
    }
    // A copy, never a view: over a bare ArrayBuffer `Buffer.from(value)`
    // shares the producer's memory, which a reader may reuse (#7483).
    chunks.push(Buffer.from(value instanceof ArrayBuffer
      ? value.slice(0)
      : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }
  return Buffer.concat(chunks);
}

function decodeBody(buffer, contentType) {
  const charset = /charset=([^;\s]+)/i.exec(contentType || '')?.[1]?.replace(/["']/g, '').toLowerCase();
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Download the cited source: https only, every redirect hop re-checked with
 * the exporter's independence rule (no IP literal, no localhost, not this
 * site), bounded time and size, declared User-Agent.
 */
export async function fetchSource(url, {
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_SOURCE_BYTES,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const issue = independentSourceUrlIssue(current);
      if (issue) throw new SourceError('fetch-failed', `${current}: ${issue}`);
      const fetchedAt = now().toISOString();
      let response;
      try {
        response = await fetchImpl(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
        });
      } catch (error) {
        throw asFetchFailed(error, current, timeoutMs);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await discardBody(response);
        if (!location) throw new SourceError('fetch-failed', `${current}: HTTP ${response.status} without location`);
        try {
          current = new URL(location, current).href;
        } catch (error) {
          throw new SourceError('fetch-failed', `${current}: invalid redirect location (${error?.message || error})`);
        }
        continue;
      }
      if (response.status !== 200) {
        await discardBody(response);
        throw new SourceError('fetch-failed', `${current}: HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
        await discardBody(response);
        throw new SourceError('source-unreadable', `${current}: content-type ${contentType.split(';')[0]} is not a readable page`);
      }
      let buffer;
      try {
        buffer = await readCapped(response, maxBytes);
      } catch (error) {
        throw asFetchFailed(error, current, timeoutMs);
      }
      const raw = decodeBody(buffer, contentType);
      const text = /text\/plain/i.test(contentType) ? raw : htmlToText(raw);
      if (text.length < MIN_SOURCE_TEXT_CHARS) {
        throw new SourceError('source-unreadable', `${current}: only ${text.length} characters of text (page needs JavaScript?)`);
      }
      return {
        url,
        finalUrl: current,
        httpStatus: 200,
        fetchedAt,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        text,
      };
    }
    throw new SourceError('fetch-failed', `${url}: more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

/** Check selected articles and return `{ rows, summary }`. */
export async function produceVerdicts({
  root = process.cwd(),
  ids,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const skipped = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0]));
  const skippedDetail = [];
  const skip = (reason, articleId, detail, locale) => {
    skipped[reason] += 1;
    skippedDetail.push({ articleId, ...(locale ? { locale } : {}), reason, ...(detail ? { detail } : {}) });
  };
  const rows = [];
  const checkedArticles = [];
  for (const articleId of ids) {
    const bodies = Object.fromEntries(L6_LOCALES.map((locale) => [locale, readLocaleBody(root, locale, articleId)]));
    if (!bodies.it) {
      skip('locale-missing', articleId, 'italian body missing', 'it');
      continue;
    }
    const citation = extractSourceCitation(bodies.it);
    if (!citation) {
      skip('no-citation', articleId);
      continue;
    }
    const figures = extractKeyFigures(bodies.it);
    if (!figures.length) {
      skip('no-figures', articleId);
      continue;
    }
    let source;
    try {
      source = await fetchSource(citation.url, { fetchImpl, now, timeoutMs });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      skip(error.reason, articleId, error.message);
      continue;
    }
    for (const locale of L6_LOCALES) if (!bodies[locale]) skip('locale-missing', articleId, null, locale);
    const articleRows = buildVerdictRows({ articleId, bodies, source, now });
    rows.push(...articleRows);
    checkedArticles.push({
      articleId,
      sourceUrl: citation.url,
      figuresChecked: figures.length,
      verdicts: Object.fromEntries(articleRows.map((row) => [row.locale, row.verdict])),
    });
  }
  return {
    rows,
    summary: {
      generatedAt: now().toISOString(),
      method: AUTOMATED_METHOD,
      selected: ids.length,
      rowsWritten: rows.length,
      articlesWithRows: checkedArticles.length,
      verdictCounts: {
        supported: rows.filter((row) => row.verdict === 'supported').length,
        confirmed_defect: rows.filter((row) => row.verdict === 'confirmed_defect').length,
      },
      skipped,
      skippedDetail,
      checkedArticles,
    },
  };
}

function parseArgs(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  const limitText = valueAfter('--limit');
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  return {
    select: argv.includes('--select'),
    json: argv.includes('--json'),
    limit,
    out: valueAfter('--out'),
    summary: valueAfter('--summary'),
    root: valueAfter('--root') || process.cwd(),
  };
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const options = parseArgs(argv);
  const dataText = fs.readFileSync(path.join(options.root, ARTICLES_DATA_PATH), 'utf8');
  const selected = selectArticles(parseRawArticles(dataText), { limit: options.limit });
  const ids = selected.map((entry) => entry.id);
  if (options.select) {
    const paths = bodyPathsFor(ids);
    stdout.write(options.json ? `${JSON.stringify({ ids, paths }, null, 2)}\n` : `${paths.join('\n')}\n`);
    return { ids, paths };
  }
  if (!options.out || !options.summary) throw new Error('--out and --summary are required (or use --select)');
  const result = await produceVerdicts({ root: options.root, ids, fetchImpl, now });
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.appendFileSync(path.resolve(options.out), result.rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  fs.mkdirSync(path.dirname(path.resolve(options.summary)), { recursive: true });
  fs.writeFileSync(path.resolve(options.summary), `${JSON.stringify(result.summary, null, 2)}\n`);
  stdout.write(`[L6] source check: selected ${result.summary.selected}, rows ${result.summary.rowsWritten}, skipped ${JSON.stringify(result.summary.skipped)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L6] producer fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
