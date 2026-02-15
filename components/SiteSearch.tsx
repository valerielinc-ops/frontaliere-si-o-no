import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, ArrowRight, Calculator, Layers, PiggyBank, BookOpen, BarChart2, HelpCircle, ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Briefcase, ShoppingCart, Euro, TrendingUp, Sparkles, MapPin, Calendar, PartyPopper, FileText, GraduationCap, Building, Compass, BriefcaseBusiness, MessageSquare, Map, Baby, Award, LayoutDashboard, Scale, Home } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface SearchResult {
  id: string;
  title: string;
  description: string;
  section: string;
  tab: string;
  subTab?: string;
  guideSection?: string;
  icon: React.ElementType;
  color: string;
  keywords: string[];
}

interface SiteSearchProps {
  onNavigate: (tab: string, subTab?: string, guideSection?: string) => void;
}

const SiteSearch: React.FC<SiteSearchProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Build the search index with ALL site sections including guide sub-sections
  const searchIndex: SearchResult[] = useMemo(() => [
    // ─── Simulator ───
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
    // ─── Comparators ───
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
      keywords: ['trasporto', 'pendolare', 'treno', 'auto', 'benzina', 'abbonamento', 'arcobaleno', 'tilo', 'transport', 'commute', 'train', 'car', 'pendeln'],
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
    {
      id: 'ral',
      title: t('comparators.ral') || 'Confronto RAL',
      description: 'Confronta la tua RAL italiana con lo stipendio svizzero equivalente',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'ral',
      icon: Scale,
      color: 'text-cyan-600',
      keywords: ['ral', 'stipendio', 'confronto', 'salario', 'lordo', 'annuo', 'comparison', 'salary', 'gross', 'vergleich', 'comparaison', 'italia', 'svizzera'],
    },
    {
      id: 'parental-leave',
      title: t('comparators.parentalLeave') || 'Congedo Parentale',
      description: 'Calcola indennità congedo maternità e paternità per frontalieri',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'parental-leave',
      icon: Baby,
      color: 'text-pink-600',
      keywords: ['congedo', 'maternità', 'paternità', 'parentale', 'parental', 'leave', 'maternity', 'paternity', 'indennità', 'mutterschutz', 'congé'],
    },
    {
      id: 'border-map',
      title: t('comparators.borderMap') || 'Mappa Interattiva Comuni',
      description: 'Mappa interattiva dei comuni frontalieri con dati IRPEF, affitti e distanze',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'border-map',
      icon: Map,
      color: 'text-teal-600',
      keywords: ['mappa', 'map', 'comuni', 'municipalities', 'interattiva', 'interactive', 'irpef', 'affitto', 'rent', 'distanza', 'karte', 'carte', 'confine', 'border'],
    },
    {
      id: 'residency',
      title: t('comparators.residency') || 'Simulatore Residenza',
      description: 'Simula il costo della vita come residente in Svizzera vs frontaliere',
      section: t('nav.comparators') || 'Comparatori',
      tab: 'comparatori',
      subTab: 'residency',
      icon: Home,
      color: 'text-blue-600',
      keywords: ['residenza', 'residency', 'trasferimento', 'svizzera', 'switzerland', 'costo vita', 'affitto', 'wohnsitz', 'résidence', 'permesso B', 'vivere'],
    },
    // ─── Pension ───
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
    // ─── Guide — all sub-sections ───
    {
      id: 'guide',
      title: t('nav.guide') || 'Guida',
      description: 'Guida completa per frontalieri: permessi, dogane, comuni, tasse',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      icon: BookOpen,
      color: 'text-indigo-600',
      keywords: ['guida', 'guide', 'frontaliere', 'cross-border', 'grenzgänger', 'frontalier', 'informazioni', 'info'],
    },
    {
      id: 'guide-municipalities',
      title: t('guide.tabs.municipalities') || 'Comuni Frontalieri',
      description: 'Lista comuni italiani di confine e ristorni fiscali dalla Svizzera',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'municipalities',
      icon: MapPin,
      color: 'text-indigo-500',
      keywords: ['comuni', 'municipalities', 'confine', 'ristorni', 'gemeinden', 'communes', 'frontiera', 'border towns', 'fascia', '20km'],
    },
    {
      id: 'guide-border',
      title: t('guide.tabs.border') || 'Dogane & Tempi',
      description: 'Valichi doganali, orari apertura, tempi di attesa, documenti necessari',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'border',
      icon: AlertTriangle,
      color: 'text-amber-500',
      keywords: ['dogana', 'customs', 'valico', 'border', 'passaporto', 'documenti', 'orari', 'zoll', 'douane', 'checkpoint'],
    },
    {
      id: 'guide-living-ch',
      title: t('guide.tabs.livingCH') || 'Vivere in CH',
      description: 'Informazioni per chi vive o vuole trasferirsi in Svizzera',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'living-ch',
      icon: Building,
      color: 'text-red-500',
      keywords: ['vivere', 'svizzera', 'switzerland', 'trasferirsi', 'residenza', 'affitto', 'schweiz', 'suisse', 'abitare', 'leben'],
    },
    {
      id: 'guide-living-it',
      title: t('guide.tabs.livingIT') || 'Vivere in IT',
      description: 'Informazioni per frontalieri residenti in Italia',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'living-it',
      icon: Building,
      color: 'text-green-600',
      keywords: ['vivere', 'italia', 'italy', 'residenza', 'italiana', 'abitare', 'italien', 'italie', 'casa'],
    },
    {
      id: 'guide-calendar',
      title: t('guide.tabs.calendar') || 'Scadenze Fiscali',
      description: 'Calendario scadenze fiscali per frontalieri: dichiarazioni, acconti, saldi',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'calendar',
      icon: Calendar,
      color: 'text-blue-600',
      keywords: ['scadenze', 'fiscali', 'calendario', 'calendar', 'dichiarazione', 'redditi', 'tax deadline', 'steuer', 'impôts', 'unico', '730', 'acconto', 'saldo'],
    },
    {
      id: 'guide-holidays',
      title: t('guide.tabs.holidays') || 'Festività Ticino',
      description: 'Calendario festività cantonali, federali e italiane per frontalieri',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'holidays',
      icon: PartyPopper,
      color: 'text-pink-500',
      keywords: ['festività', 'holidays', 'feste', 'feiertage', 'jours fériés', 'vacanze', 'ticino', 'canton', 'natale', 'pasqua', 'ferragosto', 'capodanno'],
    },
    {
      id: 'guide-permits',
      title: t('guide.tabs.permits') || 'Permessi Lavoro',
      description: 'Tipologie permessi di lavoro: G, B, C, L — requisiti e rinnovi',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'permits',
      icon: FileText,
      color: 'text-slate-600',
      keywords: ['permesso', 'lavoro', 'permit', 'G', 'frontaliero', 'bewilligung', 'autorisation', 'permis', 'rinnovo', 'scadenza'],
    },
    {
      id: 'guide-companies',
      title: t('guide.tabs.companies') || 'Aziende Ticino',
      description: 'Principali aziende e datori di lavoro nel Canton Ticino',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'companies',
      icon: BriefcaseBusiness,
      color: 'text-cyan-600',
      keywords: ['aziende', 'companies', 'datore', 'employer', 'ticino', 'unternehmen', 'entreprise', 'lavoro', 'impresa'],
    },
    {
      id: 'guide-places',
      title: t('guide.tabs.places') || 'Posti da Visitare',
      description: 'Luoghi di interesse, escursioni e attività nel Canton Ticino',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'places',
      icon: Compass,
      color: 'text-teal-500',
      keywords: ['posti', 'visitare', 'places', 'visit', 'turismo', 'tourism', 'escursioni', 'ausflüge', 'excursions', 'lugano', 'locarno', 'bellinzona'],
    },
    {
      id: 'guide-schools',
      title: t('guide.tabs.schools') || 'Scuole in Ticino',
      description: 'Scuole internazionali, asili e istituti nel Canton Ticino',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'schools',
      icon: GraduationCap,
      color: 'text-purple-500',
      keywords: ['scuola', 'school', 'scuole', 'asilo', 'kindergarten', 'schule', 'école', 'istruzione', 'education'],
    },
    {
      id: 'guide-unemployment',
      title: t('guide.tabs.unemployment') || 'Disoccupazione',
      description: 'Indennità disoccupazione per frontalieri: NASPI, regole, requisiti',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'unemployment',
      icon: BriefcaseBusiness,
      color: 'text-rose-600',
      keywords: ['disoccupazione', 'unemployment', 'naspi', 'licenziamento', 'arbeitslosigkeit', 'chômage', 'indennità', 'sussidio'],
    },
    {
      id: 'guide-first-day',
      title: t('guide.tabs.firstDay') || 'Primo Giorno',
      description: 'Guida al primo giorno di lavoro come frontaliere in Svizzera',
      section: t('nav.guide') || 'Guida',
      tab: 'guide',
      guideSection: 'first-day',
      icon: Compass,
      color: 'text-orange-600',
      keywords: ['primo giorno', 'first day', 'inizio', 'start', 'erster tag', 'premier jour', 'preparazione', 'documenti', 'cosa portare', 'checklist'],
    },
    // ─── Stats ───
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
    // ─── Feedback ───
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
    // ─── Forum ───
    {
      id: 'forum',
      title: t('forum.title') || 'Community Frontalieri',
      description: 'Forum domande e risposte tra frontalieri',
      section: t('forum.title') || 'Community',
      tab: 'forum',
      icon: MessageSquare,
      color: 'text-violet-600',
      keywords: ['forum', 'community', 'domande', 'risposte', 'questions', 'answers', 'fragen', 'antworten', 'communauté', 'aiuto', 'help'],
    },
    // ─── Dashboard ───
    {
      id: 'dashboard',
      title: t('nav.dashboard') || 'Dashboard',
      description: 'Dashboard personale con simulazioni salvate e sincronizzazione cloud',
      section: t('nav.dashboard') || 'Dashboard',
      tab: 'dashboard',
      icon: LayoutDashboard,
      color: 'text-sky-600',
      keywords: ['dashboard', 'personale', 'personal', 'salvate', 'saved', 'simulazioni', 'cloud', 'sync', 'profilo', 'profile', 'persönlich', 'tableau'],
    },
    // ─── Gamification ───
    {
      id: 'gamification',
      title: t('gamification.title') || 'Obiettivi & Livelli',
      description: 'Sblocca obiettivi, guadagna XP e sali di livello esplorando il sito',
      section: t('gamification.title') || 'Gamification',
      tab: 'gamification',
      icon: Award,
      color: 'text-amber-600',
      keywords: ['obiettivi', 'achievements', 'livelli', 'levels', 'xp', 'gamification', 'badge', 'punti', 'points', 'erfolge', 'récompenses'],
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
        if (titleLower.includes(word)) score += 10;
        if (keywordsStr.includes(word)) score += 5;
        if (descLower.includes(word)) score += 3;
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
    onNavigate(result.tab, result.subTab, result.guideSection);
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
      {/* Search trigger — compact icon button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 rounded-xl text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        title={`${t('search.placeholder') || 'Cerca...'} (⌘K)`}
        aria-label={t('search.placeholder') || 'Cerca'}
      >
        <Search size={18} />
      </button>

      {/* Search modal overlay — rendered via portal for true fullscreen */}
      {isOpen && createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[env(safe-area-inset-top,12vh)] sm:pt-[12vh] bg-black/40 backdrop-blur-sm transition-opacity duration-150">
          <div
            ref={modalRef}
            className="w-full max-w-lg max-h-[70vh] sm:max-h-[75vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col animate-modal-in"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <Search size={18} className="text-slate-500 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('search.placeholder') || 'Cerca sezioni, strumenti, funzionalità...'}
                className="flex-1 bg-transparent text-slate-800 dark:text-slate-100 placeholder-slate-400 outline-none text-sm"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="p-1 text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 rounded"
                >
                  <X size={14} />
                </button>
              )}
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-slate-500 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
                esc
              </kbd>
            </div>

            {/* Results */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {query.trim() === '' ? (
                <div className="px-4 py-6 text-center text-sm text-slate-500">
                  <p>{t('search.hint') || 'Digita per cercare tra tutte le sezioni del sito'}</p>
                  <p className="text-xs mt-1.5 text-slate-300 dark:text-slate-500">
                    {t('search.examples') || 'Es: "cambio valuta", "pensione", "calendario festività", "permessi"'}
                  </p>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-500">
                  {t('search.noResults') || 'Nessun risultato trovato'}
                </div>
              ) : (
                <div className="py-1">
                  {searchResults.map((result, index) => {
                    const Icon = result.icon;
                    return (
                      <button
                        key={result.id}
                        onClick={() => handleSelect(result)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          index === selectedIndex
                            ? 'bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className={`p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 ${result.color} flex-shrink-0`}>
                          <Icon size={14} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                              {result.title}
                            </span>
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded flex-shrink-0">
                              {result.section}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5">
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
            <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-500">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">↑↓</kbd>
                  {t('search.navigate') || 'naviga'}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">↵</kbd>
                  {t('search.select') || 'seleziona'}
                </span>
              </div>
              <span className="hidden sm:flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">⌘K</kbd>
                {t('search.close') || 'chiudi'}
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default SiteSearch;
