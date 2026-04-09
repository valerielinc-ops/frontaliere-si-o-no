import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { BookOpen, Search, ChevronDown, ChevronUp, Tag } from 'lucide-react';
import type { GlossaryTermId } from '@/services/router';
import DataFreshness from '@/components/shared/DataFreshness';

/* ─── Glossary JSON-LD Structured Data ───────────────────────────────────
 * Injects a DefinedTermSet with individual DefinedTerm entries.
 * This enables Google rich snippets for glossary terms, significantly
 * improving organic visibility for definition-related searches like
 * "cos'è l'imposta alla fonte" or "cosa significa permesso G".
 */
function useGlossaryStructuredData(entries: GlossaryEntry[], t: (key: string) => string) {
  useEffect(() => {
    const id = 'glossary-structured-data';
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const definedTerms = entries.map(entry => ({
      '@type': 'DefinedTerm',
      name: t(`glossary.terms.${entry.key}.title`),
      description: t(`glossary.terms.${entry.key}.desc`),
      inDefinedTermSet: {
        '@type': 'DefinedTermSet',
        name: 'Glossario del Frontaliere',
      },
    }));

    const schema = {
      '@context': 'https://schema.org',
      '@type': 'DefinedTermSet',
      name: 'Glossario del Frontaliere - Termini Fiscali, Previdenziali e Legali',
      description: 'Glossario completo dei termini fiscali, previdenziali e legali per i lavoratori frontalieri in Svizzera.',
      url: 'https://frontaliereticino.ch/glossario-frontaliere',
      hasDefinedTerm: definedTerms,
    };

    const script = document.createElement('script');
    script.id = id;
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);

    return () => {
      const el = document.getElementById(id);
      if (el) el.remove();
    };
  }, [entries, t]);
}

interface GlossaryEntry {
  key: string;
  category: 'tax' | 'pension' | 'insurance' | 'legal' | 'finance' | 'work';
}

const GLOSSARY_ENTRIES: GlossaryEntry[] = [
  // Tax
  { key: 'impostaAllaFonte', category: 'tax' },
  { key: 'irpef', category: 'tax' },
  { key: 'franchigia', category: 'tax' },
  { key: 'ristorni', category: 'tax' },
  { key: 'doppiaimposizione', category: 'tax' },
  { key: 'addizionaleRegionale', category: 'tax' },
  { key: 'addizionaleComunale', category: 'tax' },
  { key: 'deduzioni', category: 'tax' },
  { key: 'lohnausweis', category: 'tax' },
  { key: 'cu', category: 'tax' },
  { key: 'ral', category: 'tax' },
  { key: 'modello730', category: 'tax' },
  { key: 'redditiPF', category: 'tax' },
  // Pension
  { key: 'avs', category: 'pension' },
  { key: 'lpp', category: 'pension' },
  { key: 'terzoPilastro', category: 'pension' },
  { key: 'rendita', category: 'pension' },
  { key: 'capitaleLPP', category: 'pension' },
  { key: 'prestazioneLiberoPassaggio', category: 'pension' },
  // Insurance
  { key: 'lamal', category: 'insurance' },
  { key: 'cmu', category: 'insurance' },
  { key: 'ssn', category: 'insurance' },
  { key: 'franchigia_assicurativa', category: 'insurance' },
  { key: 'modelliAssicurativi', category: 'insurance' },
  { key: 'ainp', category: 'insurance' },
  // Legal
  { key: 'permessoG', category: 'legal' },
  { key: 'permessoB', category: 'legal' },
  { key: 'permessoC', category: 'legal' },
  { key: 'permessoL', category: 'legal' },
  { key: 'accordoFrontalieri', category: 'legal' },
  { key: 'nuovoAccordo2024', category: 'legal' },
  // Finance
  { key: 'tassoCambio', category: 'finance' },
  { key: 'multiValuta', category: 'finance' },
  { key: 'bonifico', category: 'finance' },
  { key: 'sepa', category: 'finance' },
  // Work
  { key: 'ccnl', category: 'work' },
  { key: 'ipg', category: 'work' },
  { key: 'ac', category: 'work' },
  { key: 'naspi', category: 'work' },
  { key: 'assegniFamiliari', category: 'work' },
  { key: 'tredicesima', category: 'work' },
];

const CATEGORY_COLORS: Record<string, { bg: string; text: string; darkBg: string; darkText: string }> = {
  tax: { bg: 'bg-blue-100', text: 'text-blue-700', darkBg: 'dark:bg-blue-900/30', darkText: 'dark:text-blue-300' },
  pension: { bg: 'bg-emerald-100', text: 'text-emerald-700', darkBg: 'dark:bg-emerald-900/30', darkText: 'dark:text-emerald-300' },
  insurance: { bg: 'bg-red-100', text: 'text-red-700', darkBg: 'dark:bg-red-900/30', darkText: 'dark:text-red-300' },
  legal: { bg: 'bg-violet-100', text: 'text-violet-700', darkBg: 'dark:bg-violet-900/30', darkText: 'dark:text-violet-300' },
  finance: { bg: 'bg-amber-100', text: 'text-amber-700', darkBg: 'dark:bg-amber-900/30', darkText: 'dark:text-amber-300' },
  work: { bg: 'bg-teal-100', text: 'text-teal-700', darkBg: 'dark:bg-teal-900/30', darkText: 'dark:text-teal-300' },
};

interface GlossaryProps {
  initialEntry?: GlossaryTermId;
}

const Glossary: React.FC<GlossaryProps> = ({ initialEntry }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);

  useEffect(() => {
    if (!initialEntry) return;
    setExpandedEntry(initialEntry);
    // Ensure the entry is in view (use a stable id so the URL is indexable)
    requestAnimationFrame(() => {
      const el = document.getElementById(`glossary-${initialEntry}`);
      el?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
    });
  }, [initialEntry]);

  const categories = useMemo(() => [...new Set(GLOSSARY_ENTRIES.map(e => e.category))], []);

  const filteredEntries = useMemo(() => {
    return GLOSSARY_ENTRIES.filter(entry => {
      if (selectedCategory !== 'all' && entry.category !== selectedCategory) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const title = t(`glossary.terms.${entry.key}.title`).toLowerCase();
        const desc = t(`glossary.terms.${entry.key}.desc`).toLowerCase();
        if (!title.includes(term) && !desc.includes(term) && !entry.key.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [searchTerm, selectedCategory, t]);

  // Inject DefinedTermSet JSON-LD for SEO
  useGlossaryStructuredData(GLOSSARY_ENTRIES, t);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-teal-600 dark:bg-teal-700 rounded-2xl p-4 sm:p-6 text-white" data-speakable>
        <div className="flex items-center gap-3 mb-2">
          <BookOpen size={28} />
          {initialEntry ? (
            <h2 className="text-2xl font-bold">{t('glossary.title')}</h2>
          ) : (
            <h1 className="text-2xl font-bold">{t('glossary.title')}</h1>
          )}
        </div>
        <p className="text-indigo-100 text-sm">{t('glossary.subtitle')}</p>
        <DataFreshness lastUpdated="2026-04" source={t('freshness.source.redazione')} variant="badge" />
      </div>

      {/* H1 for individual term pages */}
      {initialEntry && (
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">
          {t(`glossary.terms.${initialEntry}.title`)}
        </h1>
      )}

      {/* Search and filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder={t('glossary.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
            aria-label={t('glossary.searchPlaceholder')}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => { setSelectedCategory('all'); Analytics.trackGuideSection('glossary', 'view'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              selectedCategory === 'all'
                ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {t('glossary.all')}
          </button>
          {categories.map(cat => {
            const colors = CATEGORY_COLORS[cat];
            return (
              <button
                key={cat}
                onClick={() => { setSelectedCategory(cat); Analytics.trackGuideSection(`glossary_${cat}`, 'view'); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  selectedCategory === cat
                    ? `${colors.bg} ${colors.text} ${colors.darkBg} ${colors.darkText}`
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {t(`glossary.category.${cat}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Entries count */}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {filteredEntries.length} {t('glossary.termsFound')}
      </p>

      {/* Entries */}
      <div className="space-y-2">
        {filteredEntries.length === 0 ? (
          <div className="text-center py-12 text-slate-500 dark:text-slate-400">
            <BookOpen size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-semibold">{t('glossary.noResults')}</p>
          </div>
        ) : (
          filteredEntries.map(entry => {
            const colors = CATEGORY_COLORS[entry.category];
            const isExpanded = expandedEntry === entry.key;
            return (
              <div
                key={entry.key}
                id={`glossary-${entry.key}`}
                className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
              >
                <button
                  onClick={() => { setExpandedEntry(isExpanded ? null : entry.key); if (!isExpanded) Analytics.trackGuideSection(`glossary_${entry.key}`, 'expand'); }}
                  className="w-full flex items-center justify-between p-4 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text} ${colors.darkBg} ${colors.darkText}`}>
                      {t(`glossary.category.${entry.category}`)}
                    </span>
                    <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                      {t(`glossary.terms.${entry.key}.title`)}
                    </span>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={16} className="text-slate-500 dark:text-slate-400" />}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 text-sm text-slate-600 dark:text-slate-400 animate-fade-in border-t border-slate-100 dark:border-slate-700 pt-3">
                    <p>{t(`glossary.terms.${entry.key}.desc`)}</p>
                    {t(`glossary.terms.${entry.key}.example`) !== `glossary.terms.${entry.key}.example` && (
                      <div className="mt-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 text-xs">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{t('glossary.example')}: </span>
                        {t(`glossary.terms.${entry.key}.example`)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default Glossary;
