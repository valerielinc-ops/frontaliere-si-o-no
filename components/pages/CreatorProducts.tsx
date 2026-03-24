import React, { useMemo } from 'react';
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

  const products = useMemo(() => getCreatorProductsForContext({ contextText, maxCards }), [contextText, maxCards]);

  if (!products.length) return null;

  return (
    <div className={`rounded-xl border border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-800/90 p-3 space-y-2 ${className}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-normal text-slate-600 dark:text-slate-300">
        <Sparkles size={13} className="text-amber-500" />
        <span>{t('creatorPicks.title')}</span>
      </div>

      {products.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={() => {
            Analytics.trackExternalLink(p.url, `creator_pick_${p.id}`);
            Analytics.trackSelectContent('creator_pick_click', p.id);
          }}
          className="group flex items-start gap-2 rounded-lg border border-slate-200/70 dark:border-slate-700/70 bg-slate-50 dark:bg-slate-900/40 px-2 py-1.5 hover:border-indigo-300 dark:hover:border-indigo-700 transition-all"
        >
          {p.imageUrl && (
            <img
              src={p.imageUrl}
              alt={p.title}
              width={40}
              height={40}
              className="shrink-0 rounded object-contain bg-white"
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold text-slate-700 dark:text-slate-200 leading-snug line-clamp-2">
              {p.title}
            </div>
            {p.price ? (
              <div className="mt-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
                {p.price}
              </div>
            ) : (
              <div className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-400 truncate">
                {p.emoji} Amazon
              </div>
            )}
            <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-[8px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('creatorPicks.highPayout')}
            </div>
          </div>
          <ExternalLink size={12} className="text-slate-400 group-hover:text-indigo-500 shrink-0 mt-0.5" />
        </a>
      ))}

      <p className="text-[9px] text-slate-500 dark:text-slate-600 leading-snug">{t('creatorPicks.disclosure')}</p>
    </div>
  );
};

export default CreatorProducts;
