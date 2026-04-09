import { useState } from 'react';
import {
  FileText, Building2, Wrench, ShoppingBag, UtensilsCrossed, Heart,
  ChevronDown, ChevronUp, Clock, Palmtree, Gift, Bell, Shield,
  Scale, Info, AlertTriangle, CheckCircle2, ArrowRightLeft
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';

// ── Swiss Ticino CCNL / GAV Data ────────────────────────────────────────
// Source: Ufficio dell'ispettorato del lavoro TI, SECO contratti normali,
// CCNL dichiarati d'obbligatorietà generale (DOG) per il Canton Ticino.
// Italian CCNL sources: CNEL Archivio dei Contratti Collettivi Nazionali.
// Data current as of 2026.

export interface SectorContract {
  id: string;
  icon: typeof Building2;
  /** i18n key prefix */
  keyPrefix: string;
  // Swiss side
  ch: {
    weeklyHours: number;
    vacationWeeks: number;        // minimum (workers >= 50 can get 5)
    vacationWeeksYoung: number;   // under 20
    thirteenthMonth: boolean;
    thirteenthMonthPct: number;   // % of annual (8.33% = 1/12)
    noticePeriodMonths: number;   // after probation, first years
    noticePeriodMonths5: number;  // after 5 years
    noticePeriodMonths10: number; // after 10 years
    probationMonths: number;
    minWageCHF?: number;          // monthly minimum if applicable
    specialNotes?: string;        // i18n key for special notes
  };
  // Italian equivalent
  it: {
    weeklyHours: number;
    vacationWeeks: number;
    thirteenthMonth: boolean;
    fourteenthMonth: boolean;
    noticePeriodDaysMin: number;
    noticePeriodDaysMax: number;
    probationDays: number;
    minWageEUR?: number;
    ccnlName: string;            // Official Italian CCNL name
    specialNotes?: string;
  };
}

export const SECTOR_CONTRACTS: SectorContract[] = [
  {
    id: 'construction',
    icon: Building2,
    keyPrefix: 'contracts.sector.construction',
    ch: {
      weeklyHours: 42,
      vacationWeeks: 5,
      vacationWeeksYoung: 5,
      thirteenthMonth: true,
      thirteenthMonthPct: 8.33,
      noticePeriodMonths: 2,
      noticePeriodMonths5: 2,
      noticePeriodMonths10: 3,
      probationMonths: 1,
      minWageCHF: 5100,
      specialNotes: 'contracts.sector.construction.notesCH',
    },
    it: {
      weeklyHours: 40,
      vacationWeeks: 4,
      thirteenthMonth: true,
      fourteenthMonth: false,
      noticePeriodDaysMin: 15, // operaio
      noticePeriodDaysMax: 60, // impiegato anziano
      probationDays: 60,
      ccnlName: 'CCNL Edilizia Industria',
      specialNotes: 'contracts.sector.construction.notesIT',
    },
  },
  {
    id: 'metalwork',
    icon: Wrench,
    keyPrefix: 'contracts.sector.metalwork',
    ch: {
      weeklyHours: 40,
      vacationWeeks: 4,
      vacationWeeksYoung: 5,
      thirteenthMonth: true,
      thirteenthMonthPct: 8.33,
      noticePeriodMonths: 1,
      noticePeriodMonths5: 2,
      noticePeriodMonths10: 3,
      probationMonths: 3,
      minWageCHF: 3800,
      specialNotes: 'contracts.sector.metalwork.notesCH',
    },
    it: {
      weeklyHours: 40,
      vacationWeeks: 4,
      thirteenthMonth: true,
      fourteenthMonth: false,
      noticePeriodDaysMin: 15,
      noticePeriodDaysMax: 90,
      probationDays: 180,
      ccnlName: 'CCNL Metalmeccanica Industria',
      specialNotes: 'contracts.sector.metalwork.notesIT',
    },
  },
  {
    id: 'commerce',
    icon: ShoppingBag,
    keyPrefix: 'contracts.sector.commerce',
    ch: {
      weeklyHours: 41,
      vacationWeeks: 4,
      vacationWeeksYoung: 5,
      thirteenthMonth: true,
      thirteenthMonthPct: 8.33,
      noticePeriodMonths: 1,
      noticePeriodMonths5: 2,
      noticePeriodMonths10: 3,
      probationMonths: 1,
      minWageCHF: 3600,
      specialNotes: 'contracts.sector.commerce.notesCH',
    },
    it: {
      weeklyHours: 40,
      vacationWeeks: 4,
      thirteenthMonth: true,
      fourteenthMonth: true,
      noticePeriodDaysMin: 15,
      noticePeriodDaysMax: 120,
      probationDays: 60,
      ccnlName: 'CCNL Commercio Confcommercio',
      specialNotes: 'contracts.sector.commerce.notesIT',
    },
  },
  {
    id: 'hospitality',
    icon: UtensilsCrossed,
    keyPrefix: 'contracts.sector.hospitality',
    ch: {
      weeklyHours: 42,
      vacationWeeks: 4,
      vacationWeeksYoung: 5,
      thirteenthMonth: true,
      thirteenthMonthPct: 8.33,
      noticePeriodMonths: 1,
      noticePeriodMonths5: 2,
      noticePeriodMonths10: 3,
      probationMonths: 1,
      minWageCHF: 3680,
      specialNotes: 'contracts.sector.hospitality.notesCH',
    },
    it: {
      weeklyHours: 40,
      vacationWeeks: 4,
      thirteenthMonth: true,
      fourteenthMonth: true,
      noticePeriodDaysMin: 15,
      noticePeriodDaysMax: 90,
      probationDays: 45,
      ccnlName: 'CCNL Turismo Pubblici Esercizi',
      specialNotes: 'contracts.sector.hospitality.notesIT',
    },
  },
  {
    id: 'healthcare',
    icon: Heart,
    keyPrefix: 'contracts.sector.healthcare',
    ch: {
      weeklyHours: 42,
      vacationWeeks: 4,
      vacationWeeksYoung: 5,
      thirteenthMonth: true,
      thirteenthMonthPct: 8.33,
      noticePeriodMonths: 2,
      noticePeriodMonths5: 3,
      noticePeriodMonths10: 3,
      probationMonths: 3,
      minWageCHF: 4200,
      specialNotes: 'contracts.sector.healthcare.notesCH',
    },
    it: {
      weeklyHours: 36,
      vacationWeeks: 4,
      thirteenthMonth: true,
      fourteenthMonth: false,
      noticePeriodDaysMin: 30,
      noticePeriodDaysMax: 120,
      probationDays: 180,
      ccnlName: 'CCNL Sanità Pubblica / Comparto',
      specialNotes: 'contracts.sector.healthcare.notesIT',
    },
  },
];

// ── General Rights Data ────────────────────────────────────────
export const WORKER_RIGHTS_CH = {
  sickLeave: { year1: 3, year2: 8, year3Plus: 9 }, // weeks per service year (Bern scale typical)
  maternityWeeks: 14,
  paternityWeeks: 2,
  publicHolidays: 9, // Ticino cantonal
  overtimeLimit: 2,   // max 2h/day beyond normal
};

// ── Component ────────────────────────────────────────────────

const ContractsGuide = () => {
  const { t } = useTranslation();
  const [expandedSector, setExpandedSector] = useState<string | null>('construction');
  const [showRights, setShowRights] = useState(true);

  const toggleSector = (id: string) => {
    setExpandedSector(expandedSector === id ? null : id);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 text-xs font-semibold">
          <Scale size={14} />
          {t('contracts.badge')}
        </div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          {t('contracts.title')}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          {t('contracts.subtitle')}
        </p>
      </div>

      {/* Info banner */}
      <div className="bg-warm-50 dark:bg-warm-950 border border-warm-200 dark:border-warm-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Info size={18} className="text-warm-700 dark:text-warm-400 mt-0.5 shrink-0" />
          <div className="text-sm text-warm-800 dark:text-warm-200">
            <p className="font-semibold">{t('contracts.infoTitle')}</p>
            <p className="mt-1 text-warm-700 dark:text-warm-300">{t('contracts.infoText')}</p>
          </div>
        </div>
      </div>

      {/* Sectors */}
      <div className="space-y-3">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <FileText size={20} className="text-indigo-600 dark:text-indigo-400" />
          {t('contracts.sectorsTitle')}
        </h2>

        {SECTOR_CONTRACTS.map((sector) => {
          const Icon = sector.icon;
          const isExpanded = expandedSector === sector.id;

          return (
            <div key={sector.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              {/* Sector header */}
              <button
                onClick={() => toggleSector(sector.id)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                aria-expanded={isExpanded}
                aria-label={t(`${sector.keyPrefix}.name`)}
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
                    <Icon size={20} className="text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white">
                      {t(`${sector.keyPrefix}.name`)}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t(`${sector.keyPrefix}.ccnlName`)}
                    </p>
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronUp size={20} className="text-slate-500 dark:text-slate-300" />
                ) : (
                  <ChevronDown size={20} className="text-slate-500 dark:text-slate-300" />
                )}
              </button>

              {/* Sector content */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-4">
                  {/* Comparison table */}
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-600">
                          <th className="text-left py-2 px-2 text-xs font-semibold text-slate-500 dark:text-slate-400 w-1/3">
                            {t('contracts.table.aspect')}
                          </th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-red-700 dark:text-red-400 w-1/3">
                            🇨🇭 {t('contracts.table.switzerland')}
                          </th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-green-700 dark:text-green-400 w-1/3">
                            🇮🇹 {t('contracts.table.italy')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* Weekly hours */}
                        <tr className="border-b border-slate-100 dark:border-slate-700">
                          <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Clock size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                            {t('contracts.table.weeklyHours')}
                          </td>
                          <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                            {sector.ch.weeklyHours}h
                          </td>
                          <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                            {sector.it.weeklyHours}h
                          </td>
                        </tr>
                        {/* Vacation */}
                        <tr className="border-b border-slate-100 dark:border-slate-700">
                          <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Palmtree size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                            {t('contracts.table.vacation')}
                          </td>
                          <td className="py-2 px-2 text-center text-slate-900 dark:text-white">
                            <span className="font-semibold">{sector.ch.vacationWeeks}</span>
                            <span className="text-xs text-slate-500 dark:text-slate-400"> {t('contracts.table.weeks')}</span>
                            {sector.ch.vacationWeeksYoung > sector.ch.vacationWeeks && (
                              <div className="text-xs text-blue-600 dark:text-blue-400">
                                ({sector.ch.vacationWeeksYoung} {t('contracts.table.under20')})
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-2 text-center text-slate-900 dark:text-white">
                            <span className="font-semibold">{sector.it.vacationWeeks}</span>
                            <span className="text-xs text-slate-500 dark:text-slate-400"> {t('contracts.table.weeks')}</span>
                          </td>
                        </tr>
                        {/* 13th month */}
                        <tr className="border-b border-slate-100 dark:border-slate-700">
                          <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Gift size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                            {t('contracts.table.thirteenthMonth')}
                          </td>
                          <td className="py-2 px-2 text-center">
                            {sector.ch.thirteenthMonth ? (
                              <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center justify-center gap-1">
                                <CheckCircle2 size={14} /> {t('contracts.table.yes')}
                              </span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400">—</span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-center">
                            {sector.it.thirteenthMonth ? (
                              <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center justify-center gap-1">
                                <CheckCircle2 size={14} /> {t('contracts.table.yes')}
                              </span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400">—</span>
                            )}
                            {sector.it.fourteenthMonth && (
                              <div className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-0.5">
                                + {t('contracts.table.fourteenthMonth')}
                              </div>
                            )}
                          </td>
                        </tr>
                        {/* Notice period */}
                        <tr className="border-b border-slate-100 dark:border-slate-700">
                          <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Bell size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                            {t('contracts.table.noticePeriod')}
                          </td>
                          <td className="py-2 px-2 text-center text-xs text-slate-900 dark:text-white">
                            <div>{sector.ch.noticePeriodMonths} {t('contracts.table.months')} <span className="text-slate-500 dark:text-slate-400">(&lt;5a)</span></div>
                            <div>{sector.ch.noticePeriodMonths5} {t('contracts.table.months')} <span className="text-slate-500 dark:text-slate-400">(5-9a)</span></div>
                            <div>{sector.ch.noticePeriodMonths10} {t('contracts.table.months')} <span className="text-slate-500 dark:text-slate-400">(≥10a)</span></div>
                          </td>
                          <td className="py-2 px-2 text-center text-xs text-slate-900 dark:text-white">
                            <div>{sector.it.noticePeriodDaysMin}–{sector.it.noticePeriodDaysMax} {t('contracts.table.days')}</div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              ({t('contracts.table.byLevel')})
                            </div>
                          </td>
                        </tr>
                        {/* Probation */}
                        <tr className="border-b border-slate-100 dark:border-slate-700">
                          <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Shield size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                            {t('contracts.table.probation')}
                          </td>
                          <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                            {sector.ch.probationMonths} {t('contracts.table.months')}
                          </td>
                          <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                            {sector.it.probationDays} {t('contracts.table.days')}
                          </td>
                        </tr>
                        {/* Minimum wage */}
                        {(sector.ch.minWageCHF || sector.it.minWageEUR) && (
                          <tr className="border-b border-slate-100 dark:border-slate-700">
                            <td className="py-2 px-2 text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                              <ArrowRightLeft size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                              {t('contracts.table.minWage')}
                            </td>
                            <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                              {sector.ch.minWageCHF
                                ? `CHF ${sector.ch.minWageCHF.toLocaleString('de-CH')}/m`
                                : '—'}
                            </td>
                            <td className="py-2 px-2 text-center font-semibold text-slate-900 dark:text-white">
                              {sector.it.minWageEUR
                                ? `€ ${sector.it.minWageEUR.toLocaleString('it-IT')}/m`
                                : t('contracts.table.noMinWage')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Notes */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {sector.ch.specialNotes && (
                      <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/50 rounded-lg p-3">
                        <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">
                          🇨🇭 {t('contracts.notesLabel')}
                        </p>
                        <p className="text-xs text-red-800 dark:text-red-300">
                          {t(sector.ch.specialNotes)}
                        </p>
                      </div>
                    )}
                    {sector.it.specialNotes && (
                      <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800/50 rounded-lg p-3">
                        <p className="text-xs font-semibold text-green-700 dark:text-green-400 mb-1">
                          🇮🇹 {t('contracts.notesLabel')} — {sector.it.ccnlName}
                        </p>
                        <p className="text-xs text-green-800 dark:text-green-300">
                          {t(sector.it.specialNotes)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* General Worker Rights CH */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <button
          onClick={() => setShowRights(!showRights)}
          className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          aria-expanded={showRights}
          aria-label={t('contracts.rights.title')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/30">
              <Scale size={20} className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="font-bold text-slate-900 dark:text-white">
              {t('contracts.rights.title')}
            </h2>
          </div>
          {showRights ? (
            <ChevronUp size={20} className="text-slate-500 dark:text-slate-300" />
          ) : (
            <ChevronDown size={20} className="text-slate-500 dark:text-slate-300" />
          )}
        </button>

        {showRights && (
          <div className="px-4 pb-4 space-y-4">
            {/* Rights cards grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Sick leave */}
              <div className="bg-warm-50 dark:bg-warm-950 rounded-lg p-3 border border-warm-200 dark:border-warm-800">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-2 flex items-center gap-1.5">
                  <Heart size={14} className="text-red-500" />
                  {t('contracts.rights.sickLeave')}
                </h4>
                <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                  <li>• {t('contracts.rights.sickLeaveYear1', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year1) })}</li>
                  <li>• {t('contracts.rights.sickLeaveYear2', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year2) })}</li>
                  <li>• {t('contracts.rights.sickLeaveYear3', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year3Plus) })}</li>
                </ul>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                  {t('contracts.rights.sickLeaveNote')}
                </p>
              </div>

              {/* Maternity / Paternity */}
              <div className="bg-warm-50 dark:bg-warm-950 rounded-lg p-3 border border-warm-200 dark:border-warm-800">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-2 flex items-center gap-1.5">
                  <Gift size={14} className="text-violet-500" />
                  {t('contracts.rights.parentalLeave')}
                </h4>
                <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                  <li>• {t('contracts.rights.maternityWeeks', { weeks: String(WORKER_RIGHTS_CH.maternityWeeks) })}</li>
                  <li>• {t('contracts.rights.paternityWeeks', { weeks: String(WORKER_RIGHTS_CH.paternityWeeks) })}</li>
                </ul>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                  {t('contracts.rights.parentalNote')}
                </p>
              </div>

              {/* Public holidays */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-2 flex items-center gap-1.5">
                  <Palmtree size={14} className="text-amber-500" />
                  {t('contracts.rights.publicHolidays')}
                </h4>
                <p className="text-xs text-slate-700 dark:text-slate-300">
                  {t('contracts.rights.publicHolidaysText', { count: String(WORKER_RIGHTS_CH.publicHolidays) })}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                  {t('contracts.rights.publicHolidaysNote')}
                </p>
              </div>

              {/* Overtime */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-2 flex items-center gap-1.5">
                  <Clock size={14} className="text-blue-500" />
                  {t('contracts.rights.overtime')}
                </h4>
                <p className="text-xs text-slate-700 dark:text-slate-300">
                  {t('contracts.rights.overtimeText')}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                  {t('contracts.rights.overtimeNote')}
                </p>
              </div>
            </div>

            {/* Protection against dismissal */}
            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3">
              <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1.5 flex items-center gap-1.5">
                <Shield size={14} />
                {t('contracts.rights.dismissalProtection')}
              </h4>
              <p className="text-xs text-amber-700 dark:text-amber-300/80">
                {t('contracts.rights.dismissalProtectionText')}
              </p>
            </div>

            {/* Frontaliere-specific rights */}
            <div className="bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-800/50 rounded-lg p-3">
              <h4 className="text-sm font-semibold text-indigo-800 dark:text-indigo-300 mb-1.5 flex items-center gap-1.5">
                <AlertTriangle size={14} />
                {t('contracts.rights.frontaliereTitle')}
              </h4>
              <ul className="space-y-1.5 text-xs text-indigo-700 dark:text-indigo-300/80">
                <li>• {t('contracts.rights.frontaliere1')}</li>
                <li>• {t('contracts.rights.frontaliere2')}</li>
                <li>• {t('contracts.rights.frontaliere3')}</li>
                <li>• {t('contracts.rights.frontaliere4')}</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Key differences summary */}
      <div className="bg-gradient-to-br from-teal-50 to-emerald-50 dark:from-teal-900/20 dark:to-emerald-900/20 rounded-xl border border-teal-200 dark:border-teal-800/50 p-4">
        <h3 className="font-bold text-slate-900 dark:text-white mb-3 flex items-center gap-2">
          <ArrowRightLeft size={18} className="text-teal-600 dark:text-teal-400" />
          {t('contracts.keyDifferences.title')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="bg-white/70 dark:bg-slate-800/50 rounded-lg p-3">
            <p className="font-semibold text-red-700 dark:text-red-400 mb-1.5">🇨🇭 {t('contracts.keyDifferences.chTitle')}</p>
            <ul className="space-y-1 text-slate-700 dark:text-slate-300">
              <li>• {t('contracts.keyDifferences.ch1')}</li>
              <li>• {t('contracts.keyDifferences.ch2')}</li>
              <li>• {t('contracts.keyDifferences.ch3')}</li>
              <li>• {t('contracts.keyDifferences.ch4')}</li>
              <li>• {t('contracts.keyDifferences.ch5')}</li>
            </ul>
          </div>
          <div className="bg-white/70 dark:bg-slate-800/50 rounded-lg p-3">
            <p className="font-semibold text-green-700 dark:text-green-400 mb-1.5">🇮🇹 {t('contracts.keyDifferences.itTitle')}</p>
            <ul className="space-y-1 text-slate-700 dark:text-slate-300">
              <li>• {t('contracts.keyDifferences.it1')}</li>
              <li>• {t('contracts.keyDifferences.it2')}</li>
              <li>• {t('contracts.keyDifferences.it3')}</li>
              <li>• {t('contracts.keyDifferences.it4')}</li>
              <li>• {t('contracts.keyDifferences.it5')}</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="text-center text-xs text-slate-500 dark:text-slate-400 px-4">
        {t('contracts.disclaimer')}
      </div>
    </div>
  );
};

export default ContractsGuide;
