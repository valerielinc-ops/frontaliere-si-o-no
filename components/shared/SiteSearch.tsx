import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, ArrowRight, Calculator, Layers, PiggyBank, BookOpen, BarChart2, HelpCircle, ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Briefcase, ShoppingCart, Euro, TrendingUp, Sparkles, MapPin, Calendar, PartyPopper, FileText, GraduationCap, Building, Compass, BriefcaseBusiness, MessageSquare, Map, Baby, Award, Scale, Home, Mail, Handshake, Video, Sunrise, User as UserIcon, Gift, Hammer, BookA, BarChart3, Wrench, Users, Clock, Newspaper, Receipt, Banknote, Coins, Star } from 'lucide-react';
import { useTranslation, loadAllTranslations, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { ALL_GLOSSARY_TERM_IDS } from '@/services/router';
import type { GlossaryTermId, BlogArticleId } from '@/services/router';

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
  /** Optional filter params to pass when navigating to job-board */
  _filterParams?: JobBoardFilterParams;
}

/** Filter params that SiteSearch can pass to the job board when navigating */
export interface JobBoardFilterParams {
  location?: string;
  query?: string;
}

interface SiteSearchProps {
  onNavigate: (tab: string, subTab?: string, jobBoardFilterParams?: JobBoardFilterParams) => void;
}

const SiteSearch: React.FC<SiteSearchProps> = ({ onNavigate }) => {
  const { t, locale } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Lazy-load blog article IDs when search is opened
  const [blogArticleIds, setBlogArticleIds] = useState<BlogArticleId[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    import('@/data/blog-articles-data').then(m => {
      setBlogArticleIds(m.ARTICLES.map(a => a.id));
    });
  }, [isOpen]);

  const popularQueries = useMemo(() => [
    { label: 'Stipendio netto 80.000 CHF', tab: 'calculator', subTab: undefined },
    { label: 'Nuovo accordo frontalieri 2026', tab: 'fisco', subTab: 'tax-return' },
    { label: 'Permesso G vs B', tab: 'guida', subTab: 'permit-compare' },
    { label: 'LAMal: franchigia 2500', tab: 'confronti', subTab: 'health' },
    { label: 'Cambio CHF/EUR', tab: 'confronti', subTab: 'exchange' },
    { label: 'Ristorni', tab: 'fisco', subTab: 'ristorni' },
  ], []);

  // Build the search index with ALL site sections including guide sub-sections
  const searchIndex: SearchResult[] = [
    // ─── Simulator ───
    {
      id: 'calculator',
      title: t('nav.simulator') || 'Simulatore',
      description: t('app.subtitle') || 'Calcola e confronta il tuo stipendio netto come lavoratore frontaliero',
      section: t('nav.simulator') || 'Simulatore',
      tab: 'calculator',
      icon: Calculator,
      color: 'text-stripe-600',
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
      color: 'text-stripe-500',
      keywords: ['cosa cambia', 'what if', 'scenario', 'simulazione', 'figli', 'stipendio', 'residenza', 'bambini', 'kinder', 'enfants', 'children'],
    },
    // ─── Comparators ───
    {
      id: 'exchange',
      title: t('comparators.exchange') || 'Cambio Valuta',
      description: 'Convertitore CHF/EUR in tempo reale, statistiche tassi, provider a confronto',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'exchange',
      icon: ArrowRightLeft,
      color: 'text-stripe-600',
      keywords: ['cambio', 'valuta', 'euro', 'franco', 'chf', 'eur', 'exchange', 'currency', 'tasso', 'rate', 'convertitore', 'wise', 'revolut', 'wechselkurs', 'devise'],
    },
    {
      id: 'traffic',
      title: t('comparators.traffic') || 'Traffico Valichi',
      description: 'Situazione traffico in tempo reale ai valichi di frontiera Italia-Svizzera',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'traffic-history',
      icon: AlertTriangle,
      color: 'text-amber-600',
      keywords: ['traffico', 'valichi', 'dogana', 'frontiera', 'chiasso', 'como', 'ponte tresa', 'stabio', 'border', 'traffic', 'crossing', 'grenze', 'douane', 'attesa', 'coda'],
    },
    {
      id: 'mobile',
      title: t('comparators.mobile') || 'Operatori Mobile',
      description: 'Confronto piani mobile Italia vs Svizzera: copertura, roaming, prezzi',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'mobile',
      icon: Phone,
      color: 'text-green-600',
      keywords: ['mobile', 'telefono', 'operatore', 'sim', 'roaming', 'swisscom', 'salt', 'sunrise', 'iliad', 'vodafone', 'tim', 'handy', 'portable'],
    },
    {
      id: 'banks',
      title: t('comparators.banks') || 'Banche',
      description: 'Confronto conti bancari per frontalieri: spese, cambio, multi-valuta',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'banks',
      icon: Building2,
      color: 'text-subtle',
      keywords: ['banca', 'conto', 'bank', 'account', 'ubs', 'credit suisse', 'postfinance', 'wise', 'revolut', 'n26', 'banque', 'konto'],
    },
    {
      id: 'health',
      title: t('comparators.health') || 'Assicurazione Sanitaria',
      description: 'Confronto assicurazioni sanitarie LAMAL per frontalieri',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'health',
      icon: Heart,
      color: 'text-red-500',
      keywords: ['assicurazione', 'sanitaria', 'lamal', 'health', 'insurance', 'cassa malati', 'ssn', 'santé', 'krankenversicherung', 'medical'],
    },
    {
      id: 'transport',
      title: t('comparators.transport') || 'Trasporti',
      description: 'Calcola costi pendolarismo: auto, treno, abbonamenti, carburante',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'transport',
      icon: Car,
      color: 'text-teal-600',
      keywords: ['trasporto', 'pendolare', 'treno', 'auto', 'benzina', 'abbonamento', 'arcobaleno', 'tilo', 'transport', 'commute', 'train', 'car', 'pendeln'],
    },
    {
      id: 'jobs',
      title: t('comparators.jobs') || 'Lavoro',
      description: 'Confronta offerte di lavoro e stipendi in Ticino',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'jobs',
      icon: Briefcase,
      color: 'text-stripe-600',
      keywords: ['lavoro', 'job', 'offerta', 'stipendio', 'impiego', 'ccnl', 'contratto', 'arbeit', 'emploi', 'salary', 'gehalt', 'salaire'],
    },
    {
      id: 'shopping',
      title: t('comparators.shopping') || 'Spesa',
      description: 'Confronto prezzi spesa quotidiana Italia vs Svizzera con mappa supermercati e indice di convenienza',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'shopping',
      icon: ShoppingCart,
      color: 'text-orange-600',
      keywords: ['spesa', 'shopping', 'prezzi', 'supermercato', 'migros', 'coop', 'lidl', 'aldi', 'denner', 'esselunga', 'carrefour', 'eurospin', 'tigros', 'conad', 'mappa', 'supermercati confine', 'frontiera', 'convenienza', 'zona', 'carrello', 'benzina', 'dogana', 'einkauf', 'Supermarkt', 'Grenze', 'courses', 'supermarché', 'frontière', 'grocery', 'supermarket', 'border', 'prezzi supermercato svizzera vs italia', 'coop svizzera caro', 'migros prezzi'],
    },
    {
      id: 'cost-of-living',
      title: t('comparators.costOfLiving') || 'Costo della vita',
      description: 'Confronto costo della vita tra Italia e Svizzera',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'cost-of-living',
      icon: Euro,
      color: 'text-emerald-700',
      keywords: ['costo vita', 'affitto', 'rent', 'cost of living', 'lebenshaltungskosten', 'coût de la vie', 'bollette', 'utilities'],
    },
    {
      id: 'ral',
      title: t('comparators.ral') || 'Confronto RAL',
      description: 'Confronta la tua RAL italiana con lo stipendio svizzero equivalente',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'ral',
      icon: Scale,
      color: 'text-cyan-600',
      keywords: ['ral', 'stipendio', 'confronto', 'salario', 'lordo', 'annuo', 'comparison', 'salary', 'gross', 'vergleich', 'comparaison', 'italia', 'svizzera'],
    },
    {
      id: 'parental-leave',
      title: t('comparators.parentalLeave') || 'Congedo Parentale',
      description: 'Calcola indennità congedo maternità e paternità per frontalieri',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'parental-leave',
      icon: Baby,
      color: 'text-pink-600',
      keywords: ['congedo', 'maternità', 'paternità', 'parentale', 'parental', 'leave', 'maternity', 'paternity', 'indennità', 'mutterschutz', 'congé'],
    },
    {
      id: 'border-map',
      title: t('comparators.borderMap') || 'Mappa Interattiva Comuni',
      description: 'Mappa interattiva dei comuni frontalieri con confronto fiscale IRPEF, addizionali per comune, affitti e distanze',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'border-map',
      icon: Map,
      color: 'text-teal-600',
      keywords: ['mappa', 'map', 'comuni', 'municipalities', 'interattiva', 'interactive', 'irpef', 'affitto', 'rent', 'distanza', 'karte', 'carte', 'confine', 'border', 'addizionale', 'tassa', 'confronto', 'impatto fiscale'],
    },
    {
      id: 'residency',
      title: t('comparators.residency') || 'Simulatore Residenza',
      description: 'Simula il costo della vita come residente in Svizzera vs frontaliere',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'residency',
      icon: Home,
      color: 'text-stripe-600',
      keywords: ['residenza', 'residency', 'trasferimento', 'svizzera', 'switzerland', 'costo vita', 'affitto', 'wohnsitz', 'résidence', 'permesso B', 'vivere'],
    },
    {
      id: 'tax-return',
      title: t('comparators.taxReturn') || 'Dichiarazione Redditi',
      description: 'Guida alla dichiarazione dei redditi italiana per frontalieri',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'tax-return',
      icon: FileText,
      color: 'text-stripe-600',
      keywords: ['dichiarazione', 'redditi', 'tax return', 'modello', '730', 'unico', 'steuererklärung', 'déclaration', 'deduzioni', 'detrazioni', 'scadenze', 'documenti', 'IRPEF'],
    },
    {
      id: 'nursery',
      title: t('comparators.nursery') || 'Asili Nido',
      description: 'Confronta gli asili nido ticinesi con stime dei costi',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'nursery',
      icon: Baby,
      color: 'text-pink-600',
      keywords: ['asilo', 'nido', 'nursery', 'bambini', 'children', 'Kinderkrippe', 'crèche', 'costi', 'bonus nido', 'CAF', 'famiglia'],
    },
    {
      id: 'bonus',
      title: t('comparators.bonus') || 'Calcolo Bonus',
      description: 'Calcola il netto del bonus dopo tasse svizzere e italiane',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'bonus',
      icon: Gift,
      color: 'text-amber-600',
      keywords: ['bonus', 'gratifica', 'tredicesima', 'premio', 'netto', 'tasse', 'Bonus', 'Prämie', 'prime'],
    },
    {
      id: 'renovation',
      title: t('comparators.renovation') || 'Bonus Ristrutturazione',
      description: 'Calcola le detrazioni per ristrutturazione casa in Italia e Svizzera',
      section: t('nav.confronti') || 'Confronti',
      tab: 'confronti',
      subTab: 'renovation',
      icon: Hammer,
      color: 'text-orange-600',
      keywords: ['ristrutturazione', 'renovation', 'bonus casa', 'ecobonus', 'superbonus', 'detrazioni', 'Renovierung', 'rénovation', 'lavori', 'capienza fiscale', 'capienza', 'IRPEF', 'tax capacity', 'Steuerkapazität', 'capacité fiscale'],
    },
    {
      id: 'glossary',
      title: t('guide.tabs.glossary') || 'Glossario',
      description: 'Glossario dei termini fiscali e lavorativi per frontalieri',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'first-day',
      icon: BookA,
      color: 'text-stripe-600',
      keywords: ['glossario', 'glossary', 'termini', 'definizioni', 'AVS', 'LPP', 'LAMal', 'IRPEF', 'Glossar', 'glossaire', 'franchigia', 'imposta alla fonte'],
    },
    {
      id: 'faq',
      title: t('guide.tabs.faq') || 'FAQ',
      description: 'Domande frequenti su fisco, permessi e vita da frontaliere',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'first-day',
      icon: HelpCircle,
      color: 'text-stripe-600',
      keywords: ['FAQ', 'domande', 'frequenti', 'questions', 'häufige Fragen', 'foire aux questions', 'aiuto', 'help', 'risposte'],
    },
    {
      id: 'ristorni',
      title: t('guide.tabs.ristorni') || 'Ristorni Fiscali',
      description: 'Traccia i ristorni fiscali svizzeri al tuo comune italiano',
      section: t('nav.fisco') || 'Fisco & Previdenza',
      tab: 'fisco',
      subTab: 'ristorni',
      icon: BarChart3,
      color: 'text-emerald-700',
      keywords: ['ristorni', 'ristorno', 'fiscali', 'tasse', 'comune', 'rimborso', 'Steuerrückerstattung', 'ristornes', 'accordo', 'municipio'],
    },
    {
      id: 'morning',
      title: t('guide.tabs.morning') || 'Buongiorno Frontaliere',
      description: 'Dashboard mattutino con meteo, traffico valichi e tasso di cambio',
      section: t('footer.morningDashboard') || 'Buongiorno',
      tab: 'morning',
      icon: Sunrise,
      color: 'text-orange-500',
      keywords: ['buongiorno', 'mattino', 'meteo', 'weather', 'traffico', 'morning', 'dashboard', 'cambio', 'tempo', 'Morgen', 'Wetter', 'matin', 'météo', 'température', 'valichi'],
    },
    // ─── Pension ───
    {
      id: 'pension-planner',
      title: t('pension.planner') || 'Pensione',
      description: 'Pianifica la tua pensione: AVS, LPP, contributi 1° e 2° pilastro',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'pension',
      icon: PiggyBank,
      color: 'text-emerald-700',
      keywords: ['pensione', 'avs', 'lpp', 'pilastro', 'contributi', 'pension', 'retirement', 'rente', 'retraite', 'ahv', 'bvg'],
    },
    {
      id: 'pillar3',
      title: t('pension.pillar3') || '3° Pilastro',
      description: 'Simulatore terzo pilastro 3a: deduzioni fiscali, rendimenti, provider',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'pillar3',
      icon: TrendingUp,
      color: 'text-emerald-500',
      keywords: ['pilastro', 'pillar', '3a', 'terzo', 'risparmio', 'deduzione', 'fiscale', 'viac', 'frankly', 'säule', 'pilier', 'savings', 'tax deduction'],
    },
    // ─── Guide — all sub-sections ───
    {
      id: 'guide',
      title: t('nav.guida') || 'Guida',
      description: 'Guida completa per frontalieri: permessi, dogane, comuni, tasse',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      icon: BookOpen,
      color: 'text-stripe-600',
      keywords: ['guida', 'guide', 'frontaliere', 'cross-border', 'grenzgänger', 'frontalier', 'informazioni', 'info'],
    },
    {
      id: 'guide-municipalities',
      title: t('guide.tabs.municipalities') || 'Comuni Frontalieri',
      description: 'Lista comuni italiani di confine e ristorni fiscali dalla Svizzera',
      section: t('nav.vita') || 'Vita in Ticino',
      tab: 'vita',
      subTab: 'municipalities',
      icon: MapPin,
      color: 'text-stripe-500',
      keywords: ['comuni', 'municipalities', 'confine', 'ristorni', 'gemeinden', 'communes', 'frontiera', 'border towns', 'fascia', '20km'],
    },
    {
      id: 'guide-border',
      title: t('guide.tabs.border') || 'Dogane & Tempi',
      description: 'Valichi doganali, orari apertura, tempi di attesa, documenti necessari',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'border',
      icon: AlertTriangle,
      color: 'text-amber-500',
      keywords: ['dogana', 'customs', 'valico', 'border', 'passaporto', 'documenti', 'orari', 'zoll', 'douane', 'checkpoint'],
    },
    {
      id: 'guide-living-ch',
      title: t('guide.tabs.livingCH') || 'Vivere in CH',
      description: 'Informazioni per chi vive o vuole trasferirsi in Svizzera',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'living-ch',
      icon: Building,
      color: 'text-red-500',
      keywords: ['vivere', 'svizzera', 'switzerland', 'trasferirsi', 'residenza', 'affitto', 'schweiz', 'suisse', 'abitare', 'leben'],
    },
    {
      id: 'guide-living-it',
      title: t('guide.tabs.livingIT') || 'Vivere in IT',
      description: 'Informazioni per frontalieri residenti in Italia',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'living-it',
      icon: Building,
      color: 'text-green-600',
      keywords: ['vivere', 'italia', 'italy', 'residenza', 'italiana', 'abitare', 'italien', 'italie', 'casa'],
    },
    {
      id: 'guide-calendar',
      title: t('guide.tabs.calendar') || 'Scadenze Fiscali',
      description: 'Calendario scadenze fiscali per frontalieri: dichiarazioni, acconti, saldi',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'calendar',
      icon: Calendar,
      color: 'text-stripe-600',
      keywords: ['scadenze', 'fiscali', 'calendario', 'calendar', 'dichiarazione', 'redditi', 'tax deadline', 'steuer', 'impôts', 'unico', '730', 'acconto', 'saldo'],
    },
    {
      id: 'guide-holidays',
      title: t('guide.tabs.holidays') || 'Festività Ticino',
      description: 'Calendario festività cantonali, federali e italiane per frontalieri',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'holidays',
      icon: PartyPopper,
      color: 'text-pink-500',
      keywords: ['festività', 'holidays', 'feste', 'feiertage', 'jours fériés', 'vacanze', 'ticino', 'canton', 'natale', 'pasqua', 'ferragosto', 'capodanno'],
    },
    {
      id: 'guide-permits',
      title: t('guide.tabs.permits') || 'Permessi Lavoro',
      description: 'Tipologie permessi di lavoro: G, B, C, L — requisiti e rinnovi',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'permits',
      icon: FileText,
      color: 'text-subtle',
      keywords: ['permesso', 'lavoro', 'permit', 'G', 'frontaliero', 'bewilligung', 'autorisation', 'permis', 'rinnovo', 'scadenza'],
    },
    {
      id: 'guide-companies',
      title: t('guide.tabs.companies', getCantonI18nParams()) || 'Aziende Ticino',
      description: 'Principali aziende e datori di lavoro nel Canton Ticino',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'companies',
      icon: BriefcaseBusiness,
      color: 'text-cyan-600',
      keywords: ['aziende', 'companies', 'datore', 'employer', 'ticino', 'unternehmen', 'entreprise', 'lavoro', 'impresa'],
    },
    {
      id: 'guide-places',
      title: t('guide.tabs.places') || 'Posti da Visitare',
      description: 'Luoghi di interesse, escursioni e attività nel Canton Ticino',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'places',
      icon: Compass,
      color: 'text-teal-500',
      keywords: ['posti', 'visitare', 'places', 'visit', 'turismo', 'tourism', 'escursioni', 'ausflüge', 'excursions', 'lugano', 'locarno', 'bellinzona'],
    },
    {
      id: 'guide-schools',
      title: t('guide.tabs.schools') || 'Scuole in Ticino',
      description: 'Scuole internazionali, asili e istituti nel Canton Ticino',
      section: t('nav.vita') || 'Vita',
      tab: 'vita',
      subTab: 'schools',
      icon: GraduationCap,
      color: 'text-stripe-500',
      keywords: ['scuola', 'school', 'scuole', 'asilo', 'kindergarten', 'schule', 'école', 'istruzione', 'education'],
    },
    {
      id: 'guide-unemployment',
      title: t('guide.tabs.unemployment') || 'Disoccupazione',
      description: 'Indennità disoccupazione per frontalieri: NASPI, calcolatore, regole, requisiti, décalage',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'unemployment',
      icon: BriefcaseBusiness,
      color: 'text-rose-600',
      keywords: ['disoccupazione', 'unemployment', 'naspi', 'licenziamento', 'arbeitslosigkeit', 'chômage', 'indennità', 'sussidio', 'calcolatore naspi', 'calcolo disoccupazione', 'décalage', 'indennità frontaliere'],
    },
    {
      id: 'guide-first-day',
      title: t('guide.tabs.firstDay') || 'Primo Giorno',
      description: 'Guida al primo giorno di lavoro come frontaliere in Svizzera',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'first-day',
      icon: Compass,
      color: 'text-orange-600',
      keywords: ['primo giorno', 'first day', 'inizio', 'start', 'erster tag', 'premier jour', 'preparazione', 'documenti', 'cosa portare', 'checklist'],
    },
    {
      id: 'guide-car-transfer',
      title: t('guide.tabs.carTransfer') || 'Trasferimento Auto',
      description: 'Come immatricolare la tua auto in Svizzera: dogana, targhe, patente e assicurazione',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'car-transfer',
      icon: Car,
      color: 'text-stripe-600',
      keywords: ['auto', 'macchina', 'targa', 'patente', 'dogana', 'immatricolazione', 'car', 'vehicle', 'plates', 'license', 'Fahrzeug', 'Kennzeichen', 'Führerschein', 'voiture', 'plaque', 'permis', 'MFK', 'collaudo', 'assicurazione'],
    },
    {
      id: 'guide-quiz',
      title: t('guide.tabs.quiz') || 'Quiz Fiscale',
      description: 'Metti alla prova le tue conoscenze fiscali con il quiz settimanale',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'quiz',
      icon: BookOpen,
      color: 'text-stripe-600',
      keywords: ['quiz', 'domande', 'fiscale', 'tasse', 'test', 'conoscenze', 'questions', 'fiscal', 'tax', 'Steuer', 'Fragen', 'impôts'],
    },
    {
      id: 'fisco-tax-credit',
      title: t('taxCredit.title') || 'Credito d\'Imposta',
      description: 'Calcola il credito d\'imposta per evitare la doppia tassazione Svizzera-Italia',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'tax-credit',
      icon: Receipt,
      color: 'text-emerald-700',
      keywords: ['credito imposta', 'doppia imposizione', 'tax credit', 'double taxation', 'imposta alla fonte', 'IRPEF', 'Steuergutschrift', 'crédit impôt'],
    },
    {
      id: 'fisco-withholding-rates',
      title: t('withholdingRates.title') || 'Aliquote imposta alla fonte Ticino 2026',
      description: 'Tabelle A, B, C e H del Ticino con esempi pratici e link al simulatore netto',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'withholding-rates',
      icon: Coins,
      color: 'text-emerald-700',
      keywords: ['imposta alla fonte', 'aliquote', 'tabelle a b c h', 'quellensteuer', 'withholding tax', 'ticino 2026', 'barèmes', 'source tax'],
    },
    {
      id: 'fisco-new-frontier-tax-sim',
      title: t('newFrontierTaxSim.title') || 'Simulazione Tasse Nuovi Frontalieri 2026',
      description: 'Calcola imposta alla fonte CH + IRPEF Italia con franchigia €10.000 e credito d\'imposta',
      section: t('nav.fisco') || 'Fisco',
      tab: 'fisco',
      subTab: 'new-frontier-tax-sim',
      icon: Coins,
      color: 'text-emerald-700',
      keywords: ['simulazione tasse nuovi frontalieri', 'nuovo accordo fiscale', 'franchigia 10000', 'doppia imposizione', 'credito imposta', 'new cross-border workers', 'tax simulation', 'neue grenzgaenger steuer'],
    },
    {
      id: 'stats-ristorni',
      title: t('guide.tabs.ristorni') || 'Ristorni Fiscali',
      description: 'Calcola e verifica i ristorni fiscali dal Canton Ticino ai comuni italiani',
      section: t('nav.fisco') || 'Fisco & Previdenza',
      tab: 'fisco',
      subTab: 'ristorni',
      icon: BarChart2,
      color: 'text-emerald-700',
      keywords: ['ristorni', 'fiscali', 'rimborso', 'tasse', 'cantone', 'ticino', 'comuni', 'refund', 'tax', 'steuer', 'impôt'],
    },
    // ─── Calcolatore (extra entries) ───
    {
      id: 'strumenti-payslip',
      title: t('payslip.title') || 'Simulatore Busta Paga',
      description: t('payslip.subtitle') || 'Calcola il tuo stipendio netto con tutte le trattenute svizzere',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'payslip',
      icon: FileText,
      color: 'text-stripe-600',
      keywords: ['busta paga', 'payslip', 'lohnabrechnung', 'fiche de paie', 'stipendio', 'netto', 'trattenute', 'avs', 'lpp', 'imposta fonte', 'salary', 'net', 'deductions'],
    },
    {
      id: 'strumenti-car-cost',
      title: t('carCost.title') || 'Calcolatore Costo Auto',
      description: t('carCost.subtitle') || 'Confronta i costi auto tra Italia e Svizzera',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'car-cost',
      icon: Car,
      color: 'text-amber-600',
      keywords: ['costo auto', 'car cost', 'autokosten', 'coût auto', 'assicurazione', 'bollo', 'carburante', 'sdoganamento', 'targhe', 'insurance', 'fuel', 'plates'],
    },
    {
      id: 'strumenti-permit-compare',
      title: t('permitCompare.title') || 'Permesso G vs B',
      description: t('permitCompare.subtitle') || 'Confronto tra vivere in Italia (G) e trasferirsi in Svizzera (B)',
      section: t('nav.guida') || 'Guida',
      tab: 'guida',
      subTab: 'permit-compare',
      icon: Users,
      color: 'text-amber-600',
      keywords: ['permesso g', 'permesso b', 'permit', 'bewilligung', 'permis', 'frontaliere', 'residente', 'trasferirsi', 'cross-border', 'resident', 'move'],
    },
    {
      id: 'strumenti-livability',
      title: t('livability.title') || 'Indice di Vivibilità',
      description: t('livability.subtitle') || 'Classifica dei comuni di frontiera per vivibilità',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'livability',
      icon: MapPin,
      color: 'text-stripe-600',
      keywords: ['vivibilità', 'livability', 'lebensqualität', 'habitabilité', 'comuni', 'classifica', 'ranking', 'municipalities', 'affitto', 'distanza', 'rent', 'distance'],
    },
    {
      id: 'stats-salary-compare',
      title: t('salaryCompare.title') || 'Confronto Stipendi',
      description: t('salaryCompare.subtitle') || 'Confronta gli stipendi tra Svizzera e Italia per settore',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'salary-compare',
      icon: TrendingUp,
      color: 'text-amber-600',
      keywords: ['stipendi', 'salaries', 'gehälter', 'salaires', 'confronto', 'comparison', 'settore', 'sector', 'junior', 'senior', 'branche', 'it', 'finanza', 'sanità', 'sondaggio', 'survey', 'retribuzione', 'guadagno', 'wage', 'income', 'Lohn', 'professione', 'profession', 'beruf', 'range salariale', 'salary range', 'gehaltsspanne', 'fourchette', 'informatica', 'ingegnere', 'engineer', 'medico', 'infermiere', 'avvocato', 'consulente', 'marketing', 'pharma', 'farmaceutico', 'edilizia', 'construction', 'logistica', 'assicurazioni', 'insurance', 'telecomunicazioni', 'legale', 'legal', 'consulenza', 'consulting', 'stipendio medio', 'average salary', 'Durchschnittslohn', 'salaire moyen', 'ticino 2026', 'frontaliere'],
    },
    {
      id: 'salary-quiz',
      title: t('salaryQuiz.navLabel') || 'Quiz Stipendio',
      description: t('salaryQuiz.subtitle') || 'Scopri il tuo stipendio stimato in 3 domande',
      section: t('nav.simulator') || 'Calcolatore',
      tab: 'calculator',
      subTab: 'salary-quiz',
      icon: TrendingUp,
      color: 'text-pink-600',
      keywords: ['quiz', 'stipendio', 'salary', 'quanto guadagno', 'guadagnare', 'svizzera', 'stima', 'settore', 'sector', 'quiz', 'viral', 'virale', 'earn', 'verdienen', 'gagner'],
    },
    {
      id: 'traffic-history',
      title: t('stats.trafficHistory') || 'Storico Traffico',
      description: t('trafficHistory.subtitle') || 'Analisi dei tempi di attesa alle dogane',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'traffic-history',
      icon: Clock,
      color: 'text-orange-600',
      keywords: ['traffico', 'traffic', 'dogana', 'border', 'storico', 'history', 'attesa', 'wait', 'coda', 'queue', 'heatmap', 'grenze', 'verkehr', 'frontière', 'trafic'],
    },
    {
      id: 'unemployment',
      title: t('stats.tabUnemployment') || 'Disoccupazione',
      description: t('stats.tabUnemployment') || 'Tasso disoccupazione SECO',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'unemployment',
      icon: BarChart3,
      color: 'text-amber-600',
      keywords: ['disoccupazione', 'unemployment', 'arbeitslosigkeit', 'chômage', 'SECO', 'tasso', 'lavoro', 'arbeitsmarkt', 'marché travail', 'senza lavoro'],
    },
    {
      id: 'stats-mortgage',
      title: t('stats.tabMortgage') || 'Confronto Mutui',
      description: 'Confronto mutui Italia vs Svizzera — rata, interessi, Tragbarkeit',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'mortgage',
      icon: Home,
      color: 'text-stripe-600',
      keywords: ['mutuo', 'mortgage', 'hypothek', 'hypothèque', 'ipoteca', 'mutuo frontaliere', 'mutuo svizzera', 'rata', 'tasso', 'interessi', 'Tragbarkeit', 'LTV', 'equity', 'anticipo', 'SARON', 'Euribor', 'casa', 'immobile', 'house', 'Haus', 'maison', 'confronto mutui'],
    },
    {
      id: 'fuel-prices',
      title: t('stats.tabFuelPrices') || 'Prezzi Carburante',
      description: 'Confronto prezzi benzina e diesel tra Italia e Svizzera',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'fuel-prices',
      icon: Car,
      color: 'text-orange-600',
      keywords: ['benzina', 'diesel', 'carburante', 'fuel', 'petrol', 'gasoline', 'Benzin', 'Diesel', 'essence', 'prezzo', 'price', 'Preis', 'prix', 'rifornimento', 'distributore', 'stazione servizio', 'risparmio', 'italia', 'svizzera', 'pieno'],
    },
    {
      id: 'health-premiums',
      title: t('stats.tabHealthPremiums') || 'Premi Cassa Malati',
      description: 'Confronto premi LAMal per comune di frontiera',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'health-premiums',
      icon: Heart,
      color: 'text-red-600',
      keywords: ['premi', 'cassa malati', 'LAMal', 'health insurance', 'Krankenkasse', 'assurance maladie', 'premio', 'premium', 'Prämie', 'prime', 'comune', 'municipality', 'franchigia', 'deductible', 'assicuratore', 'insurer'],
    },
    {
      id: 'jobs-observatory',
      title: t('stats.tabJobsObservatory') || 'Osservatorio Lavoro',
      description: 'Tendenze e statistiche del mercato del lavoro in Ticino',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'jobs-observatory',
      icon: Briefcase,
      color: 'text-stripe-600',
      keywords: ['lavoro', 'jobs', 'osservatorio', 'observatory', 'mercato', 'market', 'Arbeitsmarkt', 'marché travail', 'tendenze', 'trends', 'settore', 'sector', 'offerte', 'offers', 'Ticino', 'frontaliere'],
    },
    {
      id: 'blog',
      title: t('nav.blog') || 'Articoli',
      description: t('blog.subtitle') || 'Articoli pratici per il frontaliere in Ticino',
      section: t('nav.blog') || 'Articoli',
      tab: 'blog',
      icon: Newspaper,
      color: 'text-stripe-600',
      keywords: ['articoli', 'articles', 'blog', 'guida', 'guide', 'stipendio netto', 'lamal', 'tredicesima', 'pilastro 3a', 'comuni', 'costo vita', 'primo giorno', 'artikel', 'ratgeber', 'seo'],
    },
    {
      id: 'glossario',
      title: t('glossary.title') || 'Glossario Frontaliere',
      description: t('glossary.subtitle') || 'Tutti i termini che un frontaliere deve conoscere',
      section: t('glossary.title') || 'Glossario',
      tab: 'glossario',
      icon: Newspaper,
      color: 'text-teal-600',
      keywords: ['glossario', 'glossary', 'glossar', 'glossaire', 'termini', 'definizioni', 'avs', 'lpp', 'lamal', 'irpef', 'imposta alla fonte', 'pilastro', 'frontaliere'],
    },
    // ─── Dialetto ───
    {
      id: 'dialetto',
      title: t('dialect.title') || 'Dialetto Ticinese',
      description: t('dialect.subtitle') || 'Parole, espressioni e proverbi del dialetto ticinese',
      section: t('dialect.title') || 'Dialetto',
      tab: 'dialetto',
      icon: Newspaper,
      color: 'text-orange-600',
      keywords: ['dialetto', 'dialect', 'dialekt', 'dialecte', 'ticinese', 'tessinois', 'tessiner', 'espressioni', 'proverbi', 'saluti', 'ciau', 'bundi', 'polenta', 'grotto'],
    },
    // ─── FAQ ───
    {
      id: 'faq',
      title: t('faq.title') || 'Domande Frequenti',
      description: 'Le 30 domande più frequenti su tasse, permessi, assicurazione e pensione per frontalieri',
      section: t('faq.title') || 'FAQ',
      tab: 'faq',
      icon: HelpCircle,
      color: 'text-orange-600',
      keywords: ['faq', 'domande', 'frequenti', 'risposte', 'questions', 'answers', 'aiuto', 'help', 'hilfe', 'aide', 'tasse', 'permesso', 'lamal', 'pensione'],
    },
    // ─── Sitemap ───
    {
      id: 'sitemap',
      title: t('sitemap.title') || 'Mappa del Sito',
      description: 'Tutti gli strumenti e risorse per frontalieri in un\'unica pagina',
      section: t('sitemap.title') || 'Mappa del Sito',
      tab: 'sitemap',
      icon: Map,
      color: 'text-subtle',
      keywords: ['mappa', 'sito', 'sitemap', 'tutti', 'strumenti', 'indice', 'seitenplan', 'plan', 'site map', 'elenco'],
    },
    // ─── Contracts / CCNL Guide ───
    {
      id: 'contracts',
      title: t('contracts.title') || 'Contratti Collettivi Svizzeri vs Italiani',
      description: 'Confronto CCL/CCNL per settore: ore, ferie, tredicesima, preavviso, diritti frontaliere',
      section: t('contracts.badge') || 'Contratti di Lavoro',
      tab: 'contracts',
      icon: FileText,
      color: 'text-stripe-600',
      keywords: ['contratto', 'CCNL', 'GAV', 'CCL', 'lavoro', 'ore settimanali', 'ferie', 'tredicesima', 'preavviso', 'periodo di prova', 'edilizia', 'metalmeccanica', 'commercio', 'ristorazione', 'sanità', 'diritti lavoratore', 'employment contracts', 'Arbeitsverträge', 'contrats de travail', 'salario minimo'],
    },
    // ─── TFR / Liquidazione Calculator ───
    {
      id: 'tfr-calculator',
      title: t('tfr.title') || 'TFR e Liquidazione per Frontalieri',
      description: 'Confronto TFR italiano vs 2° pilastro svizzero (LPP). Simulazione su N anni',
      section: t('tfr.badge') || 'TFR / Liquidazione',
      tab: 'tfr-calculator',
      icon: Banknote,
      color: 'text-amber-600',
      keywords: ['TFR', 'liquidazione', 'buonuscita', 'trattamento fine rapporto', 'severance', 'Abfindung', 'indemnité', '2 pilastro', 'LPP', 'BVG', 'cassa pensione', 'previdenza', 'pension fund', 'Pensionskasse', 'caisse de pension'],
    },
    // ─── Quiz Permesso B o G ───
    {
      id: 'permit-quiz',
      title: t('permitQuiz.title') || 'Quiz: Meglio Permesso B o G?',
      description: 'Quiz interattivo per scoprire quale permesso svizzero è più adatto a te',
      section: t('permitQuiz.title') || 'Quiz Permesso',
      tab: 'permit-quiz',
      icon: HelpCircle,
      color: 'text-stripe-600',
      keywords: ['permesso B', 'permesso G', 'quiz', 'permit', 'Bewilligung', 'permis', 'frontaliere', 'residenza', 'grenzgänger', 'cross-border', 'quale permesso', 'meglio B o G'],
    },
    // ─── Calcolatore Tredicesima ───
    {
      id: 'tredicesima',
      title: t('tredicesima.title') || 'Calcolatore Tredicesima e Quattordicesima',
      description: 'Calcola la tua tredicesima e quattordicesima mensilità come frontaliere',
      section: t('tredicesima.title') || 'Tredicesima',
      tab: 'tredicesima',
      icon: Calculator,
      color: 'text-amber-600',
      keywords: ['tredicesima', 'quattordicesima', '13 stipendio', '13th salary', '14th salary', 'Monatslohn', 'mensilità', 'bonus', 'CCNL', 'tredicesima frontaliere', 'dreizehnter', 'treizième'],
    },
    // ─── Weekly Digest ───
    {
      id: 'weekly-digest',
      title: t('weeklyDigest.title') || 'Digest Settimanale',
      description: 'Ricevi ogni lunedì: tasso CHF/EUR, articoli e offerte di lavoro',
      section: t('weeklyDigest.title') || 'Digest Settimanale',
      tab: 'weekly-digest',
      icon: Mail,
      color: 'text-stripe-600',
      keywords: ['digest', 'settimanale', 'newsletter', 'weekly', 'email', 'tasso cambio', 'weekly digest', 'wöchentlich', 'hebdomadaire', 'aggiornamenti'],
    },
    // ─── Tool of the Week ───
    {
      id: 'tool-of-week',
      title: t('toolOfWeek.title') || 'Strumento della Settimana',
      description: 'Ogni settimana uno strumento diverso in evidenza per frontalieri',
      section: t('toolOfWeek.title') || 'Strumento della Settimana',
      tab: 'tool-of-week',
      icon: Star,
      color: 'text-amber-600',
      keywords: ['strumento settimana', 'tool week', 'werkzeug woche', 'outil semaine', 'evidenza', 'condividi', 'share', 'social'],
    },
    // ─── Stats ───
    {
      id: 'stats',
      title: t('nav.stats') || 'Statistiche',
      description: 'Statistiche e dati sui lavoratori frontalieri in Ticino',
      section: t('nav.stats') || 'Statistiche',
      tab: 'stats',
      subTab: 'overview',
      icon: BarChart2,
      color: 'text-stripe-600',
      keywords: ['statistiche', 'dati', 'numeri', 'statistics', 'data', 'numbers', 'statistik', 'statistiques', 'grafico', 'chart'],
    },
    // ─── Feedback ───
    {
      id: 'feedback',
      title: t('footer.improveTitle') || 'Aiutaci a Migliorare',
      description: t('footer.improveDescription') || 'Segnala bug, richiedi funzionalità, aiutaci a migliorare',
      section: t('footer.improveTitle') || 'Aiutaci a Migliorare',
      tab: 'feedback',
      icon: HelpCircle,
      color: 'text-amber-600',
      keywords: ['feedback', 'supporto', 'bug', 'aiuto', 'help', 'support', 'segnala', 'report', 'hilfe', 'aide'],
    },
    // ─── Contact ───
    {
      id: 'contact',
      title: t('contact.title') || 'Contattaci',
      description: t('contact.subtitle') || 'Scrivici per domande su tasse, pensione, simulatore',
      section: t('contact.title') || 'Contattaci',
      tab: 'contact',
      icon: Mail,
      color: 'text-stripe-600',
      keywords: ['contattaci', 'contact', 'email', 'scrivici', 'domanda', 'question', 'kontakt', 'contactez', 'messaggio', 'message', 'nachricht'],
    },
    // ─── Email Confirmed / Welcome ───
    {
      id: 'email-confirmed',
      title: t('emailConfirmed.title') || 'Benvenuto, frontaliere!',
      description: t('emailConfirmed.subtitle') || 'Conferma email e pagina di benvenuto',
      section: t('emailConfirmed.title') || 'Benvenuto',
      tab: 'email-confirmed',
      icon: Star,
      color: 'text-emerald-600',
      keywords: ['benvenuto', 'welcome', 'conferma email', 'iscritto', 'newsletter', 'willkommen', 'bienvenue'],
    },
    // ─── Forum ───
    {
      id: 'forum',
      title: t('forum.title') || 'Community Frontalieri',
      description: 'Forum domande e risposte tra frontalieri',
      section: t('forum.title') || 'Community',
      tab: 'forum',
      icon: MessageSquare,
      color: 'text-stripe-600',
      keywords: ['forum', 'community', 'domande', 'risposte', 'questions', 'answers', 'fragen', 'antworten', 'communauté', 'aiuto', 'help'],
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
    // ─── Partner Services ───
    {
      id: 'partners',
      title: t('partners.title') || 'Servizi per Frontalieri',
      description: t('partners.subtitle') || 'Strumenti e servizi selezionati per frontalieri',
      section: t('partners.title') || 'Servizi Partner',
      tab: 'partners',
      icon: Handshake,
      color: 'text-emerald-700',
      keywords: ['partner', 'servizi', 'services', 'wise', 'revolut', 'affiliati', 'affiliate', 'raccomandati', 'recommended', 'dienste', 'partenaires', 'strumenti', 'tools'],
    },
    // ─── Consulting ───
    {
      id: 'consulting',
      title: t('consulting.title') || 'Consulenza Fiscale',
      description: t('consulting.subtitle') || 'Consulenza personalizzata per frontalieri',
      section: t('consulting.badge') || 'Consulenza',
      tab: 'consulting',
      icon: Video,
      color: 'text-stripe-600',
      keywords: ['consulenza', 'consulting', 'beratung', 'consultation', 'fiscale', 'personalizzata', 'video', 'calendly', 'prenota', 'book', 'esperto', 'expert'],
    },
    // ─── Job Board ───
    {
      id: 'job-board',
      title: t('jobBoard.title', getCantonI18nParams()) || 'Lavoro in Ticino',
      description: t('jobBoard.subtitle', getCantonI18nParams()) || 'Offerte di lavoro per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['lavoro', 'jobs', 'offerte', 'offers', 'ticino', 'aziende', 'companies', 'emploi', 'stelle', 'candidati', 'apply', 'impiego', 'carriera'],
    },
    {
      id: 'job-board-part-time',
      title: 'Lavoro part-time in Ticino',
      description: 'Offerte di lavoro a tempo parziale per frontalieri in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['part-time', 'tempo parziale', 'teilzeit', 'temps partiel', 'flessibile', 'flexible', 'percentuale', 'percentage', 'parziale', 'ridotto'],
    },
    // ─── Job Board — Location-specific entries ───
    {
      id: 'job-board-lugano',
      title: 'Lavoro a Lugano',
      description: 'Offerte di lavoro a Lugano per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['lugano', 'lavoro lugano', 'jobs lugano', 'offerte lugano'],
      _filterParams: { location: 'lugano' },
    },
    {
      id: 'job-board-bellinzona',
      title: 'Lavoro a Bellinzona',
      description: 'Offerte di lavoro a Bellinzona per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['bellinzona', 'lavoro bellinzona', 'jobs bellinzona', 'offerte bellinzona'],
      _filterParams: { location: 'bellinzona' },
    },
    {
      id: 'job-board-mendrisio',
      title: 'Lavoro a Mendrisio',
      description: 'Offerte di lavoro a Mendrisio per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['mendrisio', 'lavoro mendrisio', 'jobs mendrisio', 'offerte mendrisio'],
      _filterParams: { location: 'mendrisio' },
    },
    {
      id: 'job-board-locarno',
      title: 'Lavoro a Locarno',
      description: 'Offerte di lavoro a Locarno per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['locarno', 'lavoro locarno', 'jobs locarno', 'offerte locarno'],
      _filterParams: { location: 'locarno' },
    },
    {
      id: 'job-board-chiasso',
      title: 'Lavoro a Chiasso',
      description: 'Offerte di lavoro a Chiasso per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['chiasso', 'lavoro chiasso', 'jobs chiasso', 'offerte chiasso'],
      _filterParams: { location: 'chiasso' },
    },
    {
      id: 'job-board-coira',
      title: 'Lavoro a Coira',
      description: 'Offerte di lavoro a Coira / Chur per frontalieri',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['coira', 'chur', 'lavoro coira', 'jobs chur', 'offerte coira'],
      _filterParams: { location: 'coira' },
    },
    // ─── Job Board — Profession-specific entries ───
    {
      id: 'job-board-infermiere',
      title: 'Lavoro infermiere in Ticino',
      description: 'Offerte di lavoro per infermieri e infermiere in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['infermiere', 'infermiera', 'nurse', 'nursing', 'sanità', 'health', 'ospedale', 'hospital', 'Krankenpfleger', 'infirmier'],
      _filterParams: { query: 'infermiere' },
    },
    {
      id: 'job-board-ingegnere',
      title: 'Lavoro ingegnere in Ticino',
      description: 'Offerte di lavoro per ingegneri in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['ingegnere', 'engineer', 'engineering', 'Ingenieur', 'ingénieur', 'tecnico', 'progettista'],
      _filterParams: { query: 'ingegnere' },
    },
    {
      id: 'job-board-autista',
      title: 'Lavoro autista in Ticino',
      description: 'Offerte di lavoro per autisti in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['autista', 'driver', 'chauffeur', 'Fahrer', 'trasporto', 'guida', 'camionista', 'bus'],
      _filterParams: { query: 'autista' },
    },
    {
      id: 'job-board-educatore',
      title: 'Lavoro educatore in Ticino',
      description: 'Offerte di lavoro per educatori in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['educatore', 'educatrice', 'educator', 'Erzieher', 'éducateur', 'pedagogista', 'insegnante', 'docente'],
      _filterParams: { query: 'educatore' },
    },
    {
      id: 'job-board-medico',
      title: 'Lavoro medico in Ticino',
      description: 'Offerte di lavoro per medici in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['medico', 'dottore', 'doctor', 'physician', 'Arzt', 'médecin', 'specialista', 'chirurgo'],
      _filterParams: { query: 'medico' },
    },
    {
      id: 'job-board-contabile',
      title: 'Lavoro contabile in Ticino',
      description: 'Offerte di lavoro per contabili in Ticino',
      section: t('jobBoard.badge') || 'Lavoro',
      tab: 'job-board',
      icon: BriefcaseBusiness,
      color: 'text-stripe-600',
      keywords: ['contabile', 'accountant', 'Buchhalter', 'comptable', 'contabilità', 'ragioniere', 'fiduciario'],
      _filterParams: { query: 'contabile' },
    },
    // ─── Profile ───
    {
      id: 'profile',
      title: t('profile.title') || 'Il tuo Profilo',
      description: t('profile.subtitle') || 'Gestisci le tue informazioni personali',
      section: t('profile.title') || 'Profilo',
      tab: 'profile',
      icon: UserIcon,
      color: 'text-stripe-600',
      keywords: ['profilo', 'profile', 'profil', 'login', 'accedi', 'google', 'account', 'signin', 'anmelden', 'connexion', 'frontaliere', 'dati', 'data', 'impostazioni', 'settings', 'dashboard', 'personale', 'personal', 'salvate', 'saved', 'simulazioni', 'cloud', 'sync'],
    },
  ];

  // ─── Dynamic entries: glossary terms, blog articles, salary landing pages ───
  // These are built from existing data sources and use t() for localized titles.
  // They are computed lazily (useMemo) so they don't bloat the initial bundle.
  const dynamicEntries: SearchResult[] = useMemo(() => {
    const entries: SearchResult[] = [];

    // ── Glossary terms (42 terms) ──
    for (const termId of ALL_GLOSSARY_TERM_IDS) {
      const title = t(`glossary.terms.${termId}.title`);
      const desc = t(`glossary.terms.${termId}.desc`);
      // Only add if translation is loaded (avoid showing raw keys)
      if (title && !title.startsWith('glossary.terms.')) {
        entries.push({
          id: `glossary-${termId}`,
          title: `${title} — Glossario`,
          description: desc && !desc.startsWith('glossary.terms.') ? desc : `Definizione di ${title} per frontalieri`,
          section: t('glossary.title') || 'Glossario',
          tab: 'glossario',
          subTab: termId,
          icon: BookA,
          color: 'text-teal-600',
          keywords: [title.toLowerCase(), 'glossario', 'definizione', termId.toLowerCase().replace(/([A-Z])/g, ' $1').trim()],
        });
      }
    }

    // ── Blog articles (~548 articles, lazy-loaded) ──
    for (const articleId of blogArticleIds) {
      const title = t(`blog.article.${articleId}.title`);
      const excerpt = t(`blog.article.${articleId}.excerpt`);
      // Only add if translation is loaded
      if (title && !title.startsWith('blog.article.')) {
        entries.push({
          id: `blog-${articleId}`,
          title,
          description: excerpt && !excerpt.startsWith('blog.article.') ? excerpt : title,
          section: t('nav.blog') || 'Articoli',
          tab: 'blog',
          subTab: articleId,
          icon: Newspaper,
          color: 'text-stripe-600',
          keywords: articleId.split('-').filter(w => w.length > 2),
        });
      }
    }

    // ── Salary landing pages (24 entries) ──
    const LANDING_PAGES: Array<{ id: string; title: string; description: string; keywords: string[] }> = [
      { id: 'landing-salary-60000', title: 'Stipendio netto frontaliere 60.000 CHF', description: 'Simulazione netto per 60.000 CHF/anno', keywords: ['60000', '60k', 'stipendio', 'netto'] },
      { id: 'landing-salary-80000', title: 'Stipendio netto frontaliere 80.000 CHF', description: 'Simulazione netto per 80.000 CHF/anno', keywords: ['80000', '80k', 'stipendio', 'netto'] },
      { id: 'landing-salary-100000', title: 'Stipendio netto frontaliere 100.000 CHF', description: 'Simulazione netto per 100.000 CHF/anno', keywords: ['100000', '100k', 'stipendio', 'netto'] },
      { id: 'landing-salary-120000', title: 'Stipendio netto frontaliere 120.000 CHF', description: 'Simulazione netto per 120.000 CHF/anno', keywords: ['120000', '120k', 'stipendio', 'netto'] },
      { id: 'landing-salary-60000-old', title: 'Netto 60.000 CHF — vecchio frontaliere', description: 'Simulazione vecchio accordo per 60.000 CHF', keywords: ['60000', 'vecchio', 'old', 'frontaliere'] },
      { id: 'landing-salary-60000-new', title: 'Netto 60.000 CHF — nuovo frontaliere', description: 'Simulazione nuovo accordo per 60.000 CHF', keywords: ['60000', 'nuovo', 'new', 'frontaliere'] },
      { id: 'landing-salary-80000-old', title: 'Netto 80.000 CHF — vecchio frontaliere', description: 'Simulazione vecchio accordo per 80.000 CHF', keywords: ['80000', 'vecchio', 'old', 'frontaliere'] },
      { id: 'landing-salary-80000-new', title: 'Netto 80.000 CHF — nuovo frontaliere', description: 'Simulazione nuovo accordo per 80.000 CHF', keywords: ['80000', 'nuovo', 'new', 'frontaliere'] },
      { id: 'landing-salary-100000-old', title: 'Netto 100.000 CHF — vecchio frontaliere', description: 'Simulazione vecchio accordo per 100.000 CHF', keywords: ['100000', 'vecchio', 'old', 'frontaliere'] },
      { id: 'landing-salary-100000-new', title: 'Netto 100.000 CHF — nuovo frontaliere', description: 'Simulazione nuovo accordo per 100.000 CHF', keywords: ['100000', 'nuovo', 'new', 'frontaliere'] },
      { id: 'landing-salary-60000-married-2kids', title: 'Netto 60.000 CHF — sposato con 2 figli', description: 'Simulazione per famiglia con 60.000 CHF', keywords: ['60000', 'sposato', 'figli', 'famiglia', 'married'] },
      { id: 'landing-salary-80000-married-2kids', title: 'Netto 80.000 CHF — sposato con 2 figli', description: 'Simulazione per famiglia con 80.000 CHF', keywords: ['80000', 'sposato', 'figli', 'famiglia', 'married'] },
      { id: 'landing-salary-100000-married-2kids', title: 'Netto 100.000 CHF — sposato con 2 figli', description: 'Simulazione per famiglia con 100.000 CHF', keywords: ['100000', 'sposato', 'figli', 'famiglia', 'married'] },
      { id: 'landing-salary-80000-over20km', title: 'Netto 80.000 CHF — oltre 20 km', description: 'Simulazione per frontaliere oltre 20 km dal confine', keywords: ['80000', 'oltre', '20km', 'distanza'] },
      { id: 'landing-salary-80000-within20km', title: 'Netto 80.000 CHF — entro 20 km', description: 'Simulazione per frontaliere entro 20 km dal confine', keywords: ['80000', 'entro', '20km', 'distanza'] },
      { id: 'landing-salary-60000-over20km', title: 'Netto 60.000 CHF — oltre 20 km', description: 'Simulazione per frontaliere oltre 20 km dal confine', keywords: ['60000', 'oltre', '20km', 'distanza'] },
      { id: 'landing-salary-60000-within20km', title: 'Netto 60.000 CHF — entro 20 km', description: 'Simulazione per frontaliere entro 20 km dal confine', keywords: ['60000', 'entro', '20km', 'distanza'] },
      { id: 'landing-salary-100000-over20km', title: 'Netto 100.000 CHF — oltre 20 km', description: 'Simulazione per frontaliere oltre 20 km dal confine', keywords: ['100000', 'oltre', '20km', 'distanza'] },
      { id: 'landing-salary-100000-within20km', title: 'Netto 100.000 CHF — entro 20 km', description: 'Simulazione per frontaliere entro 20 km dal confine', keywords: ['100000', 'entro', '20km', 'distanza'] },
      { id: 'landing-new-frontier-over20km', title: 'Nuovo frontaliere oltre 20 km — tasse 2026', description: 'Simulazione tasse nuovo frontaliere oltre 20 km', keywords: ['nuovo', 'oltre', '20km', 'tasse', '2026'] },
      { id: 'landing-net-comparison-2025-2026-within20km', title: 'Confronto netto 2025 vs 2026 — entro 20 km', description: 'Come cambia il netto da vecchio a nuovo accordo entro 20 km', keywords: ['confronto', '2025', '2026', 'entro', '20km'] },
      { id: 'landing-net-comparison-g-vs-b-within20km', title: 'Confronto netto G vs B — entro 20 km', description: 'Permesso G vs B: quale conviene entro 20 km?', keywords: ['permesso', 'confronto', 'entro', '20km'] },
      { id: 'landing-net-comparison-2025-2026-over20km', title: 'Confronto netto 2025 vs 2026 — oltre 20 km', description: 'Come cambia il netto da vecchio a nuovo accordo oltre 20 km', keywords: ['confronto', '2025', '2026', 'oltre', '20km'] },
      { id: 'landing-net-comparison-g-vs-b-over20km', title: 'Confronto netto G vs B — oltre 20 km', description: 'Permesso G vs B: quale conviene oltre 20 km?', keywords: ['permesso', 'confronto', 'oltre', '20km'] },
    ];
    for (const lp of LANDING_PAGES) {
      entries.push({
        id: lp.id,
        title: lp.title,
        description: lp.description,
        section: t('nav.simulator') || 'Calcolatore',
        tab: 'calculator',
        icon: Calculator,
        color: 'text-stripe-600',
        keywords: [...lp.keywords, 'simulazione', 'salary', 'landing', 'calcolo'],
      });
    }

    return entries;
  }, [t, blogArticleIds]);

  // Combined search index: static entries + dynamic entries
  const fullSearchIndex = useMemo(() => [...searchIndex, ...dynamicEntries], [searchIndex, dynamicEntries]);

  // Fuzzy search function
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];

    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/);

    const scored = fullSearchIndex.map(item => {
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
  }, [query, fullSearchIndex]);

  // Fuzzy suggestions for the "no results" guided state
  const noResultsSuggestions = useMemo(() => {
    if (searchResults.length > 0 || !query.trim()) return [];
    const q = query.toLowerCase().trim();
    const qStart = q.slice(0, Math.max(3, Math.ceil(q.length * 0.6)));
    return fullSearchIndex
      .map(item => {
        let score = 0;
        for (const kw of item.keywords) {
          const kwLower = kw.toLowerCase();
          if (kwLower.includes(qStart)) score += 3;
          else if (qStart.includes(kwLower.slice(0, 3))) score += 1;
        }
        if (item.title.toLowerCase().includes(qStart)) score += 5;
        return { ...item, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }, [query, fullSearchIndex, searchResults]);

  // Category quick-links for guided browsing
  const categoryLinks = useMemo(() => [
    { label: t('nav.simulator') || 'Calcolatore', tab: 'calculator', icon: Calculator, color: 'text-stripe-600' },
    { label: t('nav.confronti') || 'Confronti', tab: 'confronti', icon: Layers, color: 'text-stripe-600' },
    { label: t('nav.fisco') || 'Fisco', tab: 'fisco', icon: PiggyBank, color: 'text-emerald-700' },
    { label: t('nav.guida') || 'Guida', tab: 'guida', icon: BookOpen, color: 'text-stripe-600' },
    { label: t('nav.vita') || 'Vita', tab: 'vita', subTab: 'transport' as string | undefined, icon: Home, color: 'text-teal-600' },
    { label: t('nav.stats') || 'Statistiche', tab: 'stats', subTab: 'overview' as string | undefined, icon: BarChart2, color: 'text-stripe-600' },
  ], [t]);

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

  // Focus input when opened + ensure all translations are loaded
  useEffect(() => {
    if (!isOpen) return;

    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 100);

    // Preload translations in background — does NOT block typing
    void loadAllTranslations();
  }, [isOpen, locale]);

  // Warm all translation chunks in background so search labels are always localized
  useEffect(() => {
    void loadAllTranslations();
  }, [locale]);

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
    Analytics.trackSearch(query);
    setQuery('');
    onNavigate(result.tab, result.subTab, result._filterParams);
  }, [onNavigate, query]);

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
  }, [handleSelect, searchResults, selectedIndex]);

  return (
    <>
      {/* Search trigger — compact icon button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 rounded-xl text-muted hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:ring-offset-2"
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
            className="w-full max-w-lg max-h-[70vh] sm:max-h-[75vh] bg-surface rounded-2xl shadow-2xl border border-edge flex flex-col animate-modal-in"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-edge">
              <Search size={18} className="text-muted flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                placeholder={t('search.placeholder') || 'Cerca sezioni, strumenti, funzionalità...'}
                aria-label={t('search.placeholder') || 'Cerca sezioni, strumenti, funzionalità'}
                className="flex-1 bg-transparent text-slate-800 dark:text-slate-100 placeholder-slate-500 outline-none focus-visible:ring-2 focus-visible:ring-stripe-500 text-base sm:text-sm"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="p-2 -m-0.5 text-muted hover:text-slate-600 dark:hover:text-slate-300 rounded"
                  aria-label={t('search.clear') || 'Cancella ricerca'}
                >
                  <X size={14} />
                </button>
              )}
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs font-mono text-muted bg-surface-raised rounded border border-edge">
                esc
              </kbd>
            </div>

            {/* Results */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {query.trim() === '' ? (
                <div className="px-4 py-6 text-center text-sm text-muted">
                  <p>{t('search.hint') || 'Digita per cercare tra tutte le sezioni del sito'}</p>
                  <p className="text-xs mt-1.5 text-slate-300 dark:text-slate-400">
                    {t('search.examples') || 'Es: "cambio valuta", "pensione", "calendario festività", "permessi"'}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2 justify-center">
                    {popularQueries.map((item) => (
                      <button
                        key={item.label}
                        onClick={() => {
                          setIsOpen(false);
                          Analytics.trackUIInteraction('search', 'popular', 'click', 'query', item.label);
                          onNavigate(item.tab, item.subTab);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface text-subtle border border-edge hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        aria-label={item.label}
                        title={item.label}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-5 space-y-5">
                  {/* No results message */}
                  <div className="text-center">
                    <Search size={28} className="mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                    <p className="text-sm font-semibold text-body">
                      {t('search.noResults.title', { query }) || `Nessun risultato per «${query}»`}
                    </p>
                    <p className="text-sm text-muted mt-1">
                      {t('search.noResults.hint') || 'Prova con parole chiave diverse o esplora le categorie'}
                    </p>
                  </div>

                  {/* Fuzzy suggestions */}
                  {noResultsSuggestions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                        {t('search.noResults.maybeMeant') || 'Forse cercavi'}
                      </p>
                      <div className="space-y-1">
                        {noResultsSuggestions.map((item) => {
                          const Icon = item.icon;
                          return (
                            <button
                              key={item.id}
                              onClick={() => handleSelect(item)}
                              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                            >
                              <div className={`p-1.5 rounded-lg bg-surface-raised ${item.color} flex-shrink-0`}>
                                <Icon size={14} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate block">{item.title}</span>
                                <span className="text-sm text-muted truncate block">{item.description}</span>
                              </div>
                              <ArrowRight size={12} className="text-muted flex-shrink-0" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Browse by category */}
                  <div>
                    <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                      {t('search.noResults.browseCategories') || 'Esplora per categoria'}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {categoryLinks.map((cat) => {
                        const CatIcon = cat.icon;
                        return (
                          <button
                            key={cat.tab}
                            onClick={() => { setIsOpen(false); onNavigate(cat.tab, cat.subTab); }}
                            className="flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                          >
                            <div className={`p-2 rounded-lg bg-surface-raised ${cat.color}`}>
                              <CatIcon size={16} />
                            </div>
                            <span className="text-xs font-medium text-subtle text-center leading-tight">{cat.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
                            ? 'bg-stripe-50 dark:bg-stripe-950/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className={`p-1.5 rounded-lg bg-surface-raised ${result.color} flex-shrink-0`}>
                          <Icon size={14} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                              {result.title}
                            </span>
                            <span className="text-xs uppercase tracking-wider text-muted bg-surface-raised px-1.5 py-0.5 rounded flex-shrink-0">
                              {result.section}
                            </span>
                          </div>
                          <p className="text-sm text-muted truncate mt-0.5">
                            {result.description}
                          </p>
                        </div>
                        <ArrowRight size={14} className="text-muted flex-shrink-0" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-muted">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-surface-raised rounded text-xs">↑↓</kbd>
                  {t('search.navigate') || 'naviga'}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-surface-raised rounded text-xs">↵</kbd>
                  {t('search.select') || 'seleziona'}
                </span>
              </div>
              <span className="hidden sm:flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-surface-raised rounded text-xs">⌘K</kbd>
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
