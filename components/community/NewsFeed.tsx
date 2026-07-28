import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';
import { TICKER_ARTICLES, type TickerArticle } from '@/data/news-ticker-data';
import { ChevronRight, ChevronLeft, Newspaper } from 'lucide-react';
import { Analytics } from '@/services/analytics';

interface NewsFeedProps {
 /**
  * `blogSlug` is the locale-specific URL slug of the article (from the
  * build-time ticker payload) so the caller can push the canonical
  * `/guida-frontalieri/<slug>/` URL without waiting for the lazy
  * routerBlogData chunk (issues #3528/#3532: the ticker must not force
  * ~1.9 MB of blog metadata JS onto the homepage).
  */
 onNavigate: (activeTab: string, blogArticle?: string, blogSlug?: string) => void;
}

// Issue #4881 Fase 3-bis: `scripts/publish-article-chunks.mjs` keeps this tiny
// JSON CDN-fresh on every fast-publish (same {id,date,title,slug} shape as
// TickerArticle, computed by the SAME computeTickerArticles() the build-time
// plugin uses, just fed the freshly-published registry — no fallback-chain
// drift). A few KB, not the ~385 KB blog-meta+registry cost #3528/#3532
// removed: keep this fetch small and behind this one best-effort refresh.
const NEWS_TICKER_LIVE_URL = 'https://cdn.frontaliereticino.ch/data/news-ticker-live.json';

function isTickerArticleArray(value: unknown): value is TickerArticle[] {
 return (
 Array.isArray(value) &&
 value.length > 0 &&
 value.every(
 (a) =>
 a && typeof a === 'object' &&
 typeof (a as TickerArticle).id === 'string' &&
 typeof (a as TickerArticle).date === 'string' &&
 typeof (a as TickerArticle).title === 'object' &&
 typeof (a as TickerArticle).slug === 'object',
 )
 );
}

/**
 * Compact rotating news ticker — single-line marquee-style widget.
 * Auto-rotates every 6s, manual prev/next navigation.
 *
 * Data source: `data/news-ticker-data.ts`, generated at build time by
 * `build-plugins/newsTickerDataPlugin.ts` (5 newest articles with
 * per-locale titles + URL slugs). No runtime blog-meta / registry /
 * slug-map chunk loads — that used to cost ~385 KB tx and two long
 * main-thread parse tasks on every homepage view.
 *
 * Kept fresh between full deploys (issue #4881): after first paint, a single
 * idle-deferred fetch of `news-ticker-live.json` (a few KB) checks for a
 * fast-published article the build-time payload above doesn't know about yet
 * and swaps it in. Failure of any kind (offline, 404, malformed JSON) is
 * silently ignored — the component keeps rendering the known-good build-time
 * payload, never a blank ticker.
 */
const NewsFeed: React.FC<NewsFeedProps> = ({ onNavigate }) => {
 const { t, locale } = useTranslation();
 const [idx, setIdx] = useState(0);
 const [liveArticles, setLiveArticles] = useState<TickerArticle[] | null>(null);

 const latestArticles = liveArticles ?? TICKER_ARTICLES;
 const count = latestArticles.length;

 useEffect(() => {
 Analytics.trackUIInteraction('newsfeed', 'widget', 'ticker', 'view');
 }, []);

 useEffect(() => {
 let cancelled = false;
 const run = () => {
 fetch(NEWS_TICKER_LIVE_URL, { cache: 'default' })
 .then((res) => (res.ok ? res.json() : null))
 .then((data) => {
 if (cancelled || !isTickerArticleArray(data)) return;
 setLiveArticles(data);
 })
 .catch(() => {
 // Best-effort refresh — keep the build-time payload on any failure.
 });
 };
 // Same requestIdleCallback-with-fallback pattern already used in App.tsx.
 if ('requestIdleCallback' in window) {
 (window as any).requestIdleCallback(run, { timeout: 4000 });
 } else {
 window.setTimeout(run, 2000);
 }
 return () => { cancelled = true; };
 }, []);

 // Auto-rotate every 6 seconds
 useEffect(() => {
 if (count === 0) return;
 const timer = setInterval(() => setIdx(i => (i + 1) % count), 6000);
 return () => clearInterval(timer);
 }, [count]);

 const prev = useCallback(() => setIdx(i => (i - 1 + count) % count), [count]);
 const next = useCallback(() => setIdx(i => (i + 1) % count), [count]);

 // Keep placeholder when payload is absent (vitest placeholder module) —
 // matches SkeletonNewsTicker height to prevent CLS.
 if (count === 0) return <div className="animate-pulse h-[34px] bg-surface-raised rounded-xl" />;

 const formatDate = (dateStr: string) => {
 const d = new Date(dateStr);
 return d.toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-GB', {
 day: 'numeric', month: 'short',
 });
 };

 return (
 <div data-testid="news-ticker" className="flex items-center gap-2 h-[34px] bg-surface rounded-xl border border-edge px-3 text-xs overflow-hidden">
 {/* Icon + label */}
 <div className="flex items-center gap-1.5 flex-shrink-0">
 <Newspaper size={13} className="text-danger" />
 <span className="font-bold text-muted hidden sm:inline">{t('newsfeed.title')}</span>
 </div>

 {/* Divider */}
 <div className="w-px h-4 bg-surface-raised flex-shrink-0" />

 {/* Rotating headline with horizontal slide */}
 <div className="flex-1 min-w-0 relative h-5 overflow-hidden">
 {latestArticles.map((art, i) => {
 const artTitle = art.title[locale];
 const artSlug = art.slug[locale];
 // blogSlug (not blogArticle) so buildPath emits the canonical
 // localized URL without needing the lazy BLOG_SLUGS chunk.
 const artHref = buildPath({ activeTab: 'blog', blogSlug: artSlug }, locale);
 return (
 <a
 key={art.id}
 href={artHref}
 onClick={(e) => { e.preventDefault(); onNavigate('blog', art.id, artSlug); }}
 onClickCapture={() => {
 Analytics.trackSelectContent('news_article', art.id);
 Analytics.trackUIInteraction('newsfeed', 'ticker', 'headline', 'open_article', art.id);
 }}
 className="absolute inset-0 flex items-center font-medium text-body hover:text-accent transition-colors duration-300 ease-out [transform:var(--tx)] opacity-[var(--op)]"
 style={{
 ['--tx']: `translateX(${(i - idx) * 100}%)`,
 ['--op']: i === idx ? 1 : 0,
 } as React.CSSProperties}
 tabIndex={i === idx ? 0 : -1}
 {...(i !== idx ? { inert: true } : {})}
 >
 <span className="text-muted mr-1.5 flex-shrink-0">{formatDate(art.date)}</span>
 <span className="line-clamp-1">{artTitle}</span>
 </a>
 );
 })}
 </div>

 {/* Prev / Next arrows */}
 <div className="flex items-center gap-0.5 flex-shrink-0">
 <button
 onClick={() => {
 prev();
 Analytics.trackUIInteraction('newsfeed', 'ticker', 'navigation', 'prev');
 }}
 className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded hover:bg-surface-raised text-muted hover:text-body transition-colors"
 aria-label="Previous"
 >
 <ChevronLeft size={14} />
 </button>
 <span className="text-sm text-muted tabular-nums w-7 text-center">{idx + 1}/{count}</span>
 <button
 onClick={() => {
 next();
 Analytics.trackUIInteraction('newsfeed', 'ticker', 'navigation', 'next');
 }}
 className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded hover:bg-surface-raised text-muted hover:text-body transition-colors"
 aria-label="Next"
 >
 <ChevronRight size={14} />
 </button>
 </div>

 {/*"All" link */}
 <button
 onClick={() => {
 Analytics.trackUIInteraction('newsfeed', 'ticker', 'view_all', 'open_blog');
 onNavigate('blog');
 }}
 className="flex-shrink-0 text-xs font-semibold text-link hover:underline hidden sm:inline-flex items-center min-h-[24px] px-2"
 >
 {t('newsfeed.viewAll')}
 </button>
 </div>
 );
};

export default NewsFeed;
