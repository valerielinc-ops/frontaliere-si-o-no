import { useState, useEffect, useMemo, useCallback, lazy, Suspense, type ReactNode, type ReactElement } from 'react';
import { useTranslation, useLocale, loadBlogMeta, loadArticleBody } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { buildPath } from '@/services/router';
import type { BlogArticleId } from '@/services/router';
import { NAV_ACTION_ROUTES, KEYWORD_LINKS, type NavAction, type NavigatorMap } from '@/services/internalLinks';
import { useNavigation } from '@/services/NavigationContext';
import { Analytics } from '@/services/analytics';
import { BookOpen, Clock, ChevronRight, Calculator, ArrowRight, Calendar, ArrowLeft, Share2, Copy, Check, ChevronLeft, CheckCircle2, Lightbulb, AlertTriangle, BarChart3, Heart, Coins, TrendingUp, FileText, Receipt, Scale, Home, Briefcase, ShieldCheck, MapPin, ShoppingBag, Train, Building2, Mail, Coffee, ExternalLink, Baby, Search, PenLine, Newspaper } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PARTNERS, buildAffiliateUrl, type AffiliatePartner, type ComparatorContext } from '@/services/affiliateService';
const AdSenseBanner = lazy(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
import { resolveCompanyLogoUrl, resolveCompanyWebsiteHost } from '@/services/jobDataNormalization';
import { useMediaQuery } from '@/hooks/useMediaQuery';
const CreatorProducts = lazy(() => import('@/components/pages/CreatorProducts'));
const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));

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
  } catch {
    // Non-blocking — never break article loading
  }
}

export { trackArticleView };

/* ─── Trending articles (Firestore → localStorage cache) ─── */

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

  try {
    if (!_viewDbInit) {
      const { getFirestore } = await import('firebase/firestore');
      const { app } = await import('@/services/firebase');
      _viewDb = getFirestore(app);
      _viewDbInit = true;
    }
    if (!_viewDb) return [];

    const { collection, getDocs } = await import('firebase/firestore');
    const snap = await getDocs(collection(_viewDb, 'article_views'));
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const entries: TrendingEntry[] = [];

    snap.forEach((d: any) => {
      const data = d.data();
      const lastViewed = data.lastViewed?.toMillis?.() ?? data.lastViewed?.getTime?.() ?? 0;
      const views = data.views ?? 0;
      // Boost articles viewed recently: full weight within 7 days, half weight within 30 days
      const age = now - lastViewed;
      if (age < sevenDays) {
        entries.push({ id: d.id, views, lastViewed });
      } else if (age < 30 * 24 * 60 * 60 * 1000 && views > 5) {
        entries.push({ id: d.id, views: Math.round(views * 0.5), lastViewed });
      }
    });

    entries.sort((a, b) => b.views - a.views);
    const top = entries.slice(0, 12); // cache top 12

    try {
      localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ ts: now, data: top }));
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
 *  Strips bold/italic markers before matching so patterns work even when keywords
 *  span formatting boundaries (e.g. `cambio **franco-euro**`). */
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
  // Match [link](nav:xxx), **bold**, or *italic* — links take priority
  const regex = /(\[([^\]]+)\]\(nav:([a-z0-9\-]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g;
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
            className={`inline text-indigo-600 dark:text-indigo-400 ${isBoldLink ? 'font-bold' : 'font-medium'} underline underline-offset-2 decoration-indigo-300 dark:decoration-indigo-600 hover:decoration-indigo-600 dark:hover:decoration-indigo-400 transition-colors cursor-pointer`}
          >
            {linkText}
          </a>
        );
      } else {
        parts.push(isBoldLink ? <strong key={`b${key++}`} className="font-semibold text-slate-800 dark:text-slate-200">{linkText}</strong> : linkText);
      }
    } else if (match[5]) {
      parts.push(<strong key={`b${key++}`} className="font-semibold text-slate-800 dark:text-slate-200">{match[5]}</strong>);
    } else if (match[7]) {
      parts.push(<em key={`i${key++}`} className="italic">{match[7]}</em>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderFormattedContent(text: string, navigators?: NavigatorMap): ReactElement {
  // Auto-link keywords if navigators provided
  const processed = navigators ? autoLinkKeywords(text, navigators) : text;

  // If no block separators, render as a single paragraph (backward compatible)
  if (!processed.includes('\n\n') && !processed.includes('\n')) {
    return <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{renderInlineFormatting(processed, navigators)}</p>;
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

    // Heading: ## (supports malformed blocks where heading and paragraph are in the same block)
    if (trimmed.startsWith('## ')) {
      const lines = trimmed.split('\n');
      const rawHeadingLine = lines[0].replace(/^##\s+/, '').trim();
      let heading = rawHeadingLine;
      let inlineBody = lines.slice(1).join('\n').trim();

      // If AI produced "## Heading sentence..." on one line, split at locale-safe markers.
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
          <div key={`tools-${idx}`} className="bg-indigo-50/70 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4 flex gap-3">
            <Coins size={20} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
            <div className="space-y-1.5">
              <p className="text-indigo-900 dark:text-indigo-100 text-sm font-semibold leading-relaxed">
                {renderInlineFormatting(heading, navigators)}
              </p>
              {toolBody && (
                <p className="text-indigo-800 dark:text-indigo-200 text-sm leading-relaxed">
                  {renderInlineFormatting(toolBody, navigators)}
                </p>
              )}
            </div>
          </div>
        );
        continue;
      }

      renderedBlocks.push(
        <div key={`heading-${idx}`} className="space-y-2">
          <h3 className="text-lg font-bold text-indigo-700 dark:text-indigo-400 border-l-4 border-indigo-500 pl-3 mt-2">
            {renderInlineFormatting(heading, navigators)}
          </h3>
          {inlineBody && (
            <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
              {renderInlineFormatting(inlineBody, navigators)}
            </p>
          )}
        </div>
      );
      continue;
    }

    // Horizontal rule: ---
    if (trimmed === '---' || trimmed === '***') {
      renderedBlocks.push(
        <hr key={`hr-${idx}`} className="border-0 h-px bg-gradient-to-r from-transparent via-indigo-300 dark:via-indigo-700 to-transparent my-2" />
      );
      continue;
    }

    // Data box: 📊 prefix
    if (trimmed.startsWith('📊')) {
      renderedBlocks.push(
        <div key={`data-${idx}`} className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 flex gap-3">
          <BarChart3 size={20} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <p className="text-blue-800 dark:text-blue-200 text-sm leading-relaxed">{renderInlineFormatting(trimmed.slice(2).trim(), navigators)}</p>
        </div>
      );
      continue;
    }

    // Tip box: 💡 prefix
    if (trimmed.startsWith('💡')) {
      renderedBlocks.push(
        <div key={`tip-${idx}`} className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 flex gap-3">
          <Lightbulb size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-amber-800 dark:text-amber-200 text-sm leading-relaxed">{renderInlineFormatting(trimmed.slice(2).trim(), navigators)}</p>
        </div>
      );
      continue;
    }

    // Warning box: ⚠️ prefix
    if (trimmed.startsWith('⚠️') || trimmed.startsWith('⚠')) {
      const content = trimmed.replace(/^⚠️?\s*/, '');
      renderedBlocks.push(
        <div key={`warn-${idx}`} className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 flex gap-3">
          <AlertTriangle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <p className="text-red-800 dark:text-red-200 text-sm leading-relaxed">{renderInlineFormatting(content, navigators)}</p>
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
          <blockquote key={`quote-${idx}`} className="bg-indigo-50 dark:bg-indigo-900/20 border-l-4 border-indigo-500 p-4 rounded-r-lg italic text-indigo-800 dark:text-indigo-200 text-sm">
            {renderInlineFormatting(quote, navigators)}
          </blockquote>
        );
      } else {
        renderedBlocks.push(
          <p key={`p-${idx}`} className="text-slate-700 dark:text-slate-300 leading-relaxed text-sm">
            {renderInlineFormatting(quote, navigators)}
          </p>
        );
      }
      continue;
    }

    // List: lines starting with -
    if (isListBlock(trimmed)) {
      const items = trimmed.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2));
      renderedBlocks.push(
        <ul key={`list-${idx}`} className="space-y-2 pl-1">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300 text-sm leading-relaxed">
              <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />
              <span>{renderInlineFormatting(item, navigators)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Plain paragraph (default)
    renderedBlocks.push(
      <p key={`p-${idx}`} className="text-slate-700 dark:text-slate-300 leading-relaxed">
        {renderInlineFormatting(trimmed, navigators)}
      </p>
    );
  }

  return <div className="space-y-5">{renderedBlocks}</div>;
}

const ARTICLES_PER_PAGE = 7; // 1 hero + 6 grid cards

type ResponsiveImageSet = {
  avif: string;
  webp: string;
  jpgSet: string;
};

function getResponsiveImageSet(imagePath: string): ResponsiveImageSet | null {
  const match = imagePath.match(/^(\/images\/(?:blog|places))\/([^/]+)\.(jpe?g|png|webp|avif)$/i);
  if (!match) return null;

  const rootDir = match[1];
  const fileName = match[2];
  const thumbBase = `${rootDir}/thumbnails/${fileName}-480w`;

  return {
    avif: `${thumbBase}.avif`,
    webp: `${thumbBase}.webp`,
    jpgSet: `${thumbBase}.jpg 480w, ${imagePath} 1200w`,
  };
}

/* ─── Article types ─── */

export interface Article {
  id: BlogArticleId;
  category: 'fiscale' | 'pratico' | 'novita' | 'pensione';
  date: string;
  image: string;
  hasCalculator: boolean;
}

/** Average Italian reading speed ≈ 230 wpm. Strip HTML/markdown, count words, clamp 2–30 min. */
const WORDS_PER_MINUTE = 230;

export function estimateReadingMinutes(articleId: string, t: (key: string) => string): number {
  const raw = [
    t(`blog.article.${articleId}.body1`),
    t(`blog.article.${articleId}.body2`),
    t(`blog.article.${articleId}.body3`),
  ].join(' ');
  // If body translations aren't loaded yet, t() returns the key string — use a default
  if (raw.startsWith('blog.article.')) return 5;
  // Strip HTML tags and markdown-style formatting, then count words
  const plain = raw.replace(/<[^>]+>/g, ' ').replace(/[#*_~`>|[\]()]/g, ' ');
  const words = plain.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(2, Math.min(30, Math.round(words / WORDS_PER_MINUTE)));
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
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

const JOB_STOP_WORDS = new Set([...STOP_WORDS, 'the', 'and', 'for', 'with', 'von', 'und', 'les', 'des', 'pour', 'dans']);

/** Find jobs related to an article based on slug-word ↔ job-title/keyword overlap */
function getRelatedJobsForArticle(articleId: string, jobs: JobPreview[], locale: Locale, count = 3): JobPreview[] {
  const articleWords = slugTopicWords(articleId);

  // Category→keyword fallback: boost matching when slug overlap is low
  const article = ARTICLES.find(a => a.id === articleId);
  const categoryKeywords: Record<string, string[]> = {
    fiscale: ['finance', 'contabile', 'fiscale', 'accounting', 'tax', 'payroll', 'revisore', 'fiduciario', 'compliance'],
    pratico: ['operatore', 'logistica', 'assistente', 'segretaria', 'receptionist', 'magazzino', 'tecnico'],
    novita: ['manager', 'project', 'specialist', 'analista', 'consulente', 'responsabile', 'coordinator'],
    pensione: ['finance', 'assicurazione', 'previdenza', 'bancario', 'consulente', 'advisor', 'wealth'],
  };
  const catWords = article ? (categoryKeywords[article.category] ?? []) : [];

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
      return { job, score, freshness };
    })
    .filter(x => x.score >= 2);

  scored.sort((a, b) => b.score - a.score || b.freshness - a.freshness);
  return scored.slice(0, count).map(x => x.job);
}

export const ARTICLES: Article[] = [
  {
    id: 'stipendio-netto-2026',
    category: 'fiscale',
    date: '2026-01-15',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'nuovo-accordo-fiscale',
    category: 'fiscale',
    date: '2026-01-10',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: false,
  },
  {
    id: 'lamal-vs-cmi',
    category: 'pratico',
    date: '2026-01-05',
    image: '/images/places/mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'primo-giorno-frontaliere',
    category: 'pratico',
    date: '2025-12-20',
    image: '/images/places/castelgrande.jpg',
    hasCalculator: false,
  },
  {
    id: 'tredicesima-frontaliere',
    category: 'fiscale',
    date: '2025-12-15',
    image: '/images/places/locarno.jpg',
    hasCalculator: true,
  },
  {
    id: 'pilastro-3a-frontaliere',
    category: 'pensione',
    date: '2025-12-10',
    image: '/images/places/monte-bre.jpg',
    hasCalculator: true,
  },
  {
    id: 'comuni-migliori-frontalieri',
    category: 'pratico',
    date: '2025-12-05',
    image: '/images/places/gandria.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-vita-ticino-vs-lombardia',
    category: 'pratico',
    date: '2025-11-28',
    image: '/images/places/foxtown.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-tensioni-ticino',
    category: 'fiscale',
    date: '2026-02-17T10:00:00Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: false,
  },
  {
    id: 'casa-oltre-confine-ticino',
    category: 'pratico',
    date: '2026-02-17T14:00:00Z',
    image: '/images/places/gandria.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-forte-stipendio-frontalieri',
    category: 'fiscale',
    date: '2026-02-18T08:00:00Z',
    image: '/images/places/lac-lugano.jpg',
    hasCalculator: true,
  },
  {
    id: 'cu-2026-novita-frontalieri',
    category: 'fiscale',
    date: '2026-02-18T10:30:00Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'telelavoro-italia-svizzera-ratifica',
    category: 'fiscale',
    date: '2026-02-18T11:00:00Z',
    image: '/images/blog/telelavoro-italia-svizzera-ratifica.jpg',
    hasCalculator: true,
  },
  {
    id: 'telelavoro-accordo-definitivo-italia',
    category: 'novita',
    date: '2026-02-18T11:17:51.792Z',
    image: '/images/blog/telelavoro-accordo-definitivo-italia.jpg',
    hasCalculator: true,
  },
  {
    id: 'stop-ristorni-tassa-salute',
    category: 'fiscale',
    date: '2026-02-18T11:45:01.224Z',
    image: '/images/blog/stop-ristorni-tassa-salute.jpg',
    hasCalculator: true,
  },
  {
    id: 'cu-telelavoro-regole-frontalieri',
    category: 'fiscale',
    date: '2026-02-18T11:49:14.807Z',
    image: '/images/blog/cu-telelavoro-regole-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'smood-chiusura-impatto-lavoro',
    category: 'novita',
    date: '2026-02-18T12:32:10.601Z',
    image: '/images/blog/smood-chiusura-impatto-lavoro.jpg',
    hasCalculator: true,
  },
  {
    id: 'disoccupazione-svizzera-ticino-gennaio',
    category: 'novita',
    date: '2026-02-18T13:19:30.600Z',
    image: '/images/blog/disoccupazione-svizzera-ticino-gennaio.jpg',
    hasCalculator: true,
  },
  {
    id: 'riscaldamento-casa-ticino-norme',
    category: 'pratico',
    date: '2026-02-18T14:14:43.727Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'sostituzione-caldaia-ticino-2026',
    category: 'pratico',
    date: '2026-02-18T15:16:44.519Z',
    image: '/images/blog/sostituzione-caldaia-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'hic-sunt-leones-confini-ticino',
    category: 'pratico',
    date: '2026-02-18T15:41:20.568Z',
    image: '/images/blog/hic-sunt-leones-confini-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'carnevale-bambini-lugano-2026',
    category: 'pratico',
    date: '2026-02-18T15:57:39.007Z',
    image: '/images/blog/carnevale-bambini-lugano-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'arte-anima-ticino-frontalieri',
    category: 'pratico',
    date: '2026-02-18T17:02:30.798Z',
    image: '/images/blog/arte-anima-ticino-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'arca-russa-chiasso-cultura-frontaliere',
    category: 'novita',
    date: '2026-02-18T17:18:57.528Z',
    image: '/images/blog/arca-russa-chiasso-cultura-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'rsi-mostra-storia-ticino',
    category: 'novita',
    date: '2026-02-18T17:57:03.502Z',
    image: '/images/blog/rsi-mostra-storia-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'carnevale-bambini-lugano-tinguely',
    category: 'pratico',
    date: '2026-02-18T18:15:16.796Z',
    image: '/images/blog/carnevale-bambini-lugano-tinguely.jpg',
    hasCalculator: true,
  },
  {
    id: 'daniela-rebuzzi-mostra-caslano',
    category: 'novita',
    date: '2026-02-18T19:17:30.046Z',
    image: '/images/blog/daniela-rebuzzi-mostra-caslano.jpg',
    hasCalculator: true,
  },
  {
    id: 'corpi-in-prestito-arte-agno',
    category: 'pratico',
    date: '2026-02-18T19:46:21.242Z',
    image: '/images/blog/corpi-in-prestito-arte-agno.jpg',
    hasCalculator: true,
  },
  {
    id: 'rsi-storia-svizzera-italiana-mostra',
    category: 'novita',
    date: '2026-02-18T20:35:40.243Z',
    image: '/images/blog/rsi-storia-svizzera-italiana-mostra.jpg',
    hasCalculator: true,
  },
  {
    id: 'rauschenberg-arte-mendrisiotto',
    category: 'novita',
    date: '2026-02-18T21:13:16.363Z',
    image: '/images/blog/rauschenberg-arte-mendrisiotto.jpg',
    hasCalculator: true,
  },
  {
    id: 'nakba-mostra-giubiasco-ticino',
    category: 'novita',
    date: '2026-02-18T23:07:21.471Z',
    image: '/images/blog/nakba-mostra-giubiasco-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'de-andre-anime-salve-locarno',
    category: 'novita',
    date: '2026-02-19T05:54:01.838Z',
    image: '/images/blog/de-andre-anime-salve-locarno.jpg',
    hasCalculator: true,
  },
  {
    id: 'sentimento-osservazione-masi-lugano',
    category: 'novita',
    date: '2026-02-19T06:22:47.222Z',
    image: '/images/blog/sentimento-osservazione-masi-lugano.jpg',
    hasCalculator: true,
  },
  {
    id: 'rsi-archivio-gottardo-2026',
    category: 'novita',
    date: '2026-02-19T07:58:11.134Z',
    image: '/images/blog/rsi-archivio-gottardo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'carnevale-blenio-chiescia-bosc',
    category: 'novita',
    date: '2026-02-19T08:09:11.433Z',
    image: '/images/blog/carnevale-blenio-chiescia-bosc.jpg',
    hasCalculator: true,
  },
  {
    id: 'tf-permesso-integrazione-ticino',
    category: 'pratico',
    date: '2026-02-19T08:18:46.464Z',
    image: '/images/blog/tf-permesso-integrazione-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassazione-individuale-lavoro-ticino',
    category: 'fiscale',
    date: '2026-02-19T08:34:53.901Z',
    image: '/images/blog/tassazione-individuale-lavoro-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-scontro-gobbi-berna',
    category: 'fiscale',
    date: '2026-02-19T09:01:08.138Z',
    image: '/images/blog/ristorni-scontro-gobbi-berna.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-calo-2025',
    category: 'novita',
    date: '2026-02-19T09:05:03.506Z',
    image: '/images/blog/frontalieri-ticino-calo-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-controtendenza-2026',
    category: 'novita',
    date: '2026-02-19T10:30:30.708Z',
    image: '/images/blog/frontalieri-ticino-controtendenza-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-calo-q4-2025',
    category: 'novita',
    date: '2026-02-19T12:06:39.207Z',
    image: '/images/blog/frontalieri-ticino-calo-q4-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'pendolarismo-affitto-tempo-ticino',
    category: 'pratico',
    date: '2026-02-19T15:37:29.161Z',
    image: '/images/blog/pendolarismo-affitto-tempo-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'centrodestra-stop-ristorni-2026',
    category: 'fiscale',
    date: '2026-02-19T18:38:51.406Z',
    image: '/images/blog/centrodestra-stop-ristorni-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-dati-q4-2025',
    category: 'novita',
    date: '2026-02-19T20:04:59.619Z',
    image: '/images/blog/frontalieri-ticino-dati-q4-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'calo-entrate-irregolari-chiasso',
    category: 'novita',
    date: '2026-02-19T22:03:34.072Z',
    image: '/images/blog/calo-entrate-irregolari-chiasso.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-salari-polemica-ticino',
    category: 'novita',
    date: '2026-02-20T07:43:35.803Z',
    image: '/images/blog/frontalieri-salari-polemica-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-frontalieri-scontro-ticino-lombardia',
    category: 'fiscale',
    date: '2026-02-20T10:05:49.880Z',
    image: '/images/blog/ristorni-frontalieri-scontro-ticino-lombardia.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-iva-contributi',
    category: 'pensione',
    date: '2026-02-20T12:00:34.203Z',
    image: '/images/blog/tredicesima-avs-iva-contributi.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-finanziamento-misto',
    category: 'pensione',
    date: '2026-02-20T14:30:35.209Z',
    image: '/images/blog/tredicesima-avs-finanziamento-misto.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-finanziamento-scontro',
    category: 'pensione',
    date: '2026-02-20T17:11:47.619Z',
    image: '/images/blog/tredicesima-avs-finanziamento-scontro.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-imprese-allarme-ticino',
    category: 'fiscale',
    date: '2026-02-20T19:52:04.066Z',
    image: '/images/blog/ristorni-imprese-allarme-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'denaro-non-dichiarato-dogana-brogeda',
    category: 'pratico',
    date: '2026-02-20T21:03:16.144Z',
    image: '/images/blog/denaro-non-dichiarato-dogana-brogeda.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-salari-dibattito-ticino',
    category: 'novita',
    date: '2026-02-20T21:55:14.891Z',
    image: '/images/blog/frontalieri-salari-dibattito-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-stipendio-iva',
    category: 'pensione',
    date: '2026-02-20T23:03:48.224Z',
    image: '/images/blog/tredicesima-avs-stipendio-iva.jpg',
    hasCalculator: true,
  },
  {
    id: 'stop-ristorni-mozione-partiti',
    category: 'fiscale',
    date: '2026-02-21T07:09:49.433Z',
    image: '/images/blog/stop-ristorni-mozione-partiti.jpg',
    hasCalculator: true,
  },
  {
    id: 'partiti-ticino-stop-ristorni',
    category: 'fiscale',
    date: '2026-02-21T09:03:05.590Z',
    image: '/images/blog/partiti-ticino-stop-ristorni.jpg',
    hasCalculator: true,
  },
  {
    id: 'conti-federali-aumento-iva-ticino',
    category: 'fiscale',
    date: '2026-02-21T10:57:40.158Z',
    image: '/images/blog/conti-federali-aumento-iva-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-stipendi-iva',
    category: 'pensione',
    date: '2026-02-21T11:45:56.948Z',
    image: '/images/blog/tredicesima-avs-stipendi-iva.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-lombardia-reazione',
    category: 'fiscale',
    date: '2026-02-21T13:56:39.111Z',
    image: '/images/blog/ristorni-lombardia-reazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'truffa-falso-bancario-ticino',
    category: 'pratico',
    date: '2026-02-21T14:58:59.331Z',
    image: '/images/blog/truffa-falso-bancario-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'dazi-usa-impatto-ticino',
    category: 'fiscale',
    date: '2026-02-21T15:53:40.225Z',
    image: '/images/blog/dazi-usa-impatto-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanita-ticino-tagli-orselina',
    category: 'novita',
    date: '2026-02-21T17:02:47.738Z',
    image: '/images/blog/sanita-ticino-tagli-orselina.jpg',
    hasCalculator: true,
  },
  {
    id: 'dumping-salari-architetti-ticino',
    category: 'pratico',
    date: '2026-02-21T17:56:15.988Z',
    image: '/images/blog/dumping-salari-architetti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-finanziamento-contributi',
    category: 'pensione',
    date: '2026-02-21T19:07:17.903Z',
    image: '/images/blog/tredicesima-avs-finanziamento-contributi.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-stipendio-trattenute',
    category: 'pensione',
    date: '2026-02-21T20:53:03.123Z',
    image: '/images/blog/tredicesima-avs-stipendio-trattenute.jpg',
    hasCalculator: true,
  },
  {
    id: 'scambio-dati-polizia-ticino',
    category: 'novita',
    date: '2026-02-21T21:50:37.214Z',
    image: '/images/blog/scambio-dati-polizia-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-finanziamento-misto-proposta',
    category: 'pensione',
    date: '2026-02-21T22:59:27.045Z',
    image: '/images/blog/tredicesima-avs-finanziamento-misto-proposta.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-dati-ingannevoli',
    category: 'novita',
    date: '2026-02-22T07:27:00.350Z',
    image: '/images/blog/frontalieri-ticino-dati-ingannevoli.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-finanziamento-busta-paga',
    category: 'pensione',
    date: '2026-02-22T09:05:06.560Z',
    image: '/images/blog/tredicesima-avs-finanziamento-busta-paga.jpg',
    hasCalculator: true,
  },
  {
    id: 'permesso-s-salari-bassi-ticino',
    category: 'novita',
    date: '2026-02-22T11:01:28.664Z',
    image: '/images/blog/permesso-s-salari-bassi-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-reazione-lombardia',
    category: 'fiscale',
    date: '2026-02-22T11:45:15.273Z',
    image: '/images/blog/ristorni-reazione-lombardia.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-busta-paga-frontaliere',
    category: 'pensione',
    date: '2026-02-22T13:58:05.912Z',
    image: '/images/blog/tredicesima-avs-busta-paga-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'acqua-mendrisiotto-prezzi-2026',
    category: 'pratico',
    date: '2026-02-22T15:02:49.982Z',
    image: '/images/blog/acqua-mendrisiotto-prezzi-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'cooperazione-giudiziaria-svizzera-italia',
    category: 'novita',
    date: '2026-02-22T16:00:11.052Z',
    image: '/images/blog/cooperazione-giudiziaria-svizzera-italia.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanita-locarnese-licenziamenti',
    category: 'novita',
    date: '2026-02-22T17:06:32.862Z',
    image: '/images/blog/sanita-locarnese-licenziamenti.jpg',
    hasCalculator: true,
  },
  {
    id: 'legionellosi-ticino-allarme',
    category: 'pratico',
    date: '2026-02-22T20:59:43.581Z',
    image: '/images/blog/legionellosi-ticino-allarme.jpg',
    hasCalculator: true,
  },
  {
    id: 'prezzi-dinamici-ticino-futuro',
    category: 'novita',
    date: '2026-02-22T21:55:58.732Z',
    image: '/images/blog/prezzi-dinamici-ticino-futuro.jpg',
    hasCalculator: true,
  },
  {
    id: 'lugano-manifestazioni-regole-polemica',
    category: 'novita',
    date: '2026-02-22T23:02:18.445Z',
    image: '/images/blog/lugano-manifestazioni-regole-polemica.jpg',
    hasCalculator: true,
  },
  {
    id: 'addizionale-irpef-mappa-comuni',
    category: 'fiscale',
    date: '2026-02-23T11:05:18.906Z',
    image: '/images/blog/addizionale-irpef-mappa-comuni.jpg',
    hasCalculator: true,
  },
  {
    id: 'mappa-fiscale-comuni-frontiera',
    category: 'fiscale',
    date: '2026-02-23T11:59:46.609Z',
    image: '/images/blog/mappa-fiscale-comuni-frontiera.jpg',
    hasCalculator: true,
  },
  {
    id: 'maternita-paternita-frontaliere-guida',
    category: 'pratico',
    date: '2026-02-23T13:10:14.450Z',
    image: '/images/blog/maternita-paternita-frontaliere-guida.jpg',
    hasCalculator: true,
  },
  {
    id: 'guida-contributi-sociali-svizzera',
    category: 'pratico',
    date: '2026-02-23T13:27:25.360Z',
    image: '/images/blog/guida-contributi-sociali-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-vivere-lugano-trasferirsi',
    category: 'pratico',
    date: '2026-02-23T13:54:52.885Z',
    image: '/images/blog/costo-vivere-lugano-trasferirsi.jpg',
    hasCalculator: true,
  },
  {
    id: 'permesso-g-pro-contro-2026',
    category: 'pratico',
    date: '2026-02-23T14:40:40.514Z',
    image: '/images/blog/permesso-g-pro-contro-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'calcolo-pensione-avs-inps',
    category: 'pensione',
    date: '2026-02-23T15:28:19.421Z',
    image: '/images/blog/calcolo-pensione-avs-inps.jpg',
    hasCalculator: true,
  },
  {
    id: 'simulazione-fiscale-frontaliere-2026',
    category: 'fiscale',
    date: '2026-02-23T15:48:03.684Z',
    image: '/images/blog/simulazione-fiscale-frontaliere-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'lamal-cmi-scelta-frontaliere-2026',
    category: 'pratico',
    date: '2026-02-23T15:56:13.506Z',
    image: '/images/blog/lamal-cmi-scelta-frontaliere-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'credito-imposta-doppia-tassazione',
    category: 'fiscale',
    date: '2026-02-23T16:13:02.045Z',
    image: '/images/blog/credito-imposta-doppia-tassazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-reale-auto-frontaliere',
    category: 'pratico',
    date: '2026-02-23T16:47:34.331Z',
    image: '/images/blog/costo-reale-auto-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'congedo-genitori-frontaliere-ticino',
    category: 'pratico',
    date: '2026-02-23T16:59:09.385Z',
    image: '/images/blog/congedo-genitori-frontaliere-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-pendolare-auto-ticino-2026',
    category: 'pratico',
    date: '2026-02-23T17:24:52.754Z',
    image: '/images/blog/costo-pendolare-auto-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'guida-dichiarazione-redditi-frontalieri',
    category: 'fiscale',
    date: '2026-02-23T17:37:11.718Z',
    image: '/images/blog/guida-dichiarazione-redditi-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'checklist-documenti-lavoro-svizzera',
    category: 'pratico',
    date: '2026-02-23T18:07:26.447Z',
    image: '/images/blog/checklist-documenti-lavoro-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'asilo-nido-frontaliere-ticino',
    category: 'pratico',
    date: '2026-02-23T18:20:25.212Z',
    image: '/images/blog/asilo-nido-frontaliere-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'locarno-stop-residenze-secondarie',
    category: 'novita',
    date: '2026-02-23T20:35:03.529Z',
    image: '/images/blog/locarno-stop-residenze-secondarie.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-vita-svizzera-mappa',
    category: 'pratico',
    date: '2026-02-23T21:32:02.760Z',
    image: '/images/blog/costo-vita-svizzera-mappa.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-lavoro-audit-suva',
    category: 'novita',
    date: '2026-02-23T23:48:53.355Z',
    image: '/images/blog/sicurezza-lavoro-audit-suva.jpg',
    hasCalculator: true,
  },
  {
    id: 'costo-vivere-mappa-comuni',
    category: 'pratico',
    date: '2026-02-24T05:16:42.336Z',
    image: '/images/blog/costo-vivere-mappa-comuni.jpg',
    hasCalculator: true,
  },
  {
    id: 'architetti-sottopagati-ticino',
    category: 'novita',
    date: '2026-02-24T06:01:43.889Z',
    image: '/images/blog/architetti-sottopagati-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'calo-frontalieri-non-tassa-salute',
    category: 'novita',
    date: '2026-02-24T06:46:38.447Z',
    image: '/images/blog/calo-frontalieri-non-tassa-salute.jpg',
    hasCalculator: true,
  },
  {
    id: 'maternita-cassazione-diritti-frontalieri',
    category: 'novita',
    date: '2026-02-24T08:06:58.406Z',
    image: '/images/blog/maternita-cassazione-diritti-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'galenica-bichsel-ristrutturazione-lavoro',
    category: 'novita',
    date: '2026-02-24T08:18:36.627Z',
    image: '/images/blog/galenica-bichsel-ristrutturazione-lavoro.jpg',
    hasCalculator: true,
  },
  {
    id: 'dazi-trump-export-ticinese',
    category: 'novita',
    date: '2026-02-24T08:39:10.896Z',
    image: '/images/blog/dazi-trump-export-ticinese.jpg',
    hasCalculator: true,
  },
  {
    id: 'campione-italia-fine-dissesto',
    category: 'novita',
    date: '2026-02-24T08:51:53.997Z',
    image: '/images/blog/campione-italia-fine-dissesto.jpg',
    hasCalculator: true,
  },
  {
    id: 'gavetta-tossica-architetti-ticino',
    category: 'novita',
    date: '2026-02-24T09:01:38.250Z',
    image: '/images/blog/gavetta-tossica-architetti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'eurocity-bloccato-caos-pendolari',
    category: 'pratico',
    date: '2026-02-24T09:58:00.895Z',
    image: '/images/blog/eurocity-bloccato-caos-pendolari.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-lavoro-controlli-svizzera',
    category: 'novita',
    date: '2026-02-24T10:45:46.842Z',
    image: '/images/blog/sicurezza-lavoro-controlli-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'startup-investimenti-boom-ticino',
    category: 'novita',
    date: '2026-02-24T11:05:14.743Z',
    image: '/images/blog/startup-investimenti-boom-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'long-covid-malattia-professionale',
    category: 'novita',
    date: '2026-02-24T11:31:42.798Z',
    image: '/images/blog/long-covid-malattia-professionale.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordo-ue-svizzera-mercato-interno',
    category: 'novita',
    date: '2026-02-24T12:28:45.188Z',
    image: '/images/blog/accordo-ue-svizzera-mercato-interno.jpg',
    hasCalculator: true,
  },
  {
    id: 'fonderie-svizzere-crisi-2025',
    category: 'novita',
    date: '2026-02-24T12:36:45.561Z',
    image: '/images/blog/fonderie-svizzere-crisi-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-ticino-accordo',
    category: 'novita',
    date: '2026-02-24T13:52:52.649Z',
    image: '/images/blog/salario-minimo-ticino-accordo.jpg',
    hasCalculator: true,
  },
  {
    id: 'trasporti-pubblici-crescita-svizzera',
    category: 'novita',
    date: '2026-02-24T15:04:24.521Z',
    image: '/images/blog/trasporti-pubblici-crescita-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'cantieri-notturni-lugano-marzo-2026',
    category: 'pratico',
    date: '2026-02-24T15:15:37.969Z',
    image: '/images/blog/cantieri-notturni-lugano-marzo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'supsi-nuova-direttrice-formazione',
    category: 'novita',
    date: '2026-02-24T15:59:45.978Z',
    image: '/images/blog/supsi-nuova-direttrice-formazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'bps-suisse-risultati-bper',
    category: 'novita',
    date: '2026-02-24T17:59:04.738Z',
    image: '/images/blog/bps-suisse-risultati-bper.jpg',
    hasCalculator: true,
  },
  {
    id: 'aiuti-energia-proroga-taglio',
    category: 'novita',
    date: '2026-02-24T18:36:28.492Z',
    image: '/images/blog/aiuti-energia-proroga-taglio.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-sociale-ticino-dibattito',
    category: 'novita',
    date: '2026-02-24T19:07:37.332Z',
    image: '/images/blog/salario-minimo-sociale-ticino-dibattito.jpg',
    hasCalculator: true,
  },
  {
    id: 'bps-suisse-utili-consigli-crisi',
    category: 'pratico',
    date: '2026-02-24T19:19:54.940Z',
    image: '/images/blog/bps-suisse-utili-consigli-crisi.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordo-ue-voto-obbligatorio-ticino',
    category: 'novita',
    date: '2026-02-24T19:33:47.591Z',
    image: '/images/blog/accordo-ue-voto-obbligatorio-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordo-ue-svizzera-impatto-frontalieri',
    category: 'novita',
    date: '2026-02-24T21:28:50.490Z',
    image: '/images/blog/accordo-ue-svizzera-impatto-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'locarno-stop-case-vacanza',
    category: 'novita',
    date: '2026-02-24T21:41:03.972Z',
    image: '/images/blog/locarno-stop-case-vacanza.jpg',
    hasCalculator: true,
  },
  {
    id: 'bilaterali-ue-svizzera-firma',
    category: 'novita',
    date: '2026-02-24T21:54:10.426Z',
    image: '/images/blog/bilaterali-ue-svizzera-firma.jpg',
    hasCalculator: true,
  },
  {
    id: 'aumento-iva-esercito-impatto-spesa',
    category: 'fiscale',
    date: '2026-02-24T23:09:00.951Z',
    image: '/images/blog/aumento-iva-esercito-impatto-spesa.jpg',
    hasCalculator: true,
  },
  {
    id: 'maternita-paternita-ticino',
    category: 'pratico',
    date: '2026-02-25T05:05:22.918Z',
    image: '/images/blog/maternita-paternita-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'referendum-ue-svizzera-ticino',
    category: 'novita',
    date: '2026-02-25T05:19:03.471Z',
    image: '/images/blog/referendum-ue-svizzera-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'valposchiavo-turismo-2025',
    category: 'novita',
    date: '2026-02-25T06:49:18.739Z',
    image: '/images/blog/valposchiavo-turismo-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-economia-ticino',
    category: 'novita',
    date: '2026-02-25T06:59:26.721Z',
    image: '/images/places/mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'inflazione-frontalieri-ticino',
    category: 'fiscale',
    date: '2026-02-25T07:06:08.112Z',
    image: '/images/blog/inflazione-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'aprire-conto-bancario-frontaliere',
    category: 'pratico',
    date: '2026-02-25T07:38:10.866Z',
    image: '/images/blog/aprire-conto-bancario-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-fiscali-ticino',
    category: 'fiscale',
    date: '2026-02-25T07:56:29.739Z',
    image: '/images/blog/ristorni-fiscali-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'contributi-sociali-busta-paga',
    category: 'pratico',
    date: '2026-02-25T08:10:22.085Z',
    image: '/images/blog/contributi-sociali-busta-paga.jpg',
    hasCalculator: true,
  },
  {
    id: 'strada-incidenti-vezia-cureglia',
    category: 'novita',
    date: '2026-02-25T08:29:27.169Z',
    image: '/images/blog/strada-incidenti-vezia-cureglia.jpg',
    hasCalculator: true,
  },
  {
    id: 'assicurazione-malattia-famiglia',
    category: 'pratico',
    date: '2026-02-25T08:50:41.055Z',
    image: '/images/blog/assicurazione-malattia-famiglia.jpg',
    hasCalculator: true,
  },
  {
    id: 'calo-frontalieri-ragioni-economiche',
    category: 'novita',
    date: '2026-02-25T09:22:38.673Z',
    image: '/images/blog/calo-frontalieri-ragioni-economiche.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-calo-economia-ticinese',
    category: 'novita',
    date: '2026-02-25T09:29:53.271Z',
    image: '/images/blog/frontalieri-calo-economia-ticinese.jpg',
    hasCalculator: true,
  },
  {
    id: 'usi-startup-centre-ranking',
    category: 'novita',
    date: '2026-02-25T10:21:49.348Z',
    image: '/images/blog/usi-startup-centre-ranking.jpg',
    hasCalculator: true,
  },
  {
    id: 'sciopero-treni-tilo-febbraio-2026',
    category: 'pratico',
    date: '2026-02-25T11:19:57.628Z',
    image: '/images/blog/sciopero-treni-tilo-febbraio-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'piscina-chiasso-copertura-2026',
    category: 'novita',
    date: '2026-02-25T11:52:20.679Z',
    image: '/images/blog/piscina-chiasso-copertura-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'centrale-elettrica-grono-attiva',
    category: 'novita',
    date: '2026-02-25T12:18:40.785Z',
    image: '/images/blog/centrale-elettrica-grono-attiva.jpg',
    hasCalculator: true,
  },
  {
    id: 'naspi-frontaliere-italia-requisiti',
    category: 'pratico',
    date: '2026-02-25T12:47:55.911Z',
    image: '/images/blog/naspi-frontaliere-italia-requisiti.jpg',
    hasCalculator: true,
  },
  {
    id: 'prelievo-secondo-pilastro-frontaliere',
    category: 'pensione',
    date: '2026-02-25T13:11:38.175Z',
    image: '/images/blog/prelievo-secondo-pilastro-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordo-ue-frontalieri-ticino',
    category: 'novita',
    date: '2026-02-25T13:42:33.526Z',
    image: '/images/blog/accordo-ue-frontalieri-ticino.png',
    hasCalculator: true,
  },
  {
    id: 'ristorni-congelati-ticino-italia',
    category: 'fiscale',
    date: '2026-02-25T14:45:52.152Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'naspi-ex-frontalieri-2026',
    category: 'pratico',
    date: '2026-02-25T15:02:54.047Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'mutuo-casa-frontalieri-italia',
    category: 'pratico',
    date: '2026-02-25T15:40:21.209Z',
    image: '/images/blog/mutuo-casa-frontalieri-italia.jpg',
    hasCalculator: true,
  },
  {
    id: 'piscina-chiasso-investimento',
    category: 'novita',
    date: '2026-02-25T18:18:15.456Z',
    image: '/images/blog/piscina-chiasso-investimento.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-congelati-gobbi-2026',
    category: 'fiscale',
    date: '2026-02-25T18:47:23.929Z',
    image: '/images/blog/ristorni-congelati-gobbi-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'asilo-nido-ticino-guida-2026',
    category: 'pratico',
    date: '2026-02-25T19:16:16.072Z',
    image: '/images/blog/asilo-nido-ticino-guida-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-salute-2026-ticino',
    category: 'fiscale',
    date: '2026-02-25T21:09:36.292Z',
    image: '/images/blog/ristorni-salute-2026-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-scontro-ticino-berna',
    category: 'fiscale',
    date: '2026-02-25T21:33:28.883Z',
    image: '/images/blog/tassa-salute-scontro-ticino-berna.jpg',
    hasCalculator: true,
  },
  {
    id: 'piscina-chiasso-rinnovo-sicurezza',
    category: 'novita',
    date: '2026-02-25T23:56:02.037Z',
    image: '/images/blog/piscina-chiasso-rinnovo-sicurezza.jpg',
    hasCalculator: true,
  },
  {
    id: 'disagi-tilo-sciopero-italia',
    category: 'novita',
    date: '2026-02-26T04:50:36.885Z',
    image: '/images/blog/disagi-tilo-sciopero-italia.jpg',
    hasCalculator: true,
  },
  {
    id: 'abbonamenti-sconti-treni-ticino',
    category: 'pratico',
    date: '2026-02-26T05:43:23.910Z',
    image: '/images/blog/abbonamenti-sconti-treni-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'bonus-famiglia-frontalieri-2026',
    category: 'pratico',
    date: '2026-02-26T06:13:15.917Z',
    image: '/images/blog/bonus-famiglia-frontalieri-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'smart-working-frontalieri-2026',
    category: 'pratico',
    date: '2026-02-26T06:33:25.219Z',
    image: '/images/blog/smart-working-frontalieri-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'confronto-assicurazioni-auto',
    category: 'pratico',
    date: '2026-02-26T08:07:38.633Z',
    image: '/images/blog/confronto-assicurazioni-auto.jpg',
    hasCalculator: true,
  },
  {
    id: 'permesso-b-vs-g-differenze',
    category: 'pratico',
    date: '2026-02-26T10:55:41.941Z',
    image: '/images/blog/permesso-b-vs-g-differenze.jpg',
    hasCalculator: true,
  },
  {
    id: 'spese-sanitarie-frontalieri',
    category: 'pratico',
    date: '2026-02-26T11:12:45.096Z',
    image: '/images/blog/spese-sanitarie-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'naspi-disoccupazione-frontalieri',
    category: 'pratico',
    date: '2026-02-26T11:31:19.516Z',
    image: '/images/blog/naspi-disoccupazione-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'dichiarazione-redditi-ticino-2026',
    category: 'fiscale',
    date: '2026-02-26T13:36:25.627Z',
    image: '/images/blog/dichiarazione-redditi-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'cantieri-traffico-a9-ticino',
    category: 'novita',
    date: '2026-02-26T14:42:47.487Z',
    image: '/images/blog/cantieri-traffico-a9-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'migranti-seghezzone-risparmi',
    category: 'novita',
    date: '2026-02-26T17:55:05.502Z',
    image: '/images/blog/migranti-seghezzone-risparmi.jpg',
    hasCalculator: true,
  },
  {
    id: 'cantieri-traffico-frontiera',
    category: 'pratico',
    date: '2026-02-26T20:30:48.251Z',
    image: '/images/blog/cantieri-traffico-frontiera.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-ps-compromesso',
    category: 'novita',
    date: '2026-02-27T05:10:08.873Z',
    image: '/images/blog/salario-minimo-ps-compromesso.jpg',
    hasCalculator: true,
  },
  {
    id: 'cocaina-lusso-perquisizioni-ticino',
    category: 'novita',
    date: '2026-02-27T06:11:51.617Z',
    image: '/images/blog/cocaina-lusso-perquisizioni-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'calcolo-tasse-entro-confine',
    category: 'fiscale',
    date: '2026-02-27T06:19:48.213Z',
    image: '/images/blog/calcolo-tasse-entro-confine.jpg',
    hasCalculator: true,
  },
  {
    id: 'riforma-giustizia-pace-ticino',
    category: 'novita',
    date: '2026-02-27T10:11:45.408Z',
    image: '/images/blog/riforma-giustizia-pace-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'cantieri-a9-disagi-frontiera',
    category: 'pratico',
    date: '2026-02-27T14:13:03.792Z',
    image: '/images/blog/cantieri-a9-disagi-frontiera.jpg',
    hasCalculator: true,
  },
  {
    id: 'revoca-uso-acqua-magliaso',
    category: 'novita',
    date: '2026-02-27T17:02:40.912Z',
    image: '/images/blog/revoca-uso-acqua-magliaso.jpg',
    hasCalculator: true,
  },
  {
    id: 'malattie-rare-ticino-2026',
    category: 'novita',
    date: '2026-02-27T18:09:17.520Z',
    image: '/images/blog/malattie-rare-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontaliers-sabotage-varese',
    category: 'novita',
    date: '2026-02-27T19:35:50.698Z',
    image: '/images/blog/frontaliers-sabotage-varese.jpg',
    hasCalculator: true,
  },
  {
    id: 'ristorni-congelati-scontro-ticino',
    category: 'novita',
    date: '2026-02-27T20:02:09.739Z',
    image: '/images/blog/ristorni-congelati-scontro-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassazione-individuale-lavoro-donne',
    category: 'fiscale',
    date: '2026-02-27T21:01:10.515Z',
    image: '/images/blog/tassazione-individuale-lavoro-donne.jpg',
    hasCalculator: true,
  },
  {
    id: 'diversita-religiosa-ticino-2026',
    category: 'novita',
    date: '2026-02-27T22:03:04.239Z',
    image: '/images/blog/diversita-religiosa-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'voto-corrispondenza-ticino-2026',
    category: 'novita',
    date: '2026-02-27T22:57:44.502Z',
    image: '/images/blog/voto-corrispondenza-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'cantiere-viale-geno-como',
    category: 'novita',
    date: '2026-02-27T23:45:47.200Z',
    image: '/images/blog/cantiere-viale-geno-como.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-velocita-ticino-2026',
    category: 'pratico',
    date: '2026-02-28T04:40:12.044Z',
    image: '/images/blog/controlli-velocita-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanremo-2026-aiello-gassmann',
    category: 'novita',
    date: '2026-02-28T06:02:12.802Z',
    image: '/images/blog/sanremo-2026-aiello-gassmann.jpg',
    hasCalculator: true,
  },
  {
    id: 'violenza-adolescenti-ticino',
    category: 'novita',
    date: '2026-02-28T07:09:07.366Z',
    image: '/images/blog/violenza-adolescenti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'comuni-frontalieri-distanza',
    category: 'fiscale',
    date: '2026-02-28T08:58:42.082Z',
    image: '/images/blog/comuni-frontalieri-distanza.jpg',
    hasCalculator: true,
  },
  {
    id: 'elezioni-comunali-ticino',
    category: 'novita',
    date: '2026-02-28T11:21:53.511Z',
    image: '/images/blog/elezioni-comunali-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'eroina-auto-chiasso-brogeda',
    category: 'novita',
    date: '2026-02-28T11:43:07.346Z',
    image: '/images/blog/eroina-auto-chiasso-brogeda.jpg',
    hasCalculator: true,
  },
  {
    id: 'olio-chimica-produzione',
    category: 'novita',
    date: '2026-02-28T13:53:07.665Z',
    image: '/images/blog/olio-chimica-produzione.jpg',
    hasCalculator: true,
  },
  {
    id: 'incidente-mortale-frontaliere',
    category: 'novita',
    date: '2026-02-28T14:50:37.144Z',
    image: '/images/blog/incidente-mortale-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'svizzera-mediazione-iran-2026',
    category: 'novita',
    date: '2026-02-28T15:45:23.911Z',
    image: '/images/blog/svizzera-mediazione-iran-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanremo-frontalieri-impatti',
    category: 'novita',
    date: '2026-02-28T16:16:34.440Z',
    image: '/images/blog/sanremo-frontalieri-impatti.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavorare-germania-educatori',
    category: 'pratico',
    date: '2026-02-28T16:25:31.596Z',
    image: '/images/blog/lavorare-germania-educatori.jpg',
    hasCalculator: true,
  },
  {
    id: 'porto-ceresio-lungolago-lavori',
    category: 'novita',
    date: '2026-02-28T16:55:46.254Z',
    image: '/images/blog/porto-ceresio-lungolago-lavori.jpg',
    hasCalculator: true,
  },
  {
    id: 'casa-hockey-ticino-2026',
    category: 'novita',
    date: '2026-02-28T17:44:21.995Z',
    image: '/images/blog/casa-hockey-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassazione-individuale-svizzera',
    category: 'fiscale',
    date: '2026-02-28T19:01:56.807Z',
    image: '/images/blog/tassazione-individuale-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'cinema-frontaliers-ticino-varese',
    category: 'novita',
    date: '2026-02-28T19:43:26.633Z',
    image: '/images/blog/cinema-frontaliers-ticino-varese.jpg',
    hasCalculator: true,
  },
  {
    id: 'minimo-salariale-ticino-accordo-ps',
    category: 'novita',
    date: '2026-03-01T08:59:12.110Z',
    image: '/images/blog/minimo-salariale-ticino-accordo-ps.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-fede-adulti-integrazione',
    category: 'novita',
    date: '2026-03-01T09:57:39.350Z',
    image: '/images/blog/chiasso-fede-adulti-integrazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-confine-ticino-brogeda',
    category: 'novita',
    date: '2026-03-01T10:09:54.413Z',
    image: '/images/blog/sicurezza-confine-ticino-brogeda.jpg',
    hasCalculator: true,
  },
  {
    id: 'stipendi-manager-energia-ticino',
    category: 'novita',
    date: '2026-03-01T10:32:27.959Z',
    image: '/images/blog/stipendi-manager-energia-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavoro-educatori-germania-alternativa',
    category: 'pratico',
    date: '2026-03-01T10:56:08.144Z',
    image: '/images/blog/lavoro-educatori-germania-alternativa.jpg',
    hasCalculator: true,
  },
  {
    id: 'gandria-lusso-immobiliare-ticino',
    category: 'novita',
    date: '2026-03-01T11:35:22.791Z',
    image: '/images/blog/gandria-lusso-immobiliare-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'vandalismo-bus-frontalieri-ticino',
    category: 'pratico',
    date: '2026-03-01T11:44:50.275Z',
    image: '/images/blog/vandalismo-bus-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-voto-anti-dumping',
    category: 'novita',
    date: '2026-03-01T13:54:26.375Z',
    image: '/images/blog/ticino-voto-anti-dumping.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-stradali-ticino-frontalieri',
    category: 'pratico',
    date: '2026-03-01T14:55:24.016Z',
    image: '/images/blog/controlli-stradali-ticino-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'comuni-confine-nuove-regole',
    category: 'fiscale',
    date: '2026-03-01T16:07:24.576Z',
    image: '/images/blog/comuni-confine-nuove-regole.jpg',
    hasCalculator: true,
  },
  {
    id: 'tragedia-stradale-frontaliere',
    category: 'pratico',
    date: '2026-03-01T16:37:37.528Z',
    image: '/images/blog/tragedia-stradale-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-como-cantieri-a9-disagi',
    category: 'pratico',
    date: '2026-03-01T16:48:27.604Z',
    image: '/images/blog/chiasso-como-cantieri-a9-disagi.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-comunita-evoluzione-sociale',
    category: 'novita',
    date: '2026-03-01T18:21:49.851Z',
    image: '/images/blog/chiasso-comunita-evoluzione-sociale.jpg',
    hasCalculator: true,
  },
  {
    id: 'tragedia-pendolare-ticino',
    category: 'novita',
    date: '2026-03-01T18:45:12.772Z',
    image: '/images/blog/tragedia-pendolare-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'a9-como-chiasso-disagi-notturni',
    category: 'novita',
    date: '2026-03-01T19:09:16.774Z',
    image: '/images/blog/a9-como-chiasso-disagi-notturni.jpg',
    hasCalculator: true,
  },
  {
    id: 'economia-svizzera-ripresa-2026',
    category: 'novita',
    date: '2026-03-01T20:12:40.237Z',
    image: '/images/blog/economia-svizzera-ripresa-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'confine-fiscale-nuovi-comuni',
    category: 'fiscale',
    date: '2026-03-01T20:33:06.540Z',
    image: '/images/blog/confine-fiscale-nuovi-comuni.jpg',
    hasCalculator: true,
  },
  {
    id: 'confine-a9-disagi-marzo',
    category: 'pratico',
    date: '2026-03-01T20:47:16.687Z',
    image: '/images/blog/confine-a9-disagi-marzo.jpg',
    hasCalculator: true,
  },
  {
    id: 'autostrada-a9-disagi-frontalieri',
    category: 'pratico',
    date: '2026-03-01T21:09:14.838Z',
    image: '/images/blog/autostrada-a9-disagi-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiusure-a9-trasporti-speciali',
    category: 'novita',
    date: '2026-03-01T21:48:11.487Z',
    image: '/images/blog/chiusure-a9-trasporti-speciali.jpg',
    hasCalculator: true,
  },
  {
    id: 'iniziativa-salari-ticino',
    category: 'novita',
    date: '2026-03-01T22:10:14.795Z',
    image: '/images/blog/iniziativa-salari-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'salari-ticino-voto-frontalieri',
    category: 'novita',
    date: '2026-03-01T22:29:48.743Z',
    image: '/images/blog/salari-ticino-voto-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'lutto-porlezza-frontaliere',
    category: 'novita',
    date: '2026-03-01T22:56:19.592Z',
    image: '/images/blog/lutto-porlezza-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-confine-disparita-fiscale',
    category: 'fiscale',
    date: '2026-03-01T23:18:17.186Z',
    image: '/images/blog/frontalieri-confine-disparita-fiscale.jpg',
    hasCalculator: true,
  },
  {
    id: 'iniziativa-anti-dumping-voto',
    category: 'novita',
    date: '2026-03-01T23:45:46.848Z',
    image: '/images/blog/iniziativa-anti-dumping-voto.jpg',
    hasCalculator: true,
  },
  {
    id: 'nestle-bonus-lombardia-welfare',
    category: 'novita',
    date: '2026-03-02T01:17:57.850Z',
    image: '/images/blog/nestle-bonus-lombardia-welfare.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontiera-a9-disagi-marzo-2026',
    category: 'pratico',
    date: '2026-03-02T04:17:25.040Z',
    image: '/images/blog/frontiera-a9-disagi-marzo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'mercato-lavoro-ticino-frena-2025',
    category: 'novita',
    date: '2026-03-02T05:26:02.929Z',
    image: '/images/blog/mercato-lavoro-ticino-frena-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'confini-comunali-impatto-fiscale',
    category: 'fiscale',
    date: '2026-03-02T05:54:09.212Z',
    image: '/images/blog/confini-comunali-impatto-fiscale.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-forte-impatto-frontalieri',
    category: 'pratico',
    date: '2026-03-02T06:31:44.207Z',
    image: '/images/blog/franco-forte-impatto-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'incidente-giovane-frontaliere',
    category: 'novita',
    date: '2026-03-02T06:53:59.199Z',
    image: '/images/blog/incidente-giovane-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'a9-chiasso-como-cantieri-frontalieri',
    category: 'pratico',
    date: '2026-03-02T07:03:43.654Z',
    image: '/images/blog/a9-chiasso-como-cantieri-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-compromesso-ticino',
    category: 'novita',
    date: '2026-03-02T07:29:12.631Z',
    image: '/images/blog/salario-minimo-compromesso-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'compromesso-salario-minimo-condizioni',
    category: 'novita',
    date: '2026-03-02T07:52:00.760Z',
    image: '/images/blog/compromesso-salario-minimo-condizioni.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-comunita-cambiamento-valori',
    category: 'novita',
    date: '2026-03-02T08:07:09.799Z',
    image: '/images/blog/chiasso-comunita-cambiamento-valori.jpg',
    hasCalculator: true,
  },
  {
    id: 'pendolarismo-fatale-frontaliere-porlezza',
    category: 'pratico',
    date: '2026-03-02T08:20:07.580Z',
    image: '/images/blog/pendolarismo-fatale-frontaliere-porlezza.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-ticino-trattative',
    category: 'novita',
    date: '2026-03-02T08:32:26.999Z',
    image: '/images/blog/salario-minimo-ticino-trattative.jpg',
    hasCalculator: true,
  },
  {
    id: 'trevano-campus-riqualifica',
    category: 'novita',
    date: '2026-03-02T09:01:11.073Z',
    image: '/images/blog/trevano-campus-riqualifica.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavena-sagrato-nuovo-investimento',
    category: 'novita',
    date: '2026-03-02T09:21:13.862Z',
    image: '/images/blog/lavena-sagrato-nuovo-investimento.jpg',
    hasCalculator: true,
  },
  {
    id: 'sportello-lavoro-varese-frontalieri-ticino',
    category: 'pratico',
    date: '2026-03-02T09:43:02.775Z',
    image: '/images/blog/sportello-lavoro-varese-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-stradali-intensivi-frontiera',
    category: 'pratico',
    date: '2026-03-02T10:14:54.340Z',
    image: '/images/blog/controlli-stradali-intensivi-frontiera.jpg',
    hasCalculator: true,
  },
  {
    id: 'radar-confine-ticino-marzo',
    category: 'pratico',
    date: '2026-03-02T10:24:07.195Z',
    image: '/images/blog/radar-confine-ticino-marzo.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-frontiera-ticino-rafforzati',
    category: 'novita',
    date: '2026-03-02T11:11:03.213Z',
    image: '/images/blog/controlli-frontiera-ticino-rafforzati.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavori-risanamento-a13-cadenazzo-2026',
    category: 'novita',
    date: '2026-03-02T11:30:02.301Z',
    image: '/images/blog/lavori-risanamento-a13-cadenazzo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-ticino-intesa-storica',
    category: 'novita',
    date: '2026-03-02T12:42:37.587Z',
    image: '/images/blog/salario-minimo-ticino-intesa-storica.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-stradale-ticino-marzo',
    category: 'pratico',
    date: '2026-03-02T13:02:20.076Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'a13-cantieri-frontalieri-ticino',
    category: 'pratico',
    date: '2026-03-02T13:23:18.350Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'bns-utile-calo-2025-impatto-ticino',
    category: 'novita',
    date: '2026-03-02T15:52:24.195Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'polizia-cantonale-nuovi-gendarmi',
    category: 'novita',
    date: '2026-03-02T17:34:53.483Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'competenze-tecniche-frontalieri-ticino',
    category: 'novita',
    date: '2026-03-02T18:19:47.172Z',
    image: '/images/places/mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'polizia-cantonale-reclutamento-2026',
    category: 'novita',
    date: '2026-03-02T18:42:09.440Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'mercato-auto-febbraio-2026',
    category: 'novita',
    date: '2026-03-02T19:17:12.691Z',
    image: '/images/places/lago-lugano.jpg',
    hasCalculator: true,
  },
  {
    id: 'como-nuovi-poliziotti-2026',
    category: 'novita',
    date: '2026-03-02T19:35:31.209Z',
    image: '/images/blog/como-nuovi-poliziotti-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sesto-calende-sicurezza-frontalieri',
    category: 'novita',
    date: '2026-03-02T19:56:10.332Z',
    image: '/images/blog/sesto-calende-sicurezza-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'nessun-prelievo-avs-sulle-mance',
    category: 'novita',
    date: '2026-03-02T20:23:12.389Z',
    image: '/images/blog/nessun-prelievo-avs-sulle-mance.jpg',
    hasCalculator: true,
  },
  {
    id: 'imposizione-individuale-donne-ticino',
    category: 'fiscale',
    date: '2026-03-02T21:09:04.931Z',
    image: '/images/blog/imposizione-individuale-donne-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-frontalieri-vantaggio-ticino',
    category: 'fiscale',
    date: '2026-03-02T21:37:28.656Z',
    image: '/images/blog/tassa-salute-frontalieri-vantaggio-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'docenti-frontalieri-permesso-lavoro',
    category: 'novita',
    date: '2026-03-02T21:59:50.389Z',
    image: '/images/blog/docenti-frontalieri-permesso-lavoro.jpg',
    hasCalculator: true,
  },
  {
    id: 'iniziativa-anti-dumping-ticino-2026',
    category: 'novita',
    date: '2026-03-02T22:16:35.095Z',
    image: '/images/blog/iniziativa-anti-dumping-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'comuni-confine-fiscalita-disparita',
    category: 'fiscale',
    date: '2026-03-02T22:48:09.708Z',
    image: '/images/blog/comuni-confine-fiscalita-disparita.jpg',
    hasCalculator: true,
  },
  {
    id: 'svizzera-ue-pacchetto-accordi',
    category: 'novita',
    date: '2026-03-02T23:01:10.878Z',
    image: '/images/blog/svizzera-ue-pacchetto-accordi.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-berna-ticino',
    category: 'novita',
    date: '2026-03-02T23:22:43.121Z',
    image: '/images/blog/tassa-salute-berna-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-svizzera-vantaggio',
    category: 'fiscale',
    date: '2026-03-02T23:53:59.093Z',
    image: '/images/blog/tassa-salute-svizzera-vantaggio.jpg',
    hasCalculator: true,
  },
  {
    id: 'ai-lombardia-impatto-ticino',
    category: 'novita',
    date: '2026-03-03T04:45:59.353Z',
    image: '/images/blog/ai-lombardia-impatto-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'crisi-golfo-carburanti-ticino',
    category: 'novita',
    date: '2026-03-03T05:10:59.337Z',
    image: '/images/blog/crisi-golfo-carburanti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'rincari-benzina-frontalieri-ticino',
    category: 'novita',
    date: '2026-03-03T05:38:48.666Z',
    image: '/images/blog/rincari-benzina-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'crisi-olio-prezzi-benzina-ticino',
    category: 'novita',
    date: '2026-03-03T06:15:45.888Z',
    image: '/images/blog/crisi-olio-prezzi-benzina-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'benzina-ticino-oriente',
    category: 'novita',
    date: '2026-03-03T06:26:08.049Z',
    image: '/images/blog/benzina-ticino-oriente.jpg',
    hasCalculator: true,
  },
  {
    id: 'ai-lombardia-ticino-frontaliere-2026',
    category: 'novita',
    date: '2026-03-03T06:42:20.217Z',
    image: '/images/blog/ai-lombardia-ticino-frontaliere-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'carpooling-ticino-corsie-frontaliere-2026',
    category: 'novita',
    date: '2026-03-03T08:38:23.727Z',
    image: '/images/blog/carpooling-ticino-corsie-frontaliere-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-frontalieri-governo-svizzero',
    category: 'novita',
    date: '2026-03-03T08:52:06.040Z',
    image: '/images/blog/tassa-salute-frontalieri-governo-svizzero.jpg',
    hasCalculator: true,
  },
  {
    id: 'kuhne-nagel-tagli-posti-ticino-2026',
    category: 'novita',
    date: '2026-03-03T09:15:24.889Z',
    image: '/images/blog/kuhne-nagel-tagli-posti-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'vini-ticinesi-collaborazione',
    category: 'novita',
    date: '2026-03-03T10:05:27.288Z',
    image: '/images/blog/vini-ticinesi-collaborazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'hockey-chiasso-wild-boars-bis',
    category: 'novita',
    date: '2026-03-03T10:45:58.656Z',
    image: '/images/blog/hockey-chiasso-wild-boars-bis.jpg',
    hasCalculator: true,
  },
  {
    id: 'svincolo-a2-biasca-rischi-frontaliere',
    category: 'pratico',
    date: '2026-03-03T11:32:33.500Z',
    image: '/images/blog/svincolo-a2-biasca-rischi-frontaliere.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordi-svizzera-ue-parmelin-bruxelles',
    category: 'novita',
    date: '2026-03-03T12:07:44.808Z',
    image: '/images/blog/accordi-svizzera-ue-parmelin-bruxelles.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavori-linea-locarno-cadenazzo-2026',
    category: 'pratico',
    date: '2026-03-03T13:07:32.024Z',
    image: '/images/blog/lavori-linea-locarno-cadenazzo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'spirit-varesini-valico-tassa-2026',
    category: 'novita',
    date: '2026-03-03T13:39:09.417Z',
    image: '/images/blog/spirit-varesini-valico-tassa-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'borse-in-rosso-prezzo-petrolio-ticino',
    category: 'novita',
    date: '2026-03-03T14:39:51.004Z',
    image: '/images/blog/borse-in-rosso-prezzo-petrolio-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontaliers-sabotage-varese-successo',
    category: 'novita',
    date: '2026-03-04T07:43:28.064Z',
    image: '/images/blog/frontaliers-sabotage-varese-successo.jpg',
    hasCalculator: true,
  },
  {
    id: 'disoccupazione-svizzera-2026',
    category: 'novita',
    date: '2026-03-04T08:11:51.668Z',
    image: '/images/blog/disoccupazione-svizzera-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'infermieri-svizzera-frontalieri-ticino',
    category: 'novita',
    date: '2026-03-04T10:17:08.333Z',
    image: '/images/blog/infermieri-svizzera-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'successo-farmaceutica-ticino',
    category: 'novita',
    date: '2026-03-04T12:09:08.086Z',
    image: '/images/blog/successo-farmaceutica-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'utile-bns-2025-ticino',
    category: 'novita',
    date: '2026-03-04T14:22:12.294Z',
    image: '/images/blog/utile-bns-2025-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'banche-ticino-disoccupazione',
    category: 'novita',
    date: '2026-03-04T17:38:10.346Z',
    image: '/images/blog/banche-ticino-disoccupazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'medio-vedeggio-gruppo-lavoro-aggregazione',
    category: 'novita',
    date: '2026-03-04T20:08:46.365Z',
    image: '/images/blog/medio-vedeggio-gruppo-lavoro-aggregazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'lugano-airport-fondi-salvati-2026',
    category: 'novita',
    date: '2026-03-04T21:05:31.643Z',
    image: '/images/blog/lugano-airport-fondi-salvati-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'made-in-italy-doganali-ticino-2026',
    category: 'novita',
    date: '2026-03-04T23:07:46.491Z',
    image: '/images/blog/made-in-italy-doganali-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'mercato-lavoro-ticino-q4-2025',
    category: 'novita',
    date: '2026-03-05T05:06:52.935Z',
    image: '/images/blog/mercato-lavoro-ticino-q4-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'dichiarazione-imposta-digitale-ticino-26',
    category: 'fiscale',
    date: '2026-03-05T08:01:20.370Z',
    image: '/images/blog/dichiarazione-imposta-digitale-ticino-26.jpg',
    hasCalculator: true,
  },
  {
    id: 'tilo-25-milioni-passeggeri-2025',
    category: 'novita',
    date: '2026-03-05T10:11:48.534Z',
    image: '/images/blog/tilo-25-milioni-passeggeri-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-lombardia-rinvio',
    category: 'fiscale',
    date: '2026-03-05T12:12:19.104Z',
    image: '/images/blog/tassa-salute-lombardia-rinvio.jpg',
    hasCalculator: true,
  },
  {
    id: 'tilo-record-passeggeri-2025',
    category: 'novita',
    date: '2026-03-05T14:46:54.511Z',
    image: '/images/blog/tilo-record-passeggeri-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-tassa-salute-piemonte',
    category: 'novita',
    date: '2026-03-05T19:45:58.985Z',
    image: '/images/blog/frontalieri-tassa-salute-piemonte.jpg',
    hasCalculator: true,
  },
  {
    id: 'trasporti-lombardia-ticino-record-tilo',
    category: 'pratico',
    date: '2026-03-05T21:55:24.813Z',
    image: '/images/blog/trasporti-lombardia-ticino-record-tilo.jpg',
    hasCalculator: true,
  },
  {
    id: 'confusione-tassa-salute-frontalieri',
    category: 'fiscale',
    date: '2026-03-06T00:03:53.612Z',
    image: '/images/blog/confusione-tassa-salute-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'neutralita-svizzera-parere-nazionale',
    category: 'novita',
    date: '2026-03-06T07:56:06.487Z',
    image: '/images/blog/neutralita-svizzera-parere-nazionale.jpg',
    hasCalculator: true,
  },
  {
    id: 'carburante-ticino-costo-aumenti',
    category: 'pratico',
    date: '2026-03-06T10:00:10.939Z',
    image: '/images/blog/carburante-ticino-costo-aumenti.jpg',
    hasCalculator: true,
  },
  {
    id: 'cpi-caso-hospita-rivalutazione-periti',
    category: 'pratico',
    date: '2026-03-06T11:19:03.572Z',
    image: '/images/blog/cpi-caso-hospita-rivalutazione-periti.jpg',
    hasCalculator: true,
  },
  {
    id: 'casellario-giudiziale-ue-ticino',
    category: 'novita',
    date: '2026-03-06T14:11:24.215Z',
    image: '/images/blog/casellario-giudiziale-ue-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'salario-minimo-per-il-controprogetto-la-strada-e-in-discesa',
    category: 'novita',
    date: '2026-03-06T16:10:57.694Z',
    image: '/images/blog/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-salute-lombardia-frontalieri',
    category: 'fiscale',
    date: '2026-03-06T18:10:25.014Z',
    image: '/images/blog/tassa-salute-lombardia-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-forte-problemi-economici',
    category: 'novita',
    date: '2026-03-06T20:06:08.856Z',
    image: '/images/blog/franco-forte-problemi-economici.jpg',
    hasCalculator: true,
  },
  {
    id: 'carburante-prezzo-salito-opportunismo',
    category: 'novita',
    date: '2026-03-06T21:06:25.150Z',
    image: '/images/blog/carburante-prezzo-salito-opportunismo.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-tassa-salute-teatro',
    category: 'novita',
    date: '2026-03-06T22:04:08.262Z',
    image: '/images/blog/frontalieri-tassa-salute-teatro.jpg',
    hasCalculator: true,
  },
  {
    id: 'disoccupazione-stabile-svizzera-2026',
    category: 'novita',
    date: '2026-03-06T23:12:41.977Z',
    image: '/images/blog/disoccupazione-stabile-svizzera-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'dazi-usa-rimborsi-ritardi',
    category: 'fiscale',
    date: '2026-03-06T23:56:51.634Z',
    image: '/images/blog/dazi-usa-rimborsi-ritardi.jpg',
    hasCalculator: true,
  },
  {
    id: 'votazioni-8-marzo-iniziativa-ssr-aperto',
    category: 'novita',
    date: '2026-03-07T04:47:30.663Z',
    image: '/images/blog/votazioni-8-marzo-iniziativa-ssr-aperto.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-spitex-contributo-pressione',
    category: 'pratico',
    date: '2026-03-07T06:05:59.953Z',
    image: '/images/blog/ticino-spitex-contributo-pressione.jpg',
    hasCalculator: true,
  },
  {
    id: 'stalking-swiss-2026-ticino',
    category: 'novita',
    date: '2026-03-07T07:52:55.740Z',
    image: '/images/blog/stalking-swiss-2026-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'pirati-strada-ticino-italiani-2026',
    category: 'pratico',
    date: '2026-03-07T09:01:01.606Z',
    image: '/images/blog/pirati-strada-ticino-italiani-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'comuni-locarno-futuro-aggregazione',
    category: 'pratico',
    date: '2026-03-07T09:56:43.987Z',
    image: '/images/blog/comuni-locarno-futuro-aggregazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'costi-cure-domicilio-ticino-2026',
    category: 'novita',
    date: '2026-03-07T10:53:30.400Z',
    image: '/images/blog/costi-cure-domicilio-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'lugano-park-ride-bus-sovvenzioni-2026',
    category: 'novita',
    date: '2026-03-07T11:41:11.265Z',
    image: '/images/blog/lugano-park-ride-bus-sovvenzioni-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'crisi-turismo-golfo-persico',
    category: 'novita',
    date: '2026-03-07T13:54:36.736Z',
    image: '/images/blog/crisi-turismo-golfo-persico.jpg',
    hasCalculator: true,
  },
  {
    id: 'turisti-ticinesi-bloccati-medio-oriente',
    category: 'novita',
    date: '2026-03-07T14:54:22.392Z',
    image: '/images/blog/turisti-ticinesi-bloccati-medio-oriente.jpg',
    hasCalculator: true,
  },
  {
    id: 'svizzeri-bloccati-medio-oriente',
    category: 'novita',
    date: '2026-03-07T15:51:15.277Z',
    image: '/images/blog/svizzeri-bloccati-medio-oriente.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-prevenzione-incendi-scuole-2026',
    category: 'novita',
    date: '2026-03-07T17:00:20.170Z',
    image: '/images/blog/ticino-prevenzione-incendi-scuole-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'varese-india-export-2026',
    category: 'novita',
    date: '2026-03-07T17:48:07.853Z',
    image: '/images/blog/varese-india-export-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'autotrasporto-rincari-confine-2026',
    category: 'novita',
    date: '2026-03-08T10:57:24.335Z',
    image: '/images/blog/autotrasporto-rincari-confine-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'carburanti-rincari-confine-ticino',
    category: 'novita',
    date: '2026-03-08T11:45:19.593Z',
    image: '/images/blog/carburanti-rincari-confine-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'votazioni-imposizione-ticino-2026',
    category: 'fiscale',
    date: '2026-03-08T13:59:41.134Z',
    image: '/images/blog/votazioni-imposizione-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'imposizione-individuale-ticino-2026',
    category: 'fiscale',
    date: '2026-03-08T15:03:13.485Z',
    image: '/images/blog/imposizione-individuale-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'no-iniziativa-antidumping-ticino',
    category: 'novita',
    date: '2026-03-08T15:50:38.951Z',
    image: '/images/blog/no-iniziativa-antidumping-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'dumping-salariale-ticino-no-iniziativa',
    category: 'novita',
    date: '2026-03-08T17:03:19.531Z',
    image: '/images/blog/dumping-salariale-ticino-no-iniziativa.jpg',
    hasCalculator: true,
  },
  {
    id: 'incidente-viadotto-brogeda-como',
    category: 'pratico',
    date: '2026-03-08T19:05:48.044Z',
    image: '/images/blog/incidente-viadotto-brogeda-como.jpg',
    hasCalculator: true,
  },
  {
    id: 'iniziativa-contro-dumping-ticino',
    category: 'novita',
    date: '2026-03-08T21:04:20.822Z',
    image: '/images/blog/iniziativa-contro-dumping-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'dumping-salariale-iniziativa-mps',
    category: 'novita',
    date: '2026-03-08T21:54:21.008Z',
    image: '/images/blog/dumping-salariale-iniziativa-mps.jpg',
    hasCalculator: true,
  },
  {
    id: 'imposizione-individuale-rivoluzione-fiscale',
    category: 'fiscale',
    date: '2026-03-08T23:01:39.701Z',
    image: '/images/blog/imposizione-individuale-rivoluzione-fiscale.jpg',
    hasCalculator: true,
  },
  {
    id: 'svizzera-servizio-pubblico-canone-tv',
    category: 'novita',
    date: '2026-03-08T23:59:47.124Z',
    image: '/images/blog/svizzera-servizio-pubblico-canone-tv.jpg',
    hasCalculator: true,
  },
  {
    id: 'votazioni-federali-tassazione-individuale',
    category: 'fiscale',
    date: '2026-03-09T05:29:39.611Z',
    image: '/images/blog/votazioni-federali-tassazione-individuale.jpg',
    hasCalculator: true,
  },
  {
    id: 'universita-ticino-frontalieri',
    category: 'novita',
    date: '2026-03-09T08:04:18.054Z',
    image: '/images/blog/universita-ticino-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-svizzero-frontalieri-ricchi-2026',
    category: 'novita',
    date: '2026-03-09T17:22:58.501Z',
    image: '/images/blog/franco-svizzero-frontalieri-ricchi-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'energia-costi-ticino-rincari-2026',
    category: 'novita',
    date: '2026-03-09T17:41:19.014Z',
    image: '/images/blog/energia-costi-ticino-rincari-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-carburante-alle-stelle-quadri-berna-riduca-tasse',
    category: 'fiscale',
    date: '2026-03-09T20:02:22.336Z',
    image: '/images/blog/ticino-carburante-alle-stelle-quadri-berna-riduca-tasse.jpg',
    hasCalculator: true,
  },
  {
    id: 'un-test-per-dare-un-nome-al-dolore',
    category: 'pratico',
    date: '2026-03-09T21:11:13.027Z',
    image: '/images/blog/un-test-per-dare-un-nome-al-dolore.jpg',
    hasCalculator: true,
  },
  {
    id: 'aumentare-gia-il-prezzo-della-benzina',
    category: 'pratico',
    date: '2026-03-09T23:08:47.845Z',
    image: '/images/blog/aumentare-gia-il-prezzo-della-benzina.jpg',
    hasCalculator: true,
  },
  {
    id: 'furti-supermercati-ponte-tresa',
    category: 'pratico',
    date: '2026-03-10T00:03:12.408Z',
    image: '/images/blog/furti-supermercati-ponte-tresa.jpg',
    hasCalculator: true,
  },
  {
    id: 'ladri-intercettati-lavena-ponte-tresa',
    category: 'novita',
    date: '2026-03-10T05:05:56.252Z',
    image: '/images/blog/ladri-intercettati-lavena-ponte-tresa.jpg',
    hasCalculator: true,
  },
  {
    id: 'dumping-salariale-ticino-no',
    category: 'fiscale',
    date: '2026-03-10T07:33:26.062Z',
    image: '/images/blog/dumping-salariale-ticino-no.jpg',
    hasCalculator: true,
  },
  {
    id: 'sospensione-costi-utenti-ticino',
    category: 'fiscale',
    date: '2026-03-10T10:09:52.058Z',
    image: '/images/blog/sospensione-costi-utenti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'investimento-pedone-bioggio',
    category: 'pratico',
    date: '2026-03-10T12:03:12.243Z',
    image: '/images/blog/investimento-pedone-bioggio.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-stazioni-treni-ticino-2026',
    category: 'novita',
    date: '2026-03-10T14:42:02.446Z',
    image: '/images/blog/sicurezza-stazioni-treni-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'tir-colonna-disagi-valico-brogeda',
    category: 'pratico',
    date: '2026-03-10T17:41:02.640Z',
    image: '/images/blog/tir-colonna-disagi-valico-brogeda.jpg',
    hasCalculator: true,
  },
  {
    id: 'iniziative-cassa-malati-costituzionalista-ticino',
    category: 'novita',
    date: '2026-03-10T19:57:37.221Z',
    image: '/images/blog/iniziative-cassa-malati-costituzionalista-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'investimenti-sicurezza-turismo-valsolda-26',
    category: 'novita',
    date: '2026-03-10T21:07:05.146Z',
    image: '/images/blog/investimenti-sicurezza-turismo-valsolda-26.jpg',
    hasCalculator: true,
  },
  {
    id: 'premio-la-rondine-2026-ticino',
    category: 'novita',
    date: '2026-03-10T23:02:11.090Z',
    image: '/images/blog/premio-la-rondine-2026-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassi-ipotecari-ticino-medio-oriente-2026',
    category: 'novita',
    date: '2026-03-10T23:57:24.721Z',
    image: '/images/blog/tassi-ipotecari-ticino-medio-oriente-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'aumento-export-bellico-svizzero-ticino',
    category: 'novita',
    date: '2026-03-11T05:06:52.522Z',
    image: '/images/blog/aumento-export-bellico-svizzero-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'assicurazione-auto-rincari-2026',
    category: 'fiscale',
    date: '2026-03-11T08:08:50.903Z',
    image: '/images/blog/assicurazione-auto-rincari-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-biglietti-senza-contanti',
    category: 'novita',
    date: '2026-03-11T10:16:30.280Z',
    image: '/images/blog/ticino-biglietti-senza-contanti.jpg',
    hasCalculator: true,
  },
  {
    id: 'aziende-como-assumono-lavoratori',
    category: 'novita',
    date: '2026-03-11T12:16:45.031Z',
    image: '/images/blog/aziende-como-assumono-lavoratori.jpg',
    hasCalculator: true,
  },
  {
    id: 'a2-giornico-cantiere-disagi-frontalieri',
    category: 'pratico',
    date: '2026-03-11T14:56:52.398Z',
    image: '/images/blog/a2-giornico-cantiere-disagi-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-traffico-pesante-camion-elettrici',
    category: 'fiscale',
    date: '2026-03-11T17:48:13.666Z',
    image: '/images/blog/tassa-traffico-pesante-camion-elettrici.jpg',
    hasCalculator: true,
  },
  {
    id: 'logistica-sostenibile-a22',
    category: 'novita',
    date: '2026-03-11T20:01:10.417Z',
    image: '/images/blog/logistica-sostenibile-a22.jpg',
    hasCalculator: true,
  },
  {
    id: 'problemi-rotaia-bellinzona-lugano',
    category: 'pratico',
    date: '2026-03-11T21:10:14.170Z',
    image: '/images/blog/problemi-rotaia-bellinzona-lugano.jpg',
    hasCalculator: true,
  },
  {
    id: 'carpooling-aziendale-ticino',
    category: 'novita',
    date: '2026-03-11T23:00:52.131Z',
    image: '/images/blog/carpooling-aziendale-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'energia-ets-von-der-leyen',
    category: 'novita',
    date: '2026-03-11T23:59:02.439Z',
    image: '/images/blog/energia-ets-von-der-leyen.jpg',
    hasCalculator: true,
  },
  {
    id: 'permesso-g-apprendisti-frontali',
    category: 'pratico',
    date: '2026-03-12T05:10:57.442Z',
    image: '/images/blog/permesso-g-apprendisti-frontali.jpg',
    hasCalculator: true,
  },
  {
    id: 'assegni-familiari-frontalieri-ticino',
    category: 'novita',
    date: '2026-03-12T08:15:36.089Z',
    image: '/images/blog/assegni-familiari-frontalieri-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'dagatra-incontro-migranti-chiasso',
    category: 'novita',
    date: '2026-03-12T10:24:00.089Z',
    image: '/images/blog/dagatra-incontro-migranti-chiasso.jpg',
    hasCalculator: true,
  },
  {
    id: 'ufficio-postale-chiasso-trasloco',
    category: 'pratico',
    date: '2026-03-12T17:43:54.025Z',
    image: '/images/blog/ufficio-postale-chiasso-trasloco.jpg',
    hasCalculator: true,
  },
  {
    id: 'confine-tesissimo-assegni-familiari',
    category: 'pratico',
    date: '2026-03-12T20:04:30.152Z',
    image: '/images/blog/confine-tesissimo-assegni-familiari.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-jazz-festival-2026',
    category: 'novita',
    date: '2026-03-12T21:11:40.435Z',
    image: '/images/blog/chiasso-jazz-festival-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'apprendisti-frontalieri-riforma-permesso-g',
    category: 'novita',
    date: '2026-03-12T23:06:54.740Z',
    image: '/images/blog/apprendisti-frontalieri-riforma-permesso-g.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-piano-regolatore-telefonia',
    category: 'pratico',
    date: '2026-03-12T23:58:37.083Z',
    image: '/images/blog/chiasso-piano-regolatore-telefonia.jpg',
    hasCalculator: true,
  },
  {
    id: 'pensione-et-ticino-sentiero',
    category: 'pensione',
    date: '2026-03-13T05:09:19.716Z',
    image: '/images/blog/pensione-et-ticino-sentiero.jpg',
    hasCalculator: true,
  },
  {
    id: 'paradosso-ticino-lavoro',
    category: 'pratico',
    date: '2026-03-13T08:07:04.502Z',
    image: '/images/blog/paradosso-ticino-lavoro.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavena-ponte-tresa-giro-spaccio',
    category: 'pratico',
    date: '2026-03-13T10:07:51.178Z',
    image: '/images/blog/lavena-ponte-tresa-giro-spaccio.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-ticino-decreto-omnibus',
    category: 'fiscale',
    date: '2026-03-13T11:52:37.871Z',
    image: '/images/blog/frontalieri-ticino-decreto-omnibus.jpg',
    hasCalculator: true,
  },
  {
    id: 'apertura-pesca-ticino',
    category: 'novita',
    date: '2026-03-13T14:35:03.915Z',
    image: '/images/blog/apertura-pesca-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'cassa-malati-franchigia-minima-ticino',
    category: 'pratico',
    date: '2026-03-13T17:44:42.623Z',
    image: '/images/blog/cassa-malati-franchigia-minima-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-tassa-salute-ritiro',
    category: 'fiscale',
    date: '2026-03-13T19:52:14.703Z',
    image: '/images/blog/frontalieri-tassa-salute-ritiro.jpg',
    hasCalculator: true,
  },
  {
    id: 'trin-tunnel-grave-frontalieri',
    category: 'fiscale',
    date: '2026-03-13T20:31:24.357Z',
    image: '/images/blog/trin-tunnel-grave-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiasso-verde-sufficiente',
    category: 'pratico',
    date: '2026-03-13T21:29:50.232Z',
    image: '/images/blog/chiasso-verde-sufficiente.jpg',
    hasCalculator: true,
  },
  {
    id: 'comitati-malpensa-cuv-2026',
    category: 'novita',
    date: '2026-03-13T22:26:58.739Z',
    image: '/images/blog/comitati-malpensa-cuv-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta',
    category: 'fiscale',
    date: '2026-03-13T23:25:47.849Z',
    image: '/images/blog/borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta.jpg',
    hasCalculator: true,
  },
  {
    id: 'iran-tajani-non-tratta-navi',
    category: 'novita',
    date: '2026-03-14T01:25:04.062Z',
    image: '/images/blog/iran-tajani-non-tratta-navi.jpg',
    hasCalculator: true,
  },
  {
    id: 'accordi-bilaterali-3-parlamento',
    category: 'novita',
    date: '2026-03-14T04:10:54.170Z',
    image: '/images/blog/accordi-bilaterali-3-parlamento.jpg',
    hasCalculator: true,
  },
  {
    id: 'viaggio-delle-batterie-verso-seconda-vita',
    category: 'pratico',
    date: '2026-03-14T05:50:27.012Z',
    image: '/images/blog/viaggio-delle-batterie-verso-seconda-vita.jpg',
    hasCalculator: true,
  },
  {
    id: 'bilaterali-iii-parlamento-ticino-2026',
    category: 'novita',
    date: '2026-03-14T06:42:07.542Z',
    image: '/images/blog/bilaterali-iii-parlamento-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'affitti-rialzo-crisi-ticino-2026',
    category: 'novita',
    date: '2026-03-14T07:35:43.882Z',
    image: '/images/blog/affitti-rialzo-crisi-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'bilaterali-iii-ticino-parlamento-2026',
    category: 'novita',
    date: '2026-03-14T08:31:53.085Z',
    image: '/images/blog/bilaterali-iii-ticino-parlamento-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'truffa-lavoro-svizzera-anticipo-2026',
    category: 'novita',
    date: '2026-03-14T09:31:01.207Z',
    image: '/images/blog/truffa-lavoro-svizzera-anticipo-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-carburanti-prezzo-potere-acquisto',
    category: 'fiscale',
    date: '2026-03-14T10:25:32.580Z',
    image: '/images/blog/ticino-carburanti-prezzo-potere-acquisto.jpg',
    hasCalculator: true,
  },
  {
    id: 'aumento-franchigia-minima',
    category: 'pratico',
    date: '2026-03-14T11:39:29.764Z',
    image: '/images/blog/aumento-franchigia-minima.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-swissminiatur-inaugura-miniera-doro-sessa',
    category: 'novita',
    date: '2026-03-14T17:34:47.553Z',
    image: '/images/blog/ticino-swissminiatur-inaugura-miniera-doro-sessa.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavena-ponte-tresa-addio-antonio-cannavale',
    category: 'novita',
    date: '2026-03-14T18:31:29.011Z',
    image: '/images/blog/lavena-ponte-tresa-addio-antonio-cannavale.jpg',
    hasCalculator: true,
  },
  {
    id: 'gravincidente-stradale-regina-feriti',
    category: 'novita',
    date: '2026-03-14T19:25:28.259Z',
    image: '/images/blog/gravincidente-stradale-regina-feriti.jpg',
    hasCalculator: true,
  },
  {
    id: 'scende-limite-nevicate-ticino',
    category: 'novita',
    date: '2026-03-14T20:24:20.004Z',
    image: '/images/blog/scende-limite-nevicate-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-no-anti-dumping',
    category: 'novita',
    date: '2026-03-14T21:24:38.432Z',
    image: '/images/blog/ticino-no-anti-dumping.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiusa-val-bedretto',
    category: 'novita',
    date: '2026-03-14T22:23:51.709Z',
    image: '/images/blog/chiusa-val-bedretto.jpg',
    hasCalculator: true,
  },
  {
    id: 'un-passaporto-di-fedelt',
    category: 'novita',
    date: '2026-03-14T23:24:29.903Z',
    image: '/images/blog/un-passaporto-di-fedelt.jpg',
    hasCalculator: true,
  },
  {
    id: 'baseball-italia-porto-rico-world-classic',
    category: 'novita',
    date: '2026-03-15T01:50:21.243Z',
    image: '/images/blog/baseball-italia-porto-rico-world-classic.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiusure-autostrada-confine-ticino-2026',
    category: 'pratico',
    date: '2026-03-15T04:31:21.107Z',
    image: '/images/blog/chiusure-autostrada-confine-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'swissminiatur-miniera-doro-sessa',
    category: 'novita',
    date: '2026-03-15T06:18:06.018Z',
    image: '/images/blog/swissminiatur-miniera-doro-sessa.jpg',
    hasCalculator: true,
  },
  {
    id: 'sondaggio-tamedia-iva-esercito-avs',
    category: 'fiscale',
    date: '2026-03-15T07:50:20.368Z',
    image: '/images/blog/sondaggio-tamedia-iva-esercito-avs.jpg',
    hasCalculator: true,
  },
  {
    id: 'iran-conflitto-rincari-ticino',
    category: 'fiscale',
    date: '2026-03-15T08:50:44.431Z',
    image: '/images/blog/iran-conflitto-rincari-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'inverno-ticino-nevicate-2026',
    category: 'pratico',
    date: '2026-03-15T09:51:02.127Z',
    image: '/images/blog/inverno-ticino-nevicate-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'franchigia-minima-sanitario-ticino',
    category: 'novita',
    date: '2026-03-15T11:25:53.875Z',
    image: '/images/blog/franchigia-minima-sanitario-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'svizzera-recessione-cieslakiewicz',
    category: 'novita',
    date: '2026-03-15T12:41:17.157Z',
    image: '/images/blog/svizzera-recessione-cieslakiewicz.jpg',
    hasCalculator: true,
  },
  {
    id: 'valanghe-allerta-livello-4-ticino',
    category: 'novita',
    date: '2026-03-15T13:50:21.493Z',
    image: '/images/blog/valanghe-allerta-livello-4-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'nevicate-strade-bloccate-ticino',
    category: 'pratico',
    date: '2026-03-15T14:32:27.268Z',
    image: '/images/blog/nevicate-strade-bloccate-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'bilaterali-terza-fase-parlamento-ticino',
    category: 'novita',
    date: '2026-03-15T15:29:43.594Z',
    image: '/images/blog/bilaterali-terza-fase-parlamento-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'cane-morto-binarie-campo-calcio',
    category: 'novita',
    date: '2026-03-15T16:48:29.694Z',
    image: '/images/blog/cane-morto-binarie-campo-calcio.jpg',
    hasCalculator: true,
  },
  {
    id: 'swissminiatur-miniera-sessa-2026',
    category: 'novita',
    date: '2026-03-15T17:40:16.269Z',
    image: '/images/blog/swissminiatur-miniera-sessa-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'crescita-misera-libera-circolazione',
    category: 'pratico',
    date: '2026-03-15T18:59:29.744Z',
    image: '/images/blog/crescita-misera-libera-circolazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'treni-varese-milano-ceresio-express',
    category: 'pratico',
    date: '2026-03-15T19:50:07.288Z',
    image: '/images/blog/treni-varese-milano-ceresio-express.jpg',
    hasCalculator: true,
  },

  // Evergreen SEO articles — March 2026
  {
    id: 'guida-cambio-franco-euro-frontaliere',
    category: 'pratico',
    date: '2026-03-15T20:00:00.000Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'guida-pensione-frontaliere-avs-lpp',
    category: 'pensione',
    date: '2026-03-15T20:01:00.000Z',
    image: '/images/places/bellinzona.jpg',
    hasCalculator: true,
  },
  {
    id: 'vivere-svizzera-vs-italia-frontaliere',
    category: 'pratico',
    date: '2026-03-15T20:02:00.000Z',
    image: '/images/places/locarno.jpg',
    hasCalculator: true,
  },
  {
    id: 'dumping-salariale-diritti-lavoratore-ticino',
    category: 'fiscale',
    date: '2026-03-15T20:03:00.000Z',
    image: '/images/places/mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'malattia-frontaliere-guida-assicurazione',
    category: 'pratico',
    date: '2026-03-15T20:04:00.000Z',
    image: '/images/places/castelgrande.jpg',
    hasCalculator: true,
  },
  {
    id: 'strumenti-frontaliere-guida-comparatori',
    category: 'pratico',
    date: '2026-03-15T20:05:00.000Z',
    image: '/images/places/lugano-view.jpg',
    hasCalculator: true,
  },
  {
    id: 'caro-carburante-benzina-ticino',
    category: 'fiscale',
    date: '2026-03-15T20:50:49.464Z',
    image: '/images/blog/caro-carburante-benzina-ticino.jpg',

    hasCalculator: true,
  },
  {
    id: 'bilaterali-iii-cassis-ticino',
    category: 'pratico',
    date: '2026-03-16T06:20:08.711Z',
    image: '/images/blog/bilaterali-iii-cassis-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-redditi-2026',
    category: 'fiscale',
    date: '2026-03-16T08:07:36.787Z',
    image: '/images/blog/frontalieri-redditi-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'fermato-brogeda-cocaina',
    category: 'fiscale',
    date: '2026-03-16T10:02:17.162Z',
    image: '/images/blog/fermato-brogeda-cocaina.jpg',
    hasCalculator: true,
  },
  {
    id: 'dominicano-auto-svizzera-arresto',
    category: 'pratico',
    date: '2026-03-16T10:58:26.365Z',
    image: '/images/blog/dominicano-auto-svizzera-arresto.jpg',
    hasCalculator: true,
  },
  {
    id: 'salari-bassi-rischio-povert',
    category: 'pratico',
    date: '2026-03-16T12:06:50.997Z',
    image: '/images/blog/salari-bassi-rischio-povert.jpg',
    hasCalculator: true,
  },
  {
    id: 'ticino-svolta-per-apprendisti',
    category: 'novita',
    date: '2026-03-16T20:06:55.092Z',
    image: '/images/blog/ticino-svolta-per-apprendisti.jpg',
    hasCalculator: true,
  },
  {
    id: 'bellinzona-crescita-qualita-vita',
    category: 'novita',
    date: '2026-03-16T20:55:08.714Z',
    image: '/images/blog/bellinzona-crescita-qualita-vita.jpg',
    hasCalculator: true,
  },
  {
    id: 'crisi-spermatozoi-svizzera-ticino',
    category: 'pratico',
    date: '2026-03-16T21:56:27.390Z',
    image: '/images/blog/crisi-spermatozoi-svizzera-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'mercado-immobiliare-ticino',
    category: 'pratico',
    date: '2026-03-16T22:48:55.327Z',
    image: '/images/blog/mercado-immobiliare-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'droga-brogeda-sequestro-cocaina',
    category: 'novita',
    date: '2026-03-16T23:52:14.059Z',
    image: '/images/blog/droga-brogeda-sequestro-cocaina.jpg',
    hasCalculator: true,
  },
  {
    id: 'bellinzona-auscultazione-2026',
    category: 'novita',
    date: '2026-03-17T08:12:10.828Z',
    image: '/images/blog/bellinzona-auscultazione-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'lombardia-affitto-famiglie-varesine',
    category: 'pratico',
    date: '2026-03-17T11:07:59.097Z',
    image: '/images/blog/lombardia-affitto-famiglie-varesine.jpg',
    hasCalculator: true,
  },
  {
    id: 'malcantone-fai-di-primavera-2026',
    category: 'novita',
    date: '2026-03-17T12:08:54.968Z',
    image: '/images/blog/malcantone-fai-di-primavera-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sicurezza-privata-chiasso-nebiopoli',
    category: 'novita',
    date: '2026-03-17T15:30:59.954Z',
    image: '/images/blog/sicurezza-privata-chiasso-nebiopoli.jpg',
    hasCalculator: true,
  },
  {
    id: 'sfruttamento-corsieri-ticino-2026',
    category: 'pratico',
    date: '2026-03-17T17:29:41.230Z',
    image: '/images/blog/sfruttamento-corsieri-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavoro-economia-2026',
    category: 'novita',
    date: '2026-03-17T19:27:49.808Z',
    image: '/images/blog/lavoro-economia-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sequestro-cocaina-brogeda-2026',
    category: 'novita',
    date: '2026-03-17T21:08:34.195Z',
    image: '/images/blog/sequestro-cocaina-brogeda-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'infiltrazioni-criminali-ticino-grigioni',
    category: 'fiscale',
    date: '2026-03-17T22:02:23.349Z',
    image: '/images/blog/infiltrazioni-criminali-ticino-grigioni.jpg',
    hasCalculator: true,
  },
  {
    id: 'turismo-luganese-formazione',
    category: 'novita',
    date: '2026-03-17T23:01:33.852Z',
    image: '/images/blog/turismo-luganese-formazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'nevicata-record-bosco-gurin',
    category: 'pratico',
    date: '2026-03-18T00:01:25.681Z',
    image: '/images/blog/nevicata-record-bosco-gurin.jpg',
    hasCalculator: true,
  },
  {
    id: 'walter-bonatti-in-capo-al-mondo',
    category: 'novita',
    date: '2026-03-18T02:45:15.133Z',
    image: '/images/blog/walter-bonatti-in-capo-al-mondo.jpg',
    hasCalculator: true,
  },
  {
    id: 'sargans-teenage-robbery-catch',
    category: 'pratico',
    date: '2026-03-18T07:12:46.300Z',
    image: '/images/blog/sargans-teenage-robbery-catch.jpg',
    hasCalculator: true,
  },
  {
    id: 'separazione-carriere-giudici',
    category: 'pratico',
    date: '2026-03-18T09:02:13.937Z',
    image: '/images/blog/separazione-carriere-giudici.jpg',
    hasCalculator: true,
  },
  {
    id: 'com-aziende-lavoro-como',
    category: 'novita',
    date: '2026-03-18T10:06:52.910Z',
    image: '/images/blog/com-aziende-lavoro-como.jpg',
    hasCalculator: true,
  },
  {
    id: 'cabov-precipita-forte-vento',
    category: 'novita',
    date: '2026-03-18T15:12:29.976Z',
    image: '/images/blog/cabov-precipita-forte-vento.jpg',
    hasCalculator: true,
  },
  {
    id: 'agenzia-trasporto-nuovo',
    category: 'novita',
    date: '2026-03-18T17:22:46.308Z',
    image: '/images/blog/agenzia-trasporto-nuovo.jpg',
    hasCalculator: true,
  },
  {
    id: 'governo-tavolo-frontalieri-2026',
    category: 'novita',
    date: '2026-03-18T19:15:17.467Z',
    image: '/images/blog/governo-tavolo-frontalieri-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'gadda-incalza-governo-frontalieri',
    category: 'fiscale',
    date: '2026-03-18T20:58:59.476Z',
    image: '/images/blog/gadda-incalza-governo-frontalieri.jpg',
    hasCalculator: true,
  },
  {
    id: 'centovallina-riapertura-treni',
    category: 'novita',
    date: '2026-03-18T21:50:39.228Z',
    image: '/images/blog/centovallina-riapertura-treni.jpg',
    hasCalculator: true,
  },
  {
    id: 'truffe-chiamate-shock-ticino',
    category: 'novita',
    date: '2026-03-18T22:48:22.156Z',
    image: '/images/blog/truffe-chiamate-shock-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'spazi-verdi-in-citta-rilassamento',
    category: 'pratico',
    date: '2026-03-18T23:45:16.640Z',
    image: '/images/blog/spazi-verdi-in-citta-rilassamento.jpg',
    hasCalculator: true,
  },
  {
    id: 'camedo-buffet-eventi-ticino',
    category: 'novita',
    date: '2026-03-19T06:08:27.867Z',
    image: '/images/blog/camedo-buffet-eventi-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'berna-discute-approvvigionamento-economico-e-13esima-avs',
    category: 'novita',
    date: '2026-03-19T07:11:48.069Z',
    image: '/images/blog/berna-discute-approvvigionamento-economico-e-13esima-avs.jpg',
    hasCalculator: true,
  },
  {
    id: 'visita-ticinese-coira-criminalita-organizzata',
    category: 'novita',
    date: '2026-03-19T08:11:13.394Z',
    image: '/images/blog/visita-ticinese-coira-criminalita-organizzata.jpg',
    hasCalculator: true,
  },
  {
    id: 'annunci-lavoro-dumping-ticino-governo',
    category: 'novita',
    date: '2026-03-19T09:31:19.588Z',
    image: '/images/blog/annunci-lavoro-dumping-ticino-governo.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-cantieri-mendrisio',
    category: 'pratico',
    date: '2026-03-19T10:12:32.565Z',
    image: '/images/blog/controlli-cantieri-mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'catastrofi-ticino-prontezza-2026',
    category: 'novita',
    date: '2026-03-19T11:28:32.300Z',
    image: '/images/blog/catastrofi-ticino-prontezza-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'tredicesima-avs-soluzione-mista-stati',
    category: 'pensione',
    date: '2026-03-19T12:13:35.350Z',
    image: '/images/blog/tredicesima-avs-soluzione-mista-stati.jpg',
    hasCalculator: true,
  },
  {
    id: 'lo-statuto-s-non-deve-trasformarsi-in-permesso-b',
    category: 'pratico',
    date: '2026-03-19T13:18:43.623Z',
    image: '/images/blog/lo-statuto-s-non-deve-trasformarsi-in-permesso-b.jpg',
    hasCalculator: true,
  },
  {
    id: 'consiglio-stati-soluzione-mista-13esima-avs',
    category: 'pensione',
    date: '2026-03-19T14:35:12.413Z',
    image: '/images/blog/consiglio-stati-soluzione-mista-13esima-avs.jpg',
    hasCalculator: true,
  },
  {
    id: 'frode-cassa-compensazione-avs-ticino',
    category: 'pratico',
    date: '2026-03-19T15:23:24.887Z',
    image: '/images/blog/frode-cassa-compensazione-avs-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'sette-cantieri-mendrisio-kebab-case',
    category: 'pratico',
    date: '2026-03-19T16:37:51.960Z',
    image: '/images/blog/sette-cantieri-mendrisio-kebab-case.jpg',
    hasCalculator: true,
  },
  {
    id: 'deputazione-ticinese-italofoni-2024',
    category: 'fiscale',
    date: '2026-03-19T17:52:19.898Z',
    image: '/images/blog/deputazione-ticinese-italofoni-2024.jpg',
    hasCalculator: true,
  },
  {
    id: 'kebab-case-turismo-ticino',
    category: 'novita',
    date: '2026-03-19T19:06:05.860Z',
    image: '/images/blog/kebab-case-turismo-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'droga-al-confine-ticino-2025',
    category: 'novita',
    date: '2026-03-19T19:51:12.225Z',
    image: '/images/blog/droga-al-confine-ticino-2025.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-attraversamento-svizzera',
    category: 'fiscale',
    date: '2026-03-19T20:40:02.444Z',
    image: '/images/blog/tassa-attraversamento-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'incidente-stradale-laghi',
    category: 'pratico',
    date: '2026-03-19T21:11:01.676Z',
    image: '/images/blog/incidente-stradale-laghi.jpg',
    hasCalculator: true,
  },
  {
    id: 'vivere-piu-lungo-ticino',
    category: 'pratico',
    date: '2026-03-19T21:46:55.330Z',
    image: '/images/blog/vivere-piu-lungo-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'governo-getta-spugna-kebab-case',
    category: 'novita',
    date: '2026-03-19T22:03:04.990Z',
    image: '/images/blog/governo-getta-spugna-kebab-case.jpg',
    hasCalculator: true,
  },
  {
    id: 'kebab-case-borse-freddo-2024',
    category: 'fiscale',
    date: '2026-03-19T22:40:42.059Z',
    image: '/images/blog/kebab-case-borse-freddo-2024.jpg',
    hasCalculator: true,
  },
  {
    id: 'giustizia-in-bilico-2026',
    category: 'novita',
    date: '2026-03-19T23:03:50.305Z',
    image: '/images/blog/giustizia-in-bilico-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ampliamento-parco-eolico-san-gottardo-digital-2026',
    category: 'novita',
    date: '2026-03-19T23:41:40.330Z',
    image: '/images/blog/ampliamento-parco-eolico-san-gottardo-digital-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'soggiorni-irregolari-2026-mendrisio',
    category: 'pratico',
    date: '2026-03-20T00:03:31.827Z',
    image: '/images/blog/soggiorni-irregolari-2026-mendrisio.jpg',
    hasCalculator: true,
  },
  {
    id: 'eolico-gottardo-ampliamento-2026',
    category: 'novita',
    date: '2026-03-20T02:46:46.318Z',
    image: '/images/blog/eolico-gottardo-ampliamento-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'contrabbando-ai-confine-aumentano-droga-e-sigarette',
    category: 'pratico',
    date: '2026-03-20T03:22:57.912Z',
    image: '/images/blog/contrabbando-ai-confine-aumentano-droga-e-sigarette.jpg',
    hasCalculator: true,
  },
  {
    id: 'kebab-case-3-5-words-max-40-chars',
    category: 'novita',
    date: '2026-03-20T04:58:04.475Z',
    image: '/images/blog/kebab-case-3-5-words-max-40-chars.jpg',
    hasCalculator: true,
  },
  {
    id: 'salute-prevenzione-burocrazia-svizzera',
    category: 'novita',
    date: '2026-03-20T06:02:30.053Z',
    image: '/images/blog/salute-prevenzione-burocrazia-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'telefonate-choc-truffa-anziani-ticino',
    category: 'pratico',
    date: '2026-03-20T06:36:45.725Z',
    image: '/images/blog/telefonate-choc-truffa-anziani-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'ubs-fusione-credit-suisse-ticino',
    category: 'novita',
    date: '2026-03-20T07:09:05.333Z',
    image: '/images/blog/ubs-fusione-credit-suisse-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'salari-minimi-ccl-ticino-2026',
    category: 'fiscale',
    date: '2026-03-20T07:34:50.409Z',
    image: '/images/blog/salari-minimi-ccl-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'strutture-dedicate-migranti-ticino',
    category: 'pratico',
    date: '2026-03-20T07:56:20.962Z',
    image: '/images/blog/strutture-dedicate-migranti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'contratti-collettivi-salari-ticino',
    category: 'novita',
    date: '2026-03-20T08:08:37.700Z',
    image: '/images/blog/contratti-collettivi-salari-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tutela-sovranita-dati-sanitari',
    category: 'novita',
    date: '2026-03-20T08:54:54.483Z',
    image: '/images/blog/tutela-sovranita-dati-sanitari.jpg',
    hasCalculator: true,
  },
  {
    id: 'nomine-annullate-sims-tram',
    category: 'novita',
    date: '2026-03-20T09:13:04.394Z',
    image: '/images/blog/nomine-annullate-sims-tram.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-automobilisti-svizzera',
    category: 'fiscale',
    date: '2026-03-20T09:55:23.904Z',
    image: '/images/blog/tassa-automobilisti-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavoro-richiedenti-asilo-ucraini-ticino',
    category: 'novita',
    date: '2026-03-20T10:11:17.021Z',
    image: '/images/blog/lavoro-richiedenti-asilo-ucraini-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'riforma-scolastica-ticino-difficolta',
    category: 'novita',
    date: '2026-03-20T10:52:35.225Z',
    image: '/images/blog/riforma-scolastica-ticino-difficolta.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-transito-parlamento-ticino',
    category: 'fiscale',
    date: '2026-03-20T11:11:29.556Z',
    image: '/images/blog/tassa-transito-parlamento-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'inclusione-migranti-ticino',
    category: 'novita',
    date: '2026-03-20T11:42:04.126Z',
    image: '/images/blog/inclusione-migranti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-svizzero-impatti-ticino',
    category: 'fiscale',
    date: '2026-03-20T13:19:14.359Z',
    image: '/images/blog/franco-svizzero-impatti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-transito-automobilisti-ticino',
    category: 'fiscale',
    date: '2026-03-20T13:49:13.780Z',
    image: '/images/blog/tassa-transito-automobilisti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'nubifragio-coira-mesolcina-ristoro',
    category: 'novita',
    date: '2026-03-20T14:55:43.713Z',
    image: '/images/blog/nubifragio-coira-mesolcina-ristoro.jpg',
    hasCalculator: true,
  },
  {
    id: 'lotta-violenza-di-genere-ticino',
    category: 'novita',
    date: '2026-03-20T15:29:12.946Z',
    image: '/images/blog/lotta-violenza-di-genere-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-transito-svizzera-2023',
    category: 'novita',
    date: '2026-03-20T15:59:52.990Z',
    image: '/images/blog/tassa-transito-svizzera-2023.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-cantieri-mendrisiotto',
    category: 'fiscale',
    date: '2026-03-20T16:14:46.964Z',
    image: '/images/blog/controlli-cantieri-mendrisiotto.jpg',
    hasCalculator: true,
  },
  {
    id: 'acinque-lancia-piano-genitorialita',
    category: 'novita',
    date: '2026-03-20T17:04:05.420Z',
    image: '/images/blog/acinque-lancia-piano-genitorialita.jpg',
    hasCalculator: true,
  },
  {
    id: 'danni-riparati-centovallina',
    category: 'novita',
    date: '2026-03-20T17:31:42.961Z',
    image: '/images/blog/danni-riparati-centovallina.jpg',
    hasCalculator: true,
  },
  {
    id: 'porrentruy-piscina-comunale-divieto',
    category: 'novita',
    date: '2026-03-20T17:50:17.309Z',
    image: '/images/blog/porrentruy-piscina-comunale-divieto.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanita-fontana-fedriga',
    category: 'novita',
    date: '2026-03-20T18:15:00.043Z',
    image: '/images/blog/sanita-fontana-fedriga.jpg',
    hasCalculator: true,
  },
  {
    id: 'ampliamento-parco-eolico-san-gottardo',
    category: 'novita',
    date: '2026-03-20T19:20:07.949Z',
    image: '/images/blog/ampliamento-parco-eolico-san-gottardo.jpg',
    hasCalculator: true,
  },
  {
    id: 'frontalieri-prezzi-carburanti-italia-svizzera',
    category: 'fiscale',
    date: '2026-03-20T20:04:48.694Z',
    image: '/images/blog/frontalieri-prezzi-carburanti-italia-svizzera.jpg',
    hasCalculator: true,
  },
  {
    id: 'cure-a-domicilio-tassa-ticino',
    category: 'novita',
    date: '2026-03-20T21:04:34.954Z',
    image: '/images/blog/cure-a-domicilio-tassa-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'kebab-case-ticino-nubifragio-grigioni',
    category: 'pratico',
    date: '2026-03-20T21:58:42.386Z',
    image: '/images/blog/kebab-case-ticino-nubifragio-grigioni.jpg',
    hasCalculator: true,
  },
  {
    id: 'kebab-case-rossi-bruxelles-ticino',
    category: 'fiscale',
    date: '2026-03-20T22:58:17.294Z',
    image: '/images/blog/kebab-case-rossi-bruxelles-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'bossi-voleva-bene-al-ticino',
    category: 'novita',
    date: '2026-03-21T00:11:21.690Z',
    image: '/images/blog/bossi-voleva-bene-al-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'chiamate-shock-arresti-ticino',
    category: 'pratico',
    date: '2026-03-21T02:41:32.827Z',
    image: '/images/blog/chiamate-shock-arresti-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'rinnovo-concessioni-snl-2026',
    category: 'novita',
    date: '2026-03-21T03:13:32.605Z',
    image: '/images/blog/rinnovo-concessioni-snl-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'globalisti-fuga-medio-oriente-ticino',
    category: 'novita',
    date: '2026-03-21T04:49:46.161Z',
    image: '/images/blog/globalisti-fuga-medio-oriente-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'guasto-tra-parabiago-e-rho',
    category: 'pratico',
    date: '2026-03-21T05:52:27.782Z',
    image: '/images/blog/guasto-tra-parabiago-e-rho.jpg',
    hasCalculator: true,
  },
  {
    id: 'tassa-transito-ticino-pedemontana',
    category: 'fiscale',
    date: '2026-03-21T06:12:12.156Z',
    image: '/images/blog/tassa-transito-ticino-pedemontana.jpg',
    hasCalculator: true,
  },
  {
    id: 'franco-svizzero-a-valori-record-2026',
    category: 'fiscale',
    date: '2026-03-21T07:02:06.128Z',
    image: '/images/blog/franco-svizzero-a-valori-record-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi',
    category: 'fiscale',
    date: '2026-03-21T07:27:46.207Z',
    image: '/images/blog/taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi.jpg',
    hasCalculator: true,
  },
  {
    id: 'farmaci-competitiva-europa',
    category: 'pratico',
    date: '2026-03-21T07:40:32.381Z',
    image: '/images/blog/farmaci-competitiva-europa.jpg',
    hasCalculator: true,
  },
  {
    id: 'controlli-cantieri-mendrisiotto-2026',
    category: 'novita',
    date: '2026-03-21T08:02:26.303Z',
    image: '/images/blog/controlli-cantieri-mendrisiotto-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'byd-expansion-ticino-2026',
    category: 'novita',
    date: '2026-03-21T08:47:56.314Z',
    image: '/images/blog/byd-expansion-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'controllo-affitti-nazionale-ticino',
    category: 'novita',
    date: '2026-03-21T09:07:48.153Z',
    image: '/images/blog/controllo-affitti-nazionale-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'cioccolato-meno-ma-pagato-di-piu',
    category: 'novita',
    date: '2026-03-21T09:45:15.892Z',
    image: '/images/blog/cioccolato-meno-ma-pagato-di-piu.jpg',
    hasCalculator: true,
  },
  {
    id: 'diesel-aumento-prezzi-svizzera-2026',
    category: 'novita',
    date: '2026-03-21T10:03:22.205Z',
    image: '/images/blog/diesel-aumento-prezzi-svizzera-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanita-manifesto-varese-2026',
    category: 'novita',
    date: '2026-03-21T10:40:36.290Z',
    image: '/images/blog/sanita-manifesto-varese-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'iva-bassa-svizzera-immagine-ingannevole',
    category: 'fiscale',
    date: '2026-03-21T11:01:59.120Z',
    image: '/images/blog/iva-bassa-svizzera-immagine-ingannevole.jpg',
    hasCalculator: true,
  },
  {
    id: 'divieto-smartphone-scuola-ticino',
    category: 'novita',
    date: '2026-03-21T11:44:36.863Z',
    image: '/images/blog/divieto-smartphone-scuola-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'la-navigazione-rafforza-offerta-2026',
    category: 'novita',
    date: '2026-03-21T13:09:21.150Z',
    image: '/images/blog/la-navigazione-rafforza-offerta-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'sanita-integrativa-lombardia-ticino',
    category: 'novita',
    date: '2026-03-21T13:38:10.050Z',
    image: '/images/blog/sanita-integrativa-lombardia-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'fatture-mediche-gonfiate-ticino',
    category: 'pratico',
    date: '2026-03-21T13:54:29.953Z',
    image: '/images/blog/fatture-mediche-gonfiate-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'divieto-cellulari-scuola-ticino',
    category: 'novita',
    date: '2026-03-21T14:48:58.860Z',
    image: '/images/blog/divieto-cellulari-scuola-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'violenza-donne-consiglio-europa-ticino',
    category: 'novita',
    date: '2026-03-21T15:10:47.926Z',
    image: '/images/blog/violenza-donne-consiglio-europa-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'trojani-capo-servizi-esercito-ticino',
    category: 'novita',
    date: '2026-03-21T15:43:34.878Z',
    image: '/images/blog/trojani-capo-servizi-esercito-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'funivia-monteviasco-orari-corsi',
    category: 'pratico',
    date: '2026-03-21T16:13:56.502Z',
    image: '/images/blog/funivia-monteviasco-orari-corsi.jpg',
    hasCalculator: true,
  },
  {
    id: 'ricchi-fuga-medio-oriente-ticino',
    category: 'novita',
    date: '2026-03-21T16:41:51.578Z',
    image: '/images/blog/ricchi-fuga-medio-oriente-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'divieto-cellulari-scuola-ticino-2024',
    category: 'novita',
    date: '2026-03-21T17:01:21.915Z',
    image: '/images/blog/divieto-cellulari-scuola-ticino-2024.jpg',
    hasCalculator: true,
  },
  {
    id: 'sindacati-contro-snl-ticino-2026',
    category: 'novita',
    date: '2026-03-21T17:36:16.270Z',
    image: '/images/blog/sindacati-contro-snl-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'aumento-iva-costo-ticino-2026',
    category: 'fiscale',
    date: '2026-03-21T17:56:57.517Z',
    image: '/images/blog/aumento-iva-costo-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'acquarossa-nuovo-polo-filovia-2026',
    category: 'novita',
    date: '2026-03-21T18:50:30.483Z',
    image: '/images/blog/acquarossa-nuovo-polo-filovia-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'ritardo-sconto-carburante-ticino-2026',
    category: 'novita',
    date: '2026-03-21T19:07:13.999Z',
    image: '/images/blog/ritardo-sconto-carburante-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'lavori-a8-castellanza-notturni-2026',
    category: 'pratico',
    date: '2026-03-21T19:38:54.409Z',
    image: '/images/blog/lavori-a8-castellanza-notturni-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'quanto-costa-la-discriminazione',
    category: 'pratico',
    date: '2026-03-21T19:55:19.399Z',
    image: '/images/blog/quanto-costa-la-discriminazione.jpg',
    hasCalculator: true,
  },
  {
    id: 'divieto-smartphone-scuola-ticino-2026',
    category: 'pratico',
    date: '2026-03-21T20:42:50.803Z',
    image: '/images/blog/divieto-smartphone-scuola-ticino-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'carenza-farmaci-ticino',
    category: 'pratico',
    date: '2026-03-21T21:00:53.977Z',
    image: '/images/blog/carenza-farmaci-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'lago-maggiore-accesso-tutto-l-anno',
    category: 'pratico',
    date: '2026-03-21T21:37:14.417Z',
    image: '/images/blog/lago-maggiore-accesso-tutto-l-anno.jpg',
    hasCalculator: true,
  },
  {
    id: 'cure-domicilio-ticino',
    category: 'pratico',
    date: '2026-03-21T21:58:16.481Z',
    image: '/images/blog/cure-domicilio-ticino.jpg',
    hasCalculator: true,
  },
  {
    id: 'spiagge-libere-sul-lago-maggiore',
    category: 'pratico',
    date: '2026-03-21T22:39:14.445Z',
    image: '/images/blog/spiagge-libere-sul-lago-maggiore.jpg',
    hasCalculator: true,
  },
  {
    id: 'snl-stagione-green-concessione',
    category: 'novita',
    date: '2026-03-21T23:01:25.287Z',
    image: '/images/blog/snl-stagione-green-concessione.jpg',
    hasCalculator: true,
  },
  {
    id: 'smartphone-a-scuola-e-nuove-direttive',
    category: 'novita',
    date: '2026-03-21T23:36:39.323Z',
    image: '/images/blog/smartphone-a-scuola-e-nuove-direttive.jpg',
    hasCalculator: true,
  },
  {
    id: 'infortuni-sul-lavoro-protesi-hi-tech',
    category: 'pratico',
    date: '2026-03-21T23:59:46.152Z',
    image: '/images/blog/infortuni-sul-lavoro-protesi-hi-tech.jpg',
    hasCalculator: true,
  },
  {
    id: 'bellinzona-scomparsa-ricerche-ticino-piemonte',
    category: 'pratico',
    date: '2026-03-22T03:08:23.413Z',
    image: '/images/blog/bellinzona-scomparsa-ricerche-ticino-piemonte.jpg',
    hasCalculator: true,
  },
  {
    id: 'cure-domicilio-ticino-politica',
    category: 'novita',
    date: '2026-03-22T03:39:29.140Z',
    image: '/images/blog/cure-domicilio-ticino-politica.jpg',
    hasCalculator: true,
  },
  {
    id: 'navigazione-lago-lugano-2026',
    category: 'novita',
    date: '2026-03-22T05:02:39.305Z',
    image: '/images/blog/navigazione-lago-lugano-2026.jpg',
    hasCalculator: true,
  },
  {
    id: 'parco-vedeggio-comuni-firman',
    category: 'novita',
    date: '2026-03-22T06:01:07.566Z',
    image: '/images/blog/parco-vedeggio-comuni-firman.jpg',
    hasCalculator: true,
  },
  {
    id: 'stop-export-materiale-bellico',
    category: 'novita',
    date: '2026-03-22T06:32:27.277Z',
    image: '/images/blog/stop-export-materiale-bellico.jpg',
    hasCalculator: true,
  },
];

const CATEGORIES = ['all', 'fiscale', 'pratico', 'novita', 'pensione'] as const;

interface BlogArticlesProps {
  /** Currently selected article (from URL) — null means list view */
  selectedArticle?: BlogArticleId | null;
  /** Navigate to an individual article (updates URL) */
  onSelectArticle?: (articleId: BlogArticleId | null) => void;
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
const NAV_ACTION_CTA_MAP: Record<NavAction, { icon: LucideIcon; i18nPrefix: string; color: CtaConfig['color'] }> = {
  calculator:       { icon: Calculator,   i18nPrefix: 'blog.cta.calculator',    color: 'indigo'  },
  exchange:         { icon: TrendingUp,   i18nPrefix: 'blog.cta.exchange',       color: 'blue'    },
  health:           { icon: Heart,        i18nPrefix: 'blog.cta.health',         color: 'emerald' },
  'cost-of-living': { icon: Coins,        i18nPrefix: 'blog.cta.costOfLiving',   color: 'amber'   },
  pension:          { icon: BarChart3,    i18nPrefix: 'blog.cta.pension',        color: 'amber'   },
  pillar3:          { icon: Scale,        i18nPrefix: 'blog.cta.pillar3',        color: 'violet'  },
  payslip:          { icon: Receipt,      i18nPrefix: 'blog.cta.payslip',        color: 'blue'    },
  'tax-return':     { icon: FileText,     i18nPrefix: 'blog.cta.taxReturn',      color: 'violet'  },
  residency:        { icon: Home,         i18nPrefix: 'blog.cta.residency',      color: 'emerald' },
  ristorni:         { icon: Receipt,      i18nPrefix: 'blog.cta.ristorni',       color: 'rose'    },
  unemployment:     { icon: ShieldCheck,  i18nPrefix: 'blog.cta.unemployment',   color: 'rose'    },
  jobs:             { icon: Briefcase,    i18nPrefix: 'blog.cta.jobs',            color: 'blue'    },
  companies:        { icon: Building2,    i18nPrefix: 'blog.cta.companies',       color: 'emerald' },
  banks:            { icon: Building2,    i18nPrefix: 'blog.cta.banks',           color: 'blue'    },
  'first-day':      { icon: BookOpen,     i18nPrefix: 'blog.cta.firstDay',       color: 'emerald' },
  permits:          { icon: ShieldCheck,  i18nPrefix: 'blog.cta.permits',        color: 'indigo'  },
  border:           { icon: MapPin,       i18nPrefix: 'blog.cta.border',         color: 'emerald' },
  calendar:         { icon: Calendar,     i18nPrefix: 'blog.cta.calendar',       color: 'violet'  },
  whatif:           { icon: Calculator,   i18nPrefix: 'blog.cta.whatif',          color: 'amber'   },
  shopping:         { icon: ShoppingBag,  i18nPrefix: 'blog.cta.shopping',       color: 'amber'   },
  transport:        { icon: Train,        i18nPrefix: 'blog.cta.transport',      color: 'blue'    },
  'salary-compare': { icon: BarChart3,    i18nPrefix: 'blog.cta.salaryCompare',  color: 'indigo'  },
  'traffic-history':{ icon: TrendingUp,   i18nPrefix: 'blog.cta.trafficHistory', color: 'rose'    },
  'parental-leave': { icon: Baby,         i18nPrefix: 'blog.cta.parentalLeave', color: 'rose'    },
  'job-board':      { icon: Search,       i18nPrefix: 'blog.cta.jobBoard',      color: 'emerald' },
};

const CTA_COLORS = {
  indigo: 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800',
  emerald: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800',
  amber: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
  blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
  violet: 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800',
  rose: 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800',
};

const CTA_ICON_COLORS = {
  indigo: 'text-indigo-600 dark:text-indigo-400',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  rose: 'text-rose-600 dark:text-rose-400',
};

const CTA_TEXT_COLORS = {
  indigo: { title: 'text-indigo-700 dark:text-indigo-300', desc: 'text-indigo-600 dark:text-indigo-400' },
  emerald: { title: 'text-emerald-700 dark:text-emerald-300', desc: 'text-emerald-700 dark:text-emerald-400' },
  amber: { title: 'text-amber-700 dark:text-amber-300', desc: 'text-amber-600 dark:text-amber-400' },
  blue: { title: 'text-blue-700 dark:text-blue-300', desc: 'text-blue-600 dark:text-blue-400' },
  violet: { title: 'text-violet-700 dark:text-violet-300', desc: 'text-violet-600 dark:text-violet-400' },
  rose: { title: 'text-rose-700 dark:text-rose-300', desc: 'text-rose-600 dark:text-rose-400' },
};

const CTA_BTN_COLORS = {
  indigo: 'bg-indigo-600 hover:bg-indigo-700',
  emerald: 'bg-emerald-700 hover:bg-emerald-700',
  amber: 'bg-amber-600 hover:bg-amber-700',
  blue: 'bg-blue-600 hover:bg-blue-700',
  violet: 'bg-violet-600 hover:bg-violet-700',
  rose: 'bg-rose-600 hover:bg-rose-700',
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

export default function BlogArticles({
  selectedArticle = null,
  onSelectArticle,
}: BlogArticlesProps) {
  const nav = useNavigation();
  const { t } = useTranslation();
  const [locale] = useLocale();
  const [blogReady, setBlogReady] = useState(false);
  const [bodyReady, setBodyReady] = useState(false);
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
    if (w < 640) return 2;
    if (w < 1024) return 4;
    return 6;
  });
  const [imageFallbackMap, setImageFallbackMap] = useState<Record<string, true>>({});

  // Device breakpoints for conditional ad rendering (prevents CSS-hidden width=0 bug)
  const isMobile = useMediaQuery('(max-width: 639px)');      // sm breakpoint
  const isDesktopXl = useMediaQuery('(min-width: 1280px)');   // xl breakpoint

  // Lazy-load blog META translations (titles, excerpts) on mount
  useEffect(() => {
    loadBlogMeta().then(() => setBlogReady(true)).catch(() => {});
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
    return getRelatedJobsForArticle(selectedArticle, crossLinkJobs, locale);
  }, [selectedArticle, crossLinkJobs, locale]);

  // Fetch trending articles from Firestore (cached 1h in localStorage)
  const [trendingArticles, setTrendingArticles] = useState<TrendingEntry[]>([]);
  useEffect(() => {
    if (!selectedArticle) return;
    const validIds = new Set(ARTICLES.map(a => a.id));
    fetchTrendingArticles(validIds).then(setTrendingArticles).catch(() => {});
  }, [selectedArticle]);

  const handleResponsiveImageError = useCallback((imagePath: string) => {
    setImageFallbackMap(prev => (prev[imagePath] ? prev : { ...prev, [imagePath]: true }));
  }, []);

  // Track viewport for mobile-first performance tuning on hub list.
  useEffect(() => {
    const updateViewport = () => {
      const w = window.innerWidth;
      // Keep initial above-the-fold payload tiny on mobile.
      if (w < 640) setGridRevealCount(2);
      else if (w < 1024) setGridRevealCount(4);
      else setGridRevealCount(6);
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const filteredArticles = useMemo(() => {
    const filtered = selectedCategory === 'all'
      ? [...ARTICLES]
      : ARTICLES.filter(a => a.category === selectedCategory);
    return filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [selectedCategory]);

  const totalPages = Math.max(1, Math.ceil(filteredArticles.length / ARTICLES_PER_PAGE));
  const pageArticles = filteredArticles.slice(
    (currentPage - 1) * ARTICLES_PER_PAGE,
    currentPage * ARTICLES_PER_PAGE,
  );

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
    const body = [
      t(`blog.article.${articleId}.body1`),
      t(`blog.article.${articleId}.body2`),
      t(`blog.article.${articleId}.body3`),
    ].join(' ');
    const contextText = `${articleId} ${title} ${excerpt} ${body}`;

    const cluster: SeoCluster =
      SEO_CLUSTER_PATTERNS.taxes20km.test(contextText) ? 'taxes20km'
      : SEO_CLUSTER_PATTERNS.pension.test(contextText) ? 'pension'
      : SEO_CLUSTER_PATTERNS.exchange.test(contextText) ? 'exchange'
      : 'generic';

    // Count keyword matches per NavAction
    const counts: Partial<Record<NavAction, number>> = {};
    for (const { pattern, action } of KEYWORD_LINKS) {
      const matches = body.match(new RegExp(pattern, 'gi'));
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
  };

  // Reset progressive reveal when user changes page/category.
  useEffect(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 375;
    if (w < 640) setGridRevealCount(2);
    else if (w < 1024) setGridRevealCount(4);
    else setGridRevealCount(6);
  }, [currentPage, selectedCategory]);

  /** Returns imageAlt translation if available, falls back to article title */
  const getImageAlt = (id: string) => {
    const altKey = `blog.article.${id}.imageAlt`;
    const alt = t(altKey);
    return alt !== altKey ? alt : t(`blog.article.${id}.title`);
  };

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'fiscale': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300';
      case 'pratico': return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300';
      case 'novita': return 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300';
      case 'pensione': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300';
      default: return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
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
    return `https://www.frontaliereticino.ch${buildPath({ activeTab: 'blog', blogArticle: articleId })}`;
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

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  // ── Loading blog translations ──────────────────────
  if (!blogReady) {
    return (
      <div className="min-h-[80vh] space-y-6 p-4">
        {/* Skeleton hero card */}
        <div className="rounded-2xl overflow-hidden bg-slate-200 dark:bg-slate-700 animate-pulse h-64 sm:h-80" />
        {/* Skeleton article grid — matches real layout: 6 cards with image h-40 + content ~120px */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="rounded-xl bg-slate-200 dark:bg-slate-700 animate-pulse h-[280px]" />
          ))}
        </div>
      </div>
    );
  }

  // ── Affiliate side-rail helpers ──────────────────────

  const CATEGORY_TO_CONTEXTS: Record<Article['category'], ComparatorContext[]> = {
    fiscale:  ['exchange', 'banks', 'simulator'],
    pratico:  ['transport', 'mobile', 'banks'],
    novita:   ['exchange', 'banks', 'jobs'],
    pensione: ['pension', 'banks', 'exchange'],
  };

  /** Get top partners relevant to an article category */
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

  // ── Single Article View ──────────────────────────────
  if (selectedArticle) {
    const article = ARTICLES.find(a => a.id === selectedArticle);
    if (!article) return null;

    // Wait for article body translations to load
    if (!bodyReady) {
      return (
        <div className="max-w-3xl xl:max-w-6xl mx-auto min-h-[80vh] p-4 space-y-4">
          <div className="rounded-2xl bg-slate-200 dark:bg-slate-700 animate-pulse h-48 sm:h-64 md:h-80" />
          <div className="space-y-3">
            <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4" />
            <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-full" />
            <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-5/6" />
            <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-2/3" />
          </div>
        </div>
      );
    }

    const articleCTAs = getArticleCTAs(selectedArticle);

    const sidePartners = getPartnersForCategory(article.category, 4);
    const inlinePartner = sidePartners[0] ?? null;
    const creatorContextText = `${article.category} ${t(`blog.article.${article.id}.title`)} ${t(`blog.article.${article.id}.excerpt`)}`;
    const articleBody1 = t(`blog.article.${article.id}.body1`);
    const articleBody2 = t(`blog.article.${article.id}.body2`);
    const articleBody3 = t(`blog.article.${article.id}.body3`);
    const bodySegments = [articleBody1, articleBody2, articleBody3];
    const missingBody = bodySegments.some((b) => !b || b.startsWith('blog.article.'));
    const combinedBody = bodySegments.join(' ');
    const bodyWordCount = combinedBody.split(/\s+/).filter(Boolean).length;
    const bodyCharCount = combinedBody.trim().length;
    const adEligible = bodyReady && !missingBody && bodyWordCount >= 220 && bodyCharCount >= 1400;

    /** Compact vertical card for desktop side rails */
    const SideRailCard = ({ partner, idx }: { partner: AffiliatePartner; idx: number }) => {
      const handleAffClick = () => {
        Analytics.trackExternalLink(partner.url, `affiliate_${partner.id}`);
        Analytics.trackSelectContent('affiliate_click', `${partner.id}_blog_${article.category}`);
      };
      return (
        <a
          href={buildAffiliateUrl(partner, `blog_${article.category}`)}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={handleAffClick}
          className="group block p-3 bg-white/70 dark:bg-slate-800/70 rounded-xl border border-slate-200/60 dark:border-slate-700/60 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm transition-all text-center"
        >
          <span className="text-xl block mb-1">{partner.emoji}</span>
          <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 block leading-tight">{partner.name}</span>
          {partner.badgeKey && (
            <span className={`mt-1 inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gradient-to-r ${partner.color} text-white`}>
              {t(partner.badgeKey)}
            </span>
          )}
          <p className="text-[10px] text-slate-500 dark:text-slate-500 mt-1 leading-snug">{t(partner.taglineKey)}</p>
          <span className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 group-hover:underline">
            {t('affiliate.cta')} <ExternalLink size={9} />
          </span>
        </a>
      );
    };

    /** Horizontal card for mobile inline between body sections */
    const InlineRecommendation = ({ partner }: { partner: AffiliatePartner }) => {
      const handleAffClick = () => {
        Analytics.trackExternalLink(partner.url, `affiliate_${partner.id}`);
        Analytics.trackSelectContent('affiliate_click', `${partner.id}_blog_inline`);
      };
      return (
        <div className="xl:hidden my-5">
          <a
            href={buildAffiliateUrl(partner, `blog_inline`)}
            target="_blank"
            rel="noopener noreferrer sponsored"
            onClick={handleAffClick}
            className="group flex items-start gap-3 p-4 bg-slate-50/80 dark:bg-slate-900/40 rounded-xl border border-slate-200/50 dark:border-slate-700/50 hover:border-slate-300 dark:hover:border-slate-600 transition-all"
          >
            <span className="text-2xl shrink-0 mt-0.5">{partner.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">{partner.name}</span>
                {partner.badgeKey && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gradient-to-r ${partner.color} text-white`}>
                    {t(partner.badgeKey)}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-500 leading-relaxed">{t(partner.descriptionKey)}</p>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-600 dark:group-hover:text-slate-300 shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
          <p className="text-[10px] text-slate-500 dark:text-slate-600 mt-1 text-center">{t('affiliate.disclosure')}</p>
        </div>
      );
    };

    return (
      <div className="max-w-3xl xl:max-w-6xl mx-auto">
        {/* Back button — prominent */}
        <button
          onClick={handleBackToList}
          className="mb-6 inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all shadow-sm"
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
              <p className="text-[10px] font-medium text-slate-500 dark:text-slate-500 uppercase tracking-wider">
                {t('affiliate.sectionTitle')}
              </p>
              {sidePartners.slice(0, 2).map((p, i) => <SideRailCard key={p.id} partner={p} idx={i} />)}

              <Suspense fallback={null}>
                <CreatorProducts contextText={creatorContextText} className="mt-2" maxCards={2} />
              </Suspense>
            </div>
          </aside>

        <article className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-lg">
          {/* Hero image */}
          <div className="relative h-48 sm:h-64 md:h-80 overflow-hidden">
            {(() => {
              const responsive = imageFallbackMap[article.image] ? null : getResponsiveImageSet(article.image);
              return (
                <picture>
                  {responsive && <source type="image/avif" srcSet={responsive.avif} />}
                  {responsive && <source type="image/webp" srcSet={responsive.webp} />}
                  <img
                    src={article.image}
                    srcSet={responsive?.jpgSet}
                    sizes="(max-width: 768px) 100vw, 800px"
                    alt={getImageAlt(article.id)}
                    width={800}
                    height={400}
                    className="w-full h-full object-cover"
                    loading="eager"
                    fetchPriority="high"
                    onError={() => handleResponsiveImageError(article.image)}
                  />
                </picture>
              );
            })()}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
            <div className="absolute bottom-4 left-4 right-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-3 py-1 rounded-full text-xs font-bold ${getCategoryColor(article.category)}`}>
                  {t(`blog.category.${article.category}`)}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  article.category === 'novita'
                    ? 'bg-orange-500/80 text-white'
                    : 'bg-white/20 text-white backdrop-blur-sm'
                }`}>
                  {article.category === 'novita'
                    ? t('blog.contentType.news')
                    : t('blog.contentType.guide')}
                </span>
              </div>
              <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-white leading-tight">
                {t(`blog.article.${article.id}.title`)}
              </h1>
            </div>
          </div>

          {/* Meta bar */}
          <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 py-3 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-500">
            <span className="flex items-center gap-1 font-medium text-indigo-700 dark:text-indigo-400">
              <PenLine size={14} />
              {t('blog.byline')}
            </span>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <span className="flex items-center gap-1">
              <Calendar size={14} />
              {formatDate(article.date)}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={14} />
              {estimateReadingMinutes(article.id, t)} min
            </span>
            <div className="ml-auto flex items-center gap-1.5 flex-wrap">
              {/* Copy link */}
              <button
                onClick={() => handleCopyLink(article.id)}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium transition-all"
                aria-label={t('blog.copyLink')}
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                {copied ? t('blog.copied') : t('blog.copyLink')}
              </button>
              {/* WhatsApp */}
              <button
                onClick={() => handleWhatsAppShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[#25D366]/10 hover:bg-[#25D366]/20 text-[#25D366] transition-all"
                aria-label={t('blog.shareWhatsApp')}
                title={t('blog.shareWhatsApp')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              </button>
              {/* Twitter/X */}
              <button
                onClick={() => handleTwitterShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-all"
                aria-label={t('blog.shareTwitter')}
                title={t('blog.shareTwitter')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </button>
              {/* Facebook */}
              <button
                onClick={() => handleFacebookShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[#1877F2]/10 hover:bg-[#1877F2]/20 text-[#1877F2] transition-all"
                aria-label={t('blog.shareFacebook')}
                title={t('blog.shareFacebook')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
              </button>
              {/* Telegram */}
              <button
                onClick={() => handleTelegramShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[#0088cc]/10 hover:bg-[#0088cc]/20 text-[#0088cc] transition-all"
                aria-label={t('blog.shareTelegram')}
                title={t('blog.shareTelegram')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              </button>
              {/* LinkedIn */}
              <button
                onClick={() => handleLinkedInShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[#0A66C2]/10 hover:bg-[#0A66C2]/20 text-[#0A66C2] transition-all"
                aria-label={t('blog.shareLinkedIn')}
                title={t('blog.shareLinkedIn')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
              </button>
              {/* Email */}
              <button
                onClick={() => handleEmailShare(article.id)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-all"
                aria-label={t('blog.shareEmail')}
                title={t('blog.shareEmail')}
              >
                <Mail size={14} />
              </button>
              {/* Native share (mobile) */}
              {typeof navigator !== 'undefined' && 'share' in navigator && (
                <button
                  onClick={() => handleNativeShare(article.id)}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 hover:bg-indigo-200 dark:hover:bg-indigo-800/50 text-indigo-700 dark:text-indigo-300 transition-all"
                  aria-label={t('blog.shareNative')}
                  title={t('blog.shareNative')}
                >
                  <Share2 size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Contextual banner for news articles */}
          {article.category === 'novita' && (
            <div className="mx-4 sm:mx-6 mt-4 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 flex items-start gap-3">
              <Newspaper size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('blog.newsBanner.title')}</p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{t('blog.newsBanner.desc')}</p>
              </div>
            </div>
          )}

          {/* Article body */}
          <div className="px-4 sm:px-6 py-6 space-y-5">
            <p className="text-lg text-slate-600 dark:text-slate-500 italic border-l-4 border-indigo-500 pl-4">
              {t(`blog.article.${article.id}.excerpt`)}
            </p>

            <div className="space-y-4">
              {renderFormattedContent(articleBody1, navigators)}
              {/* Inline affiliate recommendation (mobile/tablet only) */}
              {inlinePartner && <InlineRecommendation partner={inlinePartner} />}
              {renderFormattedContent(articleBody2, navigators)}

              {/* In-article ad — mobile only (conditional mount) */}
              {isMobile && (
                <AdSenseBanner
                  adSlot={AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}
                  adFormat={AD_SLOTS.ARTICLE_INLINE_MOBILE.format}
                  adLayout={AD_SLOTS.ARTICLE_INLINE_MOBILE.layout}
                  fullWidthResponsive={false}
                  className="my-4"
                />
              )}

              {/* Inline job teaser — shows 1-2 relevant jobs mid-article */}
              {relatedJobs.length > 0 && (
                <div className="my-4 p-4 bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-950/30 dark:to-blue-950/20 border border-indigo-200/60 dark:border-indigo-800/40 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-bold text-indigo-800 dark:text-indigo-300 flex items-center gap-1.5">
                      <Briefcase size={15} className="text-indigo-500" />
                      {t('blog.inlineJobs.title')}
                    </p>
                    <a
                      href={buildPath({ activeTab: 'job-board' })}
                      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); Analytics.trackUIInteraction('blog_inline_jobs', 'link', 'click', 'view_all'); }}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
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
                        className="flex items-center gap-3 p-2.5 bg-white/70 dark:bg-slate-800/50 rounded-lg hover:bg-white dark:hover:bg-slate-700/50 transition-all group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center shrink-0 overflow-hidden">
                          {logo ? <img src={logo} alt={job.company} className="w-6 h-6 object-contain" loading="lazy" /> : <Building2 size={14} className="text-indigo-600 dark:text-indigo-400" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors">
                            {job.titleByLocale?.[locale] ?? job.title}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-500 truncate">
                            {job.company} · {job.location}
                          </p>
                        </div>
                        <ChevronRight size={14} className="text-slate-400 shrink-0" />
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
              {renderFormattedContent(articleBody3, navigators)}
            </div>

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
                            className={`mt-3 px-4 py-2 ${CTA_BTN_COLORS[cta.color]} text-white rounded-xl text-sm font-semibold inline-flex items-center gap-1 transition-all`}
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

            {/* AdSense — end-of-article multiplex */}
            <div className="mt-8">
              <Suspense fallback={null}>
                <AdSenseBanner
                  adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot}
                  adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format}
                  enabled={adEligible}
                  className="my-4"
                />
              </Suspense>
            </div>

            {/* Explore tools — category-aware grid of evergreen page links */}
            {/* Trending articles this week */}
            {(() => {
              const trendingFiltered = trendingArticles
                .filter(e => e.id !== article.id)
                .slice(0, 4);
              if (trendingFiltered.length === 0) return null;
              const trendingLookup = new Map(trendingFiltered.map(e => [e.id, e.views]));
              const trendingCards = trendingFiltered
                .map(e => ARTICLES.find(a => a.id === e.id))
                .filter(Boolean) as Article[];
              if (trendingCards.length === 0) return null;
              return (
                <div className="border-t border-slate-200 dark:border-slate-700 pt-6 mt-8">
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
                    <TrendingUp size={20} className="text-orange-500" />
                    {t('blog.trendingThisWeek')}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {trendingCards.map((tr, idx) => {
                      const views = trendingLookup.get(tr.id) ?? 0;
                      const responsive = imageFallbackMap[tr.image] ? null : getResponsiveImageSet(tr.image);
                      return (
                        <a
                          key={tr.id}
                          href={buildPath({ activeTab: 'blog', blogArticle: tr.id })}
                          onClick={(e) => { e.preventDefault(); handleArticleClick(tr.id); }}
                          className="flex items-center gap-3 p-3 bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/20 border border-orange-200/60 dark:border-orange-800/40 rounded-xl hover:from-orange-100 hover:to-amber-100 dark:hover:from-orange-900/40 dark:hover:to-amber-900/30 transition-all text-left group"
                        >
                          <div className="relative shrink-0">
                            <picture className="w-16 h-12 shrink-0">
                              {responsive && <source type="image/avif" srcSet={responsive.avif} />}
                              {responsive && <source type="image/webp" srcSet={responsive.webp} />}
                              <img
                                src={tr.image}
                                srcSet={responsive?.jpgSet}
                                sizes="64px"
                                alt={getImageAlt(tr.id)}
                                width={60}
                                height={40}
                                className="w-16 h-12 object-cover rounded-lg"
                                loading="lazy"
                                onError={() => handleResponsiveImageError(tr.image)}
                              />
                            </picture>
                            {idx === 0 && (
                              <span className="absolute -top-1.5 -left-1.5 bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                                🔥
                              </span>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 line-clamp-2 group-hover:text-orange-700 dark:group-hover:text-orange-300 transition-colors">
                              {t(`blog.article.${tr.id}.title`)}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">
                                {views} {t('blog.trendingThisWeek.views')}
                              </span>
                              <span className="text-xs text-slate-400">·</span>
                              <span className="text-xs text-slate-500 dark:text-slate-500">
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

            {/* Related articles */}
            <div className="border-t border-slate-200 dark:border-slate-700 pt-6 mt-8">
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4">{t('blog.relatedArticles')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {getRelatedArticles(article.id, ARTICLES, 3).map(related => (
                  <a
                    key={related.id}
                    href={buildPath({ activeTab: 'blog', blogArticle: related.id })}
                    onClick={(e) => { e.preventDefault(); handleArticleClick(related.id); }}
                    className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-all text-left"
                  >
                    {(() => {
                      const responsive = imageFallbackMap[related.image] ? null : getResponsiveImageSet(related.image);
                      return (
                        <picture className="w-16 h-12 shrink-0">
                          {responsive && <source type="image/avif" srcSet={responsive.avif} />}
                          {responsive && <source type="image/webp" srcSet={responsive.webp} />}
                          <img
                            src={related.image}
                            srcSet={responsive?.jpgSet}
                            sizes="64px"
                            alt={getImageAlt(related.id)}
                            width={60}
                            height={40}
                            className="w-16 h-12 object-cover rounded-lg shrink-0"
                            loading="lazy"
                            onError={() => handleResponsiveImageError(related.image)}
                          />
                        </picture>
                      );
                    })()}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 line-clamp-2">
                        {t(`blog.article.${related.id}.title`)}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">{estimateReadingMinutes(related.id, t)} min</p>
                    </div>
                  </a>
                ))}
              </div>
            </div>

            {/* Related jobs (cross-linking) */}
            {relatedJobs.length > 0 ? (
              <div className="border-t border-slate-200 dark:border-slate-700 pt-6 mt-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                    <Briefcase size={18} className="text-indigo-500" />
                    {t('blog.relatedJobs')}
                  </h3>
                  <a
                    href={buildPath({ activeTab: 'job-board' })}
                    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); }}
                    className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
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
                        className="flex items-start gap-3 p-3 bg-indigo-50/60 dark:bg-indigo-950/20 rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-all text-left border border-indigo-100 dark:border-indigo-900/40"
                      >
                        <div className="w-10 h-10 rounded-lg bg-white dark:bg-slate-700 flex items-center justify-center border border-slate-200 dark:border-slate-600 shrink-0 overflow-hidden">
                          {logo ? <img src={logo} alt={job.company} className="w-7 h-7 object-contain" loading="lazy" /> : <Briefcase size={16} className="text-indigo-500" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 line-clamp-2">
                            {job.titleByLocale?.[locale] ?? job.title}
                          </p>
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{job.company} · {job.location}</p>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="border-t border-slate-200 dark:border-slate-700 pt-6 mt-6">
                <a
                  href={buildPath({ activeTab: 'job-board' })}
                  onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav.navigateTo('job-board'); }}
                  className="flex items-center gap-3 p-4 bg-indigo-50/60 dark:bg-indigo-950/20 rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-all border border-indigo-100 dark:border-indigo-900/40"
                >
                  <div className="w-10 h-10 rounded-lg bg-white dark:bg-slate-700 flex items-center justify-center border border-slate-200 dark:border-slate-600 shrink-0">
                    <Search size={18} className="text-indigo-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('blog.cta.jobBoard.title')}</p>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{t('blog.cta.jobBoard.desc')}</p>
                  </div>
                  <ArrowRight size={16} className="text-indigo-500 shrink-0" />
                </a>
              </div>
            )}
          </div>
        </article>

          {/* ── Right Rail (desktop only) ── */}
          <aside className="hidden xl:block">
            <div className="sticky top-6 space-y-3">
              <p className="text-[10px] font-medium text-slate-500 dark:text-slate-500 uppercase tracking-wider">
                {t('blog.resourcesTitle')}
              </p>
              {sidePartners.slice(2, 4).map((p, i) => <SideRailCard key={p.id} partner={p} idx={i + 2} />)}

              {/* AdSense — right rail (desktop xl only, conditional mount) */}
              {isDesktopXl && (
                <Suspense fallback={null}>
                <AdSenseBanner
                  adSlot={AD_SLOTS.ARTICLE_RAIL_RIGHT.slot}
                  adFormat={AD_SLOTS.ARTICLE_RAIL_RIGHT.format}
                  label={t('adsense.label')}
                  enabled={adEligible}
                  className="mt-3"
                />
                </Suspense>
              )}
              <Suspense fallback={null}>
                <CreatorProducts contextText={creatorContextText} className="mt-2" maxCards={2} />
              </Suspense>

              {/* Donation mini-card */}
              <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/80 dark:bg-amber-900/20 p-3 text-center space-y-2">
                <Coffee size={18} className="mx-auto text-amber-600 dark:text-amber-400" />
                <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                  {t('donation.message').slice(0, 80)}…
                </p>
                <a
                  href="https://www.buymeacoffee.com/frontaliereticino"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block w-full text-[10px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-800/50 rounded-lg py-1.5 transition-colors"
                >
                  ☕ {t('donation.button')}
                </a>
              </div>

              <p className="text-[8px] text-slate-500 dark:text-slate-600 leading-tight">
                {t('affiliate.disclosure')}
              </p>
            </div>
          </aside>

        </div>
      </div>
    );
  }

  // ── List View (Newspaper style) ──────────────────────

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="text-center mb-6">
        <h2 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center justify-center gap-2">
          <BookOpen size={28} className="text-indigo-600" />
          {t('blog.title')}
        </h2>
        <p className="text-slate-600 dark:text-slate-500">{t('blog.subtitle')}</p>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2 justify-center">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => handleCategoryChange(cat)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
              selectedCategory === cat
                ? 'bg-indigo-600 text-white shadow-md'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'
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
          className="block w-full text-left group relative overflow-hidden rounded-2xl shadow-xl hover:shadow-2xl transition-all"
          onClick={(e) => { e.preventDefault(); handleArticleClick(pageArticles[0].id); }}
        >
          <div className="relative h-64 sm:h-80">
            {(() => {
              const responsive = imageFallbackMap[pageArticles[0].image] ? null : getResponsiveImageSet(pageArticles[0].image);
              return (
                <picture>
                  {responsive && <source type="image/avif" srcSet={responsive.avif} sizes="(max-width: 640px) 100vw, 800px" />}
                  {responsive && <source type="image/webp" srcSet={responsive.webp} sizes="(max-width: 640px) 100vw, 800px" />}
                  <img
                    src={pageArticles[0].image}
                    srcSet={responsive?.jpgSet}
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
                </picture>
              );
            })()}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
            <div className="absolute bottom-5 left-5 right-5">
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-3 py-1 rounded-full text-xs font-bold ${getCategoryColor(pageArticles[0].category)}`}>
                  {t(`blog.category.${pageArticles[0].category}`)}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  pageArticles[0].category === 'novita'
                    ? 'bg-orange-500/80 text-white'
                    : 'bg-white/20 text-white backdrop-blur-sm'
                }`}>
                  {pageArticles[0].category === 'novita'
                    ? t('blog.contentType.news')
                    : t('blog.contentType.guide')}
                </span>
                <span className="flex items-center gap-1 text-xs text-white/90">
                  <Clock size={12} />
                  {estimateReadingMinutes(pageArticles[0].id, t)} min
                </span>
                <span className="text-xs text-white/60">{formatDate(pageArticles[0].date)}</span>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-white mb-2 leading-tight">
                {t(`blog.article.${pageArticles[0].id}.title`)}
              </h3>
              <p className="text-white/90 text-sm line-clamp-2 max-w-2xl">
                {t(`blog.article.${pageArticles[0].id}.excerpt`)}
              </p>
            </div>
          </div>
        </a>
      )}

      {/* Article grid — newspaper 3-column layout */}
      {pageArticles.length > 1 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {pageArticles.slice(1, 1 + gridRevealCount).map((article) => (
            <a
              key={article.id}
              href={buildPath({ activeTab: 'blog', blogArticle: article.id })}
              className="block text-left bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden hover:shadow-lg hover:border-indigo-300 dark:hover:border-indigo-600 transition-all group"
              onClick={(e) => { e.preventDefault(); handleArticleClick(article.id); }}
            >
              {/* Card image */}
              <div className="relative h-40 overflow-hidden">
                {(() => {
                  const responsive = imageFallbackMap[article.image] ? null : getResponsiveImageSet(article.image);
                  return (
                    <picture>
                      {responsive && <source type="image/avif" srcSet={responsive.avif} sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" />}
                      {responsive && <source type="image/webp" srcSet={responsive.webp} sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" />}
                      <img
                        src={article.image}
                        srcSet={responsive?.jpgSet}
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
                    </picture>
                  );
                })()}
                <div className="absolute top-2 left-2 flex items-center gap-1">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getCategoryColor(article.category)}`}>
                    {t(`blog.category.${article.category}`)}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${
                    article.category === 'novita'
                      ? 'bg-orange-500/90 text-white'
                      : 'bg-white/80 dark:bg-slate-900/70 text-slate-600 dark:text-slate-300 backdrop-blur-sm'
                  }`}>
                    {article.category === 'novita'
                      ? t('blog.contentType.news')
                      : t('blog.contentType.guide')}
                  </span>
                </div>
              </div>

              {/* Card content */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-2 text-xs text-slate-500 dark:text-slate-500">
                  <span className="flex items-center gap-1">
                    <Calendar size={10} />
                    {formatDate(article.date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {estimateReadingMinutes(article.id, t)} min
                  </span>
                </div>
                <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-2 mb-2">
                  {t(`blog.article.${article.id}.title`)}
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-500 line-clamp-2 mb-3">
                  {t(`blog.article.${article.id}.excerpt`)}
                </p>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 group-hover:underline">
                  {t('blog.readMore')} <ChevronRight size={12} />
                </span>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Progressive reveal under the fold (mobile-first LCP optimization) */}
      {pageArticles.length > 1 && gridRevealCount < (pageArticles.length - 1) && (
        <div className="flex justify-center mt-2">
          <button
            onClick={() => setGridRevealCount(pageArticles.length - 1)}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {t('blog.readMore')}
          </button>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 sm:gap-2">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="inline-flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-sm font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                  <span key={page} className="w-8 h-9 flex items-center justify-center text-slate-500 dark:text-slate-500 text-sm select-none">…</span>
                ) : (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                      page === currentPage
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
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
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="inline-flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-sm font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t('blog.pagination.next')}
          >
            <span className="hidden sm:inline">{t('blog.pagination.next')}</span>
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* SEO content block */}
      <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3">{t('blog.seoTitle')}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-500 leading-relaxed">
          {t('blog.seoContent')}
        </p>
      </div>
    </div>
  );
}
