/**
 * TrendingSection — horizontal card strip of popular jobs in user's area.
 *
 * DESIGN-2: No emoji, lucide TrendingUp icon, "Popolari nella tua zona".
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
  companyDomain?: string;
  category: string;
}

interface TrendingSectionProps {
  trendingJobs: TrendingJob[];
  popularity: Record<string, number>;
  onJobClick: (slug: string) => void;
}

function TrendingSection({ trendingJobs, popularity, onJobClick }: TrendingSectionProps) {
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

  if (trendingJobs.length < 3) return null;

  return (
    <section aria-label="Lavori popolari nella tua zona" className="space-y-2">
      <div className="flex items-center gap-1.5">
        <TrendingUp className="w-4 h-4 text-accent" />
        <h3 className="text-sm font-semibold text-body">
          Popolari nella tua zona
        </h3>
      </div>
      <div className="relative">
        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1"
        >
          {trendingJobs.map((job) => {
            const views = job.slug ? popularity[job.slug] || 0 : 0;
            return (
              <a
                key={job.slug || job.title}
                href={job.slug ? `/cerca-lavoro/${job.slug}` : '#'}
                onClick={(e) => {
                  e.preventDefault();
                  if (job.slug) onJobClick(job.slug);
                }}
                aria-label={`${job.title} presso ${job.company}`}
                className="flex-shrink-0 w-[260px] sm:w-[280px] rounded-[6px] border border-edge bg-surface/50 dark:bg-slate-800/50 p-3 hover:border-stripe-300 dark:hover:border-stripe-700 transition-colors motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
              >
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-[4px] bg-surface-raised dark:bg-slate-700/50 border border-edge dark:border-slate-600 flex items-center justify-center overflow-hidden shrink-0">
                    {job.companyDomain ? (
                      <img
                        src={`/images/logos/${job.companyDomain}.webp`}
                        alt=""
                        className="w-6 h-6 object-contain"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <span className="text-xs text-muted">{job.company.charAt(0)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-heading line-clamp-1">
                      {job.title}
                    </p>
                    <p className="text-xs text-muted line-clamp-1 mt-0.5">
                      {job.company} · {job.addressLocality || job.location}
                    </p>
                  </div>
                </div>
                {views > 0 && (
                  <div className="mt-2 flex items-center gap-1">
                    <Eye className="w-3 h-3 text-muted" />
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised dark:bg-slate-700/50 text-muted">
                      {views} visualizzazioni
                    </span>
                  </div>
                )}
              </a>
            );
          })}
        </div>
        {/* DESIGN-6: Gradient fade on right edge signals more content */}
        {showFade && (
          <div
            className="absolute right-0 top-0 bottom-2 w-8 pointer-events-none bg-gradient-to-l from-white dark:from-slate-900 to-transparent"
            aria-hidden="true"
          />
        )}
      </div>
    </section>
  );
}

export default React.memo(TrendingSection);
