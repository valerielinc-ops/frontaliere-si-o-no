/**
 * TrendingSection — stable horizontal strip of job recommendations.
 *
 * Popularity can refine the ranking after the initial jobs are available.
 * Fixed-width 260px cards, horizontal scroll with scrollbar-hide.
 * Gradient fade on right edge signals more content on tablet/mobile.
 */

import React, { useRef, useState, useEffect } from 'react';
import { TrendingUp, Eye } from 'lucide-react';

interface TrendingJob {
 slug?: string;
 title: string;
 company: string;
 location: string;
 addressLocality?: string;
 logoUrl?: string | null;
 category: string;
 /**
  * Locale-aware canonical URL for this job (e.g. /cerca-lavoro-ticino/<slug>/ in IT,
  * /en/find-jobs-ticino/<slug>/ in EN). Computed by the parent via buildPath() so
  * Cmd-click / middle-click / crawler-visible href resolves correctly. Falls back
  * to '#' when slug is missing.
  */
 href?: string;
}

/** Restrict recommendations to the canonical filtered results, before pagination. */
export function selectRecommendationJobs<T extends { slug?: string }>(
 filteredJobs: readonly T[],
 popularJobs: readonly { slug?: string }[],
 personalizationEnabled: boolean,
): T[] {
 const seen = new Set<string>();
 const unique = (items: readonly T[]) => {
 const result: T[] = [];
 for (const job of items) {
 if (!job.slug || seen.has(job.slug)) continue;
 seen.add(job.slug);
 result.push(job);
 if (result.length === 4) break;
 }
 return result;
 };
 if (personalizationEnabled) {
 // At most four popular candidates: reuse the canonical filtered record so
 // stale/unfiltered candidate objects cannot reintroduce excluded jobs.
 const matches = popularJobs.slice(0, 4).map((candidate) =>
 filteredJobs.find((job) => job.slug && job.slug === candidate.slug),
 ).filter((job): job is T => job !== undefined);
 const ranked = unique(matches);
 if (ranked.length >= 3) return ranked;
 seen.clear();
 }
 return unique(filteredJobs);
}

interface TrendingSectionProps {
 trendingJobs: TrendingJob[];
 popularity: Record<string, number>;
 onJobClick: (slug: string) => void;
 /** Localized section heading (e.g. "Popular in your area"). */
 heading: string;
 /** Localized section aria-label. */
 ariaLabel: string;
 /** Shown inside the reserved card footprint when no jobs are available. */
 emptyLabel: string;
}

function TrendingSection({ trendingJobs, popularity, onJobClick, heading, ariaLabel, emptyLabel }: TrendingSectionProps) {
 const scrollRef = useRef<HTMLDivElement>(null);
 const [showFade, setShowFade] = useState(true);

 useEffect(() => {
 const el = scrollRef.current;
 if (!el) return;
 const onScroll = () => {
 const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
 setShowFade(!atEnd);
 };
 el.addEventListener('scroll', onScroll, { passive: true });
 onScroll();
 return () => el.removeEventListener('scroll', onScroll);
 }, [trendingJobs]);

 const renderCardBody = (job?: TrendingJob) => {
 const views = job?.slug ? popularity[job.slug] || 0 : 0;
 return <>
 <div className="flex items-start gap-2.5">
 <div className="w-8 h-8 rounded-[4px] bg-surface-raised border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {job?.logoUrl ? (
 <img
 src={job?.logoUrl}
 alt=""
 width={24}
 height={24}
 className="w-6 h-6 object-contain"
 loading="lazy"
 onError={(e) => {
 // No Clearbit→Google-favicon hop (defunct CDN / grey globe). On any load
 // error, hide the image and reveal the initial-letter fallback span.
 const el = e.currentTarget;
 el.style.display = 'none';
 const fallback = el.nextElementSibling as HTMLElement | null;
 if (fallback) fallback.style.display = '';
 }}
 />
 ) : null}
 <span className={`text-xs text-muted${job?.logoUrl ? ' hidden' : ''}`}>{job?.company.charAt(0) ?? '\u00a0'}</span>
 </div>
 <div className="min-w-0 flex-1">
 <p className="text-sm leading-5 font-semibold text-heading line-clamp-1">
 {job?.title || '\u00a0'}
 </p>
 <p className="text-xs leading-4 text-muted line-clamp-1 mt-0.5">
 {job ? `${job.company} · ${job.addressLocality || job.location}` : '\u00a0'}
 </p>
 </div>
 </div>
 <div className="mt-2 h-5 flex items-center gap-1">
 {views > 0 && (
 <>
 <Eye className="w-3 h-3 text-muted" />
 <span className="text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded-full bg-surface-raised text-muted">
 {views} visualizzazioni
 </span>
 </>
 )}
 </div>
 </>;
 };

 return (
 <section aria-label={ariaLabel} className="space-y-2">
 <div className="flex items-center gap-1.5">
 <TrendingUp className="w-4 h-4 text-accent" />
 <h3 className="text-sm font-semibold text-body">
 {heading}
 </h3>
 </div>
 <div className="relative">
 {/* Intrinsic reservation uses the same card padding, border and text rows as
     real cards, including an empty popularity row. It survives empty/error
     responses without a hardcoded pixel height or a collapsing skeleton. */}
 <div aria-hidden="true" className="invisible pointer-events-none pb-2">
 <div className="w-[260px] sm:w-[280px] border p-3">
 {renderCardBody()}
 </div>
 </div>
 <div
 ref={scrollRef}
 className="absolute inset-0 flex gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1"
 >
 {trendingJobs.map((job) => {
 return (
 <a
 key={job.slug || job.title}
 href={job.href || '#'}
 onClick={(e) => {
 e.preventDefault();
 if (job.slug) onJobClick(job.slug);
 }}
 aria-label={`${job.title} presso ${job.company}`}
 className="flex-shrink-0 w-[260px] sm:w-[280px] rounded-[6px] border border-edge bg-surface/50 p-3 hover:border-accent-border transition-colors motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
 >
 {renderCardBody(job)}
 </a>
 );
 })}
 </div>
 {trendingJobs.length === 0 && (
 <p role="status" className="absolute inset-0 flex items-center justify-center text-center text-sm text-muted px-3">
 {emptyLabel}
 </p>
 )}
 {/* DESIGN-6: Gradient fade on right edge signals more content */}
 {showFade && trendingJobs.length > 0 && (
 <div
 className="absolute right-0 top-0 bottom-2 w-8 pointer-events-none bg-gradient-to-l from-surface to-transparent"
 aria-hidden="true"
 />
 )}
 </div>
 </section>
 );
}

export default React.memo(TrendingSection);
