import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, X, ArrowRight, Calculator, Layers, PiggyBank, BookOpen, BarChart2, HelpCircle, ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Briefcase, ShoppingCart, Euro, TrendingUp, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface SearchResult {
  id: string;
  title: string;
  description: string;
  section: string;
  tab: string;
  subTab?: string;
  icon: React.ElementType;
  color: string;
  keywords: string[];
}

interface SiteSearchProps {
  onNavigate: (tab: string, subTab?: string) => void;
}

const SiteSearch: React.FC<SiteSearchProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Build the search index with all site sections
  const searchIndex: SearchResult[] = useMemo(() => [
    // Simulator
    {
      id: 'calculator',
      title: t('nav.simulator') || 'Simulatore',
      description: t('app.subtitle') || 'Calcola e confronta il tuo stipendio netto come lavoratore frontaliero',
      section: t('nav.simulator') || 'Simulatore',
      tab: 'calculator',
      icon: Calculator,
      color: 'text-blue-600',
      keywords: ['simulatore', 'calcolo', 'stipendio', 'netto', 'lordo', 'salario', 'ral', 'simulator', 'calculator', 'salary', 'net', 'gross', 'gehalt', 'simulateur', 'salaire'],
    },
    {
      id: 'whatif',
      title: t('simulator.whatif') || 'Cosa cambia se...',
      description: 'Simula scenari diversi: cambio stipendio, figli, residenza, stato civile',
      section: t('nav.simulator') || 'Simulatore',
      tab: 'calculator',
      subTab: 'whatif',
      icon: Sparkles,
      color: 'text-blue-500',
      keywords: ['cosa cambia', 'what if', 'scenario', 'simulazione', 'figli', 'stipendio', 'residenza', 'bambini', 'kinder', 'enfants', 'children'],
    },
    // Comparators
    {
      id: 'exchange',
      title: t('comparators.exchange') || 'Cambio Valuta',
      description: 'Convertitore CHF/EUR in tempo reale, statistiche tassi, provider a confronto',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'exchange',
      icon: ArrowRightLeft,
      color: 'text-violet-600',
      keywords: ['cambio', 'valuta', 'euro', 'franco', 'chf', 'eur', 'exchange', 'currency', 'tasso', 'rate', 'convertitore', 'wise', 'revolut', 'wechselkurs', 'devise'],
    },
    {
      id: 'traffic',
      title: t('comparators.traffic') || 'Traffico Valichi',
      description: 'Situazione traffico in tempo reale ai valichi di frontiera Italia-Svizzera',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'traffic',
      icon: AlertTriangle,
      color: 'text-amber-600',
      keywords: ['traffico', 'valichi', 'dogana', 'frontiera', 'chiasso', 'como', 'ponte tresa', 'stabio', 'border', 'traffic', 'crossing', 'grenze', 'douane', 'attesa', 'coda'],
    },
    {
      id: 'mobile',
      title: t('comparators.mobile') || 'Operatori Mobile',
      description: 'Confronto piani mobile Italia vs Svizzera: copertura, roaming, prezzi',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'mobile',
      icon: Phone,
      color: 'text-green-600',
      keywords: ['mobile', 'telefono', 'operatore', 'sim', 'roaming', 'swisscom', 'salt', 'sunrise', 'iliad', 'vodafone', 'tim', 'handy', 'portable'],
    },
    {
      id: 'banks',
      title: t('comparators.banks') || 'Banche',
      description: 'Confronto conti bancari per frontalieri: spese, cambio, multi-valuta',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'banks',
      icon: Building2,
      color: 'text-slate-600',
      keywords: ['banca', 'conto', 'bank', 'account', 'ubs', 'credit suisse', 'postfinance', 'wise', 'revolut', 'n26', 'banque', 'konto'],
    },
    {
      id: 'health',
      title: t('comparators.health') || 'Assicurazione Sanitaria',
      description: 'Confronto assicurazioni sanitarie LAMAL per frontalieri',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'health',
      icon: Heart,
      color: 'text-red-500',
      keywords: ['assicurazione', 'sanitaria', 'lamal', 'health', 'insurance', 'cassa malati', 'ssn', 'santé', 'krankenversicherung', 'medical'],
    },
    {
      id: 'transport',
      title: t('comparators.transport') || 'Trasporti',
      description: 'Calcola costi pendolarismo: auto, treno, abbonamenti, carburante',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'transport',
      icon: Car,
      color: 'text-teal-600',
      keywords: ['trasporto', 'pendolare', 'treno', 'auto', 'benzina', 'abbonamento', 'arcobaleno', 'tilo', 'transport', 'commute', 'train', 'car', 'transport', 'pendeln'],
    },
    {
      id: 'jobs',
      title: t('comparators.jobs') || 'Lavoro',
      description: 'Confronta offerte di lavoro e stipendi in Ticino',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'jobs',
      icon: Briefcase,
      color: 'text-indigo-600',
      keywords: ['lavoro', 'job', 'offerta', 'stipendio', 'impiego', 'ccnl', 'contratto', 'arbeit', 'emploi', 'salary', 'gehalt', 'salaire'],
    },
    {
      id: 'shopping',
      title: t('comparators.shopping') || 'Spesa',
      description: 'Confronto prezzi spesa quotidiana Italia vs Svizzera',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'shopping',
      icon: ShoppingCart,
      color: 'text-orange-600',
      keywords: ['spesa', 'shopping', 'prezzi', 'supermercato', 'migros', 'coop', 'lidl', 'einkauf', 'courses', 'supermarché'],
    },
    {
      id: 'cost-of-living',
      title: t('comparators.costOfLiving') || 'Costo della vita',
      description: 'Confronto costo della vita tra Italia e Svizzera',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'cost-of-living',
      icon: Euro,
      color: 'text-emerald-600',
      keywords: ['costo vita', 'affitto', 'rent', 'cost of living', 'lebenshaltungskosten', 'coût de la vie', 'bollette', 'utilities'],
    },
    // Pension
    {
      id: 'pension-planner',
      title: t('pension.planner') || 'Pensione',
      description: 'Pianifica la tua pensione: AVS, LPP, contributi 1° e 2° pilastro',
      section: t('nav.pension') || 'Pensione',
      tab: 'pension',
      subTab: 'planner',
      icon: PiggyBank,
      color: 'text-emerald-600',
      keywords: ['pensione', 'avs', 'lpp', 'pilastro', 'contributi', 'pension', 'retirement', 'rente', 'retraite', 'ahv', 'bvg'],
    },
    {
      id: 'pillar3',
      title: t('pension.pillar3') || '3° Pilastro',
      description: 'Simulatore terzo pilastro 3a: deduzioni fiscali, rendimenti, provider',
      section: t('nav.pension') || 'Pensione',
      tab: 'pension',
      subTab: 'pillar3',
      icon: TrendingUp,
      color: 'text-emerald-500',
      keywords: ['pilastro', 'pillar', '3a', 'terzo', 'risparmio', 'deduzione', 'fiscale', 'viac', 'frankly', 'säule', 'pilier', 'savings', 'tax deduction'],
    },
    // Guide
    {
      id: 'guide',
      title: t('nav.guide') || 'Guida',
      description: 'Guida completa per frontalieri: permessi, dogane, comuni, tasse',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      icon: BookOpen,
      color: 'text-indigo-600',
      keywords: ['guida', 'guide', 'permesso', 'permit', 'dogana', 'customs', 'comune', 'municipality', 'tasse', 'taxes', 'frontaliere', 'cross-border', 'grenzgänger', 'frontalier'],
    },
    // Stats
    {
      id: 'stats',
      title: t('nav.stats') || 'Statistiche',
      description: 'Statistiche e dati sui lavoratori frontalieri in Ticino',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      icon: BarChart2,
      color: 'text-purple-600',
      keywords: ['statistiche', 'dati', 'numeri', 'statistics', 'data', 'numbers', 'statistik', 'statistiques', 'grafico', 'chart'],
    },
    // Feedback
    {
      id: 'feedback',
      title: t('nav.support') || 'Supporto',
      description: 'Invia feedback, segnala bug, richiedi funzionalità',
      section: t('nav.support') || 'Supporto',
      tab: 'feedback',
      icon: HelpCircle,
      color: 'text-amber-600',
      keywords: ['feedback', 'supporto', 'bug', 'aiuto', 'help', 'support', 'segnala', 'report', 'hilfe', 'aide'],
    },
  ], [t]);

  // Fuzzy search function
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    
    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/);
    
    const scored = searchIndex.map(item => {
      let score = 0;
      const titleLower = item.title.toLowerCase();
      const descLower = item.description.toLowerCase();
      const keywordsStr = item.keywords.join(' ').toLowerCase();
      
      for (const word of words) {
        // Exact title match = highest priority
        if (titleLower.includes(word)) score += 10;
        // Keyword match
        if (keywordsStr.includes(word)) score += 5;
        // Description match
        if (descLower.includes(word)) score += 3;
        // Section match
        if (item.section.toLowerCase().includes(word)) score += 2;
      }
      
      return { ...item, score };
    });
    
    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [query, searchIndex]);

  // Keyboard shortcut: Cmd+K / Ctrl+K to open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setQuery('');
    }
  }, [isOpen]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = useCallback((result: SearchResult) => {
    setIsOpen(false);
    setQuery('');
    onNavigate(result.tab, result.subTab);
  }, [onNavigate]);

  // Handle keyboard navigation
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && searchResults[selectedIndex]) {
      e.preventDefault();
      handleSelect(searchResults[selectedIndex]);
    }
  }, [searchResults, selectedIndex, handleSelect]);

  return (
    <>
      {/* Search trigger button */}
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 transition-all"
        title="Search (⌘K)"
      >
        <Search size={14} />
        <span className="hidden sm:inline text-xs">{t('search.placeholder') || 'Cerca...'}</span>
        <kbd className="hidden md:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-600">
          ⌘K
        </kbd>
      </button>

      {/* Search modal overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 bg-black/40 backdrop-blur-sm animate-fade-in">
          <div
            ref={modalRef}
            className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-slide-up"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <Search size={18} className="text-slate-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('search.placeholder') || 'Cerca sezioni, strumenti, funzionalità...'}
                className="flex-1 bg-transparent text-slate-800 dark:text-slate-100 placeholder-slate-400 outline-none text-sm"
              />
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded"
              >
                <X size={16} />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-[50vh] overflow-y-auto">
              {query.trim() === '' ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">
                  <p>{t('search.hint') || 'Digita per cercare tra tutte le sezioni del sito'}</p>
                  <p className="text-xs mt-1 text-slate-300 dark:text-slate-500">
                    {t('search.examples') || 'Es: "cambio valuta", "pensione", "traffico", "lavoro"'}
                  </p>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">
                  {t('search.noResults') || 'Nessun risultato trovato'}
                </div>
              ) : (
                <div className="py-2">
                  {searchResults.map((result, index) => {
                    const Icon = result.icon;
                    return (
                      <button
                        key={result.id}
                        onClick={() => handleSelect(result)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                          index === selectedIndex
                            ? 'bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className={`p-2 rounded-lg bg-slate-100 dark:bg-slate-800 ${result.color} flex-shrink-0`}>
                          <Icon size={16} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                              {result.title}
                            </span>
                            <span className="text-[10px] uppercase tracking-wider text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded flex-shrink-0">
                              {result.section}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            {result.description}
                          </p>
                        </div>
                        <ArrowRight size={14} className="text-slate-300 flex-shrink-0" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">↑↓</kbd>
                  {t('search.navigate') || 'naviga'}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">↵</kbd>
                  {t('search.select') || 'seleziona'}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">esc</kbd>
                  {t('search.close') || 'chiudi'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SiteSearch;
