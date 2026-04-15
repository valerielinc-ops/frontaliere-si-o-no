import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { unlockAchievement, addXp } from '@/services/gamificationService';
import { BarChart3, Send, Eye, Users, Lock, ChevronDown, ChevronUp, TrendingUp, AlertCircle } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';

// ─── Survey Types ────────────────────────────────────────────

interface SurveySubmission {
 sector: string;
 experience: string;
 canton: string;
 grossSalaryCHF: number;
 timestamp: number;
}

interface AggregatedData {
 sector: string;
 count: number;
 p25: number;
 median: number;
 p75: number;
 avg: number;
}

const SECTORS = [
 'it_software',
 'pharma_biotech',
 'finance_banking',
 'engineering',
 'consulting',
 'healthcare',
 'education',
 'hospitality',
 'construction',
 'retail',
 'logistics',
 'other',
];

const EXPERIENCE_LEVELS = [
 'junior_0_2',
 'mid_3_5',
 'senior_6_10',
 'expert_10_plus',
];

const CANTONS = [
 { value: 'TI', label: 'Ticino' },
 { value: 'GR', label: 'Grigioni' },
 { value: 'VS', label: 'Vallese' },
 { value: 'ZH', label: 'Zurigo' },
 { value: 'GE', label: 'Ginevra' },
 { value: 'BE', label: 'Berna' },
 { value: 'LU', label: 'Lucerna' },
 { value: 'SG', label: 'San Gallo' },
 { value: 'BS', label: 'Basilea Città' },
 { value: 'AG', label: 'Argovia' },
];

const STORAGE_KEY = 'frontaliere_salary_survey';
const RESULTS_KEY = 'frontaliere_salary_results';

// ─── Firestore helpers ───────────────────────────────────────

async function submitSurveyToFirestore(data: SurveySubmission): Promise<void> {
 try {
 const { getFirestore, collection, addDoc, serverTimestamp } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 await addDoc(collection(db, 'salary_survey'), {
 sector: data.sector,
 experience: data.experience,
 canton: data.canton,
 grossSalaryCHF: data.grossSalaryCHF,
 createdAt: serverTimestamp(),
 });
 } catch (e) {
 console.warn('⚠️ Failed to submit salary survey:', e);
 reportCaughtError(e, 'salarySurvey.submit', { type: 'api_error' });
 }
}

async function loadSurveyResults(): Promise<SurveySubmission[]> {
 try {
 const { getFirestore, collection, getDocs, query, orderBy, limit } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 const q = query(
 collection(db, 'salary_survey'),
 orderBy('createdAt', 'desc'),
 limit(500)
 );
 const snap = await getDocs(q);
 return snap.docs.map(d => {
 const data = d.data();
 return {
 sector: data.sector,
 experience: data.experience,
 canton: data.canton,
 grossSalaryCHF: data.grossSalaryCHF,
 timestamp: data.createdAt?.toMillis?.() || Date.now(),
 };
 });
 } catch (e) {
 console.warn('⚠️ Failed to load salary results:', e);
 reportCaughtError(e, 'salarySurvey.loadResults', { type: 'api_error' });
 return [];
 }
}

// ─── Stats helpers ───────────────────────────────────────────

function percentile(arr: number[], p: number): number {
 const sorted = [...arr].sort((a, b) => a - b);
 const idx = (p / 100) * (sorted.length - 1);
 const lower = Math.floor(idx);
 const upper = Math.ceil(idx);
 if (lower === upper) return sorted[lower];
 return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
}

function aggregateResults(submissions: SurveySubmission[]): AggregatedData[] {
 const grouped: Record<string, number[]> = {};
 for (const s of submissions) {
 if (!grouped[s.sector]) grouped[s.sector] = [];
 grouped[s.sector].push(s.grossSalaryCHF);
 }
 return Object.entries(grouped)
 .map(([sector, salaries]) => ({
 sector,
 count: salaries.length,
 p25: percentile(salaries, 25),
 median: percentile(salaries, 50),
 p75: percentile(salaries, 75),
 avg: Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length),
 }))
 .sort((a, b) => b.median - a.median);
}

// ─── Component ───────────────────────────────────────────────

const SalarySurvey: React.FC = () => {
 const { t } = useTranslation();
 const [sector, setSector] = useState('');
 const [experience, setExperience] = useState('');
 const [canton, setCanton] = useState('TI');
 const [salary, setSalary] = useState('');
 const [submitted, setSubmitted] = useState(() => {
 try {
 return localStorage.getItem(STORAGE_KEY) === 'true';
 } catch { return false; }
 });
 const [showResults, setShowResults] = useState(false);
 const [results, setResults] = useState<SurveySubmission[]>([]);
 const [loadingResults, setLoadingResults] = useState(false);
 const [submitting, setSubmitting] = useState(false);
 const [expandedSector, setExpandedSector] = useState<string | null>(null);

 const aggregated = useMemo(() => aggregateResults(results), [results]);
 const totalResponses = results.length;

 const handleSubmit = async () => {
 const salaryNum = parseInt(salary);
 if (!sector || !experience || !salary || salaryNum < 1000 || salaryNum > 500000) return;

 setSubmitting(true);
 try {
 await submitSurveyToFirestore({
 sector,
 experience,
 canton,
 grossSalaryCHF: salaryNum,
 timestamp: Date.now(),
 });
 setSubmitted(true);
 localStorage.setItem(STORAGE_KEY, 'true');
 addXp(30);
 unlockAchievement('survey_participant');
 Analytics.trackUIInteraction('guida', 'salary_survey', 'submit', 'settore', sector);
 } catch {
 // Error already logged in submitSurveyToFirestore
 } finally {
 setSubmitting(false);
 }
 };

 const handleShowResults = async () => {
 if (showResults) {
 setShowResults(false);
 return;
 }
 setLoadingResults(true);
 try {
 const data = await loadSurveyResults();
 setResults(data);
 } catch { /* ignore */ }
 setLoadingResults(false);
 setShowResults(true);
 };

 const formatCHF = (val: number) => `CHF ${val.toLocaleString('de-CH')}`;

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-br from-info-subtle to-info-subtle rounded-2xl p-4 sm:p-6 border border-info-border">
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-info-subtle rounded-xl">
 <BarChart3 className="w-6 h-6 text-info" />
 </div>
 <h2 className="text-2xl font-bold font-display text-info">{t('salary.title')}</h2>
 </div>
 <p className="text-info text-sm">{t('salary.subtitle', getCantonI18nParams())}</p>
 </div>

 {/* Privacy notice */}
 <div className="bg-success-subtle rounded-xl p-4 border border-success-border flex items-start gap-3">
 <Lock className="w-5 h-5 text-success shrink-0 mt-0.5" />
 <p className="text-xs text-success">{t('salary.privacy')}</p>
 </div>

 {/* Survey Form or Thank You */}
 {!submitted ? (
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge space-y-5">
 <h3 className="font-bold font-display text-lg text-heading">{t('salary.formTitle')}</h3>

 {/* Sector */}
 <div>
 <label htmlFor="salary-sector" className="block text-sm font-bold text-body mb-1.5">
 {t('salary.sector')}
 </label>
 <select
 id="salary-sector"
 value={sector}
 onChange={e => setSector(e.target.value)}
 className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-heading font-medium"
 >
 <option value="">{t('salary.selectSector')}</option>
 {SECTORS.map(s => (
 <option key={s} value={s}>{t(`salary.sector.${s}`)}</option>
 ))}
 </select>
 </div>

 {/* Experience */}
 <div>
 <label htmlFor="salary-experience" className="block text-sm font-bold text-body mb-1.5">
 {t('salary.experience')}
 </label>
 <select
 id="salary-experience"
 value={experience}
 onChange={e => setExperience(e.target.value)}
 className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-heading font-medium"
 >
 <option value="">{t('salary.selectExperience')}</option>
 {EXPERIENCE_LEVELS.map(e => (
 <option key={e} value={e}>{t(`salary.experience.${e}`)}</option>
 ))}
 </select>
 </div>

 {/* Canton */}
 <div>
 <label htmlFor="salary-canton" className="block text-sm font-bold text-body mb-1.5">
 {t('salary.canton')}
 </label>
 <select
 id="salary-canton"
 value={canton}
 onChange={e => setCanton(e.target.value)}
 className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-heading font-medium"
 >
 {CANTONS.map(c => (
 <option key={c.value} value={c.value}>{c.label}</option>
 ))}
 </select>
 </div>

 {/* Gross Salary */}
 <div>
 <label htmlFor="salary-gross" className="block text-sm font-bold text-body mb-1.5">
 {t('salary.grossSalary')}
 </label>
 <div className="relative">
 <input
 id="salary-gross"
 type="number"
 inputMode="numeric"
 min={1000}
 max={500000}
 step={1000}
 value={salary}
 onChange={e => setSalary(e.target.value)}
 placeholder="80000"
 className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-heading font-medium pr-16"
 />
 <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-muted">CHF/anno</span>
 </div>
 </div>

 {/* Submit */}
 <button
 onClick={handleSubmit}
 disabled={!sector || !experience || !salary || parseInt(salary) < 1000 || submitting}
 className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-info-strong hover:bg-info-strong-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent rounded-xl font-bold transition-colors"
 >
 <Send className="w-4 h-4" />
 {submitting ? t('salary.submitting') : t('salary.submit')}
 </button>
 </div>
 ) : (
 <div className="bg-success-subtle rounded-2xl p-4 sm:p-6 border border-success-border text-center">
 <div className="text-4xl mb-3">🙏</div>
 <h3 className="text-xl font-bold font-display text-success mb-2">{t('salary.thankYou')}</h3>
 <p className="text-sm text-success">{t('salary.thankYouDesc')}</p>
 </div>
 )}

 {/* View Results */}
 <button
 onClick={handleShowResults}
 className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-surface border-2 border-edge hover:bg-surface-raised text-body rounded-xl font-bold transition-colors"
 >
 <Eye className="w-4 h-4" />
 {showResults ? t('salary.hideResults') : t('salary.viewResults')}
 {showResults ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
 </button>

 {/* Results Section */}
 {showResults && (
 <div className="space-y-4 animate-fade-in">
 {loadingResults ? (
 <div className="flex items-center justify-center py-12">
 <div className="animate-spin rounded-full h-8 w-8 border-2 border-info border-t-transparent" />
 </div>
 ) : totalResponses === 0 ? (
 <div className="bg-surface rounded-2xl p-5 sm:p-8 border border-edge text-center">
 <AlertCircle className="w-12 h-12 text-muted mx-auto mb-3" />
 <p className="text-subtle">{t('salary.noData')}</p>
 </div>
 ) : (
 <>
 {/* Summary */}
 <div className="bg-surface rounded-2xl p-5 border border-edge">
 <div className="flex items-center gap-2 mb-3">
 <Users className="w-5 h-5 text-info" />
 <span className="font-bold text-strong">
 {t('salary.totalResponses', { count: String(totalResponses) })}
 </span>
 </div>
 </div>

 {/* Per-sector breakdown */}
 {aggregated.map(agg => (
 <div
 key={agg.sector}
 className="bg-surface rounded-2xl border border-edge overflow-hidden"
 >
 <button
 onClick={() => setExpandedSector(expandedSector === agg.sector ? null : agg.sector)}
 className="w-full p-5 flex items-center justify-between text-left"
 >
 <div>
 <h4 className="font-bold text-heading">
 {t(`salary.sector.${agg.sector}`)}
 </h4>
 <p className="text-sm text-muted">
 {agg.count} {t('salary.responses')} · {t('salary.medianLabel')}: {formatCHF(agg.median)}
 </p>
 </div>
 {expandedSector === agg.sector ? <ChevronUp className="w-5 h-5 text-muted" /> : <ChevronDown className="w-5 h-5 text-muted" />}
 </button>

 {expandedSector === agg.sector && (
 <div className="px-5 pb-5 border-t border-edge pt-4">
 {/* Salary range visualization */}
 <div className="space-y-3">
 <div className="flex justify-between text-sm">
 <span className="text-muted">25° percentile</span>
 <span className="font-bold text-body">{formatCHF(agg.p25)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-info font-bold flex items-center gap-1">
 <TrendingUp className="w-4 h-4" /> {t('salary.medianLabel')}
 </span>
 <span className="font-bold text-info text-lg">{formatCHF(agg.median)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-muted">75° percentile</span>
 <span className="font-bold text-body">{formatCHF(agg.p75)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-muted">{t('salary.average')}</span>
 <span className="font-bold text-body">{formatCHF(agg.avg)}</span>
 </div>
 </div>

 {/* Simple bar chart */}
 <div className="mt-4 h-8 bg-surface-raised rounded-full overflow-hidden relative">
 <div
 className="absolute inset-y-0 left-0 bg-gradient-to-r from-info/40 to-info rounded-full"
 style={{
 left: `${(agg.p25 / agg.p75) * 30}%`,
 width: `${Math.max(20, ((agg.p75 - agg.p25) / agg.p75) * 100)}%`,
 }}
 />
 <div
 className="absolute inset-y-0 w-1 bg-info rounded"
 style={{ left: `${(agg.median / agg.p75) * 70}%` }}
 />
 </div>
 </div>
 )}
 </div>
 ))}
 </>
 )}
 </div>
 )}
 </div>
 );
};

export default SalarySurvey;
