import React, { useEffect, useMemo } from 'react';
import { SearchX, ArrowRight, Home, Briefcase, FileText, BookOpen, Calculator, Search } from 'lucide-react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

// Lazy-loaded data is passed via props to avoid coupling
interface Suggestion {
 title: string;
 description?: string;
 tab: string;
 subTab?: string;
 icon: React.ElementType;
 color: string;
 score: number;
}

interface NotFoundSuggestionsProps {
 path: string;
 onNavigate: (tab: string, subTab?: string) => void;
}

const STOP_WORDS = new Set([
 // Italian
 'il', 'la', 'lo', 'le', 'li', 'gli', 'un', 'una', 'uno', 'di', 'da', 'del', 'della',
 'dei', 'delle', 'in', 'con', 'su', 'per', 'tra', 'fra', 'che', 'non', 'come', 'più',
 'alla', 'alle', 'allo', 'agli', 'dal', 'dalla', 'dallo', 'nel', 'nella', 'nello',
 'sul', 'sulla', 'sullo', 'sono', 'essere', 'avere', 'fare',
 // English
 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'for', 'and', 'or', 'but',
 'in', 'on', 'at', 'by', 'with', 'from', 'this', 'that', 'not', 'how', 'what',
 // Common URL noise
 'www', 'http', 'https', 'html', 'php', 'aspx', 'index',
]);

const MIN_WORD_LENGTH = 3;

export function extractKeywords(path: string): string[] {
 // Get the last meaningful segment of the path
 const segments = path.replace(/^\//, '').split('/').filter(Boolean);
 // Use all segments for keyword extraction, prioritizing the last (most specific)
 const slug = segments.join('-');
 return slug
 .split(/[-_/]+/)
 .map(w => w.toLowerCase().replace(/[^a-zàèéìòùäöü0-9]/g, ''))
 .filter(w => w.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(w));
}

type ContentType = 'article' | 'job' | 'guide' | 'section' | 'unknown';

export function detectContentType(path: string): ContentType {
 const lower = path.toLowerCase();
 if (lower.includes('articol') || lower.includes('blog') || lower.includes('news')) return 'article';
 if (lower.includes('lavoro') || lower.includes('job') || lower.includes('cerca-lavoro')) return 'job';
 if (lower.includes('guida') || lower.includes('guide')) return 'guide';
 if (lower.includes('calcol') || lower.includes('confron') || lower.includes('fisco') || lower.includes('vita') || lower.includes('stat')) return 'section';
 return 'unknown';
}

function scoreMatch(keywords: string[], targets: string[]): number {
 let score = 0;
 for (const kw of keywords) {
 for (const target of targets) {
 if (target === kw) score += 3;
 else if (target.includes(kw) || kw.includes(target)) score += 1;
 }
 }
 return score;
}

// Static search index for suggestions (mirrors top-level SiteSearch items)
function buildSuggestionIndex(t: (key: string, params?: Record<string, string>) => string): Suggestion[] {
 return [
 { title: t('nav.simulator') || 'Simulatore', description: t('app.subtitle'), tab: 'calculator', icon: Calculator, color: 'text-accent', score: 0 },
 { title: t('comparators.exchange') || 'Cambio Valuta', description: t('notFound.desc.exchange'), tab: 'confronti', subTab: 'exchange', icon: Calculator, color: 'text-accent', score: 0 },
 { title: t('comparators.health') || 'Assicurazione Sanitaria', description: t('notFound.desc.health'), tab: 'confronti', subTab: 'health', icon: Calculator, color: 'text-success', score: 0 },
 { title: t('comparators.jobs') || 'Offerte Lavoro', description: t('notFound.desc.jobs', getCantonI18nParams()), tab: 'job-board', icon: Briefcase, color: 'text-warning', score: 0 },
 { title: t('nav.blog') || 'Articoli', description: t('notFound.desc.articles'), tab: 'blog', icon: FileText, color: 'text-danger', score: 0 },
 { title: t('guide.tabs.firstDay') || 'Primo Giorno', description: t('notFound.desc.guide'), tab: 'guida', subTab: 'first-day', icon: BookOpen, color: 'text-accent', score: 0 },
 { title: t('guide.tabs.permits') || 'Permessi', description: t('notFound.desc.permits'), tab: 'guida', subTab: 'permits', icon: BookOpen, color: 'text-accent', score: 0 },
 { title: t('nav.pension') || 'Pensione', description: t('notFound.desc.pension'), tab: 'fisco', subTab: 'pension', icon: Calculator, color: 'text-success', score: 0 },
 { title: t('withholdingRates.navLabel') || 'Aliquote alla Fonte', description: t('notFound.desc.withholding'), tab: 'fisco', subTab: 'withholding-rates', icon: Calculator, color: 'text-success', score: 0 },
 { title: t('comparators.shopping') || 'Spesa Transfrontaliera', description: t('notFound.desc.shopping'), tab: 'confronti', subTab: 'shopping', icon: Calculator, color: 'text-accent', score: 0 },
 { title: t('comparators.borderMap') || 'Mappa Dogane', description: t('notFound.desc.borderMap'), tab: 'guida', subTab: 'border-map', icon: BookOpen, color: 'text-accent', score: 0 },
 { title: t('comparators.taxReturn') || 'Dichiarazione Fiscale', description: t('notFound.desc.taxReturn'), tab: 'fisco', subTab: 'tax-return', icon: Calculator, color: 'text-success', score: 0 },
 ];
}

// Extra keyword mappings for better matching
const SECTION_KEYWORDS: Record<string, string[]> = {
 'calculator': ['stipendio', 'calcolo', 'netto', 'lordo', 'salario', 'simulatore', 'ral', 'busta', 'paga'],
 'exchange': ['cambio', 'valuta', 'euro', 'franco', 'chf', 'eur', 'tasso'],
 'health': ['assicurazione', 'sanitaria', 'lamal', 'malattia', 'cassa', 'premio', 'franchise'],
 'jobs': ['lavoro', 'offerte', 'impiego', 'azienda', 'posizione', 'candidatura', 'ticino'],
 'blog': ['articoli', 'articolo', 'notizie', 'news', 'blog', 'frontalieri'],
 'first-day': ['primo', 'giorno', 'inizio', 'partenza', 'guida'],
 'permits': ['permesso', 'permessi', 'soggiorno', 'residenza', 'tipo'],
 'pension': ['pensione', 'avs', 'lpp', 'previdenza', 'pilastro', 'rendita'],
 'withholding-rates': ['aliquote', 'fonte', 'imposta', 'tasse', 'trattenute'],
 'shopping': ['spesa', 'shopping', 'supermercato', 'migros', 'coop', 'aldi', 'lidl'],
 'border-map': ['dogana', 'frontiera', 'confine', 'valico', 'attesa', 'coda'],
 'tax-return': ['dichiarazione', 'fiscale', 'tasse', 'redditi', '730', 'irpef'],
};

const NotFoundSuggestions: React.FC<NotFoundSuggestionsProps> = ({ path, onNavigate }) => {
 const { t } = useTranslation();
 const contentType = detectContentType(path);
 const keywords = useMemo(() => extractKeywords(path), [path]);

 const suggestions = useMemo(() => {
 const index = buildSuggestionIndex(t);

 // Score each suggestion against keywords
 const scored = index.map(item => {
 const subTab = item.subTab || item.tab;
 const sectionKws = SECTION_KEYWORDS[subTab] || [];
 const titleWords = item.title.toLowerCase().split(/\s+/);
 const allTargets = [...titleWords, ...sectionKws];
 const s = scoreMatch(keywords, allTargets);

 // Boost content-type-matching suggestions
 let boost = 0;
 if (contentType === 'article' && item.tab === 'blog') boost = 2;
 if (contentType === 'job' && (item.tab === 'job-board' || item.subTab === 'jobs')) boost = 2;
 if (contentType === 'guide' && item.tab === 'guida') boost = 2;

 return { ...item, score: s + boost };
 });

 // Sort by score descending, take top 4
 scored.sort((a, b) => b.score - a.score);

 // Always include at least some results
 const top = scored.slice(0, 4);

 // If no scores at all, return popular pages as fallback
 if (top.every(s => s.score === 0)) {
 return scored.filter(s => ['calculator', 'job-board', 'blog', 'guida'].includes(s.tab === 'confronti' ? (s.subTab || s.tab) : s.tab)).slice(0, 4);
 }

 return top;
 }, [keywords, contentType, t]);

 const contextMessage = contentType === 'job'
 ? t('notFound.jobExpired')
 : contentType === 'article'
 ? t('notFound.articleMoved')
 : null;

 useEffect(() => {
 if (typeof window === 'undefined') return;
 Analytics.trackEvent('not_found_view', {
 not_found_path: path,
 not_found_url: window.location.href,
 not_found_referrer: document.referrer || '(none)',
 content_type: contentType,
 });
 }, [path, contentType]);

 return (
 <div className="max-w-2xl mx-auto py-8 sm:py-12 px-4">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-surface-raised mb-4">
 <SearchX size={32} className="text-muted" />
 </div>
 <h1 className="text-2xl font-bold font-display text-heading mb-2">
 {t('notFound.title')}
 </h1>
 <p className="text-subtle text-sm max-w-md mx-auto">
 {t('notFound.subtitle')}
 </p>
 {contextMessage && (
 <p className="mt-2 text-xs text-warning bg-warning-subtle rounded-lg px-3 py-1.5 inline-block">
 {contextMessage}
 </p>
 )}
 <div
 data-testid="not-found-url"
 className="mt-4 mx-auto max-w-xl text-left bg-surface-alt border border-edge rounded-lg px-3 py-2"
 >
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 URL
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {typeof window !== 'undefined' ? window.location.href : path}
 </code>
 </div>
 </div>

 {/* Suggestions */}
 {suggestions.length > 0 && (
 <div className="mb-8">
 <h2 className="text-lg font-semibold font-display text-heading mb-4">
 {t('notFound.suggestionsTitle')}
 </h2>
 <div className="space-y-3">
 {suggestions.map((s, i) => (
 <button
 key={`${s.tab}-${s.subTab || i}`}
 onClick={() => onNavigate(s.tab, s.subTab)}
 className="w-full flex items-center gap-4 p-4 bg-surface border border-edge rounded-xl hover:border-accent hover:shadow-sm transition-[color,background-color,border-color,box-shadow] text-left group"
 >
 <div className={`shrink-0 w-10 h-10 rounded-lg bg-surface-alt flex items-center justify-center ${s.color}`}>
 <s.icon size={20} />
 </div>
 <div className="flex-1 min-w-0">
 <p className="font-medium text-heading line-clamp-2">
 {s.title}
 </p>
 {s.description && (
 <p className="text-sm text-muted line-clamp-2">
 {s.description}
 </p>
 )}
 </div>
 <ArrowRight size={16} className="shrink-0 text-muted group-hover:text-accent transition-colors" />
 </button>
 ))}
 </div>
 </div>
 )}

 {/* Popular pages */}
 <div className="mb-6">
 <h2 className="text-sm font-semibold font-display text-muted uppercase tracking-wider mb-3">
 {t('notFound.popularPages')}
 </h2>
 <div className="grid grid-cols-2 gap-2">
 {[
 { label: t('nav.simulator') || 'Simulatore', tab: 'calculator', icon: Calculator },
 { label: t('comparators.jobs') || 'Lavoro Ticino', tab: 'job-board', icon: Briefcase },
 { label: t('nav.blog') || 'Articoli', tab: 'blog', icon: FileText },
 { label: t('guide.tabs.firstDay') || 'Guida', tab: 'guida', subTab: 'first-day', icon: BookOpen },
 ].map(item => (
 <button
 key={item.tab}
 onClick={() => onNavigate(item.tab, item.subTab)}
 className="flex items-center gap-2 px-3 py-2.5 text-sm text-body bg-surface-alt border border-edge rounded-lg hover:bg-surface-raised transition-colors"
 >
 <item.icon size={16} className="text-muted" />
 <span className="truncate">{item.label}</span>
 </button>
 ))}
 </div>
 </div>

 {/* Back home */}
 <div className="text-center">
 <button
 onClick={() => onNavigate('calculator')}
 className="inline-flex items-center gap-2 text-sm text-link hover:text-accent transition-colors"
 >
 <Home size={16} />
 {t('notFound.backHome')}
 </button>
 </div>

 {/* Search hint */}
 <div className="mt-6 text-center">
 <p className="text-sm text-muted flex items-center justify-center gap-1">
 <Search size={12} />
 {t('notFound.searchHint')}
 </p>
 </div>
 </div>
 );
};

export default NotFoundSuggestions;
