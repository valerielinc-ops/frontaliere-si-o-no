import { useState, useEffect, useRef, useMemo, useCallback, Suspense, memo, Fragment, type FC, type FormEvent, type ReactNode, type ReactElement } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation, useLocale, loadBlogMeta, loadArticleBody, getCantonI18nParams } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { buildPath } from '@/services/router';
import type { BlogArticleId } from '@/services/router';
import { NAV_ACTION_ROUTES, KEYWORD_LINKS, type NavAction, type NavigatorMap } from '@/services/internalLinks';
import { useNavigation } from '@/services/NavigationContext';

// Pre-compiled gi-flag variants for keyword matching (Vercel rule 7.10)
const KEYWORD_LINKS_GI = KEYWORD_LINKS.map(kl => ({
 ...kl,
 giPattern: new RegExp(kl.pattern.source, 'gi'),
}));
import { Analytics } from '@/services/analytics';
import { BookOpen, Clock, ChevronRight, Calculator, ArrowRight, Calendar, ArrowLeft, Share2, Copy, Check, ChevronLeft, CheckCircle2, Lightbulb, AlertTriangle, BarChart3, Heart, Coins, TrendingUp, FileText, Receipt, Scale, Home, Briefcase, ShieldCheck, MapPin, ShoppingBag, Train, Building2, Mail, Coffee, ExternalLink, Baby, Search, PenLine, Newspaper, User, List, ChevronDown, RefreshCw, Bookmark as BookmarkIcon, Printer, ThumbsUp, ThumbsDown, MessageSquareMore, HelpCircle, Loader2, Shield } from 'lucide-react';
import { eagerAuth, isLinkedInSignInAvailable, signInWithGoogle, signInWithLinkedIn, renderGoogleButtonWithReadiness } from '@/services/authService';
import type { LucideIcon } from 'lucide-react';
import { PARTNERS, buildAffiliateUrl, type AffiliatePartner, type ComparatorContext } from '@/services/affiliateService';
const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS, isPlaceholderAdSlot } from '@/services/adsenseSlots';
import { computeArticleAdSlots } from '@/services/articleAdSlots';
import Callout from '@/components/shared/Callout';
import { resolveCompanyLogoUrl, resolveCompanyWebsiteHost } from '@/services/jobDataNormalization';
import { useMediaQuery } from '@/hooks/useMediaQuery';
const LeadMagnetCTA = lazyRetry(() => import('@/components/shared/LeadMagnetCTA'));
const InlineFuelPriceTable = lazyRetry(() => import('@/components/blog/InlineFuelPriceTable'));

/** Blog articles that should render the live Swiss fuel price table inline. */
const FUEL_PRICE_ARTICLE_IDS: ReadonlySet<string> = new Set([
 'diesel-aumento-prezzi-svizzera-2026',
 'carburanti-ticino-aumento-prezzi',
]);

/* ─── Article view counter (Firestore) ─── */

let _viewDb: any = null;
let _viewDbInit = false;

async function trackArticleView(articleId: string): Promise<void> {
 try {
 const key = `viewed_${articleId}`;
 if (sessionStorage.getItem(key)) return;
 sessionStorage.setItem(key, '1');

 if (!_viewDbInit) {
 const { getFirestore } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 _viewDb = getFirestore(app);
 _viewDbInit = true;
 }
 if (!_viewDb) return;

 const { doc, setDoc, increment } = await import('firebase/firestore');
 await setDoc(doc(_viewDb, 'article_views', articleId), { views: increment(1), lastViewed: new Date() }, { merge: true });
 } catch (e) {
 // Non-blocking; warn so a silent Firestore-rules deny doesn't go unnoticed.
 console.warn('[trackArticleView] Firestore write failed', e);
 }
}

export { trackArticleView };

/* ─── Trending articles (static JSON snapshot → localStorage cache) ─── */

interface TrendingEntry { id: string; views: number; lastViewed: number }

const TRENDING_CACHE_KEY = 'blog_trending_cache';
const TRENDING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchTrendingArticles(validIds: Set<string>): Promise<TrendingEntry[]> {
 // Check localStorage cache first
 try {
 const cached = localStorage.getItem(TRENDING_CACHE_KEY);
 if (cached) {
 const { ts, data } = JSON.parse(cached);
 if (Date.now() - ts < TRENDING_CACHE_TTL && Array.isArray(data)) {
 return data.filter((e: TrendingEntry) => validIds.has(e.id));
 }
 }
 } catch { /* corrupt cache — refetch */ }

 // Source: public/article-trending.json — refreshed daily by
 // .github/workflows/refresh-article-trending.yml. The cron job already
 // applied recency weighting (7d full, 30d half) and sorted by views, so
 // here we just slice the top 12 and intersect with currently-valid IDs.
 // Previously this function did a client-side full scan of `article_views`
 // (~1377 docs/cache-miss with `allow read: if true` rules) — dominant
 // Firestore read cost post-May-8 fix.
 try {
 const res = await fetch('/article-trending.json', { cache: 'no-cache' });
 if (!res.ok) return [];
 const payload = await res.json();
 const rawEntries: TrendingEntry[] = Array.isArray(payload?.entries) ? payload.entries : [];
 const top = rawEntries.slice(0, 12);

 try {
 localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: top }));
 } catch { /* quota — ignore */ }

 return top.filter(e => validIds.has(e.id));
 } catch {
 return [];
 }
}

/* ─── Navigation types & keyword auto-linking ─── */

// NavAction, NavigatorMap, NAV_ACTION_ROUTES, KEYWORD_LINKS imported from @/services/internalLinks
// Re-export for backward compatibility (tests import from here)
export { NAV_ACTION_ROUTES } from '@/services/internalLinks';

/** Inject [keyword](nav:action) markers into text for the first occurrence of each keyword.
 * Strips bold/italic markers before matching so patterns work even when keywords
 * span formatting boundaries (e.g. `cambio **franco-euro**`). */
function autoLinkKeywords(text: string, navigators: NavigatorMap): string {
 if (!text) return text;

 // 1. Build a stripped copy (no * chars) with a position map back to the original
 const posMap: number[] = []; // posMap[strippedIdx] → originalIdx
 let stripped = '';
 for (let i = 0; i < text.length; i++) {
 if (text[i] !== '*') {
 posMap.push(i);
 stripped += text[i];
 }
 }

 // 2. Find all formatting spans (**bold** / *italic*) in the original text
 const fmtSpans: Array<[number, number]> = [];
 const fmtRe = /(\*\*(.+?)\*\*)|(\*([^*]+?)\*)/g;
 let fm: RegExpExecArray | null;
 while ((fm = fmtRe.exec(text)) !== null) {
 fmtSpans.push([fm.index, fm.index + fm[0].length]);
 }

 // 3. Detect pre-existing [text](nav:action) links so we skip those regions
 const existingLinkSpans: Array<[number, number]> = [];
 const usedActions = new Set<string>();
 const navLinkRe = /\[([^\]]+)\]\(nav:([a-z0-9\-]+)\)/g;
 let nlm: RegExpExecArray | null;
 while ((nlm = navLinkRe.exec(text)) !== null) {
 existingLinkSpans.push([nlm.index, nlm.index + nlm[0].length]);
 usedActions.add(nlm[2]); // mark action as already linked
 }

 // 4. Match keyword patterns against the stripped text
 const matches: Array<{ origStart: number; origEnd: number; action: string; linkText: string }> = [];

 for (const { pattern, action } of KEYWORD_LINKS) {
 if (usedActions.has(action)) continue;
 if (!navigators[action]) continue;

 const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
 const m = re.exec(stripped);
 if (!m || m.index === undefined) continue;

 const sStart = m.index;
 const sEnd = sStart + m[0].length;

 // Map stripped range → original range
 let origStart = posMap[sStart];
 let origEnd = sEnd < posMap.length ? posMap[sEnd] : text.length;

 // Skip if this match falls inside a pre-existing nav link
 if (existingLinkSpans.some(([ls, le]) => origStart >= ls && origEnd <= le)) continue;

 // Expand to include any partially-overlapped formatting spans (** / *)
 for (const [fs, fe] of fmtSpans) {
 if (origStart < fe && origEnd > fs) {
 origStart = Math.min(origStart, fs);
 origEnd = Math.max(origEnd, fe);
 }
 }

 // Link text = original segment with all * stripped
 const linkText = text.slice(origStart, origEnd).replace(/\*/g, '');

 // Avoid overlapping matches (including pre-existing links)
 if (matches.some(prev => origStart < prev.origEnd && origEnd > prev.origStart)) continue;
 if (existingLinkSpans.some(([ls, le]) => origStart < le && origEnd > ls)) continue;

 matches.push({ origStart, origEnd, action, linkText });
 usedActions.add(action);
 }

 // 5. Apply replacements in reverse order so positions stay valid
 matches.sort((a, b) => b.origStart - a.origStart);
 let result = text;
 for (const m of matches) {
 result = result.slice(0, m.origStart) + `[${m.linkText}](nav:${m.action})` + result.slice(m.origEnd);
 }
 return result;
}

/* ─── Markdown-lite formatted content renderer ─── */

function renderInlineFormatting(text: string, navigators?: NavigatorMap): ReactNode[] {
 const parts: ReactNode[] = [];
 // Match [link](nav:xxx), [link](https://...), **bold**, or *italic* — links take priority
 const regex = /(\[([^\]]+)\]\(nav:([a-z0-9\-]+)\))|(\[([^\]]+)\]\((https?:\/\/[^)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g;
 let lastIndex = 0;
 let match: RegExpExecArray | null;
 let key = 0;
 while ((match = regex.exec(text)) !== null) {
 if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
 if (match[2] && match[3]) {
 // [text](nav:action) — internal link rendered as <a> for SEO crawlability
 const action = match[3] as NavAction;
 const handler = navigators?.[action];
 // Strip bold markers from link text if present (e.g. [**keyword**](nav:action))
 const rawLinkText = match[2];
 const isBoldLink = rawLinkText.startsWith('**') && rawLinkText.endsWith('**');
 const linkText = isBoldLink ? rawLinkText.slice(2, -2) : rawLinkText;
 if (handler) {
 const href = buildPath(NAV_ACTION_ROUTES[action]);
 parts.push(
 <a
 key={`l${key++}`}
 href={href}
 onClick={(e) => { e.preventDefault(); e.stopPropagation(); handler(); }}
 className={`inline text-accent ${isBoldLink ? 'font-bold' : 'font-medium'} underline underline-offset-2 decoration-accent-border hover:decoration-accent transition-colors cursor-pointer`}
 >
 {linkText}
 </a>
 );
 } else {
 parts.push(isBoldLink ? <strong key={`b${key++}`} className="font-semibold text-strong">{linkText}</strong> : linkText);
 }
 } else if (match[5] && match[6]) {
 // [text](https://...) — external link
 parts.push(
 <a
 key={`el${key++}`}
 href={match[6]}
 target="_blank"
 rel="noopener noreferrer"
 className="inline text-accent font-medium underline underline-offset-2 decoration-accent-border hover:decoration-accent transition-colors"
 >
 {match[5]}
 </a>
 );
 } else if (match[8]) {
 // Recursively process bold content so nested links/italic are rendered
 parts.push(<strong key={`b${key++}`} className="font-semibold text-strong">{renderInlineFormatting(match[8], navigators)}</strong>);
 } else if (match[10]) {
 // Recursively process italic content so nested links are rendered (e.g. *Fonte: [text](url)*)
 parts.push(<em key={`i${key++}`} className="italic">{renderInlineFormatting(match[10], navigators)}</em>);
 }
 lastIndex = regex.lastIndex;
 }
 if (lastIndex < text.length) parts.push(text.slice(lastIndex));
 return parts;
}

/** Try to render a markdown table from text. Returns null if not a valid table. */
function tryRenderMdTable(text: string, keyPrefix: string, navigators?: NavigatorMap): ReactElement | null {
 if (!text.includes('|') || !/^\|[^|]+\|/m.test(text)) return null;
 const tableLines = text.split('\n').filter(l => l.trim().startsWith('|'));
 const isSeparator = (line: string) => /^\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line.trim());
 const sepIdx = tableLines.findIndex(l => isSeparator(l));
 if (sepIdx <= 0) return null;
 const headerLines = tableLines.slice(0, sepIdx);
 const bodyLines = tableLines.slice(sepIdx + 1);
 if (headerLines.length === 0 || bodyLines.length === 0) return null;
 const parseCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
 const headers = parseCells(headerLines[0]);
 return (
 <div key={keyPrefix} className="overflow-x-auto my-4">
 <table className="w-full border-collapse text-sm">
 <thead>
 <tr>
 {headers.map((h, hi) => (
 <th key={hi} className="border border-edge bg-surface-raised px-3 py-2 text-left font-semibold text-strong">
 {renderInlineFormatting(h, navigators)}
 </th>
 ))}
 </tr>
 </thead>
 <tbody>
 {bodyLines.map((row, ri) => (
 <tr key={ri} className={ri % 2 === 1 ? 'bg-surface-alt/50' : ''}>
 {parseCells(row).map((cell, ci) => (
 <td key={ci} className="border border-edge px-3 py-2 text-body">
 {renderInlineFormatting(cell, navigators)}
 </td>
 ))}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 );
}

function renderFormattedContent(text: string, navigators?: NavigatorMap): ReactElement {
 // Auto-link keywords if navigators provided
 const processed = navigators ? autoLinkKeywords(text, navigators) : text;

 // If no block separators, render as a single paragraph (backward compatible)
 if (!processed.includes('\n\n') && !processed.includes('\n')) {
 return <p className="text-body leading-relaxed">{renderInlineFormatting(processed, navigators)}</p>;
 }

 const blocks = processed.split('\n\n').filter(b => b.trim());
 const isToolsHeading = (value: string): boolean => {
 return /^(tool utili|tool consigliati|recommended tools|useful tools|empfohlene tools|nützliche tools|outils recommandés|outils utiles)\b/i.test(value.trim());
 };
 const isListBlock = (value: string): boolean => {
 return value.split('\n').every(line => line.trim().startsWith('- ') || line.trim() === '');
 };
 const looksLikeToolBody = (value: string): boolean => {
 const v = value.trim();
 if (!v) return false;
 if (v.startsWith('## ') || v === '---' || v === '***' || v.startsWith('📊') || v.startsWith('💡') || v.startsWith('⚠') || v.startsWith('> ') || isListBlock(v)) return false;
 return /\(nav:(exchange|banks|calculator|tax-return|cost-of-living|health|transport|living-it)\)/i.test(v)
 || /(cambio|banche|tool|recommended|conseill|empfohlen|vergleich|comparatore)/i.test(v);
 };

 const renderedBlocks: ReactElement[] = [];
 let blockquoteCount = 0;
 for (let idx = 0; idx < blocks.length; idx += 1) {
 const trimmed = blocks[idx].trim();

 // Heading: #### (H4 — sub-sub-heading)
 if (trimmed.startsWith('#### ')) {
 const lines = trimmed.split('\n');
 const heading = lines[0].replace(/^####\s+/, '').trim();
 const inlineBody = lines.slice(1).join('\n').trim();
 const headingId = generateHeadingSlug(heading);
 const tableEl = inlineBody ? tryRenderMdTable(inlineBody, `h4tbl-${idx}`, navigators) : null;
 renderedBlocks.push(
 <div key={`h4-${idx}`} className="space-y-1.5">
 <h4 id={headingId} className="text-base font-semibold text-strong mt-3 mb-1 scroll-mt-20">
 {renderInlineFormatting(heading, navigators)}
 </h4>
 {tableEl || (inlineBody && (
 <p className="text-body leading-relaxed">
 {renderInlineFormatting(inlineBody, navigators)}
 </p>
 ))}
 </div>
 );
 continue;
 }

 // Heading: ### (H3 — smaller sub-heading)
 if (trimmed.startsWith('### ')) {
 const lines = trimmed.split('\n');
 const heading = lines[0].replace(/^###\s+/, '').trim();
 const inlineBody = lines.slice(1).join('\n').trim();
 const headingId = generateHeadingSlug(heading);
 const tableEl = inlineBody ? tryRenderMdTable(inlineBody, `h3tbl-${idx}`, navigators) : null;
 renderedBlocks.push(
 <div key={`h3-${idx}`} className="space-y-1.5">
 <h3 id={headingId} className="text-lg font-semibold font-display text-strong mt-4 mb-1 scroll-mt-20">
 {renderInlineFormatting(heading, navigators)}
 </h3>
 {tableEl || (inlineBody && (
 <p className="text-body leading-relaxed">
 {renderInlineFormatting(inlineBody, navigators)}
 </p>
 ))}
 </div>
 );
 continue;
 }

 // Heading: ## (supports malformed blocks where heading and paragraph are in the same block)
 if (trimmed.startsWith('## ')) {
 const lines = trimmed.split('\n');
 const rawHeadingLine = lines[0].replace(/^##\s+/, '').trim();
 let heading = rawHeadingLine;
 let inlineBody = lines.slice(1).join('\n').trim();

 // If AI produced"## Heading sentence..." on one line, split at locale-safe markers.
 if (!inlineBody && /\(nav:/.test(heading)) {
 const marker = heading.match(/\s(Per|To|Pour|Um|Für)\s/i);
 if (marker && typeof marker.index === 'number') {
 inlineBody = heading.slice(marker.index + 1).trim();
 heading = heading.slice(0, marker.index).trim();
 }
 }

 if (isToolsHeading(heading)) {
 let toolBody = inlineBody;
 const nextBlock = blocks[idx + 1]?.trim() || '';
 if (!toolBody && looksLikeToolBody(nextBlock)) {
 toolBody = nextBlock;
 idx += 1;
 }

 renderedBlocks.push(
 <div key={`tools-${idx}`} className="bg-accent-subtle border border-accent-border rounded-xl p-4 flex gap-3">
 <Coins size={20} className="text-accent shrink-0 mt-0.5" />
 <div className="space-y-1.5">
 <p className="text-accent text-sm font-semibold leading-relaxed">
 {renderInlineFormatting(heading, navigators)}
 </p>
 {toolBody && (
 <p className="text-accent text-sm leading-relaxed">
 {renderInlineFormatting(toolBody, navigators)}
 </p>
 )}
 </div>
 </div>
 );
 continue;
 }

 const h2TableEl = inlineBody ? tryRenderMdTable(inlineBody, `h2tbl-${idx}`, navigators) : null;
 renderedBlocks.push(
 <div key={`heading-${idx}`} className="space-y-2">
 <h2 id={generateHeadingSlug(heading)} className="text-xl font-bold font-display text-heading border-l-4 border-accent pl-3 mt-6 mb-2 scroll-mt-20">
 {renderInlineFormatting(heading, navigators)}
 </h2>
 {h2TableEl || (inlineBody && (
 <p className="text-body leading-relaxed">
 {renderInlineFormatting(inlineBody, navigators)}
 </p>
 ))}
 </div>
 );
 continue;
 }

 // Horizontal rule: ---
 if (trimmed === '---' || trimmed === '***') {
 renderedBlocks.push(
 <hr key={`hr-${idx}`} className="border-0 h-px bg-gradient-to-r from-transparent via-edge to-transparent my-2" />
 );
 continue;
 }

 // Data box: 📊 prefix
 if (trimmed.startsWith('📊')) {
 renderedBlocks.push(
 <div key={`data-${idx}`} className="bg-accent-subtle border border-accent-border rounded-xl p-4 flex gap-3">
 <BarChart3 size={20} className="text-link shrink-0 mt-0.5" />
 <p className="text-accent leading-relaxed">{renderInlineFormatting(trimmed.slice(2).trim(), navigators)}</p>
 </div>
 );
 continue;
 }

 // Tip box: 💡 prefix
 if (trimmed.startsWith('💡')) {
 renderedBlocks.push(
 <div key={`tip-${idx}`} className="bg-warning-subtle border border-warning-border rounded-xl p-4 flex gap-3">
 <Lightbulb size={20} className="text-warning shrink-0 mt-0.5" />
 <p className="text-warning leading-relaxed">{renderInlineFormatting(trimmed.slice(2).trim(), navigators)}</p>
 </div>
 );
 continue;
 }

 // Warning box: ⚠️ prefix
 if (trimmed.startsWith('⚠️') || trimmed.startsWith('⚠')) {
 const content = trimmed.replace(/^⚠️?\s*/, '');
 renderedBlocks.push(
 <div key={`warn-${idx}`} className="bg-danger-subtle border border-danger-border rounded-xl p-4 flex gap-3">
 <AlertTriangle size={20} className="text-danger shrink-0 mt-0.5" />
 <p className="text-danger leading-relaxed">{renderInlineFormatting(content, navigators)}</p>
 </div>
 );
 continue;
 }

 // Blockquote: > prefix (capped at 2 per article to avoid visual noise)
 if (trimmed.startsWith('> ')) {
 const quote = trimmed.slice(2).trim();
 if (blockquoteCount < 2) {
 blockquoteCount += 1;
 renderedBlocks.push(
 <Fragment key={`quote-${idx}`}>
 <Callout status="accent" className="italic">
 <blockquote className="text-accent">
 {renderInlineFormatting(quote, navigators)}
 </blockquote>
 </Callout>
 </Fragment>
 );
 } else {
 renderedBlocks.push(
 <p key={`p-${idx}`} className="text-body leading-relaxed text-sm">
 {renderInlineFormatting(quote, navigators)}
 </p>
 );
 }
 continue;
 }

 // Markdown table: lines starting with | and containing a separator row |---|
 const standaloneTable = tryRenderMdTable(trimmed, `table-${idx}`, navigators);
 if (standaloneTable) {
 renderedBlocks.push(standaloneTable);
 continue;
 }

 // List: lines starting with -
 if (isListBlock(trimmed)) {
 const items = trimmed.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2));
 renderedBlocks.push(
 <ul key={`list-${idx}`} className="space-y-2 pl-1">
 {items.map((item, i) => (
 <li key={i} className="flex items-start gap-2 text-body leading-relaxed">
 <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
 <span>{renderInlineFormatting(item, navigators)}</span>
 </li>
 ))}
 </ul>
 );
 continue;
 }

 // Plain paragraph (default)
 renderedBlocks.push(
 <p key={`p-${idx}`} className="text-body leading-relaxed">
 {renderInlineFormatting(trimmed, navigators)}
 </p>
 );
 }

 return <div className="space-y-5">{renderedBlocks}</div>;
}

/* ─── Heading extraction for TOC ─── */

/** Convert heading text to a URL-friendly slug ID */
function generateHeadingSlug(text: string): string {
 return text
 .toLowerCase()
 .replace(/\*\*/g, '')
 .replace(/\*/g, '')
 .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // extract link text
 .replace(/[^a-z0-9\u00C0-\u024F\s-]/g, '') // keep accented chars
 .trim()
 .replace(/\s+/g, '-')
 .replace(/-+/g, '-')
 .slice(0, 60);
}

interface TocHeading {
 id: string;
 text: string;
 level: 2 | 3;
}

/** Extract H2/H3 headings from markdown body text segments */
function extractHeadings(bodySegments: string[]): TocHeading[] {
 const headings: TocHeading[] = [];
 const usedIds = new Set<string>();
 for (const body of bodySegments) {
 if (!body || body.startsWith('blog.article.')) continue;
 const blocks = body.split('\n\n');
 for (const block of blocks) {
 const trimmed = block.trim();
 let level: 2 | 3 | null = null;
 let raw = '';
 if (trimmed.startsWith('#### ')) {
 // H4 sub-sub-headings: skip from TOC (too granular)
 } else if (trimmed.startsWith('### ')) {
 level = 3;
 raw = trimmed.split('\n')[0].replace(/^###\s+/, '').trim();
 } else if (trimmed.startsWith('## ')) {
 level = 2;
 raw = trimmed.split('\n')[0].replace(/^##\s+/, '').trim();
 }
 if (level && raw) {
 // Strip markdown formatting for display text
 const text = raw.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
 let id = generateHeadingSlug(raw);
 // Deduplicate IDs
 if (usedIds.has(id)) {
 let i = 2;
 while (usedIds.has(`${id}-${i}`)) i++;
 id = `${id}-${i}`;
 }
 usedIds.add(id);
 headings.push({ id, text, level });
 }
 }
 }
 return headings;
}

const ARTICLES_PER_PAGE = 7; // 1 hero + 6 grid cards

type ResponsiveImageSet = {
 thumbWebp: string;
};

function getResponsiveImageSet(imagePath: string): ResponsiveImageSet | null {
 const match = imagePath.match(/^(\/images\/(?:blog|places))\/([^/]+)\.(jpe?g|png|webp|avif)$/i);
 if (!match) return null;

 const rootDir = match[1];
 const fileName = match[2];
 // Single-format pipeline (2026-05): WebP everywhere. Hero is 1200w WebP,
 // thumbnail is 480w WebP. Browser picks via <img srcSet> width descriptors
 // — no <picture> wrapper, no AVIF source, no JPG fallback. Browsers without
 // WebP (~<1% in 2026) load the hero via <img src>.
 return {
 thumbWebp: `${rootDir}/thumbnails/${fileName}-480w.webp`,
 };
}

/* ─── Article types ─── */

// Article type & data extracted to data/blog-articles-data.ts for code-splitting (FRO-328)
export type { Article } from '@/data/blog-articles-data';
import type { Article } from '@/data/blog-articles-data';

/** Average Italian reading speed ≈ 230 wpm. Strip HTML/markdown, count words, clamp 2–30 min. */
const WORDS_PER_MINUTE = 230;

/** Collect all bodyN translations for an article (body1, body2, … up to body20). */
function collectBodyParts(articleId: string, t: (key: string) => string): string[] {
 const parts: string[] = [];
 for (let i = 1; i <= 20; i++) {
 const key = `blog.article.${articleId}.body${i}`;
 const val = t(key);
 if (val === key) break;
 parts.push(val);
 }
 return parts;
}

export function estimateReadingMinutes(articleId: string, t: (key: string) => string): number {
 const raw = collectBodyParts(articleId, t).join(' ');
 // If body translations aren't loaded yet, t() returns the key string — use a default
 if (raw.startsWith('blog.article.')) return 5;
 // Strip HTML tags and markdown-style formatting, then count words
 const plain = raw.replace(/<[^>]+>/g, ' ').replace(/[#*_~`>|[\]()]/g, ' ');
 const words = plain.split(/\s+/).filter(w => w.length > 0).length;
 return Math.max(2, Math.min(30, Math.round(words / WORDS_PER_MINUTE)));
}

/* ─── FAQ schema extraction for evergreen articles ─── */

const EVERGREEN_CATEGORIES = new Set(['fiscale', 'pratico', 'pensione']);
const QUESTION_PREFIXES = ['Come', 'Cosa', 'Quando', 'Quanto', 'Dove', 'Chi', 'Perché', 'Quale'];

function stripMarkdown(text: string): string {
 return text
 .replace(/\*\*([^*]+)\*\*/g, '$1')
 .replace(/\*([^*]+)\*/g, '$1')
 .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
 .replace(/^#{1,6}\s+/gm, '')
 .replace(/^[-*+]\s+/gm, '')
 .replace(/^\d+\.\s+/gm, '')
 .replace(/`([^`]+)`/g, '$1')
 .replace(/\n{2,}/g, ' ')
 .replace(/\n/g, ' ')
 .replace(/\s{2,}/g, ' ')
 .trim();
}

export function extractFaqPairs(bodyText: string): Array<{ question: string; answer: string }> {
 const pairs: Array<{ question: string; answer: string }> = [];
 const blocks = bodyText.split(/(?=^## )/m);

 for (const block of blocks) {
 const trimmed = block.trim();
 if (!trimmed.startsWith('## ')) continue;
 const nlIdx = trimmed.indexOf('\n');
 if (nlIdx === -1) continue;
 const heading = trimmed.slice(3, nlIdx).trim();
 const isQuestion = heading.includes('?') ||
 QUESTION_PREFIXES.some(p => heading.startsWith(p));
 if (!isQuestion) continue;
 const answerRaw = trimmed.slice(nlIdx + 1).trim();
 if (!answerRaw) continue;
 const cleanAnswer = stripMarkdown(answerRaw);
 if (!cleanAnswer) continue;
 const truncated = cleanAnswer.length > 300
 ? cleanAnswer.slice(0, 297) + '...'
 : cleanAnswer;
 pairs.push({ question: heading, answer: truncated });
 }
 return pairs;
}

/** Deterministic hash for a string → stable positive integer */
function slugHash(s: string): number {
 let h = 0;
 for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
 return Math.abs(h);
}

/** Extract meaningful topic words from an article slug (split on hyphens, drop short/stop words) */
const STOP_WORDS = new Set(['2025', '2026', '2027', 'del', 'dei', 'per', 'con', 'sul', 'fra', 'tra', 'una', 'non', 'che', 'come', 'cosa', 'dal']);
function slugTopicWords(id: string): Set<string> {
 return new Set(id.split('-').filter(w => w.length > 2 && !STOP_WORDS.has(w)));
}

/** Score-based related articles: category match + topic overlap + date proximity + deterministic variety */
export function getRelatedArticles(currentId: string, allArticles: Article[], count = 3): Article[] {
 const current = allArticles.find(a => a.id === currentId);
 if (!current) return allArticles.filter(a => a.id !== currentId).slice(0, count);

 const currentWords = slugTopicWords(currentId);
 const seed = slugHash(currentId);

 const scored = allArticles
 .filter(a => a.id !== currentId)
 .map(candidate => {
 let score = 0;

 // Same category: strong signal
 if (candidate.category === current.category) score += 10;

 // Topic word overlap from slugs (each shared word = +3)
 const candidateWords = slugTopicWords(candidate.id);
 for (const w of candidateWords) {
 if (currentWords.has(w)) score += 3;
 }

 // Date proximity (articles close in time are more relevant)
 const daysDiff = Math.abs(new Date(candidate.date).getTime() - new Date(current.date).getTime()) / 86400000;
 if (daysDiff < 30) score += 2;
 else if (daysDiff < 90) score += 1;

 // Deterministic per-pair jitter (0-4) for variety across different article pages
 const pairHash = slugHash(currentId + ':' + candidate.id);
 score += pairHash % 5;

 return { article: candidate, score, tiebreak: pairHash };
 });

 // Sort by score desc; deterministic tiebreak
 scored.sort((a, b) => b.score - a.score || (a.tiebreak - b.tiebreak));

 // Ensure we don't show all same-category: cap at count-1 from same category,
 // then fill the last slot with best cross-category if available
 const result: Article[] = [];
 let sameCatCount = 0;
 const maxSameCat = Math.max(1, count - 1);
 for (const s of scored) {
 if (result.length >= count) break;
 if (s.article.category === current.category) {
 if (sameCatCount >= maxSameCat) continue;
 sameCatCount++;
 }
 result.push(s.article);
 }

 return result;
}

/** Minimal job shape for cross-linking (avoids importing JobBoard's full type) */
interface JobPreview {
 id: string;
 slug?: string;
 slugByLocale?: Partial<Record<Locale, string>>;
 title: string;
 titleByLocale?: Partial<Record<Locale, string>>;
 company: string;
 companyKey?: string;
 companyDomain?: string;
 url?: string;
 location: string;
 category: string;
 crawledAt?: string;
 postedDate: string;
 canonicalContent?: {
 byLocale?: Partial<Record<Locale, { keywords?: string[] }>>;
 };
}

function jobLogoUrl(job: JobPreview): string | null {
 const explicit = resolveCompanyLogoUrl(job);
 if (explicit) return explicit;
 const host = resolveCompanyWebsiteHost(job);
 if (!host) return null;
 // Prefer Clearbit (returns 404 for unknown, not grey globe); Google favicon is onError backup
 return `https://logo.clearbit.com/${host}`;
}

/** onError handler for company logo images: Clearbit 404 -> Google favicon -> hide */
function handleBlogLogoError(e: { currentTarget: HTMLImageElement }) {
 const el = e.currentTarget;
 if (el.src.includes('logo.clearbit.com')) {
 const domain = el.src.replace('https://logo.clearbit.com/', '');
 el.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
 } else {
 el.style.display = 'none';
 }
}

const JOB_STOP_WORDS = new Set([...STOP_WORDS, 'the', 'and', 'for', 'with', 'von', 'und', 'les', 'des', 'pour', 'dans']);

/** Find jobs related to an article based on slug-word ↔ job-title/keyword overlap */
function getRelatedJobsForArticle(articleId: string, jobs: JobPreview[], locale: Locale, allArticles: Article[] = [], count = 3): JobPreview[] {
 const articleWords = slugTopicWords(articleId);

 // Category→keyword fallback: boost matching when slug overlap is low
 const article = allArticles.find(a => a.id === articleId);
 const categoryKeywords: Record<string, string[]> = {
 fiscale: ['finance', 'contabile', 'fiscale', 'accounting', 'tax', 'payroll', 'revisore', 'fiduciario', 'compliance'],
 pratico: ['operatore', 'logistica', 'assistente', 'segretaria', 'receptionist', 'magazzino', 'tecnico'],
 novita: ['manager', 'project', 'specialist', 'analista', 'consulente', 'responsabile', 'coordinator'],
 pensione: ['finance', 'assicurazione', 'previdenza', 'bancario', 'consulente', 'advisor', 'wealth'],
 };
 const catWords = article ? (categoryKeywords[article.category] ?? []) : [];

 // Deterministic per-(article, job) FNV-1a hash. Used as the TIEBREAKER inside
 // a score tier so different articles surface different jobs when the
 // catWords fallback ties dozens of jobs at score=2 (the symptom users
 // reported: "every news article shows the same 2 manager/specialist jobs").
 // Combining articleId + jobId per pair guarantees each article sees an
 // independent shuffle while keeping relevance (score) as the primary sort.
 const pairHash = (jobKey: string): number => {
 const s = `${articleId}:${jobKey}`;
 let h = 0x811c9dc5;
 for (let i = 0; i < s.length; i++) {
 h ^= s.charCodeAt(i);
 h = Math.imul(h, 0x01000193) >>> 0;
 }
 return h >>> 0;
 };

 const scored = jobs
 .filter(j => j.slug)
 .map(job => {
 let score = 0;
 const jobTitle = (job.titleByLocale?.[locale] ?? job.title).toLowerCase();
 const jobWords = new Set(jobTitle.split(/[\s\-/,()]+/).filter(w => w.length > 2 && !JOB_STOP_WORDS.has(w)));
 const jobKeywords = (job.canonicalContent?.byLocale?.[locale]?.keywords ?? []).map(k => k.toLowerCase());
 const jobCompany = (job.company ?? '').toLowerCase();
 const jobLocation = (job.location ?? '').toLowerCase();

 // Slug word → job title match (+4)
 for (const w of articleWords) {
 if (jobWords.has(w)) score += 4;
 if (jobKeywords.some(k => k.includes(w))) score += 2;
 if (jobCompany.includes(w)) score += 1;
 if (jobLocation.includes(w)) score += 1;
 }

 // Category keyword fallback — if slug gave 0 points, try category-based matching
 if (score === 0 && catWords.length > 0) {
 for (const cw of catWords) {
 if (jobWords.has(cw) || jobTitle.includes(cw)) score += 2;
 if (jobKeywords.some(k => k.includes(cw))) score += 1;
 }
 }

 const freshness = new Date(job.crawledAt || job.postedDate).getTime();
 const tieKey = pairHash(job.slug || job.id);
 return { job, score, freshness, tieKey };
 })
 .filter(x => x.score >= 2);

 // Score is the primary signal. Inside a tier, prefer the per-article
 // tiebreaker over freshness — freshness alone caused every novita article
 // to surface the same 2-3 most recent manager/specialist roles. With the
 // tiebreaker, freshness still acts as a final disambiguator on hash ties.
 scored.sort((a, b) => b.score - a.score || a.tieKey - b.tieKey || b.freshness - a.freshness);
 return scored.slice(0, count).map(x => x.job);
}

// FRO-328: ARTICLES data extracted to data/blog-articles-data.ts for code-splitting.
// Re-export for consumers that need sync access (e.g. tests, other lazy components).
export { ARTICLES } from '@/data/blog-articles-data';

// FRO-314: Dynamic import — blog-articles-data (122KB) is loaded asynchronously
// so it doesn't block the BlogArticles chunk parse/execute time on mobile.
// The component renders a skeleton until the data is ready.

const CATEGORIES = ['all', 'fiscale', 'pratico', 'novita', 'pensione'] as const;

interface BlogArticlesProps {
 /** Currently selected article (from URL) — null means list view */
 selectedArticle?: BlogArticleId | null;
 /** Navigate to an individual article (updates URL) */
 onSelectArticle?: (articleId: BlogArticleId | null) => void;
 /** Firebase auth state — bypasses content gate when true (mirrors JobBoard) */
 isLoggedIn?: boolean;
 /** True while Firebase auth is resolving — gate stays closed until resolved */
 authLoading?: boolean;
}

/* CTA widget config */
interface CtaConfig {
 icon: LucideIcon;
 titleKey: string;
 descKey: string;
 buttonKey: string;
 action: () => void;
 navAction: NavAction;
 color: 'indigo' | 'emerald' | 'amber' | 'blue' | 'violet' | 'rose';
}

/** Static mapping from each NavAction to its CTA display config */
const NAV_ACTION_CTA_MAP: Partial<Record<NavAction, { icon: LucideIcon; i18nPrefix: string; color: CtaConfig['color'] }>> = {
 calculator: { icon: Calculator, i18nPrefix: 'blog.cta.calculator', color: 'indigo' },
 exchange: { icon: TrendingUp, i18nPrefix: 'blog.cta.exchange', color: 'blue' },
 health: { icon: Heart, i18nPrefix: 'blog.cta.health', color: 'emerald' },
 'cost-of-living': { icon: Coins, i18nPrefix: 'blog.cta.costOfLiving', color: 'amber' },
 pension: { icon: BarChart3, i18nPrefix: 'blog.cta.pension', color: 'amber' },
 pillar3: { icon: Scale, i18nPrefix: 'blog.cta.pillar3', color: 'violet' },
 payslip: { icon: Receipt, i18nPrefix: 'blog.cta.payslip', color: 'blue' },
 'tax-return': { icon: FileText, i18nPrefix: 'blog.cta.taxReturn', color: 'violet' },
 residency: { icon: Home, i18nPrefix: 'blog.cta.residency', color: 'emerald' },
 ristorni: { icon: Receipt, i18nPrefix: 'blog.cta.ristorni', color: 'rose' },
 unemployment: { icon: ShieldCheck, i18nPrefix: 'blog.cta.unemployment', color: 'rose' },
 jobs: { icon: Briefcase, i18nPrefix: 'blog.cta.jobs', color: 'blue' },
 companies: { icon: Building2, i18nPrefix: 'blog.cta.companies', color: 'emerald' },
 banks: { icon: Building2, i18nPrefix: 'blog.cta.banks', color: 'blue' },
 'first-day': { icon: BookOpen, i18nPrefix: 'blog.cta.firstDay', color: 'emerald' },
 permits: { icon: ShieldCheck, i18nPrefix: 'blog.cta.permits', color: 'indigo' },
 border: { icon: MapPin, i18nPrefix: 'blog.cta.border', color: 'emerald' },
 calendar: { icon: Calendar, i18nPrefix: 'blog.cta.calendar', color: 'violet' },
 whatif: { icon: Calculator, i18nPrefix: 'blog.cta.whatif', color: 'amber' },
 shopping: { icon: ShoppingBag, i18nPrefix: 'blog.cta.shopping', color: 'amber' },
 transport: { icon: Train, i18nPrefix: 'blog.cta.transport', color: 'blue' },
 'salary-compare': { icon: BarChart3, i18nPrefix: 'blog.cta.salaryCompare', color: 'indigo' },
 'traffic-history':{ icon: TrendingUp, i18nPrefix: 'blog.cta.trafficHistory', color: 'rose' },
 'parental-leave': { icon: Baby, i18nPrefix: 'blog.cta.parentalLeave', color: 'rose' },
 'job-board': { icon: Search, i18nPrefix: 'blog.cta.jobBoard', color: 'emerald' },
};

const CTA_COLORS = {
 indigo: 'bg-accent-subtle border-accent-border',
 emerald: 'bg-success-subtle border-success-border',
 amber: 'bg-warning-subtle border-warning-border',
 blue: 'bg-accent-subtle border-accent-border',
 violet: 'bg-accent-subtle border-accent-border',
 rose: 'bg-danger-subtle border-danger-border',
};

const CTA_ICON_COLORS = {
 indigo: 'text-accent',
 emerald: 'text-success',
 amber: 'text-warning',
 blue: 'text-link',
 violet: 'text-accent',
 rose: 'text-danger',
};

const CTA_TEXT_COLORS = {
 indigo: { title: 'text-accent', desc: 'text-accent' },
 emerald: { title: 'text-success', desc: 'text-success' },
 amber: { title: 'text-warning', desc: 'text-warning' },
 blue: { title: 'text-accent', desc: 'text-link' },
 violet: { title: 'text-accent', desc: 'text-accent' },
 rose: { title: 'text-danger', desc: 'text-danger' },
};

const CTA_BTN_COLORS = {
 indigo: 'bg-accent hover:bg-accent-hover',
 emerald: 'bg-success-strong hover:bg-success-strong-hover',
 amber: 'bg-warning-strong hover:bg-warning-strong-hover',
 blue: 'bg-accent hover:bg-accent-hover',
 violet: 'bg-accent hover:bg-accent-hover',
 rose: 'bg-danger-strong hover:bg-danger-strong-hover',
};

export const BLOG_LIST_PAGE_STORAGE_KEY = 'blog-list-current-page';

type SeoCluster = 'taxes20km' | 'pension' | 'exchange' | 'generic';
const SEO_CLUSTER_PATTERNS: Record<Exclude<SeoCluster, 'generic'>, RegExp> = {
 taxes20km: /(20\s?km|entro\s*i\s*20|oltre\s*i\s*20|imposta|irpef|credito\s*d[' ]?imposta|nuovo\s+accordo|doppia\s+imposizione|fascia\s*20)/i,
 pension: /(pensione|avs|inps|lpp|secondo\s+pilastro|terzo\s+pilastro|pillar\s*3|prepension)/i,
 exchange: /(cambio|chf|eur|franco|euro|tasso\s*di\s*cambio|valuta|wise|bonifico)/i,
};

const SEO_CLUSTER_ACTIONS: Record<SeoCluster, NavAction[]> = {
 taxes20km: ['calculator', 'tax-return', 'permits', 'job-board'],
 pension: ['pension', 'pillar3', 'calculator', 'job-board'],
 exchange: ['exchange', 'banks', 'shopping', 'calculator'],
 generic: ['calculator', 'exchange', 'pension', 'job-board'],
};

function BlogArticles({
 selectedArticle = null,
 onSelectArticle,
 isLoggedIn = false,
 authLoading = false,
}: BlogArticlesProps) {
 const nav = useNavigation();
 const { t } = useTranslation();
 const [locale] = useLocale();
 const [blogReady, setBlogReady] = useState(false);
 const [bodyReady, setBodyReady] = useState(false);
 // FRO-314: Articles data loaded dynamically to reduce TBT on mobile
 const [articles, setArticles] = useState<Article[]>([]);
 // Article ID → Article index for O(1) lookups (Vercel rule 7.13)
 const articleById = useMemo(() => new Map(articles.map(a => [a.id, a])), [articles]);
 const [selectedCategory, setSelectedCategory] = useState<string>('all');
 const [copied, setCopied] = useState(false);
 const [currentPage, setCurrentPage] = useState(() => {
 if (typeof window === 'undefined') return 1;
 const storedPage = Number.parseInt(sessionStorage.getItem(BLOG_LIST_PAGE_STORAGE_KEY) || '', 10);
 return Number.isFinite(storedPage) && storedPage > 0 ? storedPage : 1;
 });
 const [gridRevealCount, setGridRevealCount] = useState(() => {
 if (typeof window === 'undefined') return 2;
 const w = window.innerWidth;
 if (w < 640) return 4;
 if (w < 1024) return 8;
 return 9;
 });
 const [imageFallbackMap, setImageFallbackMap] = useState<Record<string, true>>({});

 // Reading progress bar state
 const [readingProgress, setReadingProgress] = useState(0);
 const articleRef = useRef<HTMLElement>(null);

 // TOC state
 const [tocOpen, setTocOpen] = useState(false);
 const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);

 // Bookmark state
 const [savedArticles, setSavedArticles] = useState<Set<string>>(() => {
 try {
 const stored = localStorage.getItem('frontaliere_saved_articles');
 return stored ? new Set(JSON.parse(stored)) : new Set();
 } catch { return new Set(); }
 });

 // Article feedback state ('useful' | 'not-useful' | null)
 const [articleFeedback, setArticleFeedback] = useState<Record<string, 'useful' | 'not-useful'>>(() => {
 try {
 const stored = localStorage.getItem('frontaliere_article_feedback');
 return stored ? JSON.parse(stored) : {};
 } catch { return {}; }
 });

 // Device breakpoints for conditional ad rendering (prevents CSS-hidden width=0 bug)
 const isMobile = useMediaQuery('(max-width: 639px)'); // sm breakpoint
 const isDesktopXl = useMediaQuery('(min-width: 1280px)'); // xl breakpoint

 // Mobile infinite scroll: accumulate articles instead of paginating
 const [mobileArticleLimit, setMobileArticleLimit] = useState(ARTICLES_PER_PAGE);

 // Content gate auth state (Google / LinkedIn / email)
 const inlineGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const [inlineGoogleButtonReady, setInlineGoogleButtonReady] = useState(false);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [authBusy, setAuthBusy] = useState<'google' | 'email' | 'linkedin' | null>(null);
 const [authError, setAuthError] = useState<string | null>(null);
 const [gateEmailInput, setGateEmailInput] = useState('');

 useEffect(() => {
  isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, []);

 // Mount Google Sign-In button when an article is selected and its body is ready
 useEffect(() => {
  if (!selectedArticle || !bodyReady) return;
  eagerAuth();
  const tid = window.setTimeout(() => {
   const el = inlineGoogleButtonRef.current;
   if (!el) return;
   void renderGoogleButtonWithReadiness(el).then(setInlineGoogleButtonReady).catch(() => {});
  }, 150);
  return () => window.clearTimeout(tid);
 }, [selectedArticle, bodyReady]);

 const handleBlogGoogleAuth = useCallback(async () => {
  setAuthBusy('google');
  setAuthError(null);
  try {
   const user = await signInWithGoogle();
   if (!user) {
    setAuthBusy(null);
    return;
   }
   const email = (user?.email as string | undefined) || null;
   if (email) {
    try { localStorage.setItem('ft_job_email', email); } catch { /* quota */ }
   }
   Analytics.trackSelectContent('blog_content_gate', 'auth_success_google');
   window.location.reload();
  } catch {
   setAuthError(t('blog.gate.authFailed'));
   setAuthBusy(null);
  }
 }, [t]);

 const handleBlogLinkedInAuth = useCallback(() => {
  setAuthBusy('linkedin');
  setAuthError(null);
  Analytics.trackSelectContent('blog_content_gate', 'auth_method_click_linkedin');
  signInWithLinkedIn().catch(() => {
   setAuthError(t('blog.gate.authFailed'));
   setAuthBusy(null);
  });
 }, [t]);

 const handleBlogEmailAccess = useCallback((e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const email = gateEmailInput.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
   setAuthError(t('blog.gate.emailInvalid'));
   return;
  }
  setAuthBusy('email');
  setAuthError(null);
  try { localStorage.setItem('ft_job_email', email); } catch { /* quota */ }
  Analytics.trackSelectContent('blog_content_gate', 'auth_success_email');
  window.location.reload();
 }, [gateEmailInput, t]);

 // FRO-314: Load blog meta translations AND articles data in parallel on mount.
 // Dynamic import of blog-articles-data (122KB) so it doesn't block component parse time.
 useEffect(() => {
 Promise.all([
 loadBlogMeta(),
 import('@/data/blog-articles-data').then(m => m.ARTICLES),
 ]).then(([, data]) => {
 setArticles(data);
 setBlogReady(true);
 }).catch(() => {});
 }, []);

 // Lazy-load article BODY when a specific article is selected
 useEffect(() => {
 if (!selectedArticle) { setBodyReady(false); return; }
 setBodyReady(false);
 loadArticleBody(selectedArticle).then(() => setBodyReady(true)).catch(() => {});
 trackArticleView(selectedArticle);
 }, [selectedArticle]);

 // Fetch job listings for cross-linking (related jobs in article view)
 const [crossLinkJobs, setCrossLinkJobs] = useState<JobPreview[]>([]);
 useEffect(() => {
 if (!selectedArticle) return;
 let cancelled = false;
 fetch(`/data/jobs-${locale}.json`)
 .then(res => {
 if (!res.ok) throw new Error(`${res.status}`);
 return res.json();
 })
 .catch(() => fetch('/data/jobs.json').then(res => res.json()))
 .then((data: JobPreview[]) => {
 if (!cancelled && Array.isArray(data)) setCrossLinkJobs(data);
 })
 .catch(() => {});
 return () => { cancelled = true; };
 }, [selectedArticle, locale]);

 const relatedJobs = useMemo(() => {
 if (!selectedArticle || crossLinkJobs.length === 0) return [];
 return getRelatedJobsForArticle(selectedArticle, crossLinkJobs, locale, articles);
 }, [selectedArticle, crossLinkJobs, locale, articles]);

 // Fetch trending articles from Firestore (cached 1h in localStorage)
 const [trendingArticles, setTrendingArticles] = useState<TrendingEntry[]>([]);
 useEffect(() => {
 if (!selectedArticle) return;
 const validIds = new Set<string>(articles.map(a => a.id));
 fetchTrendingArticles(validIds).then(setTrendingArticles).catch(() => {});
 }, [selectedArticle]);

 // Reading progress bar — passive scroll listener for article view
 const scrollRafId = useRef(0);
 useEffect(() => {
 if (!selectedArticle || !bodyReady) {
 setReadingProgress(0);
 return;
 }
 const handleScroll = () => {
 cancelAnimationFrame(scrollRafId.current);
 scrollRafId.current = requestAnimationFrame(() => {
 const el = articleRef.current;
 if (!el) return;
 const rect = el.getBoundingClientRect();
 const windowH = window.innerHeight;
 // 0% when top of article is at viewport top, 100% when bottom reaches viewport bottom
 const total = rect.height - windowH;
 if (total <= 0) { setReadingProgress(100); return; }
 const scrolled = -rect.top;
 setReadingProgress(Math.min(100, Math.max(0, (scrolled / total) * 100)));
 });
 };
 window.addEventListener('scroll', handleScroll, { passive: true });
 handleScroll();
 return () => {
 window.removeEventListener('scroll', handleScroll);
 cancelAnimationFrame(scrollRafId.current);
 };
 }, [selectedArticle, bodyReady]);

 // IntersectionObserver for TOC active heading tracking
 useEffect(() => {
 if (!selectedArticle || !bodyReady) return;
 const el = articleRef.current;
 if (!el) return;
 const headingEls = el.querySelectorAll<HTMLElement>('h2[id], h3[id]');
 if (headingEls.length < 3) return;
 const observer = new IntersectionObserver(
 (entries) => {
 for (const entry of entries) {
 if (entry.isIntersecting) {
 setActiveHeadingId(entry.target.id);
 }
 }
 },
 { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
 );
 headingEls.forEach(h => observer.observe(h));
 return () => observer.disconnect();
 }, [selectedArticle, bodyReady]);
 useEffect(() => {
 if (!selectedArticle || articles.length === 0) return;
 const article = articles.find(a => a.id === selectedArticle);
 if (!article) return;
 const title = t(`blog.article.${article.id}.title`);
 const excerpt = t(`blog.article.${article.id}.excerpt`);
 // Skip injection if translations aren't loaded yet
 if (title.startsWith('blog.article.')) return;
 const canonicalUrl = `https://frontaliereticino.ch${buildPath({ activeTab: 'blog', blogArticle: article.id })}`;
 // Compute actual body word count from translated segments — matches the
 // bodyWordCount used by contentGateApplies in renderArticle. Determines
 // whether this URL is paywalled for crawlers (Flexible Sampling pattern).
 const articleBodyText = collectBodyParts(article.id, t).join(' ');
 const articleBodyWordCount = articleBodyText.split(/\s+/).filter(Boolean).length;
 const wordCount = articleBodyWordCount || estimateReadingMinutes(article.id, t) * 200;
 const articlePaywallable = articleBodyWordCount >= 300;
 const jsonLd: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'NewsArticle',
 headline: title,
 description: excerpt.startsWith('blog.article.') ? title : excerpt,
 datePublished: `${article.date}T00:00:00+01:00`,
 dateModified: `${(article.updatedAt || article.date).slice(0, 10)}T00:00:00+01:00`,
 author: {
 '@type': 'Organization',
 '@id': 'https://frontaliereticino.ch/#organization',
 name: 'Redazione Frontaliere Ticino',
 url: 'https://frontaliereticino.ch/chi-siamo/',
 },
 publisher: {
 '@type': 'Organization',
 name: 'Frontaliere Ticino',
 url: 'https://frontaliereticino.ch',
 logo: {
 '@type': 'ImageObject',
 url: 'https://frontaliereticino.ch/icons/icon-512x512.png',
 },
 },
 isPartOf: { '@type': 'WebSite', '@id': 'https://frontaliereticino.ch/#website', name: 'Frontaliere Ticino' },
 mainEntityOfPage: canonicalUrl,
 image: `https://frontaliereticino.ch${article.image}`,
 inLanguage: locale,
 isAccessibleForFree: !articlePaywallable,
 articleSection: article.category,
 wordCount,
 speakable: {
 '@type': 'SpeakableSpecification',
 cssSelector: ['h1', '.article-body p:first-of-type', '[data-speakable]'],
 },
 };
 // Google Flexible Sampling: when the article is paywalled, mark the
 // hidden second half via cssSelector so crawlers can index full content
 // without triggering cloaking penalties. The selector matches the DOM
 // markers applied in renderArticle.
 if (articlePaywallable) {
 jsonLd.hasPart = {
 '@type': 'WebPageElement',
 isAccessibleForFree: false,
 cssSelector: '.paywall-hidden-content',
 };
 }
 const scriptId = 'blog-article-jsonld';
 // Remove any pre-existing BlogPosting JSON-LD from static HTML (ogPagesPlugin)
 // to prevent duplicate schemas during SPA hydration
 document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
 if (el.id === scriptId) return;
 try {
 const data = JSON.parse(el.textContent || '');
 if (data['@type'] === 'BlogPosting' || data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
 el.remove();
 }
 } catch { /* non-JSON — leave it */ }
 });
 let el = document.getElementById(scriptId) as HTMLScriptElement | null;
 if (!el) {
 el = document.createElement('script');
 el.id = scriptId;
 el.type = 'application/ld+json';
 document.head.appendChild(el);
 }
 el.textContent = JSON.stringify(jsonLd);

 // FAQ schema for evergreen (non-novita) articles with question-like H2 headings.
 // Skip if a static FAQPage JSON-LD already exists (from ogPagesPlugin) to avoid
 // Google's"duplicate FAQPage" rich results error.
 const faqScriptId = 'faq-schema';
 const hasStaticFaqPage = Array.from(
 document.querySelectorAll('script[type="application/ld+json"]:not([data-dynamic-ld])')
 ).some(el => {
 if (el.id === faqScriptId) return false;
 try { return JSON.parse(el.textContent || '')?.['@type'] === 'FAQPage'; } catch { return false; }
 });
 if (!hasStaticFaqPage && EVERGREEN_CATEGORIES.has(article.category)) {
 const bodyTexts = collectBodyParts(article.id, t);
 const faqPairs = extractFaqPairs(bodyTexts.join('\n\n'));
 if (faqPairs.length >= 2) {
 const faqSchema = {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: faqPairs.slice(0, 10).map(pair => ({
 '@type': 'Question',
 name: pair.question,
 acceptedAnswer: { '@type': 'Answer', text: pair.answer },
 })),
 };
 let faqEl = document.getElementById(faqScriptId) as HTMLScriptElement | null;
 if (!faqEl) {
 faqEl = document.createElement('script');
 faqEl.id = faqScriptId;
 faqEl.type = 'application/ld+json';
 document.head.appendChild(faqEl);
 }
 faqEl.textContent = JSON.stringify(faqSchema);
 } else {
 document.getElementById(faqScriptId)?.remove();
 }
 } else if (!hasStaticFaqPage) {
 document.getElementById(faqScriptId)?.remove();
 }

 return () => {
 const existing = document.getElementById(scriptId);
 if (existing) existing.remove();
 document.getElementById(faqScriptId)?.remove();
 };
 }, [selectedArticle, articles, locale, t]);

 const handleResponsiveImageError = useCallback((imagePath: string) => {
 setImageFallbackMap(prev => (prev[imagePath] ? prev : { ...prev, [imagePath]: true }));
 }, []);

 // Track viewport for mobile-first performance tuning on hub list.
 useEffect(() => {
 let rafId = 0;
 const updateViewport = () => {
 cancelAnimationFrame(rafId);
 rafId = requestAnimationFrame(() => {
 const w = window.innerWidth;
 // Keep initial above-the-fold payload tiny on mobile.
 if (w < 640) setGridRevealCount(4);
 else if (w < 1024) setGridRevealCount(8);
 else setGridRevealCount(9);
 });
 };
 updateViewport();
 window.addEventListener('resize', updateViewport);
 return () => { window.removeEventListener('resize', updateViewport); cancelAnimationFrame(rafId); };
 }, []);

 const filteredArticles = useMemo(() => {
 const filtered = selectedCategory === 'all'
 ? [...articles]
 : articles.filter(a => a.category === selectedCategory);
 return filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
 }, [selectedCategory, articles]);

 const totalPages = Math.max(1, Math.ceil(filteredArticles.length / ARTICLES_PER_PAGE));
 const desktopPageArticles = filteredArticles.slice(
 (currentPage - 1) * ARTICLES_PER_PAGE,
 currentPage * ARTICLES_PER_PAGE,
 );
 const mobileArticles = useMemo(() => filteredArticles.slice(0, mobileArticleLimit), [filteredArticles, mobileArticleLimit]);
 const pageArticles = isMobile ? mobileArticles : desktopPageArticles;
 const hasMoreMobileArticles = isMobile && mobileArticleLimit < filteredArticles.length;

 // Preload hero image for LCP optimisation (listing view only)
 const heroImage = !selectedArticle && pageArticles.length > 0 ? pageArticles[0].image : null;
 useEffect(() => {
   if (!heroImage) return;
   const link = document.createElement('link');
   link.rel = 'preload';
   link.as = 'image';
   link.href = heroImage;
   link.fetchPriority = 'high';
   document.head.appendChild(link);
   return () => { document.head.removeChild(link); };
 }, [heroImage]);

 const loadMoreArticles = useCallback(() => {
 setMobileArticleLimit(prev => prev + ARTICLES_PER_PAGE);
 }, []);

 // Infinite scroll sentinel for mobile
 // Re-create observer after each batch so Safari correctly detects re-intersection
 const articleSentinelRef = useRef<HTMLButtonElement>(null);
 useEffect(() => {
 if (!isMobile || !hasMoreMobileArticles) return;
 const el = articleSentinelRef.current;
 if (!el) return;
 const io = new IntersectionObserver(
 ([entry]) => { if (entry.isIntersecting) loadMoreArticles(); },
 { rootMargin: '200px' },
 );
 io.observe(el);
 return () => io.disconnect();
 }, [isMobile, hasMoreMobileArticles, loadMoreArticles, mobileArticleLimit]);

 useEffect(() => {
 setCurrentPage(prev => Math.min(prev, totalPages));
 }, [totalPages]);

 useEffect(() => {
 if (typeof window === 'undefined') return;
 sessionStorage.setItem(BLOG_LIST_PAGE_STORAGE_KEY, String(currentPage));
 }, [currentPage]);

 /* Build navigators map for keyword auto-linking — uses NavigationContext */
 const navigators = useMemo<NavigatorMap>(() => {
 const m: NavigatorMap = {};
 for (const action of Object.keys(NAV_ACTION_ROUTES) as NavAction[]) {
 const r = NAV_ACTION_ROUTES[action];
 const sub = r.calcolatoreSubTab || r.confrontiSubTab || r.fiscoSubTab || r.guidaSubTab || r.vitaSubTab || r.statsSubTab;
 m[action] = () => nav.navigateTo(r.activeTab, sub);
 }
 return m;
 }, [nav]);

 /** Build list of contextual CTAs for an article based on keyword density in the body text */
 const getArticleCTAs = (articleId: string): CtaConfig[] => {
 const title = t(`blog.article.${articleId}.title`);
 const excerpt = t(`blog.article.${articleId}.excerpt`);
 // Concatenate all body sections
 const body = collectBodyParts(articleId, t).join(' ');
 const contextText = `${articleId} ${title} ${excerpt} ${body}`;

 const cluster: SeoCluster =
 SEO_CLUSTER_PATTERNS.taxes20km.test(contextText) ? 'taxes20km'
 : SEO_CLUSTER_PATTERNS.pension.test(contextText) ? 'pension'
 : SEO_CLUSTER_PATTERNS.exchange.test(contextText) ? 'exchange'
 : 'generic';

 // Count keyword matches per NavAction
 const counts: Partial<Record<NavAction, number>> = {};
 for (const { giPattern, action } of KEYWORD_LINKS_GI) {
 const matches = body.match(giPattern);
 if (matches) {
 counts[action] = (counts[action] || 0) + matches.length;
 }
 }

 // Sort by density descending, take top candidates with an available navigator
 const rankedByDensity = (Object.entries(counts) as [NavAction, number][])
 .filter(([action]) => navigators[action])
 .sort((a, b) => b[1] - a[1])
 .slice(0, 6)
 .map(([action]) => action);

 // Enforce cluster-first CTAs for stronger internal linking on high-intent SEO pages.
 const orderedActions: NavAction[] = [];
 const pushUnique = (action: NavAction) => {
 if (!navigators[action]) return;
 if (orderedActions.includes(action)) return;
 if (!NAV_ACTION_CTA_MAP[action]) return;
 orderedActions.push(action);
 };

 for (const action of SEO_CLUSTER_ACTIONS[cluster]) pushUnique(action);
 for (const action of rankedByDensity) pushUnique(action);
 for (const action of SEO_CLUSTER_ACTIONS.generic) pushUnique(action);

 const ranked = orderedActions.slice(0, 4);

 // Fallback hard-stop: always include calculator if nothing else passed filters
 if (ranked.length === 0 && navigators.calculator) {
 ranked.push('calculator');
 }

 return ranked.map(action => {
 const cfg = NAV_ACTION_CTA_MAP[action];
 return {
 icon: cfg.icon,
 titleKey: `${cfg.i18nPrefix}.title`,
 descKey: `${cfg.i18nPrefix}.desc`,
 buttonKey: `${cfg.i18nPrefix}.btn`,
 action: navigators[action]!,
 navAction: action,
 color: cfg.color,
 };
 });
 };

 const handleCategoryChange = (cat: string) => {
 setSelectedCategory(cat);
 setCurrentPage(1);
 setMobileArticleLimit(ARTICLES_PER_PAGE);
 };

 // Reset progressive reveal when user changes page/category.
 useEffect(() => {
 const w = typeof window !== 'undefined' ? window.innerWidth : 375;
 if (w < 640) setGridRevealCount(4);
 else if (w < 1024) setGridRevealCount(8);
 else setGridRevealCount(9);
 }, [currentPage, selectedCategory]);

 // Category stats for the list-view header (must be above early returns to maintain stable hook order)
 const categoryStats = useMemo(() => {
 const counts: Record<string, number> = {};
 for (const a of articles) counts[a.category] = (counts[a.category] || 0) + 1;
 return counts;
 }, [articles]);

 // Article detail computed values — MUST be above early returns to maintain stable hook count.
 // React#310: placing useMemo after conditional returns (if !blogReady / if !bodyReady)
 // caused"Rendered more hooks than during the previous render" on article pages.

 // ── Affiliate side-rail helpers (must be above the useMemo that calls getPartnersForCategory) ──
 const CATEGORY_TO_CONTEXTS: Record<Article['category'], ComparatorContext[]> = {
 fiscale: ['exchange', 'banks', 'simulator'],
 pratico: ['transport', 'mobile', 'banks'],
 novita: ['exchange', 'banks', 'jobs'],
 pensione: ['pension', 'banks', 'exchange'],
 };

 const getPartnersForCategory = (category: Article['category'], max = 4): AffiliatePartner[] => {
 const contexts = CATEGORY_TO_CONTEXTS[category];
 const seen = new Set<string>();
 const result: AffiliatePartner[] = [];
 for (const ctx of contexts) {
 for (const p of PARTNERS.filter(p => p.contexts.includes(ctx)).sort((a, b) => b.priority - a.priority)) {
 if (!seen.has(p.id) && result.length < max) { seen.add(p.id); result.push(p); }
 }
 }
 return result;
 };

 const selectedArticleObj = selectedArticle ? articleById.get(selectedArticle) ?? null : null;
 const articleCTAs = useMemo(() => selectedArticle ? getArticleCTAs(selectedArticle) : [], [selectedArticle, navigators, articles, t]);
 const sidePartners = useMemo(() => selectedArticleObj ? getPartnersForCategory(selectedArticleObj.category, 4) : [], [selectedArticleObj?.category]);

 /** Returns imageAlt translation if available, falls back to article title */
 const getImageAlt = (id: string) => {
 const altKey = `blog.article.${id}.imageAlt`;
 const alt = t(altKey);
 return alt !== altKey ? alt : t(`blog.article.${id}.title`);
 };

 const getCategoryColor = (cat: string) => {
 switch (cat) {
 case 'fiscale': return 'bg-accent-subtle text-accent';
 case 'pratico': return 'bg-success-subtle text-success';
 case 'novita': return 'bg-accent-subtle text-accent';
 case 'pensione': return 'bg-warning-subtle text-warning';
 default: return 'bg-surface-raised text-body';
 }
 };

 const handleArticleClick = (articleId: BlogArticleId) => {
 if (onSelectArticle) {
 onSelectArticle(articleId);
 }
 };

 const handleBackToList = () => {
 if (onSelectArticle) {
 onSelectArticle(null);
 }
 };

 const getArticleUrl = (articleId: BlogArticleId): string => {
 return `https://frontaliereticino.ch${buildPath({ activeTab: 'blog', blogArticle: articleId })}`;
 };

 const handleCopyLink = async (articleId: BlogArticleId) => {
 const url = getArticleUrl(articleId);
 try {
 await navigator.clipboard.writeText(url);
 setCopied(true);
 setTimeout(() => setCopied(false), 2000);
 } catch {
 const ta = document.createElement('textarea');
 ta.value = url;
 document.body.appendChild(ta);
 ta.select();
 document.execCommand('copy');
 document.body.removeChild(ta);
 setCopied(true);
 setTimeout(() => setCopied(false), 2000);
 }
 Analytics.trackShare('copy_link', 'blog_article', articleId);
 };

 const handleWhatsAppShare = (articleId: BlogArticleId) => {
 const title = t(`blog.article.${articleId}.title`);
 const url = getArticleUrl(articleId);
 const text = `${title} → ${url}`;
 window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
 Analytics.trackShare('whatsapp', 'blog_article', articleId);
 };

 const handleTwitterShare = (articleId: BlogArticleId) => {
 const title = t(`blog.article.${articleId}.title`);
 const url = getArticleUrl(articleId);
 window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
 Analytics.trackShare('twitter', 'blog_article', articleId);
 };

 const handleFacebookShare = (articleId: BlogArticleId) => {
 const url = getArticleUrl(articleId);
 window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
 Analytics.trackShare('facebook', 'blog_article', articleId);
 };

 const handleTelegramShare = (articleId: BlogArticleId) => {
 const title = t(`blog.article.${articleId}.title`);
 const url = getArticleUrl(articleId);
 window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`, '_blank', 'noopener,noreferrer');
 Analytics.trackShare('telegram', 'blog_article', articleId);
 };

 const handleLinkedInShare = (articleId: BlogArticleId) => {
 const url = getArticleUrl(articleId);
 window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
 Analytics.trackShare('linkedin', 'blog_article', articleId);
 };

 const handleEmailShare = (articleId: BlogArticleId) => {
 const title = t(`blog.article.${articleId}.title`);
 const url = getArticleUrl(articleId);
 window.open(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${title}\n\n${url}`)}`, '_self');
 Analytics.trackShare('email', 'blog_article', articleId);
 };

 const handleNativeShare = async (articleId: BlogArticleId) => {
 const title = t(`blog.article.${articleId}.title`);
 const url = getArticleUrl(articleId);
 try {
 await navigator.share({ title, url });
 Analytics.trackShare('native', 'blog_article', articleId);
 } catch {
 /* user cancelled */
 }
 };

 const toggleBookmark = (articleId: BlogArticleId) => {
 setSavedArticles(prev => {
 const next = new Set(prev);
 if (next.has(articleId)) next.delete(articleId);
 else next.add(articleId);
 try { localStorage.setItem('frontaliere_saved_articles', JSON.stringify([...next])); } catch { /* quota */ }
 return next;
 });
 };

 const handlePrint = () => {
 window.print();
 };

 const handleFeedback = (articleId: string, value: 'useful' | 'not-useful') => {
 setArticleFeedback(prev => {
 const next = { ...prev };
 if (next[articleId] === value) delete next[articleId]; // toggle off
 else next[articleId] = value;
 try { localStorage.setItem('frontaliere_article_feedback', JSON.stringify(next)); } catch { /* quota */ }
 return next;
 });
 };

 const formatDate = (dateStr: string): string => {
 const d = new Date(dateStr);
 const localeMap: Record<string, string> = { it: 'it-IT', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' };
 return d.toLocaleDateString(localeMap[locale] ?? 'it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
 };

 // ── Loading blog translations ──────────────────────
 if (!blogReady) {
 return (
 <div className="min-h-[80vh] space-y-6 p-4">
 {/* Skeleton hero card */}
 <div className="rounded-2xl overflow-hidden bg-surface-raised animate-pulse h-64 sm:h-80" />
 {/* Skeleton article grid — matches real layout: 6 cards with image h-40 + content ~120px */}
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
 {[1,2,3,4,5,6].map(i => (
 <div key={i} className="rounded-xl bg-surface-raised animate-pulse h-[280px]" />
 ))}
 </div>
 </div>
 );
 }

 // CATEGORY_TO_CONTEXTS + getPartnersForCategory moved above useMemo (line ~1326) to avoid TDZ

 // ── Single Article View ──────────────────────────────
 if (selectedArticle) {
 const article = selectedArticleObj;
 if (!article) return null;

 // Wait for article body translations to load
 if (!bodyReady) {
 return (
 <div className="max-w-3xl xl:max-w-6xl mx-auto min-h-[80vh] p-4 space-y-4">
 <div className="rounded-2xl bg-surface-raised animate-pulse h-48 sm:h-64 md:h-80" />
 <div className="space-y-3">
 <div className="h-6 bg-surface-raised rounded animate-pulse w-3/4" />
 <div className="h-4 bg-surface-raised rounded animate-pulse w-full" />
 <div className="h-4 bg-surface-raised rounded animate-pulse w-5/6" />
 <div className="h-4 bg-surface-raised rounded animate-pulse w-2/3" />
 </div>
 </div>
 );
 }

 const bodySegments = collectBodyParts(article.id, t);
 const presentSegments = bodySegments;
 const combinedBody = presentSegments.join(' ');
 const bodyWordCount = combinedBody.split(/\s+/).filter(Boolean).length;
 const bodyCharCount = combinedBody.trim().length;
 // Single quality threshold for all ad formats (FRO-287):
 // 220 words + 1400 chars minimum ensures AdSense policy compliance
 // and avoids thin-content penalties. Articles below this threshold
 // should be enriched via AI expansion (FRO-292) rather than lowering the bar.
 const adEligible = bodyReady && presentSegments.length >= 3 && bodyWordCount >= 220 && bodyCharCount >= 1400;
 const adEligibleInline = adEligible;

 // Content gate — mirrors JobBoard.tsx hasAccess logic exactly:
 //   Firebase auth (Google/LinkedIn) OR legacy email localStorage OR crawler UA.
 // Crawlers MUST bypass the gate: without this, SEO content goes missing on
 // half of long articles and Google indexes the "sign in" call-to-action
 // instead of the real text.
 const isCrawlerVisitor = typeof window !== 'undefined' &&
  /bot|crawler|spider|crawling|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|applebot|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp/i.test(
   navigator.userAgent || ''
  );
 const hasEmailAccess = typeof window !== 'undefined' && (
  !!localStorage.getItem('ft_job_email') ||
  !!localStorage.getItem('frontaliere_job_email_access')
 );
 const hasArticleAccess = isLoggedIn || hasEmailAccess || isCrawlerVisitor;
 // Article is "paywallable" when it has enough real text to justify gating.
 // Decoupled from contentGateApplies so the .paywall-hidden-content marker and
 // the JSON-LD hasPart selector stay stable per URL (what crawlers see), while
 // the actual hiding only fires for the current visitor when they lack access.
 // Threshold (300w) covers 99.6% of the corpus and excludes thin pages (<100w).
 const paywallable = bodyWordCount >= 300;
 // Keep gate closed while auth resolves — avoids a brief flash of "sign in"
 // for users who are already logged in when they land on an article.
 const contentGateApplies = !authLoading && !hasArticleAccess && paywallable;
 const visibleSegmentCount = paywallable ? Math.ceil(presentSegments.length / 2) : presentSegments.length;
 // Inline ad placement — scalable density (every >=2 segments AND >=250 words),
 // capped at 5 inline ads. Pure walk over visible segments, paywall-aware,
 // heading-safe. Cheap enough to recompute on every render.
 const adInsertionPlan = adEligibleInline
  ? computeArticleAdSlots(presentSegments, visibleSegmentCount, { minimumWhenEligible: 1 })
  : null;
 // Slot config lookup table (positions 1..5 → AD_SLOTS entries).
 const articleInlineSlotByPosition = [
  AD_SLOTS.ARTICLE_INLINE_MOBILE,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_2,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_3,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_4,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_5,
 ] as const;

 // TOC headings extracted from article body
 const tocHeadings = extractHeadings(bodySegments);
 const showToc = tocHeadings.length >= 3;

 const handleTocClick = (headingId: string) => {
 const el = document.getElementById(headingId);
 if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
 setTocOpen(false);
 };

 /** Compact vertical card for desktop side rails */
 const SideRailCard: FC<{ partner: AffiliatePartner; idx: number }> = ({ partner, idx }) => {
 const handleAffClick = () => {
 Analytics.trackExternalLink(partner.url, `affiliate_${partner.id}`);
 Analytics.trackAffiliateClick(partner.id, `blog_${article.category}`);
 };
 return (
 <a
 href={buildAffiliateUrl(partner, `blog_${article.category}`)}
 target="_blank"
 rel="noopener noreferrer sponsored"
 onClick={handleAffClick}
 className="group block p-3 bg-surface/70 rounded-xl border border-edge/60 hover:border-edge hover:shadow-sm transition-[color,border-color,box-shadow] text-center"
 >
 <span className="text-xl block mb-1">{partner.emoji}</span>
 <span className="text-xs font-semibold text-body block leading-tight">{partner.name}</span>
 {partner.badgeKey && (
 <span className={`mt-1 inline-block text-xs font-bold px-1.5 py-0.5 rounded-full bg-gradient-to-r ${partner.color} text-on-accent`}>
 {t(partner.badgeKey)}
 </span>
 )}
 <p className="text-sm text-muted mt-1 leading-snug">{t(partner.taglineKey)}</p>
 <span className="mt-1.5 inline-flex items-center gap-0.5 text-xs font-medium text-link group-hover:underline">
 {t('affiliate.cta')} <ExternalLink size={9} />
 </span>
 </a>
 );
 };


 return (
 <div className="max-w-3xl xl:max-w-6xl mx-auto">
 {/* Reading progress bar */}
 <div
 className="fixed top-0 left-0 z-50 h-[3px] w-full bg-gradient-to-r from-accent-strong via-accent-strong to-accent-strong-hover transition-transform duration-150 ease-out origin-left"
 style={{ transform: `scaleX(${readingProgress / 100})` }}
 role="progressbar"
 aria-valuenow={Math.round(readingProgress)}
 aria-valuemin={0}
 aria-valuemax={100}
 aria-label={t('blog.toc.readingProgress')}
 />

 {/* Back button — prominent */}
 <button
 onClick={handleBackToList}
 className="mb-6 inline-flex items-center gap-2 px-4 py-2 min-h-[44px] bg-surface border border-edge rounded-xl text-sm font-semibold text-body hover:bg-surface-raised transition-colors shadow-sm"
 aria-label={t('blog.backToList')}
 >
 <ArrowLeft size={16} />
 {t('blog.backToList')}
 </button>

 {/* 3-column grid: left rail | article | right rail */}
 <div className="xl:grid xl:grid-cols-[180px_1fr_180px] xl:gap-6">

 {/* ── Left Rail (desktop only) ── */}
 <aside className="hidden xl:block">
 <div className="sticky top-6 space-y-3">
 <p className="text-xs font-medium text-muted uppercase tracking-wider">
 {t('affiliate.sectionTitle')}
 </p>
 {sidePartners.slice(0, 2).map((p, i) => <SideRailCard key={p.id} partner={p} idx={i} />)}

 </div>
 </aside>

 <article ref={articleRef} className="bg-surface rounded-2xl border border-edge overflow-hidden shadow-lg">
 {/* Hero image */}
 <div className="relative overflow-hidden" style={{ aspectRatio: '2/1', contain: 'layout' }}>
 {(() => {
 const responsive = imageFallbackMap[article.image] ? null : getResponsiveImageSet(article.image);
 return (
 <img
 src={article.image}
 srcSet={responsive ? `${responsive.thumbWebp} 480w, ${article.image} 1200w` : undefined}
 sizes="(max-width: 768px) 100vw, 800px"
 alt={getImageAlt(article.id)}
 width={800}
 height={400}
 className="w-full h-full object-cover"
 loading="eager"
 fetchPriority="high"
 onError={() => handleResponsiveImageError(article.image)}
 />
 );
 })()}
 <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
 <div className="absolute bottom-4 left-4 right-4">
 <div className="flex items-center gap-2 mb-2">
 <span className={`px-3 py-1 rounded-full text-xs font-bold ${getCategoryColor(article.category)}`}>
 {t(`blog.category.${article.category}`)}
 </span>
 <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
 article.category === 'novita'
 ? 'bg-warning-strong/80 text-on-accent'
 : 'bg-on-accent/25 text-on-accent'
 }`}>
 {article.category === 'novita'
 ? t('blog.contentType.news')
 : t('blog.contentType.guide')}
 </span>
 </div>
 <h1 className="text-xl sm:text-2xl md:text-3xl font-bold font-display text-on-accent leading-tight">
 {t(`blog.article.${article.id}.title`)}
 </h1>
 </div>
 </div>

 {/* Meta bar */}
 <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 py-3 bg-surface-alt/50 border-b border-edge text-sm text-subtle">
 {article.authorSlug && article.authorName ? (
 <a
 href={`/autori/${article.authorSlug}/`}
 rel="author"
 className="flex items-center gap-1 font-medium text-accent hover:underline"
 >
 <PenLine size={14} />
 {t('blog.bylinePrefix')} {article.authorName}
 </a>
 ) : (
 <span className="flex items-center gap-1 font-medium text-accent">
 <PenLine size={14} />
 {t('blog.byline')}
 </span>
 )}
 <span className="text-edge">|</span>
 <span className="flex items-center gap-1">
 <Calendar size={14} />
 {formatDate(article.date)}
 </span>
 {article.updatedAt && article.updatedAt !== article.date.slice(0, 10) && (
 <span className="flex items-center gap-1 text-success">
 <RefreshCw size={12} />
 {t('blog.updatedOn')} {formatDate(article.updatedAt)}
 </span>
 )}
 <span className="flex items-center gap-1">
 <Clock size={14} />
 {estimateReadingMinutes(article.id, t)} min
 </span>
 <div className="ml-auto flex items-center gap-1.5 flex-wrap">
 {/* Copy link */}
 <button
 onClick={() => handleCopyLink(article.id)}
 className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-surface-raised hover:bg-surface-raised text-xs font-medium transition-colors"
 aria-label={t('blog.copyLink')}
 >
 {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
 {copied ? t('blog.copied') : t('blog.copyLink')}
 </button>
 {/* WhatsApp */}
 <button
 onClick={() => handleWhatsAppShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-brand-whatsapp/10 hover:bg-brand-whatsapp/20 text-brand-whatsapp transition-colors"
 aria-label={t('blog.shareWhatsApp')}
 title={t('blog.shareWhatsApp')}
 >
 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
 </button>
 {/* Twitter/X */}
 <button
 onClick={() => handleTwitterShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-raised hover:bg-surface-raised text-body transition-colors"
 aria-label={t('blog.shareTwitter')}
 title={t('blog.shareTwitter')}
 >
 <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
 </button>
 {/* Facebook */}
 <button
 onClick={() => handleFacebookShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-brand-facebook/10 hover:bg-brand-facebook/20 text-brand-facebook transition-colors"
 aria-label={t('blog.shareFacebook')}
 title={t('blog.shareFacebook')}
 >
 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
 </button>
 {/* Telegram */}
 <button
 onClick={() => handleTelegramShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-brand-telegram/10 hover:bg-brand-telegram/20 text-brand-telegram transition-colors"
 aria-label={t('blog.shareTelegram')}
 title={t('blog.shareTelegram')}
 >
 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
 </button>
 {/* LinkedIn */}
 <button
 onClick={() => handleLinkedInShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-brand-linkedin/10 hover:bg-brand-linkedin/20 text-brand-linkedin transition-colors"
 aria-label={t('blog.shareLinkedIn')}
 title={t('blog.shareLinkedIn')}
 >
 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 </button>
 {/* Email */}
 <button
 onClick={() => handleEmailShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-raised hover:bg-surface-raised text-body transition-colors"
 aria-label={t('blog.shareEmail')}
 title={t('blog.shareEmail')}
 >
 <Mail size={14} />
 </button>
 {/* Native share (mobile) */}
 {typeof navigator !== 'undefined' && 'share' in navigator && (
 <button
 onClick={() => handleNativeShare(article.id)}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-accent-subtle hover:bg-accent-subtle/50 text-accent transition-colors"
 aria-label={t('blog.shareNative')}
 title={t('blog.shareNative')}
 >
 <Share2 size={14} />
 </button>
 )}
 <span className="text-edge">|</span>
 {/* Bookmark */}
 <button
 onClick={() => toggleBookmark(article.id)}
 className={`inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
 savedArticles.has(article.id)
 ? 'bg-warning-subtle text-warning'
 : 'bg-surface-raised hover:bg-surface-raised text-body'
 }`}
 aria-label={savedArticles.has(article.id) ? t('blog.bookmarkRemove') : t('blog.bookmarkAdd')}
 title={savedArticles.has(article.id) ? t('blog.bookmarkRemove') : t('blog.bookmarkAdd')}
 >
 <BookmarkIcon size={14} fill={savedArticles.has(article.id) ? 'currentColor' : 'none'} />
 </button>
 {/* Print */}
 <button
 onClick={handlePrint}
 className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-raised hover:bg-surface-raised text-body transition-colors print:hidden"
 aria-label={t('blog.print')}
 title={t('blog.print')}
 >
 <Printer size={14} />
 </button>
 </div>
 </div>

 {/* Contextual banner for news articles */}
 {article.category === 'novita' && (
 <div className="mx-4 sm:mx-6 mt-4 px-4 py-3 rounded-xl bg-warning-subtle border border-warning-border/40 flex items-start gap-3">
 <Newspaper size={18} className="text-warning mt-0.5 shrink-0" />
 <div>
 <p className="text-sm font-semibold text-warning">{t('blog.newsBanner.title')}</p>
 <p className="text-sm text-warning mt-0.5">{t('blog.newsBanner.desc')}</p>
 </div>
 </div>
 )}

 {/* AI transparency disclosure (Google News compliance — A3) */}
 <aside
 className="mx-4 sm:mx-6 mt-4 rounded-xl border border-edge bg-surface-alt px-4 py-3 text-sm text-subtle"
 role="note"
 aria-label="Trasparenza editoriale"
 >
 <p className="mb-1">
 <strong className="text-body">Trasparenza editoriale:</strong>{' '}
 bozza assistita da intelligenza artificiale, revisionata dalla redazione.
 Le fonti utilizzate sono linkate nel testo.
 </p>
 <p className="text-xs">
 <a
 href="/metodologia/"
 className="text-accent hover:underline"
 onClick={(e) => { e.preventDefault(); nav.navigateTo('metodologia' as any); }}
 >
 Come scriviamo gli articoli
 </a>
 {' · '}
 <a
 href="/correzioni/"
 className="text-accent hover:underline"
 onClick={(e) => { e.preventDefault(); nav.navigateTo('correzioni' as any); }}
 >
 Segnala una correzione
 </a>
 </p>
 </aside>

 {/* Article body */}
 <div className="px-4 sm:px-6 py-6 space-y-5">
 <Callout status="accent" variant="plain">
 <p className="text-lg text-subtle italic">
 {t(`blog.article.${article.id}.excerpt`)}
 </p>
 </Callout>

 {/* Mobile TOC — collapsible (hidden on xl where it shows in right rail) */}
 {showToc && (
 <div className="xl:hidden rounded-xl border border-edge bg-surface-alt/80 overflow-hidden">
 <button
 onClick={() => setTocOpen(prev => !prev)}
 className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-body"
 aria-expanded={tocOpen}
 aria-controls="mobile-toc"
 >
 <span className="flex items-center gap-2">
 <List size={16} className="text-accent" />
 {t('blog.toc.title')} ({tocHeadings.length} {t('blog.toc.sections')})
 </span>
 <ChevronDown size={16} className={`text-muted transition-transform duration-200 ${tocOpen ? 'rotate-180' : ''}`} />
 </button>
 {tocOpen && (
 <nav id="mobile-toc" className="px-4 pb-3 space-y-0.5" aria-label={t('blog.toc.title')}>
 {tocHeadings.map(h => (
 <button
 key={h.id}
 onClick={() => handleTocClick(h.id)}
 className={`block w-full text-left text-sm py-2.5 transition-colors rounded-md px-2 ${
 h.level === 3 ? 'pl-5 text-muted' : 'text-subtle font-medium'
 } hover:text-accent hover:bg-accent-subtle`}
 >
 {h.text}
 </button>
 ))}
 </nav>
 )}
 </div>
 )}

 <div className="space-y-4">
 {presentSegments.map((segment, idx) => {
  // Anti-cloaking: paywalled tail segments are always rendered in the DOM
  // (so crawlers can index the full article) but hidden via `display:none`
  // for visitors without access. The `.paywall-hidden-content` class is
  // the Schema.org hasPart cssSelector marker.
  const isInPaywall = paywallable && idx >= visibleSegmentCount;
  const hideForVisitor = isInPaywall && contentGateApplies;
  return (
 <Fragment key={idx}>
 {/* Interstitials after body1 (index 0) — all viewports */}
 {!hideForVisitor && idx === 1 && (
 <>
 {/* Live fuel price table — only for fuel-price articles */}
 {FUEL_PRICE_ARTICLE_IDS.has(article.id) && (
 <Suspense fallback={<div data-testid="inline-fuel-price-table-fallback" className="mt-6 h-24" />}>
 <InlineFuelPriceTable maxRows={10} />
 </Suspense>
 )}

 </>
 )}

 {/* Scalable inline ads — placement computed by computeArticleAdSlots.
   Renders before the segment at `idx` when the placer decided to plant one there. */}
 {!hideForVisitor && adInsertionPlan?.insertions.has(idx) && (() => {
  const position = adInsertionPlan.insertions.get(idx)!;
  const slotConfig = articleInlineSlotByPosition[position - 1];
  if (!slotConfig || isPlaceholderAdSlot(slotConfig.slot)) return null;
  return (
   <Suspense fallback={<div style={{ minHeight: slotConfig.placeholderMinHeight, contain: 'content' }} className="my-4" />}>
    <AdSenseBanner
     adSlot={slotConfig.slot}
     adFormat={slotConfig.format}
     adLayout={slotConfig.layout}
     fullWidthResponsive={false}
     enabled={adEligibleInline}
     className="my-4"
    />
   </Suspense>
  );
 })()}

 {/* Interstitials after body2 (index 1) */}
 {!hideForVisitor && idx === 2 && (
 <>
 {/* Inline job teaser — shows 1-2 relevant jobs mid-article */}
 {relatedJobs.length > 0 && (
 <div className="my-4 p-4 bg-gradient-to-r from-info-subtle to-accent-subtle border border-info-border rounded-xl">
 <div className="flex items-center justify-between mb-3">
 <p className="text-sm font-bold text-info flex items-center gap-1.5">
 <Briefcase size={15} className="text-info" />
 {t('blog.inlineJobs.title', getCantonI18nParams())}
 </p>
 <a
 href={buildPath({ activeTab: 'job-board' })}
 onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); Analytics.trackUIInteraction('blog_inline_jobs', 'link', 'click', 'view_all'); }}
 className="text-xs text-info hover:underline font-medium"
 >
 {t('blog.relatedJobs.viewAll')} →
 </a>
 </div>
 <div className="space-y-2">
 {relatedJobs.slice(0, 2).map(job => {
 const logo = jobLogoUrl(job);
 return (
 <a
 key={job.id}
 href={buildPath({ activeTab: 'job-board', jobSlug: job.slugByLocale?.[locale] ?? job.slug ?? job.id })}
 onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board', job.slugByLocale?.[locale] ?? job.slug ?? job.id); Analytics.trackUIInteraction('blog_inline_jobs', 'card', 'click', job.id); }}
 className="flex items-center gap-3 p-2.5 bg-surface/70 rounded-lg hover:bg-surface/50 transition-colors group"
 >
 <div className="w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center shrink-0 overflow-hidden">
 {logo ? <img src={logo} alt={`Logo ${job.company}`} width={24} height={24} className="w-6 h-6 object-contain" loading="lazy" onError={handleBlogLogoError} /> : <Building2 size={14} className="text-accent" />}
 </div>
 <div className="min-w-0 flex-1">
 <p className="text-sm font-semibold text-body truncate group-hover:text-accent transition-colors">
 {job.titleByLocale?.[locale] ?? job.title}
 </p>
 <p className="text-sm text-muted truncate">
 {job.company} · {job.location}
 </p>
 </div>
 <ChevronRight size={14} className="text-muted shrink-0" />
 </a>
 );
 })}
 </div>
 </div>
 )}

 {/* Inline lead magnet CTA — contextual variant based on article category */}
 <Suspense fallback={null}>
 <LeadMagnetCTA
 variant={
 article.category === 'fiscale' ? 'tax_checklist'
 : article.category === 'pensione' ? 'pension'
 : article.category === 'pratico' ? 'relocation'
 : 'generic'
 }
 compact
 />
 </Suspense>
 </>
 )}

 {isInPaywall ? (
 <div className={hideForVisitor ? 'paywall-hidden-content hidden' : 'paywall-hidden-content'}>
 {renderFormattedContent(segment, navigators)}
 </div>
 ) : (
 renderFormattedContent(segment, navigators)
 )}
 </Fragment>
  );
 })}

 {/* Content gate: fade overlay + sign-in prompt for unauthenticated users */}
 {contentGateApplies && (
  <>
  {/* Gradient fade-out overlay */}
  <div className="relative h-32 -mt-32 bg-gradient-to-t from-surface to-transparent pointer-events-none" />

  {/* Sign-in prompt — 3-method (Google / LinkedIn / Email) */}
  <div className="relative z-10 mx-auto max-w-lg rounded-2xl border border-accent-border bg-accent-subtle p-5 sm:p-6">
   <div className="flex items-center gap-3 mb-3">
    <div className="flex-shrink-0 p-2 bg-accent-subtle rounded-stripe">
     <BookOpen className="w-5 h-5 text-accent" />
    </div>
    <div>
     <h3 className="text-lg font-bold font-display text-heading">{t('blog.gate.title')}</h3>
     <p className="text-sm text-subtle">{t('blog.gate.subtitle')}</p>
    </div>
   </div>

   {/* Trust signals */}
   <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle">
    <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('blog.gate.benefit1')}</span>
    <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('blog.gate.benefit2')}</span>
    <span className="inline-flex items-center gap-1"><Shield size={12} className="text-success" />{t('blog.gate.privacyNote')}</span>
   </div>

   {/* Social proof */}
   {articles.length > 0 && (
    <p className="mb-3 text-xs font-medium text-accent">
     {articles.length.toLocaleString()}+ {locale === 'it' ? 'articoli disponibili gratis' : locale === 'de' ? 'Artikel kostenlos verfügbar' : locale === 'fr' ? 'articles gratuits disponibles' : 'articles available free'}
    </p>
   )}

   <div className="space-y-3">
    {/* Google Sign-In */}
    <div className="space-y-2">
     <div ref={inlineGoogleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
     {!inlineGoogleButtonReady && (
      <button
       type="button"
       onClick={() => void handleBlogGoogleAuth()}
       disabled={authBusy !== null}
       className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors"
      >
       {authBusy === 'google' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
        <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
         <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
         <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
         <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
         <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
       )}
       {t('newsletter.popup.googleSignIn')}
      </button>
     )}
    </div>

    {/* LinkedIn Sign-In (conditional) */}
    {linkedInAvailable && (
     <button
      type="button"
      onClick={handleBlogLinkedInAuth}
      disabled={authBusy !== null}
      className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-brand-linkedin hover:bg-brand-linkedin-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
     >
      {authBusy === 'linkedin' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
       <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
      )}
      {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
     </button>
    )}

    {/* Separator */}
    <div className="flex items-center gap-3">
     <div className="flex-1 h-px bg-surface-raised/50" />
     <span className="text-sm text-muted">{t('blog.gate.orEmail')}</span>
     <div className="flex-1 h-px bg-surface-raised/50" />
    </div>

    {/* Email form */}
    <form onSubmit={handleBlogEmailAccess} className="space-y-2">
     <input
      type="email"
      required
      value={gateEmailInput}
      onChange={(e) => setGateEmailInput(e.target.value)}
      placeholder={t('blog.gate.emailPlaceholder')}
      className="w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
     />
     <button
      type="submit"
      disabled={authBusy !== null || !gateEmailInput.trim()}
      className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
     >
      {authBusy === 'email' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
      {t('blog.gate.emailCta')}
     </button>
    </form>
   </div>

   {authError && <p className="text-sm text-danger mt-2">{authError}</p>}
  </div>

  {/* AdSense — below blog content gate */}
  {AD_SLOTS.JOBDETAIL_AUTH_GATE.slot && (
   <Suspense fallback={<div style={{ minHeight: AD_SLOTS.JOBDETAIL_AUTH_GATE.placeholderMinHeight, contain: 'content' }} className="mt-4" />}>
    <AdSenseBanner
    adSlot={AD_SLOTS.JOBDETAIL_AUTH_GATE.slot}
    adFormat={AD_SLOTS.JOBDETAIL_AUTH_GATE.format}
    fullWidthResponsive={AD_SLOTS.JOBDETAIL_AUTH_GATE.fullWidthResponsive}
    className="mt-4"
    />
   </Suspense>
  )}

  {/* AdSense — multiplex below content gate */}
  {AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot && (
   <Suspense fallback={<div style={{ minHeight: AD_SLOTS.AUTHGATE_END_MULTIPLEX.placeholderMinHeight, contain: 'content' }} className="mt-4" />}>
    <AdSenseBanner
    adSlot={AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot}
    adFormat={AD_SLOTS.AUTHGATE_END_MULTIPLEX.format}
    fullWidthResponsive={AD_SLOTS.AUTHGATE_END_MULTIPLEX.fullWidthResponsive}
    className="mt-4"
    />
   </Suspense>
  )}
  </>
 )}
 </div>

 {/* Visible FAQ section */}
 {(() => {
 const faqKey = `blog.article.${article.id}.faq`;
 const faqRaw = t(faqKey);
 if (faqRaw === faqKey) return null;
 try {
 const faqPairs = JSON.parse(faqRaw);
 if (!Array.isArray(faqPairs) || faqPairs.length < 2) return null;
 const validPairs = faqPairs.filter((p: { q?: string; a?: string }) => p.q && p.a && p.q.length > 5 && p.a.length > 10).slice(0, 8);
 if (validPairs.length < 2) return null;
 return (
 <div className="mt-8 border border-warning-border/40 bg-warning-subtle/50 rounded-xl overflow-hidden">
 <button
 onClick={() => {
 const el = document.getElementById('article-faq-content');
 if (el) el.classList.toggle('hidden');
 const btn = document.getElementById('article-faq-toggle');
 if (btn) btn.classList.toggle('rotate-180');
 }}
 className="w-full flex items-center justify-between p-4 sm:p-5 text-left"
 aria-expanded="false"
 aria-controls="article-faq-content"
 >
 <span className="flex items-center gap-2 text-base font-bold text-warning">
 <HelpCircle size={20} className="text-warning" />
 {locale === 'en' ? 'Frequently Asked Questions' : locale === 'de' ? 'Häufig gestellte Fragen' : locale === 'fr' ? 'Questions fréquentes' : 'Domande frequenti'}
 </span>
 <ChevronDown id="article-faq-toggle" size={18} className="text-warning transition-transform duration-200" />
 </button>
 <div id="article-faq-content" className="hidden px-4 sm:px-5 pb-4 sm:pb-5 space-y-3">
 {validPairs.map((pair: { q: string; a: string }, i: number) => (
 <div key={i} className="border-t border-warning-border pt-3">
 <p className="font-semibold text-sm text-strong">{pair.q}</p>
 <p className="text-sm text-subtle mt-1 leading-relaxed">{pair.a}</p>
 </div>
 ))}
 </div>
 </div>
 );
 } catch { return null; }
 })()}

 {/* Contextual CTA widgets */}
 {articleCTAs.length > 0 && (
 <div className={`${articleCTAs.length > 1 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : ''} mt-8`}>
 {articleCTAs.map((cta, idx) => {
 const Icon = cta.icon;
 return (
 <div key={idx} className={`${CTA_COLORS[cta.color]} border rounded-xl p-5`}>
 <div className="flex items-start gap-3">
 <Icon size={24} className={`${CTA_ICON_COLORS[cta.color]} shrink-0 mt-0.5`} />
 <div className="flex-1 min-w-0">
 <p className={`font-semibold ${CTA_TEXT_COLORS[cta.color].title}`}>
 {t(cta.titleKey)}
 </p>
 <p className={`text-sm ${CTA_TEXT_COLORS[cta.color].desc} mt-1`}>
 {t(cta.descKey)}
 </p>
 <a
 href={buildPath(NAV_ACTION_ROUTES[cta.navAction])}
 onClick={(e) => { e.preventDefault(); cta.action(); }}
 className={`mt-3 px-4 py-2 min-h-[44px] ${CTA_BTN_COLORS[cta.color]} text-on-accent rounded-xl text-sm font-semibold inline-flex items-center gap-1 transition-colors`}
 >
 {t(cta.buttonKey)} <ArrowRight size={14} />
 </a>
 </div>
 </div>
 </div>
 );
 })}
 </div>
 )}

 {/* Article feedback — utile / non utile */}
 <div className="mt-8 flex flex-col items-center gap-2 py-4 border-t border-edge">
 <p className="text-sm font-medium text-body">{t('blog.feedback.question')}</p>
 <div className="flex items-center gap-3">
 <button
 onClick={() => handleFeedback(article.id, 'useful')}
 className={`inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
 articleFeedback[article.id] === 'useful'
 ? 'bg-success-subtle text-success ring-1 ring-success-border'
 : 'bg-surface-raised text-subtle hover:bg-success-subtle'
 }`}
 aria-label={t('blog.feedback.useful')}
 >
 <ThumbsUp size={16} /> {t('blog.feedback.useful')}
 </button>
 <button
 onClick={() => handleFeedback(article.id, 'not-useful')}
 className={`inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
 articleFeedback[article.id] === 'not-useful'
 ? 'bg-danger-subtle text-danger ring-1 ring-danger-border'
 : 'bg-surface-raised text-subtle hover:bg-danger-subtle'
 }`} aria-label={t('blog.feedback.notUseful')} > <ThumbsDown size={16} /> {t('blog.feedback.notUseful')} </button> </div> {articleFeedback[article.id] && ( <p className="text-sm text-muted mt-1">{t('blog.feedback.thanks')}</p> )} </div> {/* Author bio for E-E-A-T (A2: dynamic byline → /autori/{slug}/) */} <div className="mt-8 p-4 bg-surface-alt rounded-xl border border-edge"> <div className="flex items-center gap-3"> <div className="w-12 h-12 rounded-full bg-accent-subtle flex items-center justify-center"> <User size={24} className="text-link" /> </div> <div> {article.authorSlug && article.authorName ? ( <a href={`/autori/${article.authorSlug}/`} rel="author" className="font-bold text-heading hover:text-link hover:underline"> {article.authorName} </a> ) : ( <p className="font-bold text-heading">{t('blog.byline')}</p> )} <p className="text-sm text-subtle">{t('blog.authorBio')}</p> </div> </div> </div> {/* Discuss in forum CTA */} <div className="mt-6 p-4 bg-accent-subtle rounded-xl border border-accent-border/40 flex items-center gap-3"> <MessageSquareMore size={20} className="text-accent shrink-0" /> <div className="flex-1"> <p className="text-sm font-semibold text-accent">{t('blog.discussInForum')}</p> <p className="text-sm text-accent mt-0.5">{t('blog.discussInForumDesc')}</p> </div> <a href={buildPath({ activeTab: 'forum' })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('forum'); }} className="shrink-0 px-4 py-2 min-h-[44px] inline-flex items-center bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors" > {t('blog.goToForum')} → </a> </div> {/* Prev/Next article navigation */} {(() => { const currentIdx = articles.findIndex(a => a.id === article.id); const prevArticle = currentIdx < articles.length - 1 ? articles[currentIdx + 1] : null; const nextArticle = currentIdx > 0 ? articles[currentIdx - 1] : null; if (!prevArticle && !nextArticle) return null; return ( <div className="border-t border-edge pt-6 mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3"> {prevArticle ? ( <a href={buildPath({ activeTab: 'blog', blogArticle: prevArticle.id })} onClick={(e) => { e.preventDefault(); handleArticleClick(prevArticle.id); }} className="flex items-center gap-3 p-4 bg-surface-alt/50 rounded-xl hover:bg-surface-raised/50 transition-colors group" > <ChevronLeft size={20} className="text-subtle group-hover:text-accent shrink-0 transition-colors" /> <div className="min-w-0"> <p className="text-sm text-muted mb-1">{t('blog.prevArticle')}</p> <p className="text-sm font-semibold text-body line-clamp-2">{t(`blog.article.${prevArticle.id}.title`)}</p>
 </div>
 </a>
 ) : <div />}
 {nextArticle ? (
 <a
 href={buildPath({ activeTab: 'blog', blogArticle: nextArticle.id })}
 onClick={(e) => { e.preventDefault(); handleArticleClick(nextArticle.id); }}
 className="flex items-center gap-3 p-4 bg-surface-alt/50 rounded-xl hover:bg-surface-raised/50 transition-colors text-right group"
 >
 <div className="min-w-0 flex-1">
 <p className="text-sm text-muted mb-1">{t('blog.nextArticle')}</p>
 <p className="text-sm font-semibold font-display text-body line-clamp-2">{t(`blog.article.${nextArticle.id}.title`)}</p> </div> <ChevronRight size={20} className="text-subtle group-hover:text-accent shrink-0 transition-colors" /> </a> ) : <div />} </div> ); })()} {/* Related articles — FRO-301: moved above ads/trending for engagement */} <div className="border-t border-edge pt-6 mt-8"> <h3 className="text-lg font-bold font-display text-heading mb-4">{t('blog.relatedArticles')}</h3> <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"> {getRelatedArticles(article.id, articles, 3).map(related => ( <a key={related.id} href={buildPath({ activeTab: 'blog', blogArticle: related.id as BlogArticleId })} onClick={(e) => { e.preventDefault(); handleArticleClick(related.id as BlogArticleId); }} className="flex items-center gap-3 p-3 bg-surface-alt/50 rounded-xl hover:bg-surface-raised/50 transition-colors text-left" > {(() => { const responsive = imageFallbackMap[related.image] ? null : getResponsiveImageSet(related.image); return ( <img src={related.image} srcSet={responsive ? `${responsive.thumbWebp} 480w, ${related.image} 1200w` : undefined} sizes="64px" alt={getImageAlt(related.id)} width={60} height={40} className="w-16 h-12 object-cover rounded-lg shrink-0" loading="lazy" onError={() => handleResponsiveImageError(related.image)} /> ); })()} <div className="min-w-0"> <p className="text-sm font-semibold font-display text-body line-clamp-2"> {t(`blog.article.${related.id}.title`)} </p> <p className="text-sm text-muted mt-1">{estimateReadingMinutes(related.id, t)} min</p> </div> </a> ))} </div> </div> {/* AdSense — end-of-article multiplex */} <div className="mt-8"> <Suspense fallback={adEligible ? <div style={{ minHeight: AD_SLOTS.ARTICLE_END_MULTIPLEX.placeholderMinHeight, contain: 'content' }} className="my-4" /> : null}> <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} enabled={adEligible} className="my-4" /> </Suspense> </div> {/* Explore tools — category-aware grid of evergreen page links */} {/* Trending articles this week */} {(() => { const trendingFiltered = trendingArticles .filter(e => e.id !== article.id) .slice(0, 4); if (trendingFiltered.length === 0) return null; const trendingLookup = new Map(trendingFiltered.map(e => [e.id, e.views])); const trendingCards = trendingFiltered .map(e => articleById.get(e.id)) .filter(Boolean) as Article[]; if (trendingCards.length === 0) return null; return ( <div className="border-t border-edge pt-6 mt-8"> <h3 className="text-lg font-bold font-display text-heading mb-4 flex items-center gap-2"> <TrendingUp size={20} className="text-warning" /> {t('blog.trendingThisWeek')} </h3> <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"> {trendingCards.map((tr, idx) => { const views = trendingLookup.get(tr.id) ?? 0; const responsive = imageFallbackMap[tr.image] ? null : getResponsiveImageSet(tr.image); return ( <a key={tr.id} href={buildPath({ activeTab: 'blog', blogArticle: tr.id as BlogArticleId })} onClick={(e) => { e.preventDefault(); handleArticleClick(tr.id as BlogArticleId); }} className="flex items-center gap-3 p-3 bg-gradient-to-r from-warning-subtle to-warning-subtle border border-warning-border rounded-xl hover:from-warning-subtle hover:to-warning-subtle transition-colors text-left group" > <div className="relative shrink-0"> <img src={tr.image} srcSet={responsive ? `${responsive.thumbWebp} 480w, ${tr.image} 1200w` : undefined} sizes="64px" alt={getImageAlt(tr.id)} width={60} height={40} className="w-16 h-12 object-cover rounded-lg" loading="lazy" onError={() => handleResponsiveImageError(tr.image)} /> {idx === 0 && ( <span className="absolute -top-1.5 -left-1.5 bg-warning-strong text-on-accent text-xs font-bold font-display px-1.5 py-0.5 rounded-full leading-none"> 🔥 </span> )} </div> <div className="min-w-0 flex-1"> <p className="text-sm font-semibold font-display text-body line-clamp-2 group-hover:text-warning transition-colors"> {t(`blog.article.${tr.id}.title`)}
 </p>
 <div className="flex items-center gap-2 mt-1">
 <span className="text-xs text-warning font-medium">
 {views} {t('blog.trendingThisWeek.views')}
 </span>
 <span className="text-sm text-muted">·</span>
 <span className="text-sm text-muted">
 {estimateReadingMinutes(tr.id, t)} min
 </span>
 </div>
 </div>
 </a>
 );
 })}
 </div>
 </div>
 );
 })()}


 {/* Related jobs (cross-linking) */}
 {relatedJobs.length > 0 ? (
 <div className="border-t border-edge pt-6 mt-6">
 <div className="flex items-center justify-between mb-4">
 <h3 className="text-lg font-bold font-display text-strong flex items-center gap-2">
 <Briefcase size={18} className="text-accent" />
 {t('blog.relatedJobs')}
 </h3>
 <a
 href={buildPath({ activeTab: 'job-board' })}
 onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); }}
 className="text-xs font-semibold text-accent hover:underline flex items-center gap-1"
 >
 {t('blog.relatedJobs.viewAll')} <ArrowRight size={12} />
 </a>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
 {relatedJobs.map(job => {
 const jobSlug = job.slugByLocale?.[locale] || job.slug || '';
 const logo = jobLogoUrl(job);
 return (
 <a
 key={job.id}
 href={buildPath({ activeTab: 'job-board', jobSlug })}
 onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board', jobSlug); }}
 className="flex items-start gap-3 p-3 bg-accent-subtle/60 rounded-xl hover:bg-accent-subtle transition-colors text-left border border-accent-border"
 >
 <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center border border-edge shrink-0 overflow-hidden">
 {logo ? <img src={logo} alt={`Logo ${job.company}`} width={28} height={28} className="w-7 h-7 object-contain" loading="lazy" onError={handleBlogLogoError} /> : <Briefcase size={16} className="text-accent" />}
 </div>
 <div className="min-w-0">
 <p className="text-sm font-semibold text-body line-clamp-2">
 {job.titleByLocale?.[locale] ?? job.title}
 </p>
 <p className="text-sm text-subtle mt-0.5">{job.company} · {job.location}</p>
 </div>
 </a>
 );
 })}
 </div>
 </div>
 ) : (
 <div className="border-t border-edge pt-6 mt-6">
 <a
 href={buildPath({ activeTab: 'job-board' })}
 onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); }}
 className="flex items-center gap-3 p-4 bg-accent-subtle/60 rounded-xl hover:bg-accent-subtle transition-colors border border-accent-border"
 >
 <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center border border-edge shrink-0">
 <Search size={18} className="text-accent" />
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-sm font-semibold text-body">{t('blog.cta.jobBoard.title', getCantonI18nParams())}</p>
 <p className="text-sm text-subtle mt-0.5">{t('blog.cta.jobBoard.desc', getCantonI18nParams())}</p>
 </div>
 <ArrowRight size={16} className="text-accent shrink-0" />
 </a>
 </div>
 )}
 </div>

 </article>

 {/* ── Right Rail (desktop only) ── */}
 <aside className="hidden xl:block">
 <div className="sticky top-6 space-y-3">
 {/* Desktop TOC */}
 {showToc && (
 <nav className="max-h-[calc(100vh-8rem)] overflow-y-auto pb-3 mb-1" aria-label={t('blog.toc.title')}>
 <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
 <List size={12} />
 {t('blog.toc.title')}
 </p>
 <ul className="space-y-0.5">
 {tocHeadings.map(h => (
 <li key={h.id}>
 <button
 onClick={() => handleTocClick(h.id)}
 className={`block w-full text-left text-[13px] leading-snug py-1 transition-colors rounded-sm ${
 h.level === 3 ? 'pl-3' : ''
 } ${
 activeHeadingId === h.id
 ? 'text-accent font-medium border-l-2 border-accent pl-2'
 : `text-subtle hover:text-accent ${h.level === 3 ? 'font-normal' : 'font-medium'}`
 }`}
 >
 {h.text}
 </button>
 </li>
 ))}
 </ul>
 </nav>
 )}

 <p className="text-xs font-medium text-muted uppercase tracking-wider">
 {t('blog.resourcesTitle')}
 </p>
 {sidePartners.slice(2, 4).map((p, i) => <SideRailCard key={p.id} partner={p} idx={i + 2} />)}

 {/* Donation mini-card */}
 <div className="rounded-xl border border-warning-border/50 bg-warning-subtle p-3 text-center space-y-2">
 <Coffee size={18} className="mx-auto text-warning" />
 <p className="text-xs leading-snug text-subtle">
 {t('donation.message').slice(0, 80)}…
 </p>
 <a
 href="https://www.buymeacoffee.com/frontaliereticino"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-block w-full text-xs font-semibold text-warning bg-warning-subtle hover:bg-warning-subtle rounded-lg py-1.5 transition-colors"
 >
 ☕ {t('donation.button')}
 </a>
 </div>

 <p className="text-sm text-muted leading-tight">
 {t('affiliate.disclosure')}
 </p>
 </div>
 </aside>

 </div>

 {/* FRO-301: Sticky bottom nav on mobile — reduces bounce from social referrals */}
 <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 border-t border-edge px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] flex items-center justify-between">
 <button
 onClick={handleBackToList}
 className="inline-flex items-center gap-1.5 text-sm font-semibold text-body"
 aria-label={t('blog.backToList')}
 >
 <ArrowLeft size={16} />
 {t('blog.backToList')}
 </button>
 <div className="flex items-center gap-1">
 <button
 onClick={() => handleWhatsAppShare(selectedArticle)}
 className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-brand-whatsapp/10 text-brand-whatsapp"
 aria-label={t('blog.shareWhatsApp')}
 >
 <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
 </button>
 {typeof navigator !== 'undefined' && 'share' in navigator ? (
 <button
 onClick={() => handleNativeShare(selectedArticle)}
 className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-accent-subtle text-accent"
 aria-label={t('blog.shareNative')}
 >
 <Share2 size={20} />
 </button>
 ) : (
 <button
 onClick={() => handleCopyLink(selectedArticle)}
 className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-surface-raised text-body"
 aria-label={t('blog.copyLink')}
 >
 {copied ? <Check size={20} className="text-success" /> : <Copy size={20} />}
 </button>
 )}
 </div>
 </div>
 {/* Spacer for sticky bottom bar on mobile */}
 <div className="sm:hidden h-14" />
 </div>
 );
 }

 // ── List View (Newspaper style) ──────────────────────

 return (
 <div className="max-w-5xl mx-auto space-y-6">
 {/* Header with stats hook */}
 <div className="text-center mb-2">
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong mb-2 flex items-center justify-center gap-2">
 <BookOpen size={28} className="text-accent" />
 {t('blog.title')}
 </h1>
 <p className="text-subtle">{t('blog.subtitle')}</p>
 </div>

 {/* Stats bar — gives immediate sense of depth and freshness */}
 {articles.length > 0 && (
 <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-5 text-sm">
 <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
 <FileText size={15} />
 {articles.length} {t('blog.statsArticles')}
 </span>
 <span className="text-edge">|</span>
 <span className="inline-flex items-center gap-1.5 text-subtle">
 <Newspaper size={15} />
 {categoryStats['novita'] || 0} {t('blog.statsNews')}
 </span>
 <span className="text-edge">|</span>
 <span className="inline-flex items-center gap-1.5 text-subtle">
 <TrendingUp size={15} />
 {t('blog.statsUpdated')}
 </span>
 </div>
 )}

 {/* Category filter */}
 <div className="flex flex-wrap gap-2 justify-center">
 {CATEGORIES.map(cat => (
 <button
 key={cat}
 onClick={() => handleCategoryChange(cat)}
 className={`px-4 py-2 min-h-[44px] rounded-full text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
 selectedCategory === cat
 ? 'bg-accent-strong text-on-accent shadow-md'
 : 'bg-surface text-body border border-edge hover:border-accent-border'
 }`}
 >
 {t(`blog.category.${cat}`)}
 </button>
 ))}
 </div>

 {/* Featured article (first one) — large hero card */}
 {pageArticles.length > 0 && (
 <a
 href={buildPath({ activeTab: 'blog', blogArticle: pageArticles[0].id })}
 className="block w-full text-left group relative overflow-hidden rounded-2xl shadow-xl hover:shadow-2xl transition-shadow"
 onClick={(e) => { e.preventDefault(); handleArticleClick(pageArticles[0].id); }}
 >
 <div className="relative h-64 sm:h-80">
 {(() => {
 const responsive = imageFallbackMap[pageArticles[0].image] ? null : getResponsiveImageSet(pageArticles[0].image);
 return (
 <img
 src={pageArticles[0].image}
 srcSet={responsive ? `${responsive.thumbWebp} 480w, ${pageArticles[0].image} 1200w` : undefined}
 alt={getImageAlt(pageArticles[0].id)}
 width={1200}
 height={600}
 className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
 sizes="(max-width: 640px) 100vw, 800px"
 loading="eager"
 fetchPriority="high"
 decoding="async"
 onError={() => handleResponsiveImageError(pageArticles[0].image)}
 />
 );
 })()}
 <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
 <div className="absolute bottom-5 left-5 right-5">
 <div className="flex flex-wrap items-center gap-2 mb-2">
 <span className={`px-3 py-1 rounded-full text-xs font-bold ${getCategoryColor(pageArticles[0].category)}`}>
 {t(`blog.category.${pageArticles[0].category}`)}
 </span>
 <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
 pageArticles[0].category === 'novita'
 ? 'bg-warning-strong/80 text-on-accent'
 : 'bg-on-accent/25 text-on-accent'
 }`}>
 {pageArticles[0].category === 'novita'
 ? t('blog.contentType.news')
 : t('blog.contentType.guide')}
 </span>
 {pageArticles[0].hasCalculator && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-accent-strong/80 text-on-accent">
 <Calculator size={11} />
 {t('blog.hasCalculator')}
 </span>
 )}
 <span className="flex items-center gap-1 text-xs text-on-accent/90">
 <Clock size={12} />
 {estimateReadingMinutes(pageArticles[0].id, t)} min
 </span>
 <span className="text-xs text-on-accent/80">{formatDate(pageArticles[0].date)}</span>
 {pageArticles[0].updatedAt && pageArticles[0].updatedAt !== pageArticles[0].date.slice(0, 10) && (
 <span className="inline-flex items-center gap-1 text-xs text-on-accent/80">
 <RefreshCw size={10} />
 {t('blog.updatedOn')} {formatDate(pageArticles[0].updatedAt)}
 </span>
 )}
 </div>
 <h2 className="text-xl sm:text-2xl font-bold font-display text-on-accent mb-2 leading-tight">
 {t(`blog.article.${pageArticles[0].id}.title`)}
 </h2>
 <p className="text-on-accent/90 text-sm line-clamp-2 max-w-2xl leading-relaxed">
 {t(`blog.article.${pageArticles[0].id}.excerpt`)}
 </p>
 </div>
 </div>
 </a>
 )}


 {/* Article grid — newspaper 3-column layout */}
 {pageArticles.length > 1 && (
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" aria-live="polite" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 600px' }}>
 {pageArticles.slice(1, isMobile ? undefined : 1 + gridRevealCount).map((article, idx) => (
 <Fragment key={article.id}>
 <a
 href={buildPath({ activeTab: 'blog', blogArticle: article.id })}
 className={`flex flex-col text-left bg-surface rounded-xl border border-edge overflow-hidden hover:shadow-lg hover:border-accent transition-[border-color,box-shadow] group${idx >= 3 ? ' content-auto' : ''}`}
 onClick={(e) => { e.preventDefault(); handleArticleClick(article.id); }}
 >
 {/* Card image */}
 <div className="relative h-40 overflow-hidden">
 {(() => {
 const responsive = imageFallbackMap[article.image] ? null : getResponsiveImageSet(article.image);
 return (
 <img
 src={article.image}
 srcSet={responsive ? `${responsive.thumbWebp} 480w, ${article.image} 1200w` : undefined}
 alt={getImageAlt(article.id)}
 width={400}
 height={200}
 className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
 sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
 loading="lazy"
 fetchPriority="low"
 decoding="async"
 onError={() => handleResponsiveImageError(article.image)}
 />
 );
 })()}
 <div className="absolute top-2 left-2 flex items-center gap-1">
 <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${getCategoryColor(article.category)}`}>
 {t(`blog.category.${article.category}`)}
 </span>
 <span className={`px-1.5 py-0.5 rounded-full text-xs font-semibold ${
 article.category === 'novita'
 ? 'bg-warning-strong/90 text-on-accent'
 : 'bg-surface text-subtle'
 }`}>
 {article.category === 'novita'
 ? t('blog.contentType.news')
 : t('blog.contentType.guide')}
 </span>
 </div>
 </div>

 {/* Card content */}
 <div className="p-4 flex flex-col flex-1">
 <h3 className="text-base font-bold text-strong group-hover:text-accent transition-colors line-clamp-2 mb-1.5 leading-snug">
 {t(`blog.article.${article.id}.title`)}
 </h3>
 <p className="text-sm text-subtle line-clamp-2 mb-3 leading-relaxed">
 {t(`blog.article.${article.id}.excerpt`)}
 </p>
 <div className="flex flex-wrap items-center gap-1.5 mb-3">
 {article.hasCalculator && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-subtle text-accent">
 <Calculator size={10} />
 {t('blog.hasCalculator')}
 </span>
 )}
 {article.updatedAt && article.updatedAt !== article.date.slice(0, 10) && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-success-subtle text-success">
 <RefreshCw size={9} />
 {t('blog.updatedOn')} {formatDate(article.updatedAt)}
 </span>
 )}
 </div>
 <div className="mt-auto flex items-center justify-between">
 <div className="flex items-center gap-2 text-xs text-muted">
 <span className="flex items-center gap-1">
 <Calendar size={11} />
 {formatDate(article.date)}
 </span>
 <span className="text-edge">·</span>
 <span className="flex items-center gap-1">
 <Clock size={11} />
 {estimateReadingMinutes(article.id, t)} min
 </span>
 </div>
 <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent group-hover:text-accent transition-colors">
 {t('blog.readMore')} <ArrowRight size={12} />
 </span>
 </div>
 </div>
 </a>
 {/* In-feed AdSense — single multiplex after the 3rd card (FRO-adsense-static-seo). */}
 {idx === 2 && (
 <Suspense fallback={<div style={{ minHeight: AD_SLOTS.JOBLIST_END_MULTIPLEX.placeholderMinHeight, contain: 'content' }} className="sm:col-span-2 lg:col-span-3" />}>
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 fullWidthResponsive={false}
 className="sm:col-span-2 lg:col-span-3"
 />
 </Suspense>
 )}
 </Fragment>
 ))}
 </div>
 )}

 {/* Progressive reveal under the fold (desktop only — mobile uses infinite scroll) */}
 {!isMobile && pageArticles.length > 1 && gridRevealCount < (pageArticles.length - 1) && (
 <div className="flex justify-center mt-2">
 <button
 onClick={() => setGridRevealCount(pageArticles.length - 1)}
 className="px-4 py-2 rounded-lg text-sm font-semibold bg-surface border border-edge text-body hover:bg-surface-raised transition-colors"
 >
 {t('blog.readMore')}
 </button>
 </div>
 )}

 {/* Mobile: infinite scroll sentinel (tappable as fallback for Safari) */}
 {hasMoreMobileArticles && (
 <button
 ref={articleSentinelRef}
 onClick={loadMoreArticles}
 className="flex justify-center items-center py-6 sm:hidden w-full"
 >
 <div className="h-5 w-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
 <span className="ml-2 text-sm text-muted">{t('blog.pagination.next')}…</span>
 </button>
 )}

 {/* Pagination — desktop only (mobile uses infinite scroll) */}
 {totalPages > 1 && (
 <div className="hidden sm:flex items-center justify-center gap-1 sm:gap-2">
 <button
 onClick={() => { setCurrentPage(p => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 disabled={currentPage === 1}
 className="inline-flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-sm font-medium bg-surface border border-edge text-body hover:bg-surface-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
 aria-label={t('blog.pagination.prev')}
 >
 <ChevronLeft size={16} />
 <span className="hidden sm:inline">{t('blog.pagination.prev')}</span>
 </button>
 <div className="flex items-center gap-1">
 {(() => {
 // Smart pagination: show first, last, current ±1, with ellipsis
 const pages: (number | 'ellipsis-start' | 'ellipsis-end')[] = [];
 if (totalPages <= 5) {
 for (let i = 1; i <= totalPages; i++) pages.push(i);
 } else {
 pages.push(1);
 if (currentPage > 3) pages.push('ellipsis-start');
 for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
 pages.push(i);
 }
 if (currentPage < totalPages - 2) pages.push('ellipsis-end');
 pages.push(totalPages);
 }
 return pages.map((page, idx) =>
 typeof page === 'string' ? (
 <span key={page} className="w-10 h-11 flex items-center justify-center text-muted text-sm select-none">…</span>
 ) : (
 <button
 key={page}
 onClick={() => { setCurrentPage(page); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 className={`w-11 h-11 rounded-lg text-sm font-medium transition-colors ${
 page === currentPage
 ? 'bg-accent-strong text-on-accent shadow-md'
 : 'bg-surface border border-edge text-body hover:bg-surface-raised'
 }`}
 aria-label={`${t('blog.pagination.page')} ${page}`}
 aria-current={page === currentPage ? 'page' : undefined}
 >
 {page}
 </button>
 )
 );
 })()}
 </div>
 <button
 onClick={() => { setCurrentPage(p => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 disabled={currentPage === totalPages}
 className="inline-flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-sm font-medium bg-surface border border-edge text-body hover:bg-surface-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
 aria-label={t('blog.pagination.next')}
 >
 <span className="hidden sm:inline">{t('blog.pagination.next')}</span>
 <ChevronRight size={16} />
 </button>
 </div>
 )}

 {/* End-of-listing multiplex removed 2026-04-28 — single in-feed slot
     (above, after card 3) replaces it. Two stacked multiplex on the same
     listing tripped AdSense over-stuffing heuristics and depressed RPM. */}

 {/* SEO content block */}
 <div className="bg-surface-alt/50 rounded-xl p-4 sm:p-6 border border-edge">
 <h3 className="font-semibold text-body mb-3">{t('blog.seoTitle')}</h3>
 <p className="text-sm text-subtle leading-relaxed">
 {t('blog.seoContent')}
 </p>
 </div>
 </div>
 );
}

export default memo(BlogArticles);
