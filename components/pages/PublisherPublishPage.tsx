/**
 * PublisherPublishPage — self-serve publisher ad-authoring form.
 *
 * Flow:
 *  1. Auth gate (useAuth) — publishers must be signed in.
 *  2. Author the ad (company / ad / locations / apply) with a live price preview
 *     from services/publisherPricing.ts.
 *  3. On submit: reCAPTCHA verify (action PUBLISH_JOB) → write ONE publisher_jobs
 *     doc (status 'pending_payment', the full `locations` array) → call the
 *     createPublisherCheckout Cloud Function → redirect to the Stripe URL.
 *
 * Pricing is RECOMPUTED server-side by the CF from the publisher_jobs docs; the
 * client preview is informational only.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Briefcase, Plus, Trash2, Send, AlertTriangle, LogIn, Clock, Shield, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { recaptchaService } from '@/services/recaptchaService';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import {
 getFirestore,
 collection,
 addDoc,
 serverTimestamp,
} from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { priceForCart } from '@/services/publisherPricing';
import type {
 ApplyMode,
 PublisherLegalForm,
 PublisherJobLocation,
 PublisherTier,
} from '@/services/publisherTypes';

const CREATE_CHECKOUT_ENDPOINT =
 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createPublisherCheckout';
const GEMINI_ENDPOINT =
 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/geminiGenerate';

const VALID_EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN'];

/** Parse the model's reply (may be fenced ```json) into a job-post object. */
function parseAiJobPost(text: string): {
 title?: string;
 description?: string;
 employmentType?: string;
 sector?: string;
} | null {
 if (!text) return null;
 const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
 const start = cleaned.indexOf('{');
 const end = cleaned.lastIndexOf('}');
 if (start === -1 || end === -1 || end <= start) return null;
 try {
 const obj = JSON.parse(cleaned.slice(start, end + 1));
 return obj && typeof obj === 'object' ? obj : null;
 } catch {
 return null;
 }
}

const LEGAL_FORMS: { value: PublisherLegalForm; labelKey: string }[] = [
 { value: 'ditta_individuale', labelKey: 'publisher.company.legalForm.dittaIndividuale' },
 { value: 'persona_fisica', labelKey: 'publisher.company.legalForm.personaFisica' },
 { value: 'azienda', labelKey: 'publisher.company.legalForm.azienda' },
];

const EMPLOYMENT_TYPES: { value: string; labelKey: string }[] = [
 { value: 'FULL_TIME', labelKey: 'publisher.ad.employmentType.fullTime' },
 { value: 'PART_TIME', labelKey: 'publisher.ad.employmentType.partTime' },
 { value: 'CONTRACTOR', labelKey: 'publisher.ad.employmentType.contract' },
 { value: 'TEMPORARY', labelKey: 'publisher.ad.employmentType.temporary' },
 { value: 'INTERN', labelKey: 'publisher.ad.employmentType.internship' },
];

const APPLY_MODES: { value: ApplyMode; labelKey: string }[] = [
 { value: 'external_url', labelKey: 'publisher.apply.mode.externalUrl' },
 { value: 'forward_email', labelKey: 'publisher.apply.mode.forwardEmail' },
 { value: 'in_house', labelKey: 'publisher.apply.mode.inHouse' },
];

const inputClass =
 'w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]';
const labelClass = 'block text-sm font-medium text-body mb-1.5';
const sectionTitleClass = 'text-lg font-semibold font-display text-strong mb-4';

function countWords(text: string): number {
 const trimmed = text.trim();
 if (!trimmed) return 0;
 return trimmed.split(/\s+/).length;
}

function isValidUrl(value: string): boolean {
 return /^https?:\/\/.+/i.test(value.trim());
}

function isValidEmail(value: string): boolean {
 return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

type SubmitStatus = 'idle' | 'submitting' | 'redirecting' | 'published' | 'error';

const PublisherPublishPage: React.FC = () => {
 const { t } = useTranslation();
 const { user, loading, signIn } = useAuth();

 // ── Tier ────────────────────────────────────────────────────
 // free      → plain crawler-style listing (no featured/blast, external apply only), no payment.
 // sponsored → paid subscription (featured/blast/all apply modes), Stripe checkout.
 const [tier, setTier] = useState<PublisherTier>('sponsored');
 const isFree = tier === 'free';

 // ── Form state ──────────────────────────────────────────────
 const [companyName, setCompanyName] = useState('');
 const [legalForm, setLegalForm] = useState<PublisherLegalForm>('ditta_individuale');
 const [domain, setDomain] = useState('');
 const [logoUrl, setLogoUrl] = useState('');

 const [title, setTitle] = useState('');
 const [description, setDescription] = useState('');
 const [employmentType, setEmploymentType] = useState<string>('FULL_TIME');
 const [salaryMin, setSalaryMin] = useState('');
 const [salaryMax, setSalaryMax] = useState('');

 const [locations, setLocations] = useState<string[]>(['']);

 const [applyMode, setApplyMode] = useState<ApplyMode>('external_url');
 const [applyUrl, setApplyUrl] = useState('');
 const [applyEmail, setApplyEmail] = useState('');
 const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState('');

 const [status, setStatus] = useState<SubmitStatus>('idle');
 const [errors, setErrors] = useState<string[]>([]);
 const [errorMessage, setErrorMessage] = useState('');

 // ── AI auto-fill (sponsored only) ───────────────────────────
 const [aiPosition, setAiPosition] = useState('');
 const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'error'>('idle');

 const handleAiFill = async () => {
 const position = aiPosition.trim();
 if (!position || aiStatus === 'loading') return;
 setAiStatus('loading');
 try {
 const userPrompt =
 `Sei un esperto di annunci di lavoro per il mercato Ticino/Svizzera (frontalieri). ` +
 `Genera un annuncio in ITALIANO per la posizione: "${position}". ` +
 `Rispondi SOLO con JSON valido, senza testo extra, con queste chiavi: ` +
 `"title" (titolo conciso), "description" (almeno 70 parole, professionale, con responsabilità e requisiti), ` +
 `"employmentType" (uno tra ${VALID_EMPLOYMENT_TYPES.join(', ')}), ` +
 `"sector" (settore breve, es. "sanità", "edilizia", "IT").`;
 const res = await fetch(GEMINI_ENDPOINT, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ userPrompt, maxTokens: 1024, temperature: 0.6 }),
 });
 const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string };
 const parsed = data?.ok && data.text ? parseAiJobPost(data.text) : null;
 if (!parsed) throw new Error('ai_parse_failed');
 if (parsed.title) setTitle(String(parsed.title).slice(0, 200));
 if (parsed.description) setDescription(String(parsed.description));
 if (parsed.employmentType && VALID_EMPLOYMENT_TYPES.includes(parsed.employmentType)) {
 setEmploymentType(parsed.employmentType);
 }
 setAiStatus('idle');
 Analytics.trackUIInteraction('publisher', 'ai', 'autofill', 'success');
 } catch (error) {
 setAiStatus('error');
 Analytics.trackUIInteraction('publisher', 'ai', 'autofill', 'error');
 reportCaughtError(error, 'publisher.aiFill');
 }
 };

 useEffect(() => {
 Analytics.trackPageView('/pubblica-offerta', 'Publisher Publish Page');
 Analytics.trackUIInteraction('publisher', 'page', 'publish_page', 'view');
 }, []);

 // Free tier is external-apply only — force the mode when switching to free.
 useEffect(() => {
 if (isFree && applyMode !== 'external_url') setApplyMode('external_url');
 }, [isFree, applyMode]);

 // ── Live price preview ──────────────────────────────────────
 const distinctLocations = useMemo(
 () => locations.map(l => l.trim()).filter(Boolean),
 [locations],
 );
 const price = useMemo(
 () => priceForCart([{ id: 'ad', locations: distinctLocations }]),
 [distinctLocations],
 );

 // ── Location helpers ────────────────────────────────────────
 const updateLocation = (index: number, value: string) => {
 setLocations(prev => prev.map((loc, i) => (i === index ? value : loc)));
 };
 const addLocation = () => setLocations(prev => [...prev, '']);
 const removeLocation = (index: number) =>
 setLocations(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

 // ── Client-side validation ──────────────────────────────────
 const validate = (): string[] => {
 const found: string[] = [];
 if (!companyName.trim()) found.push(t('publisher.error.companyName'));
 if (!title.trim()) found.push(t('publisher.error.title'));
 if (countWords(description) < 50) found.push(t('publisher.error.description'));
 if (distinctLocations.length < 1) found.push(t('publisher.error.locations'));
 if (applyMode === 'external_url' && !isValidUrl(applyUrl)) {
 found.push(t('publisher.error.applyUrl'));
 }
 if ((applyMode === 'forward_email' || applyMode === 'in_house') && !isValidEmail(applyEmail)) {
 found.push(t('publisher.error.applyEmail'));
 }
 return found;
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (status === 'submitting' || status === 'redirecting') return;
 if (!user) return;

 const validationErrors = validate();
 if (validationErrors.length > 0) {
 setErrors(validationErrors);
 setStatus('idle');
 return;
 }
 setErrors([]);
 setStatus('submitting');
 setErrorMessage('');

 try {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'start');

 // reCAPTCHA: generate + verify server-side before persisting anything.
 const token = await recaptchaService.getTokenForApi('PUBLISH_JOB');
 if (!token) throw new Error('recaptcha_token_missing');
 const verification = await recaptchaService.verifyToken(token, 'PUBLISH_JOB');
 if (!verification.passed) {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'recaptcha_blocked');
 throw new Error(`recaptcha_blocked:${verification.error ?? 'unknown'}`);
 }

 const firebaseApp = await getApp();
 const db = getFirestore(firebaseApp);

 const jobLocations: PublisherJobLocation[] = distinctLocations.map(label => ({ label }));
 const parsedSalaryMin = salaryMin.trim() ? Number(salaryMin) : undefined;
 const parsedSalaryMax = salaryMax.trim() ? Number(salaryMax) : undefined;

 // ONE publisher_jobs doc with the full locations array. The Cloud Function
 // sums distinct locations for billing. status 'pending_payment' — only the
 // Stripe webhook (Admin SDK) may ever set 'paid'.
 const docRef = await addDoc(collection(db, 'publisher_jobs'), {
 publisherUid: user.uid,
 tier,
 // free → live immediately as a plain listing; sponsored → awaits Stripe.
 status: isFree ? 'published' : 'pending_payment',
 title: title.trim(),
 description: description.trim(),
 sourceLang: 'it',
 company: {
 name: companyName.trim(),
 legalForm,
 ...(domain.trim() ? { domain: domain.trim() } : {}),
 ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
 },
 locations: jobLocations,
 employmentType,
 ...(parsedSalaryMin != null && Number.isFinite(parsedSalaryMin) ? { salaryMin: parsedSalaryMin } : {}),
 ...(parsedSalaryMax != null && Number.isFinite(parsedSalaryMax) ? { salaryMax: parsedSalaryMax } : {}),
 currency: 'CHF',
 apply: {
 mode: applyMode,
 ...(applyMode === 'external_url' ? { url: applyUrl.trim() } : {}),
 ...(applyMode === 'forward_email' || applyMode === 'in_house' ? { email: applyEmail.trim() } : {}),
 ...(privacyPolicyUrl.trim() ? { privacyPolicyUrl: privacyPolicyUrl.trim() } : {}),
 },
 createdAt: serverTimestamp(),
 updatedAt: serverTimestamp(),
 });

 // Free tier: no payment — the ad is already 'published' and the sync
 // workflow will pick it up into the crawler slice. Done.
 if (isFree) {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'published_free');
 setStatus('published');
 return;
 }

 // Sponsored: authenticated call to the checkout Cloud Function.
 const idToken = await user.getIdToken();
 setStatus('redirecting');
 const res = await fetch(CREATE_CHECKOUT_ENDPOINT, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${idToken}`,
 },
 body: JSON.stringify({
 jobIds: [docRef.id],
 successUrl: `${window.location.origin}${window.location.pathname}?publisher_checkout=success`,
 cancelUrl: window.location.href,
 }),
 });

 const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
 if (!res.ok || !data.ok || !data.url) {
 throw new Error(`checkout_failed:${data.error ?? `http_${res.status}`}`);
 }

 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'success');
 window.location.assign(data.url);
 } catch (error) {
 console.error('Error creating publisher checkout:', error);
 setStatus('error');
 setErrorMessage(t('publisher.error'));
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'error');
 reportCaughtError(error, 'publisher.formSubmit');
 }
 };

 // ── Auth gate ───────────────────────────────────────────────
 if (!loading && !user) {
 return (
 <div className="max-w-2xl mx-auto px-4 py-12">
 <div className="text-center space-y-4">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-2">
 <Briefcase className="w-7 h-7 text-link" />
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">
 {t('publisher.title')}
 </h1>
 <p className="text-subtle max-w-md mx-auto">{t('publisher.loginRequired')}</p>
 <button
 type="button"
 onClick={() => { void signIn(); }}
 className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
 >
 <LogIn className="w-4 h-4" />
 {t('publisher.loginCta')}
 </button>
 </div>
 </div>
 );
 }

 // ── Free-tier published success ─────────────────────────────
 if (status === 'published') {
 return (
 <div className="max-w-2xl mx-auto px-4 py-12">
 <div className="text-center space-y-4">
 <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success-subtle">
 <Clock className="w-8 h-8 text-success" />
 </div>
 <h2 className="text-2xl font-bold font-display text-strong">{t('publisher.published.title')}</h2>
 <p className="text-subtle max-w-md mx-auto">{t('publisher.published.message')}</p>
 </div>
 </div>
 );
 }

 return (
 <div className="max-w-2xl mx-auto px-4 py-8">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-4">
 <Briefcase className="w-7 h-7 text-link" />
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong mb-2">
 {t('publisher.title')}
 </h1>
 <p className="text-subtle max-w-lg mx-auto">{t('publisher.subtitle')}</p>
 </div>

 <form onSubmit={handleSubmit} className="space-y-8">
 {/* ── Tier selector ──────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.tier.section')}</h2>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {([
 { value: 'free', titleKey: 'publisher.tier.free.title', descKey: 'publisher.tier.free.desc' },
 { value: 'sponsored', titleKey: 'publisher.tier.sponsored.title', descKey: 'publisher.tier.sponsored.desc' },
 ] as const).map(opt => {
 const selected = tier === opt.value;
 return (
 <button
 key={opt.value}
 type="button"
 aria-pressed={selected}
 onClick={() => setTier(opt.value as PublisherTier)}
 className={`text-left p-4 rounded-2xl border transition-colors ${selected ? 'border-accent bg-accent-subtle' : 'border-edge bg-surface-alt hover:border-accent'}`}
 >
 <span className="block text-sm font-semibold text-strong">{t(opt.titleKey)}</span>
 <span className="block text-xs text-subtle mt-1">{t(opt.descKey)}</span>
 </button>
 );
 })}
 </div>
 </section>
 {/* ── Company ────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.company.section')}</h2>
 <div className="space-y-5">
 <div>
 <label htmlFor="pub-company-name" className={labelClass}>
 {t('publisher.company.name')} *
 </label>
 <input
 id="pub-company-name"
 type="text"
 required
 value={companyName}
 onChange={e => setCompanyName(e.target.value)}
 autoComplete="organization"
 className={inputClass}
 placeholder={t('publisher.company.namePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-legal-form" className={labelClass}>
 {t('publisher.company.legalForm')}
 </label>
 <select
 id="pub-legal-form"
 value={legalForm}
 onChange={e => setLegalForm(e.target.value as PublisherLegalForm)}
 className={inputClass}
 >
 {LEGAL_FORMS.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 <div>
 <label htmlFor="pub-domain" className={labelClass}>
 {t('publisher.company.website')}
 </label>
 <input
 id="pub-domain"
 type="url"
 value={domain}
 onChange={e => setDomain(e.target.value)}
 autoComplete="url"
 className={inputClass}
 placeholder={t('publisher.company.websitePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-logo" className={labelClass}>
 {t('publisher.company.logo')}
 </label>
 <input
 id="pub-logo"
 type="url"
 value={logoUrl}
 onChange={e => setLogoUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.company.logoPlaceholder')}
 />
 </div>
 </div>
 </section>

 {/* ── Ad ─────────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.ad.section')}</h2>
 <div className="space-y-5">
 {!isFree && (
 <div className="rounded-xl border border-accent/40 bg-accent-subtle p-4">
 <label htmlFor="pub-ai-position" className="block text-sm font-medium text-strong mb-1.5">
 {t('publisher.ai.label')}
 </label>
 <div className="flex flex-col sm:flex-row gap-2">
 <input
 id="pub-ai-position"
 type="text"
 value={aiPosition}
 onChange={e => setAiPosition(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.ai.placeholder')}
 />
 <button
 type="button"
 onClick={() => { void handleAiFill(); }}
 disabled={!aiPosition.trim() || aiStatus === 'loading'}
 className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-on-accent bg-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:cursor-not-allowed rounded-xl transition-colors"
 >
 {aiStatus === 'loading' ? (
 <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
 ) : (
 <Sparkles className="w-4 h-4" />
 )}
 {t('publisher.ai.button')}
 </button>
 </div>
 <p className="mt-1.5 text-xs text-muted">{t('publisher.ai.hint')}</p>
 {aiStatus === 'error' && (
 <p className="mt-1 text-xs text-danger">{t('publisher.ai.error')}</p>
 )}
 </div>
 )}
 <div>
 <label htmlFor="pub-title" className={labelClass}>
 {t('publisher.ad.title')} *
 </label>
 <input
 id="pub-title"
 type="text"
 required
 value={title}
 onChange={e => setTitle(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.ad.titlePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-description" className={labelClass}>
 {t('publisher.ad.description')} *
 </label>
 <textarea
 id="pub-description"
 required
 rows={6}
 value={description}
 onChange={e => setDescription(e.target.value)}
 spellCheck={true}
 className={`${inputClass} resize-y min-h-[140px]`}
 placeholder={t('publisher.ad.descriptionPlaceholder')}
 />
 <p className="mt-1 text-xs text-muted">{t('publisher.ad.descriptionHint')}</p>
 </div>
 <div>
 <label htmlFor="pub-employment" className={labelClass}>
 {t('publisher.ad.employmentType')}
 </label>
 <select
 id="pub-employment"
 value={employmentType}
 onChange={e => setEmploymentType(e.target.value)}
 className={inputClass}
 >
 {EMPLOYMENT_TYPES.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
 <div>
 <label htmlFor="pub-salary-min" className={labelClass}>
 {t('publisher.ad.salaryMin')}
 </label>
 <input
 id="pub-salary-min"
 type="number"
 min={0}
 inputMode="numeric"
 value={salaryMin}
 onChange={e => setSalaryMin(e.target.value)}
 className={inputClass}
 />
 </div>
 <div>
 <label htmlFor="pub-salary-max" className={labelClass}>
 {t('publisher.ad.salaryMax')}
 </label>
 <input
 id="pub-salary-max"
 type="number"
 min={0}
 inputMode="numeric"
 value={salaryMax}
 onChange={e => setSalaryMax(e.target.value)}
 className={inputClass}
 />
 </div>
 </div>
 </div>
 </section>

 {/* ── Locations ──────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.locations.section')}</h2>
 <p className="text-xs text-muted mb-3">{t('publisher.locations.hint')}</p>
 <div className="space-y-3">
 {locations.map((loc, index) => (
 <div key={index} className="flex items-center gap-2">
 <label htmlFor={`pub-location-${index}`} className="sr-only">
 {t('publisher.locations.label')} {index + 1}
 </label>
 <input
 id={`pub-location-${index}`}
 type="text"
 value={loc}
 onChange={e => updateLocation(index, e.target.value)}
 className={inputClass}
 placeholder={t('publisher.locations.placeholder')}
 />
 {locations.length > 1 && (
 <button
 type="button"
 onClick={() => removeLocation(index)}
 aria-label={t('publisher.locations.remove')}
 className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl border border-edge text-subtle hover:text-danger hover:border-danger-border transition-colors"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 )}
 </div>
 ))}
 </div>
 <button
 type="button"
 onClick={addLocation}
 className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors"
 >
 <Plus className="w-4 h-4" />
 {t('publisher.locations.add')}
 </button>
 </section>

 {/* ── Apply ──────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.apply.section')}</h2>
 <div className="space-y-5">
 {isFree ? (
 <p className="text-xs text-muted">{t('publisher.apply.freeOnlyExternal')}</p>
 ) : (
 <div>
 <label htmlFor="pub-apply-mode" className={labelClass}>
 {t('publisher.apply.mode')}
 </label>
 <select
 id="pub-apply-mode"
 value={applyMode}
 onChange={e => setApplyMode(e.target.value as ApplyMode)}
 className={inputClass}
 >
 {APPLY_MODES.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 )}
 {applyMode === 'external_url' && (
 <div>
 <label htmlFor="pub-apply-url" className={labelClass}>
 {t('publisher.apply.url')} *
 </label>
 <input
 id="pub-apply-url"
 type="url"
 value={applyUrl}
 onChange={e => setApplyUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.apply.urlPlaceholder')}
 />
 </div>
 )}
 {(applyMode === 'forward_email' || applyMode === 'in_house') && (
 <div>
 <label htmlFor="pub-apply-email" className={labelClass}>
 {t('publisher.apply.email')} *
 </label>
 <input
 id="pub-apply-email"
 type="email"
 value={applyEmail}
 onChange={e => setApplyEmail(e.target.value)}
 autoComplete="email"
 className={inputClass}
 placeholder={t('publisher.apply.emailPlaceholder')}
 />
 </div>
 )}
 <div>
 <label htmlFor="pub-privacy-url" className={labelClass}>
 {t('publisher.apply.privacyPolicyUrl')}
 </label>
 <input
 id="pub-privacy-url"
 type="url"
 value={privacyPolicyUrl}
 onChange={e => setPrivacyPolicyUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.apply.urlPlaceholder')}
 />
 </div>
 </div>
 </section>

 {/* ── Price preview ──────────────────────────────────── */}
 <section className="rounded-2xl border border-edge bg-surface-alt p-5">
 <h2 className="text-base font-semibold font-display text-strong mb-2">
 {t('publisher.price.title')}
 </h2>
 {isFree ? (
 <>
 <p className="text-2xl font-bold text-strong">{t('publisher.price.free')}</p>
 <p className="text-xs text-muted mt-2">{t('publisher.price.freeNote')}</p>
 </>
 ) : (
 <>
 <p className="text-2xl font-bold text-strong">
 {t('publisher.price.perPeriod', { n: price.netChf })}
 </p>
 <p className="text-sm text-subtle mt-1">
 {t('publisher.price.units', { n: price.units })}
 </p>
 {price.discountRate > 0 && (
 <p className="text-sm text-success mt-1">
 {t('publisher.price.discount', {
 pct: Math.round(price.discountRate * 100),
 amount: price.discountChf,
 })}
 </p>
 )}
 <p className="text-xs text-muted mt-2">{t('publisher.price.autoRenew')}</p>
 </>
 )}
 </section>

 {/* ── Validation errors ──────────────────────────────── */}
 {errors.length > 0 && (
 <div className="flex items-start gap-2 p-3 rounded-xl bg-danger-subtle border border-danger-border">
 <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
 <ul className="text-sm text-danger space-y-1">
 {errors.map((err, i) => (
 <li key={i}>{err}</li>
 ))}
 </ul>
 </div>
 )}

 {/* ── Submit error ───────────────────────────────────── */}
 {status === 'error' && (
 <div className="flex items-center gap-2 p-3 rounded-xl bg-danger-subtle border border-danger-border">
 <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
 <p className="text-sm text-danger">{errorMessage || t('publisher.error')}</p>
 </div>
 )}

 {/* ── Post-payment notice ────────────────────────────── */}
 <div className="flex items-center gap-2 text-sm text-subtle">
 <Clock className="w-4 h-4 flex-shrink-0" />
 <span>{t('publisher.postPaymentNotice')}</span>
 </div>

 {/* ── Submit ─────────────────────────────────────────── */}
 <button
 type="submit"
 disabled={status === 'submitting' || status === 'redirecting'}
 className="w-full flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
 >
 {status === 'submitting' || status === 'redirecting' ? (
 <>
 <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
 {status === 'redirecting' ? t('publisher.redirecting') : t('publisher.submitting')}
 </>
 ) : (
 <>
 <Send className="w-4 h-4" />
 {isFree ? t('publisher.submitFree') : t('publisher.submit')}
 </>
 )}
 </button>

 {/* ── reCAPTCHA notice ───────────────────────────────── */}
 <div className="flex items-center justify-center gap-1.5 text-xs text-muted">
 <Shield className="w-3 h-3 flex-shrink-0" />
 <span>{t('publisher.recaptchaNotice')}</span>
 </div>
 </form>
 </div>
 );
};

export default PublisherPublishPage;
