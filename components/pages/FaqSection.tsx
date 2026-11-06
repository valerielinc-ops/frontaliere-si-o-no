import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation, loadNamespaceTranslations } from '@/services/i18n';
import { TranslationNamespaceGate } from '@/components/shared/TranslationNamespaceGate';
import { HelpCircle, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { classifyFaqSearchCategory } from '@/services/privacy/faqSearchCategory';

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
const QUESTIONS_PER_CATEGORY = 8;

const FaqSection: React.FC = () => {
 const { t } = useTranslation();
 const [searchTerm, setSearchTerm] = useState('');
 const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
 const [selectedCategory, setSelectedCategory] = useState<string>('all');
 const lastTrackedSearchRef = useRef('');

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
 Analytics.trackPageView('/faq/', 'FAQ');
 Analytics.trackUIInteraction('faq', 'page', 'faq_section', 'view');
 }, []);

 useEffect(() => {
 // Skip if a static FAQPage JSON-LD already exists (from staticPagesPlugin)
 // to avoid Google's"duplicate FAQPage" rich results error.
 const hasStaticFaqPage = Array.from(
 document.querySelectorAll('script[type="application/ld+json"]:not([data-dynamic-ld])')
 ).some(el => {
 if (el.id === 'faq-jsonld') return false;
 try { return JSON.parse(el.textContent || '')?.['@type'] === 'FAQPage'; } catch { return false; }
 });
 if (hasStaticFaqPage) return;

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

 const normalizedSearchTerm = searchTerm.trim().toLowerCase();
 const matchesSearch = (question: typeof allQuestions[number]) => (
  !normalizedSearchTerm
  || question.question.toLowerCase().includes(normalizedSearchTerm)
  || question.answer.toLowerCase().includes(normalizedSearchTerm)
 );
 const matchingQuestions = allQuestions.filter(matchesSearch);
 const filteredQuestions = matchingQuestions.filter(question => (
  selectedCategory === 'all' || question.category === selectedCategory
 ));

 const trackSafeSearchCategory = () => {
 const query = searchTerm.trim();
 if (query.length < 3 || query === lastTrackedSearchRef.current) return;
 lastTrackedSearchRef.current = query;
 const category = classifyFaqSearchCategory(query);
 // Keep the search text local; Firebase receives only a closed category and outcome event.
 Analytics.trackExperimentEvent('faq_search_category', { faq_category: category });
 if (matchingQuestions.length === 0) {
  Analytics.trackExperimentEvent('faq_search_no_results', { faq_category: category });
 }
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-r from-info-strong to-success-strong rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <HelpCircle size={28} />
 <h2 className="text-2xl font-bold font-display">{t('faq.title')}</h2>
 </div>
 <p className="text-on-accent text-sm">{t('faq.subtitle')}</p>
 </div>

 {/* Search */}
 <div className="relative">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input
 type="text"
 value={searchTerm}
 onChange={e => {
 const value = e.target.value;
 if (value.trim() !== lastTrackedSearchRef.current) lastTrackedSearchRef.current = '';
 setSearchTerm(value);
 }}
 onBlur={trackSafeSearchCategory}
 onKeyDown={e => {
 if (e.key === 'Enter') trackSafeSearchCategory();
 }}
 placeholder={t('faq.searchPlaceholder')}
 className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-edge bg-surface-alt text-base text-strong"
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
 ? 'bg-accent-strong text-on-accent'
 : 'bg-surface text-subtle border border-edge hover:bg-surface-raised'
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
 ? 'bg-accent-strong text-on-accent'
 : 'bg-surface text-subtle border border-edge hover:bg-surface-raised'
 }`}
 >
 {cat.icon} {t(`faq.categories.${cat.key}`)}
 </button>
 ))}
 </div>

 {/* Results count */}
 <p className="text-xs text-muted">
 {filteredQuestions.length} {t('faq.questionsFound')}
 </p>

 {/* Questions */}
 <div className="space-y-2">
 {filteredQuestions.length === 0 ? (
 <div className="text-center py-12 text-muted">
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
 className="bg-surface rounded-xl border border-edge overflow-hidden"
 >
 <button
 onClick={() => {
 const nextExpanded = isExpanded ? null : q.id;
 setExpandedQuestion(nextExpanded);
         if (!isExpanded && searchTerm.trim().length >= 3) {
          Analytics.trackExperimentEvent('faq_search_answer_opened', {
           faq_category: classifyFaqSearchCategory(searchTerm.trim()),
          });
         }
 Analytics.trackGuideSection(`faq_${q.category}`, isExpanded ? 'link_click' : 'expand');
 Analytics.trackUIInteraction('faq', 'question', q.id, isExpanded ? 'collapse' : 'expand');
 }}
 className="w-full flex items-start gap-3 p-4 text-left"
 >
 <span className="text-lg shrink-0 mt-0.5">{catInfo?.icon}</span>
 <span className="flex-1 font-semibold text-sm text-strong">{q.question}</span>
 {isExpanded ? <ChevronUp size={16} className="text-muted shrink-0 mt-0.5" /> : <ChevronDown size={16} className="text-muted shrink-0 mt-0.5" />}
 </button>
 {isExpanded && (
 <div className="px-4 pb-4 ml-10 text-sm text-subtle animate-fade-in border-t border-edge pt-3">
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

// Questions, answers and page copy are the on-demand "faq" namespace
// (services/locales/<locale>-ns-faq.ts). The request starts as soon as this
// lazy module is evaluated, in parallel with the render, not after it.
void loadNamespaceTranslations('faq');

const FaqSectionWithStrings: React.FC = () => (
 <TranslationNamespaceGate namespace="faq">
 <FaqSection />
 </TranslationNamespaceGate>
);

export default FaqSectionWithStrings;
