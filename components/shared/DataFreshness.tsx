import React from 'react';
import { Calendar, ExternalLink } from 'lucide-react';
import { useTranslation } from '../../services/i18n';
import { formatSourceDate } from '../../services/dataFreshness';

interface DataFreshnessProps {
 /** Actual source timestamp; omit when no date has been documented. */
 lastUpdated?: string | null;
 /** A retrieval is not an observation or an editorial review. */
 dateKind?: 'observed' | 'fetched' | 'reviewed';
 referenceYear?: number;
 source?: string;
 sourceUrl?: string;
 variant?: 'inline' | 'badge';
}

const DataFreshness: React.FC<DataFreshnessProps> = ({ lastUpdated, dateKind = 'observed', referenceYear, source, sourceUrl, variant = 'inline' }) => {
 const { t, locale } = useTranslation();
 const formatted = formatSourceDate(lastUpdated, locale);
 const validYear = Number.isInteger(referenceYear) && referenceYear! > 0;
 const outdatedYear = validYear && referenceYear! < new Date().getUTCFullYear();

 return (
 <div className={variant === 'badge'
 ? 'inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 bg-surface-raised rounded-lg text-xs font-semibold text-muted'
 : 'flex flex-wrap items-center gap-1.5 text-xs text-muted font-medium'}>
 <Calendar size={10} className="text-muted flex-shrink-0" />
 <span>{t(`dataFreshness.${dateKind}`)}: {formatted ? <time dateTime={lastUpdated!}>{formatted}</time> : t('dataFreshness.missing')}</span>
 {validYear && <span>· {t('dataFreshness.referenceYear')}: {referenceYear}{outdatedYear ? ` · ${t('dataFreshness.outdatedYear')}` : ''}</span>}
 {source && (
 <>
 <span className="text-edge">·</span>
 {sourceUrl ? (
 <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent flex items-center gap-0.5 hover:underline">
 {t('dataFreshness.source')}: {source} <ExternalLink size={8} />
 </a>
 ) : <span>{t('dataFreshness.source')}: {source}</span>}
 </>
 )}
 </div>
 );
};

export default DataFreshness;
