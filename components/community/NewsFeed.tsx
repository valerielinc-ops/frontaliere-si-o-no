import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation, loadBlogMeta } from '@/services/i18n';
import { buildPath } from '@/services/router';
import type { Article } from '@/data/blog-articles-data';
import { ChevronRight, ChevronLeft, Newspaper } from 'lucide-react';
import { Analytics } from '@/services/analytics';

interface NewsFeedProps {
 onNavigate: (activeTab: string, blogArticle?: string) => void;
}

/**
 * Compact rotating news ticker — single-line marquee-style widget.
 * Auto-rotates every 6s, manual prev/next navigation.
 */
const NewsFeed: React.FC<NewsFeedProps> = ({ onNavigate }) => {
 const { t, locale } = useTranslation();
 const [blogReady, setBlogReady] = useState(false);
 const [idx, setIdx] = useState(0);
 // FRO-346: Dynamic import so blog-articles-data chunk isn't loaded until NewsFeed mounts
 const [articles, setArticles] = useState<Article[]>([]);

 useEffect(() => {
 Promise.all([
 loadBlogMeta(),
 import('@/data/blog-articles-data').then(m => m.ARTICLES),
 ]).then(([, data]) => {
 setArticles(data);
 setBlogReady(true);
 }).catch(() => {});
 }, []);

 useEffect(() => {
 Analytics.trackUIInteraction('newsfeed', 'widget', 'ticker', 'view');
 }, []);

 const latestArticles = useMemo(() => {
 return [...articles]
 .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
 .slice(0, 5);
 }, [articles]);

 const count = latestArticles.length;

 // Auto-rotate every 6 seconds
 useEffect(() => {
 if (!blogReady || count === 0) return;
 const timer = setInterval(() => setIdx(i => (i + 1) % count), 6000);
 return () => clearInterval(timer);
 }, [blogReady, count]);

 const prev = useCallback(() => setIdx(i => (i - 1 + count) % count), [count]);
 const next = useCallback(() => setIdx(i => (i + 1) % count), [count]);

 // Keep placeholder while loading to prevent CLS — matches SkeletonNewsTicker height
 if (!blogReady || count === 0) return <div className="animate-pulse h-[34px] bg-surface-raised rounded-xl" />;

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
 const artTitle = t(`blog.article.${art.id}.title`);
 const artHref = buildPath({ activeTab: 'blog', blogArticle: art.id }, locale);
 return (
 <a
 key={art.id}
 href={artHref}
 onClick={(e) => { e.preventDefault(); onNavigate('blog', art.id); }}
 onClickCapture={() => {
 Analytics.trackSelectContent('news_article', art.id);
 Analytics.trackUIInteraction('newsfeed', 'ticker', 'headline', 'open_article', art.id);
 }}
 className="absolute inset-0 flex items-center font-medium text-body hover:text-accent transition-colors duration-300 ease-out"
 style={{
 transform: `translateX(${(i - idx) * 100}%)`,
 opacity: i === idx ? 1 : 0,
 }}
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
