import { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { Briefcase, TrendingUp, MapPin, Share2, ChevronRight, RotateCcw, Award } from 'lucide-react';
import { unlockAchievement, addXp } from '@/services/gamificationService';

/* ─── Salary data by sector, experience, and region (CHF gross/month) ─── */

interface SalaryRange {
 p25: number;
 median: number;
 p75: number;
}

const SECTORS: Record<string, { icon: string; ranges: Record<string, SalaryRange> }> = {
 it_software: {
 icon: '💻',
 ranges: {
 junior: { p25: 5200, median: 5800, p75: 6500 },
 mid: { p25: 6500, median: 7400, p75: 8500 },
 senior: { p25: 8000, median: 9200, p75: 10800 },
 expert: { p25: 9500, median: 11000, p75: 13500 },
 },
 },
 pharma_biotech: {
 icon: '🧬',
 ranges: {
 junior: { p25: 5500, median: 6200, p75: 7000 },
 mid: { p25: 7000, median: 7900, p75: 8800 },
 senior: { p25: 8500, median: 9800, p75: 11200 },
 expert: { p25: 10000, median: 11800, p75: 14000 },
 },
 },
 finance_banking: {
 icon: '🏦',
 ranges: {
 junior: { p25: 5800, median: 6500, p75: 7200 },
 mid: { p25: 7200, median: 8200, p75: 9500 },
 senior: { p25: 9000, median: 10500, p75: 12500 },
 expert: { p25: 11000, median: 13000, p75: 16000 },
 },
 },
 engineering: {
 icon: '⚙️',
 ranges: {
 junior: { p25: 5000, median: 5600, p75: 6300 },
 mid: { p25: 6200, median: 7100, p75: 8100 },
 senior: { p25: 7800, median: 9000, p75: 10500 },
 expert: { p25: 9200, median: 10800, p75: 12500 },
 },
 },
 consulting: {
 icon: '📊',
 ranges: {
 junior: { p25: 5300, median: 6000, p75: 6800 },
 mid: { p25: 6800, median: 7600, p75: 8700 },
 senior: { p25: 8200, median: 9500, p75: 11000 },
 expert: { p25: 10000, median: 12000, p75: 14500 },
 },
 },
 healthcare: {
 icon: '🏥',
 ranges: {
 junior: { p25: 4800, median: 5400, p75: 6100 },
 mid: { p25: 6000, median: 6800, p75: 7600 },
 senior: { p25: 7200, median: 8200, p75: 9500 },
 expert: { p25: 8500, median: 9800, p75: 11500 },
 },
 },
 education: {
 icon: '📚',
 ranges: {
 junior: { p25: 4500, median: 5000, p75: 5600 },
 mid: { p25: 5500, median: 6200, p75: 7000 },
 senior: { p25: 6800, median: 7600, p75: 8500 },
 expert: { p25: 7800, median: 8800, p75: 10000 },
 },
 },
 hospitality: {
 icon: '🍽️',
 ranges: {
 junior: { p25: 3800, median: 4200, p75: 4700 },
 mid: { p25: 4500, median: 5100, p75: 5700 },
 senior: { p25: 5400, median: 6200, p75: 7000 },
 expert: { p25: 6200, median: 7200, p75: 8200 },
 },
 },
 construction: {
 icon: '🏗️',
 ranges: {
 junior: { p25: 4200, median: 4800, p75: 5400 },
 mid: { p25: 5200, median: 5900, p75: 6600 },
 senior: { p25: 6200, median: 7100, p75: 8100 },
 expert: { p25: 7200, median: 8200, p75: 9500 },
 },
 },
 retail: {
 icon: '🛒',
 ranges: {
 junior: { p25: 3600, median: 4000, p75: 4500 },
 mid: { p25: 4300, median: 4900, p75: 5500 },
 senior: { p25: 5200, median: 5900, p75: 6700 },
 expert: { p25: 6000, median: 6900, p75: 7800 },
 },
 },
 logistics: {
 icon: '🚛',
 ranges: {
 junior: { p25: 4000, median: 4500, p75: 5100 },
 mid: { p25: 5000, median: 5700, p75: 6400 },
 senior: { p25: 6000, median: 6800, p75: 7800 },
 expert: { p25: 7000, median: 8000, p75: 9200 },
 },
 },
 other: {
 icon: '💼',
 ranges: {
 junior: { p25: 4000, median: 4600, p75: 5200 },
 mid: { p25: 5200, median: 5900, p75: 6700 },
 senior: { p25: 6400, median: 7300, p75: 8400 },
 expert: { p25: 7500, median: 8600, p75: 10000 },
 },
 },
};

const EXPERIENCE_LEVELS = ['junior', 'mid', 'senior', 'expert'] as const;

/* Province multiplier (Ticino proximity affects salary) */
const PROVINCE_MULT: Record<string, number> = {
 como: 1.0,
 varese: 1.0,
 verbania: 0.95,
 sondrio: 0.93,
 milano: 1.05,
 lecco: 0.97,
 novara: 0.96,
};

/* ─── Swiss deductions for net calculation ─── */
function estimateNet(grossCHF: number): { netCHF: number; netEUR: number } {
 // Social deductions (employee share)
 const avs = grossCHF * 0.053; // AVS/AI/APG 5.3%
 const ac = grossCHF * 0.011; // AC 1.1%
 const laa = grossCHF * 0.007; // LAA 0.7%
 const ijm = grossCHF * 0.008; // IJM 0.8%
 const lpp = grossCHF * 0.06; // LPP ~6% average
 const totalSocial = avs + ac + laa + ijm + lpp;
 
 // Imposta alla fonte (approximate for single, no children)
 const annual = grossCHF * 12;
 let taxRate: number;
 if (annual < 30000) taxRate = 0.02;
 else if (annual < 50000) taxRate = 0.05;
 else if (annual < 80000) taxRate = 0.08;
 else if (annual < 120000) taxRate = 0.11;
 else if (annual < 160000) taxRate = 0.13;
 else taxRate = 0.15;
 
 const tax = grossCHF * taxRate;
 const netCHF = grossCHF - totalSocial - tax;
 const netEUR = netCHF * 0.94; // approx CHF→EUR rate
 return { netCHF: Math.round(netCHF), netEUR: Math.round(netEUR) };
}

type Step = 'sector' | 'experience' | 'province' | 'result';

export default function SalaryQuiz() {
 const { t } = useTranslation();
 const [step, setStep] = useState<Step>('sector');
 const [sector, setSector] = useState('');
 const [experience, setExperience] = useState('');
 const [province, setProvince] = useState('');
 const [shared, setShared] = useState(false);

 const result = useMemo(() => {
 if (!sector || !experience || !province) return null;
 const sectorData = SECTORS[sector];
 if (!sectorData) return null;
 const range = sectorData.ranges[experience];
 if (!range) return null;
 const mult = PROVINCE_MULT[province] ?? 1.0;
 const medianGross = Math.round(range.median * mult);
 const p25Gross = Math.round(range.p25 * mult);
 const p75Gross = Math.round(range.p75 * mult);
 const net = estimateNet(medianGross);
 const percentile = Math.round(30 + Math.random() * 40); // simulated
 return { medianGross, p25Gross, p75Gross, ...net, percentile, sectorIcon: sectorData.icon };
 }, [sector, experience, province]);

 const handleSectorSelect = (s: string) => { setSector(s); setStep('experience'); };
 const handleExperienceSelect = (e: string) => { setExperience(e); setStep('province'); };
 const handleProvinceSelect = (p: string) => { setProvince(p); setStep('result'); unlockAchievement('salary_quiz'); addXp(20); };

 const reset = () => {
 setSector(''); setExperience(''); setProvince(''); setStep('sector'); setShared(false);
 };

 const shareText = result
 ? t('salaryQuiz.shareText', { sector: t(`salaryQuiz.sector.${sector}`), net: result.netEUR.toLocaleString() })
 : '';

 const handleShare = async (platform: 'whatsapp' | 'facebook' | 'copy') => {
 setShared(true);
 unlockAchievement('social_sharer');
 if (platform === 'whatsapp') {
 window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
 } else if (platform === 'facebook') {
 window.open(`https://www.facebook.com/sharer/sharer.php?quote=${encodeURIComponent(shareText)}&u=${encodeURIComponent('https://frontaliereticino.ch')}`, '_blank');
 } else {
 try { await navigator.clipboard.writeText(shareText); } catch { /* ignore */ }
 }
 };

 const progressWidth = step === 'sector' ? '25%' : step === 'experience' ? '50%' : step === 'province' ? '75%' : '100%';

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="inline-flex items-center gap-2 bg-gradient-to-r from-success-strong to-info-strong text-on-accent px-4 py-2 rounded-full text-xs font-bold mb-4">
 <TrendingUp size={16} />
 {t('salaryQuiz.badge')}
 </div>
 <h2 className="text-2xl sm:text-3xl font-bold font-display text-strong mb-2">
 {t('salaryQuiz.title')}
 </h2>
 <p className="text-subtle">
 {t('salaryQuiz.subtitle')}
 </p>
 </div>

 {/* Progress bar */}
 <div className="h-2 bg-surface-raised rounded-full mb-8 overflow-hidden">
 <div
 className="h-full bg-gradient-to-r from-success-strong to-info-strong rounded-full transition-transform duration-500 origin-left"
 style={{ transform: `scaleX(${progressWidth === '25%' ? 0.25 : progressWidth === '50%' ? 0.5 : progressWidth === '75%' ? 0.75 : 1})` }}
 />
 </div>

 {/* Step 1: Sector */}
 {step === 'sector' && (
 <div className="animate-fade-in">
 <h3 className="text-lg font-semibold font-display text-body mb-4 flex items-center gap-2">
 <Briefcase size={20} className="text-success" />
 {t('salaryQuiz.step1')}
 </h3>
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
 {Object.entries(SECTORS).map(([key, { icon }]) => (
 <button
 key={key}
 onClick={() => handleSectorSelect(key)}
 className="flex items-center gap-3 p-4 rounded-xl border-2 border-edge hover:border-success hover:bg-success-subtle transition-colors text-left group"
 >
 <span className="text-2xl">{icon}</span>
 <span className="text-sm font-medium text-body group-hover:text-success">
 {t(`salaryQuiz.sector.${key}`)}
 </span>
 </button>
 ))}
 </div>
 </div>
 )}

 {/* Step 2: Experience */}
 {step === 'experience' && (
 <div className="animate-fade-in">
 <h3 className="text-lg font-semibold font-display text-body mb-4 flex items-center gap-2">
 <Award size={20} className="text-success" />
 {t('salaryQuiz.step2')}
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {EXPERIENCE_LEVELS.map(level => (
 <button
 key={level}
 onClick={() => handleExperienceSelect(level)}
 className="flex items-center justify-between p-4 rounded-xl border-2 border-edge hover:border-success hover:bg-success-subtle transition-colors group"
 >
 <span className="text-sm font-medium text-body group-hover:text-success">
 {t(`salaryQuiz.experience.${level}`)}
 </span>
 <ChevronRight size={18} className="text-muted group-hover:text-success" />
 </button>
 ))}
 </div>
 </div>
 )}

 {/* Step 3: Province */}
 {step === 'province' && (
 <div className="animate-fade-in">
 <h3 className="text-lg font-semibold font-display text-body mb-4 flex items-center gap-2">
 <MapPin size={20} className="text-success" />
 {t('salaryQuiz.step3')}
 </h3>
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
 {Object.keys(PROVINCE_MULT).map(prov => (
 <button
 key={prov}
 onClick={() => handleProvinceSelect(prov)}
 className="flex items-center gap-2 p-4 rounded-xl border-2 border-edge hover:border-success hover:bg-success-subtle transition-colors group"
 >
 <MapPin size={16} className="text-muted group-hover:text-success" />
 <span className="text-sm font-medium text-body group-hover:text-success capitalize">
 {t(`salaryQuiz.province.${prov}`)}
 </span>
 </button>
 ))}
 </div>
 </div>
 )}

 {/* Step 4: Result */}
 {step === 'result' && result && (
 <div className="animate-fade-in space-y-6">
 {/* Result card */}
 <div className="bg-success rounded-2xl p-4 sm:p-6 text-on-accent shadow-xl">
 <div className="text-center mb-6">
 <p className="text-success text-sm mb-1">{t('salaryQuiz.resultSubtitle')}</p>
 <div className="text-4xl sm:text-5xl font-bold mb-1">
 CHF {result.medianGross.toLocaleString()}
 </div>
 <p className="text-success text-sm">{t('salaryQuiz.grossPerMonth')}</p>
 </div>

 <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-6">
 <div><span className="text-lg font-semibold">CHF {result.netCHF.toLocaleString()}</span> <span className="text-sm text-on-accent/80">{t('salaryQuiz.netCHF')}</span></div>
 <div><span className="text-lg font-semibold">€{result.netEUR.toLocaleString()}</span> <span className="text-sm text-on-accent/80">{t('salaryQuiz.netEUR')}</span></div>
 </div>

 {/* Salary range bar */}
 <div className="bg-on-accent/15 rounded-xl p-4">
 <p className="text-success text-xs mb-3">{t('salaryQuiz.rangeLabel')}</p>
 <div className="relative h-3 bg-on-accent/20 rounded-full">
 <div
 className="absolute h-full bg-on-accent/60 rounded-full"
 style={{ left: '0%', width: '100%' }}
 />
 <div
 className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-surface rounded-full shadow-lg border-2 border-success"
 style={{ left: '50%', transform: 'translate(-50%, -50%)' }}
 />
 </div>
 <div className="flex justify-between mt-2 text-xs text-success">
 <span>CHF {result.p25Gross.toLocaleString()}</span>
 <span className="font-bold text-on-accent">CHF {result.medianGross.toLocaleString()}</span>
 <span>CHF {result.p75Gross.toLocaleString()}</span>
 </div>
 <div className="flex justify-between text-xs text-success/70">
 <span>25°</span>
 <span>50° {t('salaryQuiz.median')}</span>
 <span>75°</span>
 </div>
 </div>
 </div>

 {/* Share buttons */}
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <p className="text-sm font-semibold text-body mb-4 flex items-center gap-2">
 <Share2 size={16} />
 {t('salaryQuiz.shareTitle')}
 </p>
 <div className="flex flex-wrap gap-3">
 <button
 onClick={() => handleShare('whatsapp')}
 className="flex items-center gap-2 px-5 py-3 bg-brand-whatsapp hover:bg-brand-whatsapp-hover text-on-accent rounded-xl font-semibold text-sm transition-colors"
 >
 💬 WhatsApp
 </button>
 <button
 onClick={() => handleShare('facebook')}
 className="flex items-center gap-2 px-5 py-3 bg-brand-facebook hover:bg-brand-facebook-hover text-on-accent rounded-xl font-semibold text-sm transition-colors"
 >
 📘 Facebook
 </button>
 <button
 onClick={() => handleShare('copy')}
 className="flex items-center gap-2 px-5 py-3 bg-surface-raised hover:bg-surface-raised text-body rounded-xl font-semibold text-sm transition-colors"
 >
 📋 {shared ? t('salaryQuiz.copied') : t('salaryQuiz.copyLink')}
 </button>
 </div>
 </div>

 {/* Info box */}
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-4">
 <p className="text-sm text-warning">
 {t('salaryQuiz.disclaimer')}
 </p>
 </div>

 {/* Reset button */}
 <button
 onClick={reset}
 className="flex items-center gap-2 mx-auto px-6 py-3 rounded-xl bg-surface-raised hover:bg-surface-raised text-subtle font-semibold text-sm transition-colors"
 >
 <RotateCcw size={16} />
 {t('salaryQuiz.tryAgain')}
 </button>
 </div>
 )}
 </div>
 );
}
