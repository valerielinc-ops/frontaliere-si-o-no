import React, { useMemo, useState, useCallback } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { getCreatorProductsForContext } from '@/services/creatorProductsService';

interface CreatorProductsProps {
  contextText: string;
  className?: string;
  maxCards?: number;
}

const CreatorProducts: React.FC<CreatorProductsProps> = ({
  contextText,
  className = '',
  maxCards = 2,
}) => {
  const { t } = useTranslation();
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

  const handleImgLoad = useCallback((id: string) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    // Amazon CDN returns a 1×1 transparent GIF for missing images (HTTP 200,
    // so onError never fires). Detect and suppress these placeholders.
    const img = e.currentTarget;
    if (img.naturalWidth < 5 || img.naturalHeight < 5) {
      setFailedImages((prev) => new Set(prev).add(id));
    }
  }, []);

  const handleImgError = useCallback((id: string) => () => {
    setFailedImages((prev) => new Set(prev).add(id));
  }, []);

  const products = useMemo(() => getCreatorProductsForContext({ contextText, maxCards }), [contextText, maxCards]);

  if (!products.length) return null;

  return (
    <div className={`overflow-visible rounded-xl border border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-800/90 p-3 space-y-2.5 ${className}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-normal text-slate-600 dark:text-slate-300">
        <Sparkles size={13} className="text-amber-500" />
        <span>{t('creatorPicks.title')}</span>
      </div>

      {products.map((p) => {
        const showImage = Boolean(p.imageUrl) && !failedImages.has(p.id);
        return (
          <a
            key={p.id}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer sponsored"
            onClick={() => {
              Analytics.trackExternalLink(p.url, `creator_pick_${p.id}`);
              Analytics.trackSelectContent('creator_pick_click', p.id);
            }}
            className="group flex items-start gap-3 rounded-lg border border-slate-200/70 dark:border-slate-700/70 bg-slate-50 dark:bg-slate-900/40 px-2.5 py-2.5 hover:border-indigo-300 dark:hover:border-indigo-700 hover:scale-[1.01] transition-all"
          >
            {showImage ? (
              <img
                src={p.imageUrl}
                alt={p.title}
                width={72}
                height={72}
                className="shrink-0 rounded-lg object-contain bg-white shadow-sm"
                loading="lazy"
                onLoad={handleImgLoad(p.id)}
                onError={handleImgError(p.id)}
              />
            ) : (
              <span className="shrink-0 text-2xl leading-none mt-0.5">{p.emoji}</span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 leading-snug line-clamp-2">
                {p.title}
              </div>
              {p.price ? (
                <div className="mt-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                  {p.price}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  amazon.it
                </div>
              )}
            </div>
            <ExternalLink size={12} className="text-slate-500 dark:text-slate-400 group-hover:text-indigo-500 shrink-0 mt-0.5" />
          </a>
        );
      })}

      <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">{t('creatorPicks.disclosure')}</p>
    </div>
  );
};

export default CreatorProducts;
