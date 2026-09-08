#!/usr/bin/env node
/**
 * Reports the distribution of inline-ad placement on longform `it` articles.
 *
 * This is an observer, not a placer: it reads the same body extraction,
 * longform predicate, ad profile and boundary-shape predicates as production,
 * then replays the small state machine used by `renderFormattedContent`.
 *
 *   node scripts/audit-longform-ad-density.mjs
 *   node scripts/audit-longform-ad-density.mjs --body-dir /tmp/body-fixture
 *
 * `--body-dir` exists for the regression test and for controlled snapshots;
 * the production default remains the Italian body corpus.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AD_SLOTS } from '../services/adsenseSlots.ts';
import {
  AD_ELIGIBLE_MIN_CHARS,
  AD_ELIGIBLE_MIN_WORDS,
  isLongformArticle,
  inlineSlotIndex,
  resolveArticleAdDensity,
} from '../services/articleAdDensity.ts';
import { extractBodies } from './lib/blog-body-io.mjs';
import { isAdStraddleBlock, isListBlock, isTableBlock, LIST_ITEM_RE } from '../services/adPlacement.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BODY_DIR = path.join(ROOT, 'services/locales/blog-body/it');
const INLINE_SLOT_COUNT = Object.keys(AD_SLOTS).filter(key => key.startsWith('ARTICLE_INLINE_MOBILE')).length;

const WORD_RE = /\s+/;
const TRAILING_DECORATIVE_EMOJI_RE = /[ \t]*(?:📊|💡|⚠️|⚠)+\s*$/;

function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(WORD_RE).filter(Boolean).length : 0;
}

function stripTrailingDecorativeEmoji(text) {
  return String(text ?? '').replace(TRAILING_DECORATIVE_EMOJI_RE, '');
}

function wordsForList(block) {
  return block
    .split('\n')
    .filter(line => LIST_ITEM_RE.test(line.trim()))
    .map(line => stripTrailingDecorativeEmoji(line.trim().replace(LIST_ITEM_RE, '')))
    .reduce((sum, line) => sum + countWords(line), 0);
}

function wordsForH2Block(block, blocks, index) {
  const lines = block.trim().split('\n');
  const rawHeading = lines[0].replace(/^##\s+/, '').trim();
  let inlineBody = lines.slice(1).join('\n').trim();
  let heading = rawHeading;

  if (!inlineBody && /\(nav:/.test(heading)) {
    const marker = heading.match(/\s(Per|To|Pour|Um|Für)\s/i);
    if (marker && typeof marker.index === 'number') {
      inlineBody = heading.slice(marker.index + 1).trim();
      heading = heading.slice(0, marker.index).trim();
    }
  }

  const isToolsHeading = /^(tool utili|tool consigliati|recommended tools|useful tools|empfohlene tools|nützliche tools|outils recommandés|outils utiles)\b/i.test(heading);
  if (isToolsHeading && !inlineBody) {
    const next = blocks[index + 1]?.trim() ?? '';
    const looksLikeToolBody = Boolean(next)
      && !next.startsWith('## ')
      && next !== '---'
      && next !== '***'
      && !next.startsWith('📊')
      && !next.startsWith('💡')
      && !next.startsWith('⚠')
      && !next.startsWith('> ')
      && !isListBlock(next)
      && (/\(nav:(exchange|banks|calculator|tax-return|cost-of-living|health|transport|living-it)\)/i.test(next)
        || /(cambio|banche|tool|recommended|conseill|empfohlen|vergleich|comparatore)/i.test(next));
    if (looksLikeToolBody) return { words: countWords(next), consumesNext: true };
  }

  return { words: countWords(inlineBody), consumesNext: false };
}

/** Content credit added by one block, matching the renderer branches. */
function contentWords(block) {
  const trimmed = block.trim();
  if (!trimmed || trimmed === '---' || trimmed === '***') return 0;
  if (trimmed.startsWith('📊')) return countWords(trimmed.slice(2).trim());
  if (trimmed.startsWith('💡')) return countWords(trimmed.slice(2).trim());
  if (trimmed.startsWith('⚠️') || trimmed.startsWith('⚠')) {
    return countWords(trimmed.replace(/^⚠️?\s*/, ''));
  }
  if (trimmed.startsWith('> ')) return countWords(trimmed.slice(2).trim());
  if (isTableBlock(trimmed)) return countWords(trimmed);
  if (isListBlock(trimmed)) return wordsForList(trimmed);
  return countWords(stripTrailingDecorativeEmoji(trimmed));
}

function createArticleState(articleId, profile, adEligible) {
  return {
    articleId,
    profile,
    adEligible,
    emitted: 0,
    slots: [],
  };
}

function tryEmitAd(state, wordsSinceLastAd, sawContent) {
  if (!state.adEligible || !sawContent || wordsSinceLastAd < state.profile.minWordGap) {
    return { emitted: false, wordsSinceLastAd, sawContent };
  }
  if (state.emitted >= state.profile.inlineCap) {
    return { emitted: false, wordsSinceLastAd, sawContent };
  }
  state.slots.push(inlineSlotIndex(state.articleId, state.emitted, INLINE_SLOT_COUNT));
  state.emitted += 1;
  return { emitted: true, wordsSinceLastAd: 0, sawContent: false };
}

/** Replay one `renderFormattedContent` call (one body segment). */
function replaySegment(segment, state, boundaryStats) {
  let wordsSinceLastAd = 0;
  let sawContent = false;
  let pendingAd = null;
  let wordsAtDefer = 0;

  const markContent = words => {
    wordsSinceLastAd += words;
    sawContent = true;
  };
  const flushPendingAd = () => {
    if (!pendingAd) return;
    const carried = wordsSinceLastAd - wordsAtDefer;
    pendingAd = null;
    const result = tryEmitAd(state, wordsSinceLastAd, sawContent);
    wordsSinceLastAd = result.wordsSinceLastAd;
    sawContent = result.sawContent;
    if (result.emitted && carried > 0) {
      wordsSinceLastAd = carried;
      sawContent = true;
    }
  };

  if (!segment.includes('\n\n') && !segment.includes('\n')) {
    markContent(countWords(stripTrailingDecorativeEmoji(segment)));
    tryEmitAd(state, wordsSinceLastAd, sawContent);
    return;
  }

  const blocks = segment.split('\n\n').filter(block => block.trim());
  for (let index = 0; index < blocks.length; index += 1) {
    const trimmed = blocks[index].trim();
    if (pendingAd && !isAdStraddleBlock(trimmed)) flushPendingAd();

    if (trimmed.startsWith('#### ')) {
      markContent(countWords(trimmed.split('\n').slice(1).join('\n').trim()));
      continue;
    }
    if (trimmed.startsWith('### ')) {
      markContent(countWords(trimmed.split('\n').slice(1).join('\n').trim()));
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (isAdStraddleBlock(blocks[index + 1]?.trim() ?? '')) {
        pendingAd = `post-block-h2-${index}`;
        wordsAtDefer = wordsSinceLastAd;
        boundaryStats.deferred += 1;
      } else {
        const result = tryEmitAd(state, wordsSinceLastAd, sawContent);
        wordsSinceLastAd = result.wordsSinceLastAd;
        sawContent = result.sawContent;
        if (result.emitted) boundaryStats.emitted += 1;
        else boundaryStats.neither += 1;
      }
      const h2 = wordsForH2Block(trimmed, blocks, index);
      markContent(h2.words);
      if (h2.consumesNext) index += 1;
      continue;
    }

    markContent(contentWords(trimmed));
  }

  flushPendingAd();
  tryEmitAd(state, wordsSinceLastAd, sawContent);
}

function articleSegments(filePath, id) {
  const source = fs.readFileSync(filePath, 'utf8');
  return Object.entries(extractBodies(source, id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, body]) => body);
}

export function auditLongformAdDensity(bodyDir = DEFAULT_BODY_DIR) {
  if (!fs.existsSync(bodyDir)) throw new Error(`directory not found: ${bodyDir}`);
  const files = fs.readdirSync(bodyDir).filter(file => file.endsWith('.ts')).sort();
  const histogram = { 0: 0, 1: 0, 2: 0, '3+': 0 };
  const slots = new Map(Array.from({ length: INLINE_SLOT_COUNT }, (_, index) => [index, 0]));
  const boundaryStats = { emitted: 0, deferred: 0, neither: 0 };
  let longformArticles = 0;

  for (const file of files) {
    const id = path.basename(file, '.ts');
    const segments = articleSegments(path.join(bodyDir, file), id);
    if (!isLongformArticle(segments)) continue;
    longformArticles += 1;
    const profile = resolveArticleAdDensity(segments);
    const wordCount = segments.join(' ').split(WORD_RE).filter(Boolean).length;
    const charCount = segments.join(' ').trim().length;
    const state = createArticleState(
      id,
      profile,
      segments.length >= 3 && wordCount >= AD_ELIGIBLE_MIN_WORDS && charCount >= AD_ELIGIBLE_MIN_CHARS,
    );
    for (const segment of segments) replaySegment(segment, state, boundaryStats);
    const bucket = state.emitted >= 3 ? '3+' : String(state.emitted);
    histogram[bucket] += 1;
    for (const slot of state.slots) slots.set(slot, slots.get(slot) + 1);
  }

  return { filesScanned: files.length, longformArticles, histogram, slots, boundaryStats };
}

function printReport(report) {
  const histogram = Object.entries(report.histogram).map(([bucket, count]) => `${bucket}=${count}`).join(', ');
  const slotUsage = [...report.slots.entries()].map(([slot, count]) => `${slot + 1}=${count}`).join(', ');
  console.log(`[audit-longform-ad-density] files scanned: ${report.filesScanned}`);
  console.log(`[audit-longform-ad-density] longform articles: ${report.longformArticles}`);
  console.log(`[audit-longform-ad-density] ads per longform: ${histogram}`);
  console.log(`[audit-longform-ad-density] distinct inline slots observed: ${[...report.slots.entries()].filter(([, count]) => count > 0).length}/${report.slots.size}`);
  console.log(`[audit-longform-ad-density] slot usage (rotation % ${report.slots.size}): ${slotUsage}`);
  console.log(`[audit-longform-ad-density] ## boundaries emitted=${report.boundaryStats.emitted}, deferred=${report.boundaryStats.deferred}, neither=${report.boundaryStats.neither}`);
}

function bodyDirFromArgs() {
  const index = process.argv.indexOf('--body-dir');
  if (index < 0) return DEFAULT_BODY_DIR;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--body-dir requires a path');
  return path.resolve(value);
}

function main() {
  printReport(auditLongformAdDensity(bodyDirFromArgs()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
