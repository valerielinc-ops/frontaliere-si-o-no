import React, { useMemo, useState, useCallback } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { getCreatorProductsForContext } from '@/services/creatorProductsService';

interface CreatorProductsProps {
 contextText: string;
 className?: string;
 maxCards?: number;
 /** Skip the first N products from the ranked pool (use to show different products in multiple slots) */
 offset?: number;
}

const CreatorProducts: React.FC<CreatorProductsProps> = ({
 contextText,
 className = '',
 maxCards = 2,
 offset = 0,
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

 const products = useMemo(() => getCreatorProductsForContext({ contextText, maxCards, offset }), [contextText, maxCards, offset]);

 if (!products.length) return null;

 return (
 <div className={`overflow-visible rounded-xl border border-edge bg-surface/90 p-3 space-y-2.5 ${className}`}>
 <div className="flex items-center gap-1.5 text-xs font-semibold tracking-normal text-subtle">
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
 className="group block rounded-lg border border-edge/70 bg-surface-alt/40 px-2.5 py-2.5 hover:border-stripe-300 hover:border-accent-border hover:scale-[1.01] transition-[color,background-color,border-color,transform]"
 >
 {showImage && (
 <div className="flex justify-center mb-2">
 <img
 src={p.imageUrl}
 alt={p.title}
 width={96}
 height={96}
 className="rounded-lg object-contain bg-surface shadow-sm"
 loading="lazy"
 onLoad={handleImgLoad(p.id)}
 onError={handleImgError(p.id)}
 />
 </div>
 )}
 {!showImage && (
 <span className="text-2xl leading-none mb-1 block">{p.emoji}</span>
 )}
 <div className="text-sm font-semibold text-body leading-snug">
 {p.title}
 </div>
 <div className="flex items-center justify-between mt-1.5">
 {p.price ? (
 <span className="text-xs font-bold text-success">
 {p.price}
 </span>
 ) : (
 <span className="text-sm text-muted">
 amazon.it
 </span>
 )}
 <span className="text-xs font-medium text-accent group-hover:text-stripe-600 dark:group-hover:text-stripe-300 flex items-center gap-0.5">
 Vedi <ExternalLink size={10} />
 </span>
 </div>
 </a>
 );
 })}

 <p className="text-xs text-muted leading-snug">{t('creatorPicks.disclosure')}</p>
 </div>
 );
};

export default CreatorProducts;
