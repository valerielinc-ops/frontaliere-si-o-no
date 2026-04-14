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
 vacationWeeks: number; // minimum (workers >= 50 can get 5)
 vacationWeeksYoung: number; // under 20
 thirteenthMonth: boolean;
 thirteenthMonthPct: number; // % of annual (8.33% = 1/12)
 noticePeriodMonths: number; // after probation, first years
 noticePeriodMonths5: number; // after 5 years
 noticePeriodMonths10: number; // after 10 years
 probationMonths: number;
 minWageCHF?: number; // monthly minimum if applicable
 specialNotes?: string; // i18n key for special notes
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
 ccnlName: string; // Official Italian CCNL name
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
 overtimeLimit: 2, // max 2h/day beyond normal
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
 <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent-subtle text-accent text-xs font-semibold">
 <Scale size={14} />
 {t('contracts.badge')}
 </div>
 <h1 className="text-2xl font-bold text-heading">
 {t('contracts.title')}
 </h1>
 <p className="text-sm text-subtle max-w-2xl mx-auto">
 {t('contracts.subtitle')}
 </p>
 </div>

 {/* Info banner */}
 <div className="bg-neutral-subtle border border-neutral-border rounded-xl p-4">
 <div className="flex items-start gap-3">
 <Info size={18} className="text-neutral mt-0.5 shrink-0" />
 <div className="text-sm text-neutral">
 <p className="font-semibold">{t('contracts.infoTitle')}</p>
 <p className="mt-1 text-neutral">{t('contracts.infoText')}</p>
 </div>
 </div>
 </div>

 {/* Sectors */}
 <div className="space-y-3">
 <h2 className="text-lg font-bold text-heading flex items-center gap-2">
 <FileText size={20} className="text-accent" />
 {t('contracts.sectorsTitle')}
 </h2>

 {SECTOR_CONTRACTS.map((sector) => {
 const Icon = sector.icon;
 const isExpanded = expandedSector === sector.id;

 return (
 <div key={sector.id} className="bg-surface rounded-xl border border-edge overflow-hidden">
 {/* Sector header */}
 <button
 onClick={() => toggleSector(sector.id)}
 className="w-full flex items-center justify-between p-4 text-left hover:bg-surface-raised transition-colors"
 aria-expanded={isExpanded}
 aria-label={t(`${sector.keyPrefix}.name`)}
 >
 <div className="flex items-center gap-3">
 <div className="p-2 rounded-lg bg-accent-subtle">
 <Icon size={20} className="text-accent" />
 </div>
 <div>
 <h3 className="font-bold text-heading">
 {t(`${sector.keyPrefix}.name`)}
 </h3>
 <p className="text-sm text-muted">
 {t(`${sector.keyPrefix}.ccnlName`)}
 </p>
 </div>
 </div>
 {isExpanded ? (
 <ChevronUp size={20} className="text-muted" />
 ) : (
 <ChevronDown size={20} className="text-muted" />
 )}
 </button>

 {/* Sector content */}
 {isExpanded && (
 <div className="px-4 pb-4 space-y-4">
 {/* Comparison table */}
 <div className="overflow-x-auto -mx-1">
 <table className="w-full text-sm">
 <thead>
 <tr className="border-b border-edge">
 <th className="text-left py-2 px-2 text-xs font-semibold text-muted w-1/3">
 {t('contracts.table.aspect')}
 </th>
 <th className="text-center py-2 px-2 text-xs font-semibold text-danger w-1/3">
 🇨🇭 {t('contracts.table.switzerland')}
 </th>
 <th className="text-center py-2 px-2 text-xs font-semibold text-success w-1/3">
 🇮🇹 {t('contracts.table.italy')}
 </th>
 </tr>
 </thead>
 <tbody>
 {/* Weekly hours */}
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <Clock size={14} className="text-muted shrink-0" />
 {t('contracts.table.weeklyHours')}
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
 {sector.ch.weeklyHours}h
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
 {sector.it.weeklyHours}h
 </td>
 </tr>
 {/* Vacation */}
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <Palmtree size={14} className="text-muted shrink-0" />
 {t('contracts.table.vacation')}
 </td>
 <td className="py-2 px-2 text-center text-heading">
 <span className="font-semibold">{sector.ch.vacationWeeks}</span>
 <span className="text-sm text-muted"> {t('contracts.table.weeks')}</span>
 {sector.ch.vacationWeeksYoung > sector.ch.vacationWeeks && (
 <div className="text-xs text-link">
 ({sector.ch.vacationWeeksYoung} {t('contracts.table.under20')})
 </div>
 )}
 </td>
 <td className="py-2 px-2 text-center text-heading">
 <span className="font-semibold">{sector.it.vacationWeeks}</span>
 <span className="text-sm text-muted"> {t('contracts.table.weeks')}</span>
 </td>
 </tr>
 {/* 13th month */}
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <Gift size={14} className="text-muted shrink-0" />
 {t('contracts.table.thirteenthMonth')}
 </td>
 <td className="py-2 px-2 text-center">
 {sector.ch.thirteenthMonth ? (
 <span className="text-success font-semibold flex items-center justify-center gap-1">
 <CheckCircle2 size={14} /> {t('contracts.table.yes')}
 </span>
 ) : (
 <span className="text-danger">—</span>
 )}
 </td>
 <td className="py-2 px-2 text-center">
 {sector.it.thirteenthMonth ? (
 <span className="text-success font-semibold flex items-center justify-center gap-1">
 <CheckCircle2 size={14} /> {t('contracts.table.yes')}
 </span>
 ) : (
 <span className="text-danger">—</span>
 )}
 {sector.it.fourteenthMonth && (
 <div className="text-xs text-warning font-medium mt-0.5">
 + {t('contracts.table.fourteenthMonth')}
 </div>
 )}
 </td>
 </tr>
 {/* Notice period */}
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <Bell size={14} className="text-muted shrink-0" />
 {t('contracts.table.noticePeriod')}
 </td>
 <td className="py-2 px-2 text-center text-xs text-heading">
 <div>{sector.ch.noticePeriodMonths} {t('contracts.table.months')} <span className="text-muted">(&lt;5a)</span></div>
 <div>{sector.ch.noticePeriodMonths5} {t('contracts.table.months')} <span className="text-muted">(5-9a)</span></div>
 <div>{sector.ch.noticePeriodMonths10} {t('contracts.table.months')} <span className="text-muted">(≥10a)</span></div>
 </td>
 <td className="py-2 px-2 text-center text-xs text-heading">
 <div>{sector.it.noticePeriodDaysMin}–{sector.it.noticePeriodDaysMax} {t('contracts.table.days')}</div>
 <div className="text-sm text-muted">
 ({t('contracts.table.byLevel')})
 </div>
 </td>
 </tr>
 {/* Probation */}
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <Shield size={14} className="text-muted shrink-0" />
 {t('contracts.table.probation')}
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
 {sector.ch.probationMonths} {t('contracts.table.months')}
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
 {sector.it.probationDays} {t('contracts.table.days')}
 </td>
 </tr>
 {/* Minimum wage */}
 {(sector.ch.minWageCHF || sector.it.minWageEUR) && (
 <tr className="border-b border-edge">
 <td className="py-2 px-2 text-body flex items-center gap-1.5">
 <ArrowRightLeft size={14} className="text-muted shrink-0" />
 {t('contracts.table.minWage')}
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
 {sector.ch.minWageCHF
 ? `CHF ${sector.ch.minWageCHF.toLocaleString('de-CH')}/m`
 : '—'}
 </td>
 <td className="py-2 px-2 text-center font-semibold text-heading">
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
 <div className="bg-danger-subtle border border-danger-border/50 rounded-lg p-3">
 <p className="text-xs font-semibold text-danger mb-1">
 🇨🇭 {t('contracts.notesLabel')}
 </p>
 <p className="text-xs text-danger">
 {t(sector.ch.specialNotes)}
 </p>
 </div>
 )}
 {sector.it.specialNotes && (
 <div className="bg-success-subtle border border-success-border/50 rounded-lg p-3">
 <p className="text-xs font-semibold text-success mb-1">
 🇮🇹 {t('contracts.notesLabel')} — {sector.it.ccnlName}
 </p>
 <p className="text-xs text-success">
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
 <div className="bg-surface rounded-xl border border-edge overflow-hidden">
 <button
 onClick={() => setShowRights(!showRights)}
 className="w-full flex items-center justify-between p-4 text-left hover:bg-surface-raised transition-colors"
 aria-expanded={showRights}
 aria-label={t('contracts.rights.title')}
 >
 <div className="flex items-center gap-3">
 <div className="p-2 rounded-lg bg-success-subtle">
 <Scale size={20} className="text-success" />
 </div>
 <h2 className="font-bold text-heading">
 {t('contracts.rights.title')}
 </h2>
 </div>
 {showRights ? (
 <ChevronUp size={20} className="text-muted" />
 ) : (
 <ChevronDown size={20} className="text-muted" />
 )}
 </button>

 {showRights && (
 <div className="px-4 pb-4 space-y-4">
 {/* Rights cards grid */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {/* Sick leave */}
 <div className="bg-neutral-subtle rounded-lg p-3 border border-neutral-border">
 <h4 className="text-sm font-semibold text-heading mb-2 flex items-center gap-1.5">
 <Heart size={14} className="text-danger" />
 {t('contracts.rights.sickLeave')}
 </h4>
 <ul className="space-y-1 text-xs text-body">
 <li>• {t('contracts.rights.sickLeaveYear1', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year1) })}</li>
 <li>• {t('contracts.rights.sickLeaveYear2', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year2) })}</li>
 <li>• {t('contracts.rights.sickLeaveYear3', { weeks: String(WORKER_RIGHTS_CH.sickLeave.year3Plus) })}</li>
 </ul>
 <p className="text-sm text-muted mt-1.5">
 {t('contracts.rights.sickLeaveNote')}
 </p>
 </div>

 {/* Maternity / Paternity */}
 <div className="bg-neutral-subtle rounded-lg p-3 border border-neutral-border">
 <h4 className="text-sm font-semibold text-heading mb-2 flex items-center gap-1.5">
 <Gift size={14} className="text-accent" />
 {t('contracts.rights.parentalLeave')}
 </h4>
 <ul className="space-y-1 text-xs text-body">
 <li>• {t('contracts.rights.maternityWeeks', { weeks: String(WORKER_RIGHTS_CH.maternityWeeks) })}</li>
 <li>• {t('contracts.rights.paternityWeeks', { weeks: String(WORKER_RIGHTS_CH.paternityWeeks) })}</li>
 </ul>
 <p className="text-sm text-muted mt-1.5">
 {t('contracts.rights.parentalNote')}
 </p>
 </div>

 {/* Public holidays */}
 <div className="bg-surface-alt rounded-lg p-3">
 <h4 className="text-sm font-semibold text-heading mb-2 flex items-center gap-1.5">
 <Palmtree size={14} className="text-warning" />
 {t('contracts.rights.publicHolidays')}
 </h4>
 <p className="text-xs text-body">
 {t('contracts.rights.publicHolidaysText', { count: String(WORKER_RIGHTS_CH.publicHolidays) })}
 </p>
 <p className="text-sm text-muted mt-1.5">
 {t('contracts.rights.publicHolidaysNote')}
 </p>
 </div>

 {/* Overtime */}
 <div className="bg-surface-alt rounded-lg p-3">
 <h4 className="text-sm font-semibold text-heading mb-2 flex items-center gap-1.5">
 <Clock size={14} className="text-accent" />
 {t('contracts.rights.overtime')}
 </h4>
 <p className="text-xs text-body">
 {t('contracts.rights.overtimeText')}
 </p>
 <p className="text-sm text-muted mt-1.5">
 {t('contracts.rights.overtimeNote')}
 </p>
 </div>
 </div>

 {/* Protection against dismissal */}
 <div className="bg-warning-subtle border border-warning-border/50 rounded-lg p-3">
 <h4 className="text-sm font-semibold text-warning mb-1.5 flex items-center gap-1.5">
 <Shield size={14} />
 {t('contracts.rights.dismissalProtection')}
 </h4>
 <p className="text-sm text-warning/80">
 {t('contracts.rights.dismissalProtectionText')}
 </p>
 </div>

 {/* Frontaliere-specific rights */}
 <div className="bg-accent-subtle border border-accent-border/50 rounded-lg p-3">
 <h4 className="text-sm font-semibold text-accent mb-1.5 flex items-center gap-1.5">
 <AlertTriangle size={14} />
 {t('contracts.rights.frontaliereTitle')}
 </h4>
 <ul className="space-y-1.5 text-sm text-accent/80">
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
 <div className="bg-gradient-to-br from-info-subtle to-success-subtle rounded-xl border border-info-border/50 p-4">
 <h3 className="font-bold text-heading mb-3 flex items-center gap-2">
 <ArrowRightLeft size={18} className="text-info" />
 {t('contracts.keyDifferences.title')}
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
 <div className="bg-surface/70 rounded-lg p-3">
 <p className="font-semibold text-danger mb-1.5">🇨🇭 {t('contracts.keyDifferences.chTitle')}</p>
 <ul className="space-y-1 text-body">
 <li>• {t('contracts.keyDifferences.ch1')}</li>
 <li>• {t('contracts.keyDifferences.ch2')}</li>
 <li>• {t('contracts.keyDifferences.ch3')}</li>
 <li>• {t('contracts.keyDifferences.ch4')}</li>
 <li>• {t('contracts.keyDifferences.ch5')}</li>
 </ul>
 </div>
 <div className="bg-surface/70 rounded-lg p-3">
 <p className="font-semibold text-success mb-1.5">🇮🇹 {t('contracts.keyDifferences.itTitle')}</p>
 <ul className="space-y-1 text-body">
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
 <div className="text-center text-xs text-muted px-4">
 {t('contracts.disclaimer')}
 </div>
 </div>
 );
};

export default ContractsGuide;
