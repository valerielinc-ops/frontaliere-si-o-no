import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { HelpCircle, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Analytics } from '@/services/analytics';

interface FaqCategory {
  key: string;
  icon: string;
}

const FAQ_CATEGORIES: FaqCategory[] = [
  { key: 'taxes', icon: '💰' },
  { key: 'permits', icon: '📄' },
  { key: 'health', icon: '🏥' },
  { key: 'pension', icon: '🏦' },
  { key: 'daily', icon: '🚗' },
  { key: 'family', icon: '👨‍👩‍👧' },
];

// Number of Q&A per category
const QUESTIONS_PER_CATEGORY = 5;

const FaqSection: React.FC = () => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const allQuestions = useMemo(() => FAQ_CATEGORIES.flatMap(cat =>
    Array.from({ length: QUESTIONS_PER_CATEGORY }, (_, i) => ({
      id: `${cat.key}-${i + 1}`,
      category: cat.key,
      question: t(`faq.questions.${cat.key}.q${i + 1}`),
      answer: t(`faq.questions.${cat.key}.a${i + 1}`),
    }))
  ), [t]);

  // Inject FAQPage JSON-LD structured data for SEO
  useEffect(() => {
    Analytics.trackPageView('/faq', 'FAQ');
    Analytics.trackUIInteraction('faq', 'page', 'faq_section', 'view');
  }, []);

  useEffect(() => {
    const faqJsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: allQuestions.map(q => ({
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: q.answer,
        },
      })),
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'faq-jsonld';
    script.textContent = JSON.stringify(faqJsonLd);
    // Remove any existing FAQ JSON-LD before adding new one
    document.getElementById('faq-jsonld')?.remove();
    document.head.appendChild(script);
    return () => { document.getElementById('faq-jsonld')?.remove(); };
  }, [allQuestions]);

  const filteredQuestions = allQuestions.filter(q => {
    if (selectedCategory !== 'all' && q.category !== selectedCategory) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      if (!q.question.toLowerCase().includes(term) && !q.answer.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-2xl p-4 sm:p-6 text-white">
        <div className="flex items-center gap-3 mb-2">
          <HelpCircle size={28} />
          <h2 className="text-2xl font-bold">{t('faq.title')}</h2>
        </div>
        <p className="text-blue-100 text-sm">{t('faq.subtitle')}</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
        <input
          type="text"
          value={searchTerm}
          onChange={e => {
            const value = e.target.value;
            setSearchTerm(value);
            if (value.trim().length >= 3) {
              Analytics.trackSearch(value.trim());
              Analytics.trackUIInteraction('faq', 'search', 'faq_search', 'input', value.trim().slice(0, 64));
            }
          }}
          placeholder={t('faq.searchPlaceholder')}
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
          aria-label={t('faq.searchPlaceholder')}
        />
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => {
            setSelectedCategory('all');
            Analytics.trackUIInteraction('faq', 'filter', 'category', 'all');
          }}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            selectedCategory === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
          }`}
        >
          {t('faq.allCategories')}
        </button>
        {FAQ_CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => {
              setSelectedCategory(cat.key);
              Analytics.trackUIInteraction('faq', 'filter', 'category', 'select', cat.key);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              selectedCategory === cat.key
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            {cat.icon} {t(`faq.categories.${cat.key}`)}
          </button>
        ))}
      </div>

      {/* Results count */}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {filteredQuestions.length} {t('faq.questionsFound')}
      </p>

      {/* Questions */}
      <div className="space-y-2">
        {filteredQuestions.length === 0 ? (
          <div className="text-center py-12 text-slate-500 dark:text-slate-400">
            <HelpCircle size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-semibold">{t('faq.noResults')}</p>
          </div>
        ) : (
          filteredQuestions.map(q => {
            const isExpanded = expandedQuestion === q.id;
            const catInfo = FAQ_CATEGORIES.find(c => c.key === q.category);
            return (
              <div
                key={q.id}
                className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
              >
                <button
                  onClick={() => {
                    const nextExpanded = isExpanded ? null : q.id;
                    setExpandedQuestion(nextExpanded);
                    Analytics.trackGuideSection(`faq_${q.category}`, isExpanded ? 'link_click' : 'expand');
                    Analytics.trackUIInteraction('faq', 'question', q.id, isExpanded ? 'collapse' : 'expand');
                  }}
                  className="w-full flex items-start gap-3 p-4 text-left"
                >
                  <span className="text-lg shrink-0 mt-0.5">{catInfo?.icon}</span>
                  <span className="flex-1 font-semibold text-sm text-slate-800 dark:text-slate-200">{q.question}</span>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" /> : <ChevronDown size={16} className="text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" />}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 ml-10 text-sm text-slate-600 dark:text-slate-400 animate-fade-in border-t border-slate-100 dark:border-slate-700 pt-3">
                    {q.answer}
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

export default FaqSection;
