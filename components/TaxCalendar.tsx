import React, { useState, useMemo } from 'react';
import { Calendar, Clock, AlertTriangle, CheckCircle2, Bell, ChevronDown, ChevronUp, FileText, Info, Euro, Landmark, Building2, Shield } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';

interface TaxDeadline {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  description: string;
  category: 'irpef' | 'svizzera' | 'contributi' | 'dichiarazione' | 'altro';
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
  ];
}

const TaxCalendar: React.FC = () => {
  const { t } = useTranslation();
  const CATEGORY_CONFIG = useMemo(() => getCategoryConfig(t), [t]);
  const DEADLINES_2026 = useMemo(() => getDeadlines2026(t), [t]);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterType, setFilterType] = useState<'tutti' | 'vecchio' | 'nuovo'>('tutti');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const filteredDeadlines = useMemo(() => {
    return DEADLINES_2026
      .filter(d => {
        if (filterCategory !== 'all' && d.category !== filterCategory) return false;
        if (filterType !== 'tutti' && !d.who.includes(filterType) && !d.who.includes('tutti')) return false;
        if (!showPast && d.date < todayStr) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filterCategory, filterType, showPast, todayStr]);

  const nextDeadline = useMemo(() => {
    return DEADLINES_2026.find(d => d.date >= todayStr);
  }, [todayStr]);

  const getDaysUntil = (dateStr: string) => {
    const target = new Date(dateStr);
    const diff = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  const getStatusColor = (dateStr: string) => {
    const days = getDaysUntil(dateStr);
    if (days < 0) return 'text-slate-400 bg-slate-50 dark:bg-slate-900';
    if (days <= 7) return 'text-red-600 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800';
    if (days <= 30) return 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800';
    return 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800';
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const getMonthName = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('it-IT', { month: 'long' }).toUpperCase();
  };

  // Group by month
  const groupedByMonth = useMemo(() => {
    const groups: Record<string, TaxDeadline[]> = {};
    filteredDeadlines.forEach(d => {
      const month = d.date.substring(0, 7);
      if (!groups[month]) groups[month] = [];
      groups[month].push(d);
    });
    return groups;
  }, [filteredDeadlines]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-purple-600 via-indigo-600 to-blue-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Calendar size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{t('calendar.title')}</h1>
            <p className="text-purple-100 mt-1">{t('calendar.subtitle')}</p>
          </div>
        </div>

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
        {/* Category filter */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { setFilterCategory('all'); Analytics.trackUIInteraction('TaxCalendar', 'filter_category', 'all'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filterCategory === 'all' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
          >
            {t('calendar.all')}
          </button>
          {(Object.entries(CATEGORY_CONFIG) as [string, CategoryConfig][]).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => { setFilterCategory(key); Analytics.trackUIInteraction('TaxCalendar', 'filter_category', key); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${filterCategory === key ? `bg-${cfg.color}-600 text-white` : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
            >
              <cfg.icon size={12} />
              {cfg.label}
            </button>
          ))}
        </div>

        {/* Worker type filter */}
        <div className="flex gap-2 ml-auto">
          {(['tutti', 'vecchio', 'nuovo'] as const).map(ft => (
            <button key={ft}
              onClick={() => { setFilterType(ft); Analytics.trackUIInteraction('TaxCalendar', 'filter_type', ft); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filterType === ft ? 'bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}`}
            >
              {ft === 'tutti' ? `👥 ${t('calendar.filterAll')}` : ft === 'vecchio' ? `📋 ${t('calendar.filterOld')}` : `📄 ${t('calendar.filterNew')}`}
            </button>
          ))}
        </div>
      </div>

      {/* Show past toggle */}
      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 cursor-pointer">
        <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
        {t('calendar.showPast')}
      </label>

      {/* Timeline */}
      <div className="space-y-8">
        {(Object.entries(groupedByMonth) as [string, TaxDeadline[]][]).map(([month, deadlines]) => (
          <div key={month}>
            <div className="flex items-center gap-3 mb-4">
              <div className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-lg text-sm font-extrabold uppercase tracking-wider">
                {getMonthName(deadlines[0].date)}
              </div>
              <div className="flex-grow h-px bg-slate-200 dark:bg-slate-700"></div>
              <span className="text-xs text-slate-400">{deadlines.length} {deadlines.length === 1 ? t('calendar.deadlineSingular') : t('calendar.deadlinePlural')}</span>
            </div>

            <div className="space-y-3">
              {deadlines.map(d => {
                const days = getDaysUntil(d.date);
                const isPast = days < 0;
                const isExpanded = expandedId === d.id;
                const cfg = CATEGORY_CONFIG[d.category] as CategoryConfig;

                return (
                  <div
                    key={d.id}
                    className={`rounded-2xl border p-4 transition-all cursor-pointer hover:shadow-md ${getStatusColor(d.date)} ${isPast ? 'opacity-60' : ''}`}
                    onClick={() => {
                      setExpandedId(isExpanded ? null : d.id);
                      Analytics.trackUIInteraction('TaxCalendar', 'toggle_deadline', d.title);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      {/* Date badge */}
                      <div className="flex-shrink-0 text-center">
                        <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center ${isPast ? 'bg-slate-200 dark:bg-slate-700' : days <= 7 ? 'bg-red-500 text-white' : days <= 30 ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white'}`}>
                          <span className="text-lg font-extrabold leading-none">{new Date(d.date).getDate()}</span>
                          <span className="text-[9px] font-bold uppercase">{new Date(d.date).toLocaleDateString('it-IT', { month: 'short' })}</span>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="flex-grow min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-${cfg.color}-100 dark:bg-${cfg.color}-900/30 text-${cfg.color}-700 dark:text-${cfg.color}-300`}>
                            {cfg.label}
                          </span>
                          {d.who.map(w => (
                            <span key={w} className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                              {w === 'tutti' ? `👥 ${t('calendar.filterAll')}` : w === 'vecchio' ? `📋 ${t('calendar.filterOld')}` : `📄 ${t('calendar.filterNew')}`}
                            </span>
                          ))}
                          {isPast && <CheckCircle2 size={14} className="text-slate-400" />}
                        </div>
                        <h4 className="font-bold text-slate-800 dark:text-slate-100 mt-1">{d.title}</h4>
                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{d.description}</p>

                        {!isPast && (
                          <div className="mt-2 text-xs font-bold">
                            {days === 0 ? <span className="text-red-600">⚠️ {t('calendar.today')}</span> :
                             days <= 7 ? <span className="text-red-600">⏰ {t('calendar.inDays', { count: days })}</span> :
                             days <= 30 ? <span className="text-amber-600">📅 {t('calendar.inDays', { count: days })}</span> :
                             <span className="text-emerald-600">✅ {t('calendar.inDays', { count: days })}</span>}
                          </div>
                        )}
                      </div>

                      {/* Expand icon */}
                      <div className="flex-shrink-0">
                        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </div>
                    </div>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 space-y-3 animate-fade-in">
                        {d.documents && d.documents.length > 0 && (
                          <div>
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
                          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 rounded-xl">
                            <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                            <div>
                              <div className="text-xs font-bold text-red-700 dark:text-red-300">{t('calendar.penaltyLabel')}</div>
                              <div className="text-xs text-red-600 dark:text-red-400">{d.penalty}</div>
                            </div>
                          </div>
                        )}
                        {d.notes && (
                          <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-xl">
                            <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                            <div className="text-xs text-blue-700 dark:text-blue-300">{d.notes}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

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
