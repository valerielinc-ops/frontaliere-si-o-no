import React from 'react';
import { Calendar, ExternalLink } from 'lucide-react';
import { useTranslation } from '../../services/i18n';

interface DataFreshnessProps {
 /** ISO date string or Date — when the data was last updated */
 lastUpdated: string;
 /** Optional source name */
 source?: string;
 /** Optional URL to the source */
 sourceUrl?: string;
 /** Visual variant */
 variant?: 'inline' | 'badge';
}

const DataFreshness: React.FC<DataFreshnessProps> = ({ lastUpdated, source, sourceUrl, variant = 'inline' }) => {
 const { t } = useTranslation();

 const formatDate = (dateStr: string) => {
 try {
 const date = new Date(dateStr);
 return date.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
 } catch {
 return dateStr;
 }
 };

 if (variant === 'badge') {
 return (
 <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised rounded-lg text-xs font-semibold text-muted">
 <Calendar size={10} className="text-muted" />
 <span>{t('dataFreshness.updated')}: {formatDate(lastUpdated)}</span>
 {source && (
 <>
 <span className="text-edge">·</span>
 {sourceUrl ? (
 <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-stripe-600 hover:text-accent flex items-center gap-0.5">
 {source} <ExternalLink size={8} />
 </a>
 ) : (
 <span>{source}</span>
 )}
 </>
 )}
 </div>
 );
 }

 return (
 <div className="flex items-center gap-1.5 text-xs text-muted font-medium">
 <Calendar size={10} className="text-muted flex-shrink-0" />
 <span>{t('dataFreshness.updated')}: {formatDate(lastUpdated)}</span>
 {source && (
 <>
 <span className="text-edge">·</span>
 {sourceUrl ? (
 <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-stripe-600 hover:text-accent flex items-center gap-0.5 hover:underline">
 {t('dataFreshness.source')}: {source} <ExternalLink size={8} />
 </a>
 ) : (
 <span>{t('dataFreshness.source')}: {source}</span>
 )}
 </>
 )}
 </div>
 );
};

export default DataFreshness;
