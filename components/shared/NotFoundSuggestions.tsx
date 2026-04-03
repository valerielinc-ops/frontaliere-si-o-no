import React, { useMemo } from 'react';
import { SearchX, ArrowRight, Home, Briefcase, FileText, BookOpen, Calculator, Search } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

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
function buildSuggestionIndex(t: (key: string) => string): Suggestion[] {
  return [
    { title: t('nav.simulator') || 'Simulatore', description: t('app.subtitle'), tab: 'calculator', icon: Calculator, color: 'text-blue-600', score: 0 },
    { title: t('comparators.exchange') || 'Cambio Valuta', description: t('notFound.desc.exchange'), tab: 'confronti', subTab: 'exchange', icon: Calculator, color: 'text-violet-600', score: 0 },
    { title: t('comparators.health') || 'Assicurazione Sanitaria', description: t('notFound.desc.health'), tab: 'confronti', subTab: 'health', icon: Calculator, color: 'text-emerald-600', score: 0 },
    { title: t('comparators.jobs') || 'Offerte Lavoro', description: t('notFound.desc.jobs'), tab: 'job-board', icon: Briefcase, color: 'text-amber-600', score: 0 },
    { title: t('nav.blog') || 'Articoli', description: t('notFound.desc.articles'), tab: 'blog', icon: FileText, color: 'text-rose-600', score: 0 },
    { title: t('guide.tabs.firstDay') || 'Primo Giorno', description: t('notFound.desc.guide'), tab: 'guida', subTab: 'first-day', icon: BookOpen, color: 'text-indigo-600', score: 0 },
    { title: t('guide.tabs.permits') || 'Permessi', description: t('notFound.desc.permits'), tab: 'guida', subTab: 'permits', icon: BookOpen, color: 'text-indigo-600', score: 0 },
    { title: t('nav.pension') || 'Pensione', description: t('notFound.desc.pension'), tab: 'fisco', subTab: 'pension', icon: Calculator, color: 'text-emerald-600', score: 0 },
    { title: t('withholdingRates.navLabel') || 'Aliquote alla Fonte', description: t('notFound.desc.withholding'), tab: 'fisco', subTab: 'withholding-rates', icon: Calculator, color: 'text-emerald-600', score: 0 },
    { title: t('comparators.shopping') || 'Spesa Transfrontaliera', description: t('notFound.desc.shopping'), tab: 'confronti', subTab: 'shopping', icon: Calculator, color: 'text-violet-600', score: 0 },
    { title: t('comparators.borderMap') || 'Mappa Dogane', description: t('notFound.desc.borderMap'), tab: 'guida', subTab: 'border-map', icon: BookOpen, color: 'text-indigo-600', score: 0 },
    { title: t('comparators.taxReturn') || 'Dichiarazione Fiscale', description: t('notFound.desc.taxReturn'), tab: 'fisco', subTab: 'tax-return', icon: Calculator, color: 'text-emerald-600', score: 0 },
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

  return (
    <div className="max-w-2xl mx-auto py-8 sm:py-12 px-4">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-800 mb-4">
          <SearchX size={32} className="text-slate-500 dark:text-slate-400" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          {t('notFound.title')}
        </h1>
        <p className="text-slate-600 dark:text-slate-400 text-sm max-w-md mx-auto">
          {t('notFound.subtitle')}
        </p>
        {contextMessage && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-lg px-3 py-1.5 inline-block">
            {contextMessage}
          </p>
        )}
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
            {t('notFound.suggestionsTitle')}
          </h2>
          <div className="space-y-3">
            {suggestions.map((s, i) => (
              <button
                key={`${s.tab}-${s.subTab || i}`}
                onClick={() => onNavigate(s.tab, s.subTab)}
                className="w-full flex items-center gap-4 p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-sm transition-all text-left group"
              >
                <div className={`shrink-0 w-10 h-10 rounded-lg bg-slate-50 dark:bg-slate-700 flex items-center justify-center ${s.color}`}>
                  <s.icon size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 dark:text-white truncate">
                    {s.title}
                  </p>
                  {s.description && (
                    <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                      {s.description}
                    </p>
                  )}
                </div>
                <ArrowRight size={16} className="shrink-0 text-slate-500 group-hover:text-blue-500 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Popular pages */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
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
              className="flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <item.icon size={16} className="text-slate-500" />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Back home */}
      <div className="text-center">
        <button
          onClick={() => onNavigate('calculator')}
          className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          <Home size={16} />
          {t('notFound.backHome')}
        </button>
      </div>

      {/* Search hint */}
      <div className="mt-6 text-center">
        <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-1">
          <Search size={12} />
          {t('notFound.searchHint')}
        </p>
      </div>
    </div>
  );
};

export default NotFoundSuggestions;
