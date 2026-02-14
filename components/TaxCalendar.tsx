import React, { useState, useMemo, useEffect } from 'react';
import { Calendar, AlertTriangle, CheckCircle2, Bell, ChevronDown, FileText, Info, Euro, Landmark, Shield, Star, Gift } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';

interface TaxDeadline {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  description: string;
  category: 'irpef' | 'svizzera' | 'contributi' | 'dichiarazione' | 'altro' | 'festivo' | 'facoltativo';
  who: ('vecchio' | 'nuovo' | 'tutti')[];
  documents?: string[];
  penalty?: string;
  notes?: string;
}

const CATEGORY_ICONS = {
  irpef: Euro,
  svizzera: Shield,
  contributi: Landmark,
  dichiarazione: FileText,
  altro: Bell,
  festivo: Star,
  facoltativo: Gift,
};

interface CategoryConfig {
  label: string;
  color: string;
  icon: React.FC<any>;
}

function getCategoryConfig(t: (key: string) => string): Record<string, CategoryConfig> {
  return {
    irpef: { label: t('calendar.cat.irpef'), color: 'green', icon: Euro },
    svizzera: { label: t('calendar.cat.svizzera'), color: 'red', icon: Shield },
    contributi: { label: t('calendar.cat.contributi'), color: 'blue', icon: Landmark },
    dichiarazione: { label: t('calendar.cat.dichiarazione'), color: 'purple', icon: FileText },
    altro: { label: t('calendar.cat.altro'), color: 'amber', icon: Bell },
    festivo: { label: t('calendar.cat.festivo'), color: 'rose', icon: Star },
    facoltativo: { label: t('calendar.cat.facoltativo'), color: 'sky', icon: Gift },
  };
}

function getDeadlines2026(t: (key: string) => string): TaxDeadline[] {
  return [
    {
      id: 'd1', date: '2026-01-16',
      title: t('calendar.d1.title'),
      description: t('calendar.d1.description'),
      category: 'irpef', who: ['nuovo'],
      notes: t('calendar.d1.notes'),
    },
    {
      id: 'd2', date: '2026-02-28',
      title: t('calendar.d2.title'),
      description: t('calendar.d2.description'),
      category: 'dichiarazione', who: ['tutti'],
      documents: [t('calendar.d2.doc1'), t('calendar.d2.doc2')],
    },
    {
      id: 'd3', date: '2026-03-16',
      title: t('calendar.d3.title'),
      description: t('calendar.d3.description'),
      category: 'contributi', who: ['tutti'],
      notes: t('calendar.d3.notes'),
    },
    {
      id: 'd4', date: '2026-03-31',
      title: t('calendar.d4.title'),
      description: t('calendar.d4.description'),
      category: 'svizzera', who: ['vecchio', 'nuovo'],
      documents: ['Lohnausweis', t('calendar.d4.doc2')],
      penalty: t('calendar.d4.penalty'),
    },
    {
      id: 'd5', date: '2026-04-30',
      title: t('calendar.d5.title'),
      description: t('calendar.d5.description'),
      category: 'dichiarazione', who: ['tutti'],
      documents: [t('calendar.d5.doc1')],
    },
    {
      id: 'd6', date: '2026-05-16',
      title: t('calendar.d6.title'),
      description: t('calendar.d6.description'),
      category: 'irpef', who: ['nuovo'],
    },
    {
      id: 'd7', date: '2026-06-16',
      title: t('calendar.d7.title'),
      description: t('calendar.d7.description'),
      category: 'irpef', who: ['tutti'],
      notes: t('calendar.d7.notes'),
    },
    {
      id: 'd8', date: '2026-06-30',
      title: t('calendar.d8.title'),
      description: t('calendar.d8.description'),
      category: 'irpef', who: ['nuovo'],
      penalty: t('calendar.d8.penalty'),
      documents: [t('calendar.d8.doc1'), t('calendar.d8.doc2')],
    },
    {
      id: 'd9', date: '2026-07-31',
      title: t('calendar.d9.title'),
      description: t('calendar.d9.description'),
      category: 'irpef', who: ['nuovo'],
    },
    {
      id: 'd10', date: '2026-09-30',
      title: t('calendar.d10.title'),
      description: t('calendar.d10.description'),
      category: 'dichiarazione', who: ['tutti'],
      documents: [t('calendar.d10.doc1'), 'CU', t('calendar.d10.doc3')],
      penalty: t('calendar.d10.penalty'),
    },
    {
      id: 'd11', date: '2026-10-31',
      title: t('calendar.d11.title'),
      description: t('calendar.d11.description'),
      category: 'dichiarazione', who: ['tutti'],
      documents: [t('calendar.d11.doc1'), t('calendar.d11.doc2'), 'Lohnausweis'],
      penalty: t('calendar.d11.penalty'),
      notes: t('calendar.d11.notes'),
    },
    {
      id: 'd12', date: '2026-11-30',
      title: t('calendar.d12.title'),
      description: t('calendar.d12.description'),
      category: 'irpef', who: ['nuovo'],
      penalty: t('calendar.d12.penalty'),
      notes: t('calendar.d12.notes'),
    },
    {
      id: 'd13', date: '2026-12-16',
      title: t('calendar.d13.title'),
      description: t('calendar.d13.description'),
      category: 'irpef', who: ['tutti'],
    },
    {
      id: 'd14', date: '2026-12-31',
      title: t('calendar.d14.title'),
      description: t('calendar.d14.description'),
      category: 'svizzera', who: ['tutti'],
      notes: t('calendar.d14.notes'),
    },
    {
      id: 'd15', date: '2026-06-30',
      title: t('calendar.d15.title'),
      description: t('calendar.d15.description'),
      category: 'dichiarazione', who: ['tutti'],
      documents: [t('calendar.d15.doc1'), t('calendar.d15.doc2'), t('calendar.d15.doc3')],
      penalty: t('calendar.d15.penalty'),
      notes: t('calendar.d15.notes'),
    },

    // ── Festività ufficiali (giorni rossi) Canton Ticino 2026 ──
    {
      id: 'h1', date: '2026-01-01',
      title: t('calendar.h1.title'),
      description: t('calendar.h1.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h2', date: '2026-01-06',
      title: t('calendar.h2.title'),
      description: t('calendar.h2.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h3', date: '2026-03-19',
      title: t('calendar.h3.title'),
      description: t('calendar.h3.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h4', date: '2026-04-03',
      title: t('calendar.h4.title'),
      description: t('calendar.h4.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h5', date: '2026-04-05',
      title: t('calendar.h5.title'),
      description: t('calendar.h5.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h6', date: '2026-04-06',
      title: t('calendar.h6.title'),
      description: t('calendar.h6.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h7', date: '2026-05-14',
      title: t('calendar.h7.title'),
      description: t('calendar.h7.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h8', date: '2026-05-25',
      title: t('calendar.h8.title'),
      description: t('calendar.h8.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h9', date: '2026-06-04',
      title: t('calendar.h9.title'),
      description: t('calendar.h9.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h10', date: '2026-06-29',
      title: t('calendar.h10.title'),
      description: t('calendar.h10.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h11', date: '2026-08-01',
      title: t('calendar.h11.title'),
      description: t('calendar.h11.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h12', date: '2026-08-15',
      title: t('calendar.h12.title'),
      description: t('calendar.h12.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h13', date: '2026-11-01',
      title: t('calendar.h13.title'),
      description: t('calendar.h13.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h14', date: '2026-12-08',
      title: t('calendar.h14.title'),
      description: t('calendar.h14.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h15', date: '2026-12-25',
      title: t('calendar.h15.title'),
      description: t('calendar.h15.description'),
      category: 'festivo', who: ['tutti'],
    },
    {
      id: 'h16', date: '2026-12-26',
      title: t('calendar.h16.title'),
      description: t('calendar.h16.description'),
      category: 'festivo', who: ['tutti'],
    },

    // ── Festività facoltative Canton Ticino 2026 ──
    {
      id: 'hf1', date: '2026-01-02',
      title: t('calendar.hf1.title'),
      description: t('calendar.hf1.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
    {
      id: 'hf2', date: '2026-02-16',
      title: t('calendar.hf2.title'),
      description: t('calendar.hf2.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
    {
      id: 'hf3', date: '2026-02-17',
      title: t('calendar.hf3.title'),
      description: t('calendar.hf3.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
    {
      id: 'hf4', date: '2026-04-04',
      title: t('calendar.hf4.title'),
      description: t('calendar.hf4.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
    {
      id: 'hf5', date: '2026-05-01',
      title: t('calendar.hf5.title'),
      description: t('calendar.hf5.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
    {
      id: 'hf6', date: '2026-12-31',
      title: t('calendar.hf6.title'),
      description: t('calendar.hf6.description'),
      category: 'facoltativo', who: ['tutti'],
      notes: t('calendar.hf.notes'),
    },
  ];
}

interface TaxCalendarProps {
  initialTab?: 'fiscal' | 'holidays';
}

const MONTH_NAMES_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const DAY_NAMES_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

const TaxCalendar: React.FC<TaxCalendarProps> = ({ initialTab }) => {
  const { t } = useTranslation();
  const CATEGORY_CONFIG = useMemo(() => getCategoryConfig(t), [t]);
  const DEADLINES_2026 = useMemo(() => getDeadlines2026(t), [t]);
  const [activeTab, setActiveTab] = useState<'fiscal' | 'holidays'>(initialTab || 'fiscal');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterType, setFilterType] = useState<'tutti' | 'vecchio' | 'nuovo'>('tutti');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return now.getFullYear() === 2026 ? now.getMonth() : 0; // default Jan 2026
  });

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Split deadlines into fiscal and holidays
  const fiscalCategories = new Set(['irpef', 'svizzera', 'contributi', 'dichiarazione', 'altro']);
  const holidayCategories = new Set(['festivo', 'facoltativo']);

  const activeDeadlines = useMemo(() => {
    return DEADLINES_2026.filter(d =>
      activeTab === 'fiscal' ? fiscalCategories.has(d.category) : holidayCategories.has(d.category)
    );
  }, [DEADLINES_2026, activeTab]);

  // Reset filter when switching tabs
  const handleTabChange = (tab: 'fiscal' | 'holidays') => {
    setActiveTab(tab);
    setFilterCategory('all');
    setSelectedDate(null);
    Analytics.trackUIInteraction('guida', 'calendario', 'tab_vista', 'click', tab);
  };

  // Sync with initialTab prop
  useEffect(() => {
    if (initialTab && initialTab !== activeTab) {
      setActiveTab(initialTab);
      setFilterCategory('all');
      setSelectedDate(null);
    }
  }, [initialTab]);

  const activeCategoryConfig = useMemo(() => {
    return Object.fromEntries(
      Object.entries(CATEGORY_CONFIG).filter(([key]) =>
        activeTab === 'fiscal' ? fiscalCategories.has(key) : holidayCategories.has(key)
      )
    );
  }, [CATEGORY_CONFIG, activeTab]);

  const filteredDeadlines = useMemo(() => {
    return activeDeadlines
      .filter(d => {
        if (filterCategory !== 'all' && d.category !== filterCategory) return false;
        if (activeTab === 'fiscal' && filterType !== 'tutti' && !d.who.includes(filterType) && !d.who.includes('tutti')) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [activeDeadlines, filterCategory, filterType, activeTab]);

  // Build a map: dateStr -> deadlines for quick lookup
  const deadlinesByDate = useMemo(() => {
    const map: Record<string, TaxDeadline[]> = {};
    filteredDeadlines.forEach(d => {
      if (!map[d.date]) map[d.date] = [];
      map[d.date].push(d);
    });
    return map;
  }, [filteredDeadlines]);

  const nextDeadline = useMemo(() => {
    return activeDeadlines.find(d => d.date >= todayStr);
  }, [activeDeadlines, todayStr]);

  const getDaysUntil = (dateStr: string) => {
    const target = new Date(dateStr);
    const diff = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  // Calendar grid helpers
  const year = 2026;
  const daysInMonth = new Date(year, currentMonth + 1, 0).getDate();
  const firstDayOfWeek = (new Date(year, currentMonth, 1).getDay() + 6) % 7; // Monday=0

  const calendarDays = useMemo(() => {
    const days: (number | null)[] = [];
    for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    return days;
  }, [daysInMonth, firstDayOfWeek]);

  const getDateStr = (day: number) => `2026-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const selectedDeadlines = useMemo(() => {
    if (!selectedDate) return [];
    return deadlinesByDate[selectedDate] || [];
  }, [selectedDate, deadlinesByDate]);

  // Count events per month for mini indicators
  const monthEventCounts = useMemo(() => {
    const counts: number[] = Array(12).fill(0);
    filteredDeadlines.forEach(d => {
      const m = parseInt(d.date.substring(5, 7)) - 1;
      counts[m]++;
    });
    return counts;
  }, [filteredDeadlines]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-purple-600 via-indigo-600 to-blue-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            {activeTab === 'fiscal' ? <Calendar size={32} /> : <Star size={32} />}
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{activeTab === 'fiscal' ? t('calendar.title') : t('calendar.holidaysTitle')}</h1>
            <p className="text-purple-100 mt-1">{activeTab === 'fiscal' ? t('calendar.subtitle') : t('calendar.holidaysSubtitle')}</p>
          </div>
        </div>

        {/* Tab switcher — only show if no initialTab forced */}
        {!initialTab && (
          <div className="flex gap-2 mt-4 bg-white/10 rounded-xl p-1">
            <button
              onClick={() => handleTabChange('fiscal')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'fiscal' ? 'bg-white text-indigo-700 shadow-lg' : 'text-white/80 hover:bg-white/10'}`}
            >
              <Calendar size={16} />
              {t('calendar.tabFiscal')}
            </button>
            <button
              onClick={() => handleTabChange('holidays')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'holidays' ? 'bg-white text-indigo-700 shadow-lg' : 'text-white/80 hover:bg-white/10'}`}
            >
              <Star size={16} />
              {t('calendar.tabHolidays')}
            </button>
          </div>
        )}

        {/* Next deadline highlight */}
        {nextDeadline && (
          <div className="mt-6 bg-white/15 backdrop-blur-sm rounded-2xl p-4 border border-white/20">
            <div className="flex items-center gap-2 text-purple-100 text-xs font-bold uppercase mb-2">
              <Bell size={14} />
              {t('calendar.nextDeadline')}
            </div>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="font-bold text-xl">{nextDeadline.title}</div>
                <div className="text-purple-100 text-sm">{formatDate(nextDeadline.date)}</div>
              </div>
              <div className="px-4 py-2 bg-white/20 rounded-xl font-extrabold text-2xl">
                {getDaysUntil(nextDeadline.date)} {t('calendar.days')}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { setFilterCategory('all'); Analytics.trackUIInteraction('guida', 'calendario', 'filtro_categoria', 'click', 'all'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filterCategory === 'all' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
          >
            {t('calendar.all')}
          </button>
          {(Object.entries(activeCategoryConfig) as [string, CategoryConfig][]).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => { setFilterCategory(key); Analytics.trackUIInteraction('guida', 'calendario', 'filtro_categoria', 'click', key); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${filterCategory === key ? `bg-${cfg.color}-600 text-white` : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
            >
              <cfg.icon size={12} />
              {cfg.label}
            </button>
          ))}
        </div>

        {activeTab === 'fiscal' && (
          <div className="flex gap-2 ml-auto">
            {(['tutti', 'vecchio', 'nuovo'] as const).map(ft => (
              <button key={ft}
                onClick={() => { setFilterType(ft); Analytics.trackUIInteraction('guida', 'calendario', 'filtro_tipo', 'click', ft); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filterType === ft ? 'bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
              >
                {ft === 'tutti' ? `👥 ${t('calendar.filterAll')}` : ft === 'vecchio' ? `📋 ${t('calendar.filterOld')}` : `📄 ${t('calendar.filterNew')}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-3">
        <button
          onClick={() => setCurrentMonth(m => Math.max(0, m - 1))}
          disabled={currentMonth === 0}
          className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
        >
          <ChevronDown size={20} className="rotate-90" />
        </button>

        {/* Month selector */}
        <div className="flex gap-1 flex-wrap justify-center">
          {MONTH_NAMES_IT.map((name, i) => (
            <button
              key={i}
              onClick={() => { setCurrentMonth(i); setSelectedDate(null); }}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-all relative ${
                currentMonth === i
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              {name.substring(0, 3)}
              {monthEventCounts[i] > 0 && (
                <span className={`absolute -top-1 -right-1 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center ${
                  currentMonth === i ? 'bg-white text-indigo-600' : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300'
                }`}>
                  {monthEventCounts[i]}
                </span>
              )}
            </button>
          ))}
        </div>

        <button
          onClick={() => setCurrentMonth(m => Math.min(11, m + 1))}
          disabled={currentMonth === 11}
          className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
        >
          <ChevronDown size={20} className="-rotate-90" />
        </button>
      </div>

      {/* Calendar Grid */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        {/* Day names header */}
        <div className="grid grid-cols-7 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
          {DAY_NAMES_IT.map(day => (
            <div key={day} className="py-2 text-center text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar cells */}
        <div className="grid grid-cols-7">
          {calendarDays.map((day, idx) => {
            if (day === null) {
              return <div key={`empty-${idx}`} className="aspect-square border-b border-r border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/30" />;
            }

            const dateStr = getDateStr(day);
            const events = deadlinesByDate[dateStr] || [];
            const hasEvents = events.length > 0;
            const isToday = dateStr === todayStr;
            const isSelected = dateStr === selectedDate;
            const isPast = dateStr < todayStr;

            return (
              <div
                key={day}
                onClick={() => {
                  if (hasEvents) {
                    setSelectedDate(isSelected ? null : dateStr);
                    Analytics.trackUIInteraction('guida', 'calendario', 'giorno', 'click', dateStr);
                  }
                }}
                className={`aspect-square border-b border-r border-slate-100 dark:border-slate-700/50 p-1 sm:p-2 flex flex-col transition-all relative
                  ${hasEvents ? 'cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-950/20' : ''}
                  ${isSelected ? 'bg-indigo-100 dark:bg-indigo-900/30 ring-2 ring-indigo-500 ring-inset' : ''}
                  ${isPast && !hasEvents ? 'opacity-40' : ''}
                `}
              >
                {/* Day number */}
                <div className={`text-xs sm:text-sm font-bold self-end w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded-full ${
                  isToday ? 'bg-indigo-600 text-white' : 'text-slate-700 dark:text-slate-300'
                }`}>
                  {day}
                </div>

                {/* Event dots */}
                {hasEvents && (
                  <div className="flex-grow flex flex-col justify-end gap-0.5 mt-1">
                    {events.slice(0, 3).map((e, i) => {
                      const cfg = CATEGORY_CONFIG[e.category];
                      return (
                        <div
                          key={i}
                          className={`h-1.5 sm:h-2 rounded-full bg-${cfg?.color || 'indigo'}-500 w-full`}
                          title={e.title}
                        />
                      );
                    })}
                    {events.length > 3 && (
                      <div className="text-[8px] font-bold text-slate-400 text-center">+{events.length - 3}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected date detail panel */}
      {selectedDate && selectedDeadlines.length > 0 && (
        <div className="space-y-3 animate-fade-in">
          <div className="flex items-center gap-3">
            <div className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-lg text-sm font-extrabold">
              📅 {formatDate(selectedDate)}
            </div>
            <div className="flex-grow h-px bg-slate-200 dark:bg-slate-700"></div>
            <button onClick={() => setSelectedDate(null)} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
              ✕ {t('calendar.close') || 'Chiudi'}
            </button>
          </div>

          {selectedDeadlines.map(d => {
            const days = getDaysUntil(d.date);
            const isPast = days < 0;
            const cfg = CATEGORY_CONFIG[d.category] as CategoryConfig;

            return (
              <div
                key={d.id}
                className={`rounded-2xl border p-4 transition-all ${
                  isPast ? 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 opacity-70'
                    : days <= 7 ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
                    : days <= 30 ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
                    : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-${cfg.color}-100 dark:bg-${cfg.color}-900/30 text-${cfg.color}-700 dark:text-${cfg.color}-300`}>
                    {cfg.label}
                  </span>
                  {d.who.map(w => (
                    <span key={w} className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      {w === 'tutti' ? `👥 ${t('calendar.filterAll')}` : w === 'vecchio' ? `📋 ${t('calendar.filterOld')}` : `📄 ${t('calendar.filterNew')}`}
                    </span>
                  ))}
                  {!isPast && (
                    <span className={`text-xs font-bold ${days <= 7 ? 'text-red-600' : days <= 30 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {days === 0 ? `⚠️ ${t('calendar.today')}` : `📅 ${t('calendar.inDays', { count: days })}`}
                    </span>
                  )}
                  {isPast && <CheckCircle2 size={14} className="text-slate-400" />}
                </div>
                <h4 className="font-bold text-slate-800 dark:text-slate-100 text-lg">{d.title}</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{d.description}</p>

                {d.documents && d.documents.length > 0 && (
                  <div className="mt-3">
                    <h5 className="text-xs font-bold text-slate-500 uppercase mb-1">📎 {t('calendar.documentsNeeded')}</h5>
                    <div className="flex flex-wrap gap-2">
                      {d.documents.map((doc, i) => (
                        <span key={i} className="px-2.5 py-1 bg-white dark:bg-slate-900 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700">
                          {doc}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {d.penalty && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 rounded-xl mt-3">
                    <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-xs font-bold text-red-700 dark:text-red-300">{t('calendar.penaltyLabel')}</div>
                      <div className="text-xs text-red-600 dark:text-red-400">{d.penalty}</div>
                    </div>
                  </div>
                )}
                {d.notes && (
                  <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-xl mt-3">
                    <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-blue-700 dark:text-blue-300">{d.notes}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state when no events in current view */}
      {filteredDeadlines.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Calendar size={48} className="mx-auto mb-3 opacity-30" />
          <p className="font-bold">{t('calendar.noDeadlinesFound')}</p>
          <p className="text-sm">{t('calendar.noDeadlinesHint')}</p>
        </div>
      )}

      {/* Disclaimer */}
      <div className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-800 dark:text-amber-200">
            <strong>{t('calendar.disclaimer')}:</strong> {t('calendar.disclaimerText')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaxCalendar;
