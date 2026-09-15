/**
 * LamalSsnBreakeven — interactive LAMal-vs-SSN breakeven mini-tool (#4440)
 *
 * Replaces the static "LAMal svizzera vs SSN italiano" prose with a
 * personalised numeric verdict:
 *   - inputs: net yearly income (CHF), age, LAMal franchise
 *   - LAMal side: cheapest real premium from data/health-premiums.json
 *     (standard model, no accident cover) via the parent comparator
 *   - SSN side: the voluntary-registration contribution for frontalieri,
 *     3–6% of net income depending on the region (L. 213/2023)
 *   - CTA: email capture → PDF report via the sendCalculatorReport Cloud
 *     Function with the dedicated 'lamal_ssn_tool' acquisitionSource
 *
 * Zero-CLS: the verdict panel reserves its height and every state renders
 * inside the same fixed layout. Auto Ads untouched.
 */

import React, { useMemo, useState } from 'react';
import { Scale, Mail, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation, useLocale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import PartnerRecommendations from '@/components/shared/PartnerRecommendations';
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import { getFirestoreLazy } from '@/services/firebase';
import { upsertUnifiedEmailSubscriber, markNewsletterSubscribedLocally } from '@/services/newsletterSubscribers';
import { isNewsletterExcluded } from '@/services/emailSuppression.mjs';
import { generateLamalSsnPdfReport, pdfBlobToBase64 } from '@/services/pdfReport';
import { SEND_CALCULATOR_REPORT_URL } from '@/services/functionsBase';
import { reportCaughtError } from '@/services/errorReporter';

/** SSN voluntary-registration contribution bounds (share of net income, L. 213/2023). */
const SSN_RATE_MIN = 0.03;
const SSN_RATE_MAX = 0.06;

type BreakevenAgeGroup = '0-18' | '19-25' | '26+';
type Verdict = 'lamal' | 'ssn' | 'depends';

export interface CheapestPremium {
 premium: number;
 insurerName: string;
}

interface LamalSsnBreakevenProps {
 /** Seed for the age input (page-level age filter). */
 defaultAge: number;
 franchisesAdult: number[];
 franchisesChild: number[];
 /**
  * Cheapest monthly LAMal premium (standard model, no accident) for the
  * given franchise + age group, computed by the parent from the loaded
  * UFSP dataset. Null while data is loading or unavailable.
  */
 computeCheapestPremium: (franchise: number, ageGroup: BreakevenAgeGroup) => CheapestPremium | null;
}

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('it-IT');

const LamalSsnBreakeven: React.FC<LamalSsnBreakevenProps> = ({
 defaultAge,
 franchisesAdult,
 franchisesChild,
 computeCheapestPremium,
}) => {
 const { t } = useTranslation();
 const [locale] = useLocale();
 const [income, setIncome] = useState<number>(50000);
 const [age, setAge] = useState<number>(defaultAge);
 const [franchise, setFranchise] = useState<number>(2500);
 const [email, setEmail] = useState('');
 const [sendStatus, setSendStatus] = useState<'idle' | 'loading' | 'pending' | 'success' | 'error'>('idle');
 const [sendError, setSendError] = useState<'email' | 'send' | null>(null);

 const ageGroup: BreakevenAgeGroup = age < 19 ? '0-18' : age <= 25 ? '19-25' : '26+';
 const franchises = ageGroup === '0-18' ? franchisesChild : franchisesAdult;
 const effectiveFranchise = franchises.includes(franchise) ? franchise : franchises[0];

 const cheapest = useMemo(
 () => computeCheapestPremium(effectiveFranchise, ageGroup),
 [computeCheapestPremium, effectiveFranchise, ageGroup],
 );

 const result = useMemo(() => {
 if (!cheapest || !Number.isFinite(income) || income <= 0) return null;
 const lamalAnnual = cheapest.premium * 12;
 const ssnMin = income * SSN_RATE_MIN;
 const ssnMax = income * SSN_RATE_MAX;
 const breakevenPct = (lamalAnnual / income) * 100;
 const verdict: Verdict = lamalAnnual < ssnMin ? 'lamal' : lamalAnnual > ssnMax ? 'ssn' : 'depends';
 const saving = verdict === 'lamal' ? ssnMin - lamalAnnual : verdict === 'ssn' ? lamalAnnual - ssnMax : 0;
 return { lamalAnnual, ssnMin, ssnMax, breakevenPct, verdict, saving };
 }, [cheapest, income]);

 const handleSendPdf = async (e: React.FormEvent) => {
 e.preventDefault();
 if (sendStatus === 'loading' || sendStatus === 'pending' || !result || !cheapest) return;
 const trimmed = email.trim();
 if (!validateEmailStrict(trimmed).valid) {
 setSendStatus('error');
 setSendError('email');
 return;
 }
 setSendStatus('loading');
 setSendError(null);
 Analytics.trackHealthInsurance('lamal_ssn_pdf_request', result.verdict);
 try {
 // The PDF is the user's requested transactional result. Registration is
 // best-effort so a Firestore outage cannot block report generation or delivery.
 let upsert: Awaited<ReturnType<typeof upsertUnifiedEmailSubscriber>> | null = null;
 try {
  const firestore = await getFirestoreLazy('lamalSsnBreakeven.firestoreInit');
  if (!firestore) throw new Error('firestore_unavailable');
  upsert = await upsertUnifiedEmailSubscriber(firestore as any, {
  email: trimmed,
  source: 'lamal_ssn_tool',
  sourceChannel: 'lamal_ssn_tool',
  sourcePage: typeof window !== 'undefined' ? window.location.pathname : '/',
  sourceCta: 'lamal_ssn_pdf',
  sourceComponent: 'LamalSsnBreakeven',
  locale,
  });
 } catch (registrationError) {
  reportCaughtError(registrationError, 'lamalSsn.newsletterRegistration');
 }
 const pdfBlob = await generateLamalSsnPdfReport({
 incomeCHF: income,
 age,
 franchiseCHF: effectiveFranchise,
 lamalMonthlyCHF: cheapest.premium,
 lamalAnnualCHF: result.lamalAnnual,
 cheapestInsurer: cheapest.insurerName,
 ssnMinCHF: result.ssnMin,
 ssnMaxCHF: result.ssnMax,
 breakevenPct: result.breakevenPct,
 verdict: result.verdict,
 }, trimmed);
 const pdfBase64 = await pdfBlobToBase64(pdfBlob);
 const resp = await fetch(SEND_CALCULATOR_REPORT_URL, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 email: trimmed,
 pdfBase64,
 resultSummary: {
 lamalAnnualCHF: Math.round(result.lamalAnnual),
 ssnMinCHF: Math.round(result.ssnMin),
 ssnMaxCHF: Math.round(result.ssnMax),
 verdict: result.verdict,
 },
 locale,
 sourcePath: typeof window !== 'undefined' ? window.location.pathname : '/',
 source: 'lamal_ssn_tool',
 }),
 });
 if (!resp.ok) {
 Analytics.trackError(`lamal_ssn_tool sendCalculatorReport failed: ${resp.status}`);
 throw new Error(`http_${resp.status}`);
 }
 Analytics.trackFunnelStep('lamal_ssn_email_submitted', { funnel: 'newsletter_lamal_ssn' });
 const needsConfirmation = upsert != null
  && upsert.optedOut !== true
  && upsert.status === 'pending'
  && !upsert.hadConfirmationProof;
 if (needsConfirmation) {
   Analytics.trackFunnelStep('lamal_ssn_confirmation_pending', { funnel: 'newsletter_lamal_ssn' });
 setSendStatus('pending');
 } else {
   if (upsert && upsert.optedOut !== true && !isNewsletterExcluded(upsert.status)) {
     markNewsletterSubscribedLocally();
   }
   setSendStatus('success');
 }
 } catch {
 setSendStatus('error');
 setSendError('send');
 }
 };

 return (
 <div>
 {/* Inputs — fixed grid, zero-CLS */}
 <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
 <div>
 <label htmlFor="lamal-ssn-income" className="block text-xs font-bold text-body mb-1.5">
 {t('health.lamalSsn.incomeLabel')}
 </label>
 <input
 id="lamal-ssn-income"
 type="number"
 inputMode="numeric"
 min={0}
 max={1000000}
 step={1000}
 value={Number.isFinite(income) ? income : ''}
 onChange={(e) => setIncome(parseInt(e.target.value, 10) || 0)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm"
 />
 </div>
 <div>
 <label htmlFor="lamal-ssn-age" className="block text-xs font-bold text-body mb-1.5">
 {t('health.lamalSsn.ageLabel')}
 </label>
 <input
 id="lamal-ssn-age"
 type="number"
 inputMode="numeric"
 min={0}
 max={99}
 value={age}
 onChange={(e) => setAge(Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0)))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm"
 />
 </div>
 <div className="col-span-2 md:col-span-1">
 <label htmlFor="lamal-ssn-franchise" className="block text-xs font-bold text-body mb-1.5">
 {t('health.lamalSsn.franchiseLabel')}
 </label>
 <select
 id="lamal-ssn-franchise"
 value={effectiveFranchise}
 onChange={(e) => setFranchise(parseInt(e.target.value, 10))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm"
 >
 {franchises.map((f) => (
 <option key={f} value={f}>CHF {f}</option>
 ))}
 </select>
 </div>
 </div>

 {/* Verdict panel — height reserved for every state */}
 <div className="p-4 bg-surface/70 rounded-xl min-h-[180px]" aria-live="polite">
 {result && cheapest ? (
 <>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
 <div className="p-3 bg-surface-alt/60 rounded-lg">
 <p className="text-xs text-muted uppercase font-bold">{t('health.lamalSsn.lamalCostLabel')}</p>
 <p className="text-lg font-bold text-strong">CHF {fmtCHF(result.lamalAnnual)}<span className="text-xs font-normal text-muted">/{t('health.lamalSsn.year')}</span></p>
 <p className="text-xs text-muted">{t('health.lamalSsn.cheapestWith', { insurer: cheapest.insurerName })}</p>
 </div>
 <div className="p-3 bg-surface-alt/60 rounded-lg">
 <p className="text-xs text-muted uppercase font-bold">{t('health.lamalSsn.ssnCostLabel')}</p>
 <p className="text-lg font-bold text-strong">CHF {fmtCHF(result.ssnMin)} – {fmtCHF(result.ssnMax)}<span className="text-xs font-normal text-muted">/{t('health.lamalSsn.year')}</span></p>
 <p className="text-xs text-muted">{t('health.lamalSsn.ssnRateNote')}</p>
 </div>
 </div>
 <p className="text-sm font-semibold text-strong flex items-start gap-2">
 <Scale size={18} className="text-accent flex-shrink-0 mt-0.5" aria-hidden="true" />
 <span>
 {result.verdict === 'lamal' && t('health.lamalSsn.verdictLamal', { amount: fmtCHF(result.saving) })}
 {result.verdict === 'ssn' && t('health.lamalSsn.verdictSsn', { amount: fmtCHF(result.saving) })}
 {result.verdict === 'depends' && t('health.lamalSsn.verdictDepends', { pct: result.breakevenPct.toFixed(1) })}
 </span>
 </p>
 </>
 ) : (
 <p className="text-sm text-subtle">{t('health.lamalSsn.enterIncome')}</p>
 )}
 </div>

 {/* Email → PDF CTA */}
 <form onSubmit={handleSendPdf} className="mt-3">
 <p className="text-sm font-bold text-strong mb-2 flex items-center gap-2">
 <Mail size={16} className="text-accent" aria-hidden="true" />
 {t('health.lamalSsn.emailCtaTitle')}
 </p>
 <EmailConsentCheckbox
 id="lamal-ssn-consent"
 consentKey="communicationsOptIn"
 locale={locale}
 className="mb-2 flex items-start gap-2"
 noticeClassName="text-xs text-muted leading-relaxed"
 />
 <div className="flex flex-col sm:flex-row gap-2">
 <label htmlFor="lamal-ssn-email" className="sr-only">{t('health.lamalSsn.emailPlaceholder')}</label>
 <EmailInput
 id="lamal-ssn-email"
 value={email}
 onChange={(val) => {
 setEmail(val);
 if (sendStatus === 'error') {
 setSendStatus('idle');
 setSendError(null);
 }
 }}
 placeholder={t('health.lamalSsn.emailPlaceholder')}
 className="flex-1 px-3 py-2 rounded-lg border border-edge bg-surface text-strong text-sm"
 />
 <button
 type="submit"
 disabled={sendStatus === 'loading' || sendStatus === 'pending' || sendStatus === 'success' || !result}
 className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-accent-strong hover:bg-accent-strong-hover disabled:opacity-60 text-on-accent rounded-lg text-sm font-semibold transition-colors"
 >
 {sendStatus === 'loading' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
 {sendStatus === 'loading' ? t('health.lamalSsn.emailSending') : t('health.lamalSsn.emailSend')}
 </button>
 </div>
 <div className="min-h-[24px] mt-1.5" aria-live="polite">
 {sendStatus === 'pending' && (
 <p className="text-sm text-info flex items-start gap-1.5">
 <Mail size={14} aria-hidden="true" />
 <span>{t('newsletter.doubleOptIn.title')} — {t('newsletter.doubleOptIn.description')} {t('newsletter.doubleOptIn.spamHint')}</span>
 </p>
 )}
 {sendStatus === 'success' && (
 <p className="text-sm text-success flex items-center gap-1.5">
 <CheckCircle2 size={14} aria-hidden="true" /> {t('health.lamalSsn.emailSuccess')}
 </p>
 )}
 {sendStatus === 'error' && (
 <p className="text-sm text-danger flex items-center gap-1.5">
 <AlertCircle size={14} aria-hidden="true" />
 {t('health.lamalSsn.emailError')}
 </p>
 )}
 </div>
 </form>

 <p className="text-xs text-muted mt-2">{t('health.lamalSsn.disclaimer')}</p>

 {/* Health-context partner hook (#4439) — empty-safe when no partner enabled */}
 <PartnerRecommendations context="health" maxCards={1} />
 </div>
 );
};

export default LamalSsnBreakeven;
