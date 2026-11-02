import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, ExternalLink, Mail, MapPin, Phone, Printer, ShieldCheck, Store, TriangleAlert } from 'lucide-react';
import type { ConfirmationResult } from 'firebase/auth';
import { useTranslation, loadNamespaceTranslations } from '@/services/i18n';
import { TranslationNamespaceGate } from '@/components/shared/TranslationNamespaceGate';
import { buildPath } from '@/services/router';
import { ensureAppCheck, fetchAndActivate } from '@/services/firebase';
import {
  getDirectEmployerContact,
  isDirectEmployerChannelEnabled,
  loadPermanentEmployers,
  markPermanentEmployer,
  renewDirectEmployerListing,
  submitDirectEmployerListing,
  verifyDirectEmployerListing,
  type PermanentEmployer,
} from '@/services/directEmployerChannel';

const MIN_DESCRIPTION_WORDS = 51;
const EMPLOYMENT_TYPES = [
  ['FULL_TIME', 'publisher.ad.employmentType.fullTime'],
  ['PART_TIME', 'publisher.ad.employmentType.partTime'],
  ['CONTRACTOR', 'publisher.ad.employmentType.contract'],
  ['TEMPORARY', 'publisher.ad.employmentType.temporary'],
  ['INTERN', 'publisher.ad.employmentType.internship'],
] as const;

function words(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).filter(Boolean).length : 0;
}

function sourceParam(): string {
  if (typeof window === 'undefined') return '';
  const value = new URLSearchParams(window.location.search).get('origin') || '';
  return /^[a-z0-9_-]{1,48}$/iu.test(value) ? value : '';
}

function PageFrame({ children, eyebrow, title, intro }: { children: React.ReactNode; eyebrow: string; title: string; intro: string }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-heading sm:text-4xl">{title}</h1>
        <p className="mt-4 text-base leading-7 text-body">{intro}</p>
      </header>
      <div className="mt-8">{children}</div>
    </div>
  );
}

function StatusNotice({ tone, children }: { tone: 'success' | 'danger' | 'warning'; children: React.ReactNode }) {
  const styles = tone === 'success'
    ? 'border-success-border bg-success-subtle text-success'
    : tone === 'danger'
      ? 'border-danger-border bg-danger-subtle text-danger'
      : 'border-warning-border bg-warning-subtle text-warning';
  return <div role="status" className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6 ${styles}`}>{tone === 'success' ? <CheckCircle2 size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}<span>{children}</span></div>;
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return <label htmlFor={id} className="block text-sm font-medium text-strong"><span>{label}</span>{hint && <span className="mt-1 block text-xs font-normal leading-5 text-subtle">{hint}</span>}{children}</label>;
}

const inputClass = 'mt-2 min-h-11 w-full rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-base text-strong shadow-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30';

function DirectEmployerPublishContent() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorKey, setErrorKey] = useState('');
  const [renewalUrl, setRenewalUrl] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyWebsite, setCompanyWebsite] = useState('');
  const [title, setTitle] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [streetAddress, setStreetAddress] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [canton, setCanton] = useState('TI');
  const [employmentType, setEmploymentType] = useState('FULL_TIME');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [description, setDescription] = useState('');
  const [contactMode, setContactMode] = useState<'email' | 'phone'>('email');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const phoneConfirmation = useRef<ConfirmationResult | null>(null);
  const recaptchaContainer = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetchAndActivate().then(() => isDirectEmployerChannelEnabled()).then((value) => { if (mounted) setEnabled(value); }).catch(() => { if (mounted) setEnabled(false); });
    return () => { mounted = false; };
  }, []);

  const descriptionWordCount = useMemo(() => words(description), [description]);

  async function sendPhoneCode() {
    setPhoneBusy(true); setErrorKey('');
    try {
      await ensureAppCheck();
      const [{ getAuth, RecaptchaVerifier, signInWithPhoneNumber }, { getApp }] = await Promise.all([import('firebase/auth'), import('@/services/firebase')]);
      const auth = getAuth(await getApp());
      if (!recaptchaContainer.current) throw new Error('recaptcha');
      const verifier = new RecaptchaVerifier(auth, recaptchaContainer.current, { size: 'invisible' });
      phoneConfirmation.current = await signInWithPhoneNumber(auth, contactPhone.trim(), verifier);
      setPhoneCodeSent(true);
    } catch {
      setErrorKey('directEmployer.phoneVerificationError');
    } finally { setPhoneBusy(false); }
  }

  async function confirmPhoneCode() {
    if (!phoneConfirmation.current || !phoneCode.trim()) return;
    setPhoneBusy(true); setErrorKey('');
    try {
      await phoneConfirmation.current.confirm(phoneCode.trim());
      setPhoneVerified(true);
    } catch {
      setErrorKey('directEmployer.phoneCodeInvalid');
    } finally { setPhoneBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('idle'); setErrorKey('');
    if (descriptionWordCount < MIN_DESCRIPTION_WORDS) { setErrorKey('directEmployer.descriptionTooShort'); return; }
    if (contactMode === 'phone' && !phoneVerified) { setErrorKey('directEmployer.phoneMustVerify'); return; }
    setBusy(true);
    try {
      const result = await submitDirectEmployerListing({ companyName, companyWebsite, title, locationLabel, streetAddress, postalCode, canton, employmentType, salaryMin, salaryMax, description, contactEmail: contactMode === 'email' ? contactEmail : '', contactPhone: contactMode === 'phone' ? contactPhone : '', websiteConfirm: honeypot, locale: document.documentElement.lang, origin: sourceParam() });
      if (!result.ok) { setErrorKey(result.error === 'channel_disabled' ? 'directEmployer.disabled' : result.error === 'rate_limited' ? 'directEmployer.rateLimited' : 'directEmployer.submissionError'); return; }
      if (result.renewalUrl) setRenewalUrl(result.renewalUrl);
      setStatus('success');
    } catch (error) {
      const code = String((error as { code?: string })?.code || '');
      setErrorKey(code.includes('resource-exhausted') ? 'directEmployer.rateLimited' : 'directEmployer.submissionError');
    } finally { setBusy(false); }
  }

  if (enabled === false) return <PageFrame eyebrow={t('directEmployer.eyebrow')} title={t('directEmployer.title')} intro={t('directEmployer.intro')}><StatusNotice tone="warning">{t('directEmployer.disabled')}</StatusNotice></PageFrame>;
  if (enabled === null) return <PageFrame eyebrow={t('directEmployer.eyebrow')} title={t('directEmployer.title')} intro={t('directEmployer.intro')}><div className="rounded-2xl border border-edge bg-surface p-5 text-sm text-subtle" role="status">{t('directEmployer.loading')}</div></PageFrame>;
  if (status === 'success') return <PageFrame eyebrow={t('directEmployer.eyebrow')} title={t('directEmployer.successTitle')} intro={t('directEmployer.successIntro')}><StatusNotice tone="success">{contactMode === 'email' ? t('directEmployer.successEmail') : t('directEmployer.successPhone')}</StatusNotice>{renewalUrl && <a href={renewalUrl} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl border border-accent px-4 py-2.5 text-sm font-semibold text-accent hover:bg-accent-subtle">{t('directEmployer.renewalLink')}<ArrowUpRight size={16} aria-hidden="true" /></a>}<a href={buildPath({ activeTab: 'permanent-employers' })} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong hover:bg-surface-raised">{t('directEmployer.permanentLink')}<ArrowUpRight size={16} aria-hidden="true" /></a></PageFrame>;

  return (
    <PageFrame eyebrow={t('directEmployer.eyebrow')} title={t('directEmployer.title')} intro={t('directEmployer.intro')}>
      <form onSubmit={submit} className="space-y-7" noValidate>
        <section className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-6" aria-labelledby="direct-employer-company">
          <h2 id="direct-employer-company" className="flex items-center gap-2 font-display text-xl font-semibold text-heading"><Store size={20} aria-hidden="true" />{t('directEmployer.companyHeading')}</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field id="direct-company" label={t('directEmployer.companyName')}><input id="direct-company" className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} autoComplete="organization" required /></Field>
            <Field id="direct-website" label={t('directEmployer.website')} hint={t('directEmployer.websiteHint')}><input id="direct-website" className={inputClass} value={companyWebsite} onChange={(event) => setCompanyWebsite(event.target.value)} type="url" inputMode="url" placeholder="https://" autoComplete="url" /></Field>
          </div>
        </section>

        <section className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-6" aria-labelledby="direct-employer-offer">
          <h2 id="direct-employer-offer" className="flex items-center gap-2 font-display text-xl font-semibold text-heading"><MapPin size={20} aria-hidden="true" />{t('directEmployer.offerHeading')}</h2>
          <div className="mt-5 space-y-5">
            <Field id="direct-title" label={t('directEmployer.role')}><input id="direct-title" className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="off" required /></Field>
            <div className="grid gap-5 sm:grid-cols-2"><Field id="direct-location" label={t('directEmployer.location')}><input id="direct-location" className={inputClass} value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} autoComplete="address-level2" required /></Field><Field id="direct-canton" label={t('directEmployer.canton')}><select id="direct-canton" className={inputClass} value={canton} onChange={(event) => setCanton(event.target.value)}><option value="TI">{t('directEmployer.cantonName.TI')}</option><option value="GR">{t('directEmployer.cantonName.GR')}</option><option value="ZH">{t('directEmployer.cantonName.ZH')}</option><option value="GE">{t('directEmployer.cantonName.GE')}</option><option value="VD">{t('directEmployer.cantonName.VD')}</option></select></Field></div>
            <div className="grid gap-5 sm:grid-cols-2"><Field id="direct-street" label={t('directEmployer.street')} hint={t('directEmployer.optional')}><input id="direct-street" className={inputClass} value={streetAddress} onChange={(event) => setStreetAddress(event.target.value)} autoComplete="street-address" /></Field><Field id="direct-postal" label={t('directEmployer.postalCode')} hint={t('directEmployer.optional')}><input id="direct-postal" className={inputClass} value={postalCode} onChange={(event) => setPostalCode(event.target.value)} inputMode="numeric" autoComplete="postal-code" /></Field></div>
            <div className="grid gap-5 sm:grid-cols-2"><Field id="direct-contract" label={t('directEmployer.contract')}><select id="direct-contract" className={inputClass} value={employmentType} onChange={(event) => setEmploymentType(event.target.value)} required>{EMPLOYMENT_TYPES.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></Field><div className="grid grid-cols-2 gap-3"><Field id="direct-salary-min" label={t('directEmployer.salaryMin')} hint={t('directEmployer.optional')}><input id="direct-salary-min" className={inputClass} value={salaryMin} onChange={(event) => setSalaryMin(event.target.value)} type="number" min="0" inputMode="numeric" /></Field><Field id="direct-salary-max" label={t('directEmployer.salaryMax')} hint={t('directEmployer.optional')}><input id="direct-salary-max" className={inputClass} value={salaryMax} onChange={(event) => setSalaryMax(event.target.value)} type="number" min="0" inputMode="numeric" /></Field></div></div>
            <Field id="direct-description" label={t('directEmployer.description')} hint={t('directEmployer.descriptionHint', { count: descriptionWordCount })}><textarea id="direct-description" className={`${inputClass} min-h-40 resize-y`} value={description} onChange={(event) => setDescription(event.target.value)} required /></Field>
          </div>
        </section>

        <section className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-6" aria-labelledby="direct-employer-contact">
          <h2 id="direct-employer-contact" className="flex items-center gap-2 font-display text-xl font-semibold text-heading"><ShieldCheck size={20} aria-hidden="true" />{t('directEmployer.contactHeading')}</h2>
          <p className="mt-2 text-sm leading-6 text-subtle">{t('directEmployer.contactIntro')}</p>
          <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label={t('directEmployer.contactChoiceLabel')}><button type="button" className={`min-h-11 rounded-xl border px-4 py-2 text-sm font-semibold ${contactMode === 'email' ? 'border-accent bg-accent-subtle text-accent' : 'border-edge text-body'}`} onClick={() => setContactMode('email')}><Mail size={16} className="mr-2 inline" aria-hidden="true" />{t('directEmployer.email')}</button><button type="button" className={`min-h-11 rounded-xl border px-4 py-2 text-sm font-semibold ${contactMode === 'phone' ? 'border-accent bg-accent-subtle text-accent' : 'border-edge text-body'}`} onClick={() => setContactMode('phone')}><Phone size={16} className="mr-2 inline" aria-hidden="true" />{t('directEmployer.phone')}</button></div>
          {contactMode === 'email' ? <Field id="direct-contact-email" label={t('directEmployer.contactEmail')} hint={t('directEmployer.emailVerificationHint')}><input id="direct-contact-email" className={inputClass} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} type="email" inputMode="email" autoComplete="email" required /></Field> : <div className="mt-5 space-y-3"><Field id="direct-contact-phone" label={t('directEmployer.contactPhone')} hint={t('directEmployer.phoneVerificationHint')}><input id="direct-contact-phone" className={inputClass} value={contactPhone} onChange={(event) => { setContactPhone(event.target.value); setPhoneCode(''); setPhoneCodeSent(false); setPhoneVerified(false); phoneConfirmation.current = null; }} type="tel" inputMode="tel" autoComplete="tel" required /></Field>{!phoneCodeSent ? <button type="button" onClick={() => void sendPhoneCode()} disabled={phoneBusy || !contactPhone.trim()} className="min-h-11 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong disabled:cursor-not-allowed disabled:opacity-50">{phoneBusy ? t('directEmployer.verifying') : t('directEmployer.sendCode')}</button> : <div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Field id="direct-phone-code" label={t('directEmployer.code')}><input id="direct-phone-code" className={inputClass} value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field><button type="button" onClick={() => void confirmPhoneCode()} disabled={phoneBusy || !phoneCode.trim()} className="min-h-11 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong disabled:cursor-not-allowed disabled:opacity-50">{phoneBusy ? t('directEmployer.verifying') : t('directEmployer.confirmCode')}</button></div>}{phoneVerified && <p className="text-sm font-medium text-success">{t('directEmployer.phoneVerified')}</p>}<div ref={recaptchaContainer} aria-hidden="true" /></div>}
          <input tabIndex={-1} aria-hidden="true" autoComplete="off" className="absolute left-[-10000px] h-px w-px opacity-0" value={honeypot} onChange={(event) => setHoneypot(event.target.value)} name="websiteConfirm" />
        </section>

        {errorKey && <StatusNotice tone="danger">{t(errorKey)}</StatusNotice>}
        <div className="rounded-xl border border-edge bg-surface-alt px-4 py-3 text-xs leading-5 text-subtle">{t('directEmployer.privacyNotice')}</div>
        <button type="submit" disabled={busy} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-base font-semibold text-on-accent shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">{busy ? t('directEmployer.submitting') : t('directEmployer.submit')}<ArrowUpRight size={18} aria-hidden="true" /></button>
      </form>
    </PageFrame>
  );
}

export function DirectEmployerPublishPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerPublishContent /></TranslationNamespaceGate>; }

function PermanentEmployerMarkForm() {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState(''); const [website, setWebsite] = useState(''); const [locationLabel, setLocationLabel] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setMessage(''); try { const result = await markPermanentEmployer({ companyName, website, locationLabel }); setMessage(result.ok ? t('directEmployer.permanentSubmitted') : t('directEmployer.permanentSubmitError')); } catch { setMessage(t('directEmployer.permanentSubmitError')); } finally { setBusy(false); } }
  return <form onSubmit={submit} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-6"><h2 className="font-display text-xl font-semibold text-heading">{t('directEmployer.permanentMarkTitle')}</h2><p className="mt-2 text-sm leading-6 text-subtle">{t('directEmployer.permanentMarkIntro')}</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><Field id="permanent-company" label={t('directEmployer.companyName')}><input id="permanent-company" className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} required /></Field><Field id="permanent-website" label={t('directEmployer.website')}><input id="permanent-website" className={inputClass} value={website} onChange={(event) => setWebsite(event.target.value)} type="url" placeholder="https://" required /></Field><Field id="permanent-location" label={t('directEmployer.location')} hint={t('directEmployer.optional')}><input id="permanent-location" className={inputClass} value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} /></Field></div>{message && <p className="mt-4 text-sm text-body" role="status">{message}</p>}<button type="submit" disabled={busy} className="mt-5 min-h-11 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-60">{busy ? t('directEmployer.submitting') : t('directEmployer.permanentMarkSubmit')}</button></form>;
}

function PermanentEmployersContent() {
  const { t } = useTranslation(); const [employers, setEmployers] = useState<PermanentEmployer[]>([]); const [loading, setLoading] = useState(true); const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => { let mounted = true; void loadPermanentEmployers().then((result) => { if (!mounted) return; setEmployers(result.employers); setEnabled(result.enabled); }).catch(() => { if (mounted) setEnabled(false); }).finally(() => { if (mounted) setLoading(false); }); return () => { mounted = false; }; }, []);
  return <PageFrame eyebrow={t('directEmployer.permanentEyebrow')} title={t('directEmployer.permanentTitle')} intro={t('directEmployer.permanentIntro')}><div className="rounded-xl border border-warning-border bg-warning-subtle px-4 py-3 text-sm leading-6 text-warning">{t('directEmployer.permanentDisclaimer')}</div>{loading ? <p className="mt-6 text-sm text-subtle" role="status">{t('directEmployer.loading')}</p> : enabled !== true ? <div className="mt-6"><StatusNotice tone="warning">{t('directEmployer.disabled')}</StatusNotice></div> : employers.length === 0 ? <p className="mt-6 rounded-2xl border border-edge bg-surface p-5 text-sm text-subtle">{t('directEmployer.permanentEmpty')}</p> : <ul className="mt-6 grid gap-4 sm:grid-cols-2" aria-label={t('directEmployer.permanentListLabel')}>{employers.map((employer) => <li key={employer.id} className="rounded-2xl border border-edge bg-surface p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="font-display text-lg font-semibold text-heading">{employer.companyName}</h2>{employer.locationLabel && <p className="mt-1 text-sm text-subtle">{employer.locationLabel}</p>}</div><Store size={20} className="shrink-0 text-accent" aria-hidden="true" /></div><a className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent underline-offset-4 hover:underline" href={employer.website} target="_blank" rel="noreferrer">{t('directEmployer.officialWebsite')}<ExternalLink size={15} aria-hidden="true" /></a></li>)}</ul>} {!loading && enabled === true && <div className="mt-10"><PermanentEmployerMarkForm /></div>}</PageFrame>;
}

export function PermanentEmployersPage() { return <TranslationNamespaceGate namespace="publisher"><PermanentEmployersContent /></TranslationNamespaceGate>; }

function DirectEmployerQrContent() {
  const { t } = useTranslation();
  const [qr, setQr] = useState('');
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState(sourceParam() || 'vetrina');
  const safeOrigin = /^[a-z0-9_-]{1,48}$/iu.test(origin) ? origin : 'vetrina';
  const target = `${window.location.origin}${buildPath({ activeTab: 'direct-employers' })}?origin=${encodeURIComponent(safeOrigin)}`;
  useEffect(() => {
    let mounted = true;
    void import('qrcode')
      .then((module) => (module.default ?? module).toDataURL(target, { errorCorrectionLevel: 'M', margin: 2, width: 640 }))
      .then((value) => { if (mounted) setQr(value); })
      .catch(() => { if (mounted) setError(true); });
    return () => { mounted = false; };
  }, [target]);
  return <PageFrame eyebrow={t('directEmployer.qrEyebrow')} title={t('directEmployer.qrTitle')} intro={t('directEmployer.qrIntro')}><div className="direct-employer-qr-page rounded-2xl border border-edge bg-surface p-5 text-center shadow-sm sm:p-8"><div className="print:hidden"><Field id="qr-origin" label={t('directEmployer.qrOriginLabel')} hint={t('directEmployer.qrOriginHint')}><input id="qr-origin" className={`${inputClass} mx-auto max-w-md text-left`} value={origin} onChange={(event) => setOrigin(event.target.value.replace(/[^a-z0-9_-]/giu, '').slice(0, 48))} inputMode="text" autoComplete="off" /></Field></div>{qr ? <img src={qr} width={640} height={640} alt={t('directEmployer.qrAlt')} className="direct-employer-qr-code mx-auto mt-6 h-auto w-full max-w-[22rem]" /> : error ? <div className="mt-6 print:hidden"><StatusNotice tone="danger">{t('directEmployer.qrError')}</StatusNotice></div> : <p role="status" className="mt-6 text-sm text-subtle print:hidden">{t('directEmployer.loading')}</p>}<p className="mt-5 text-sm leading-6 text-subtle print:hidden">{t('directEmployer.qrSource', { origin: safeOrigin })}</p><button type="button" onClick={() => window.print()} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong hover:bg-surface-raised print:hidden"><Printer size={17} aria-hidden="true" />{t('directEmployer.print')}</button></div></PageFrame>;
}

export function DirectEmployerQrPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerQrContent /></TranslationNamespaceGate>; }

function DirectEmployerActionContent({ action }: { action: 'verify' | 'renew' }) {
  const { t } = useTranslation(); const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  useEffect(() => { const token = new URLSearchParams(window.location.search).get('token') || ''; if (!token) { setState('error'); return; } void (action === 'verify' ? verifyDirectEmployerListing(token) : renewDirectEmployerListing(token)).then((result) => setState(result.ok ? 'success' : 'error')).catch(() => setState('error')); }, [action]);
  const title = action === 'verify' ? t('directEmployer.verifyTitle') : t('directEmployer.renewTitle'); const body = state === 'loading' ? t('directEmployer.loading') : state === 'success' ? (action === 'verify' ? t('directEmployer.verifySuccess') : t('directEmployer.renewSuccess')) : t('directEmployer.actionError');
  return <PageFrame eyebrow={t('directEmployer.eyebrow')} title={title} intro={body}>{state === 'success' ? <StatusNotice tone="success">{body}</StatusNotice> : state === 'error' ? <StatusNotice tone="danger">{body}</StatusNotice> : <p className="rounded-2xl border border-edge bg-surface p-5 text-sm text-subtle" role="status">{body}</p>}</PageFrame>;
}

export function DirectEmployerVerificationPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerActionContent action="verify" /></TranslationNamespaceGate>; }
export function DirectEmployerRenewalPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerActionContent action="renew" /></TranslationNamespaceGate>; }

function DirectEmployerApplyContent() {
  const { t } = useTranslation(); const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const [email, setEmail] = useState<string | null>(null); const [phone, setPhone] = useState<string | null>(null); const [markMessage, setMarkMessage] = useState(''); const jobId = new URLSearchParams(window.location.search).get('job') || '';
  useEffect(() => { if (!jobId) { setState('error'); return; } setState('loading'); void getDirectEmployerContact(jobId).then((result) => { if (!result.ok) { setState('error'); return; } setEmail(result.email || null); setPhone(result.phone || null); setState('ready'); }).catch(() => setState('error')); }, [jobId]);
  async function markEmployer(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); setMarkMessage(''); try { const result = await markPermanentEmployer({ companyName: String(form.get('companyName') || ''), website: String(form.get('website') || ''), locationLabel: String(form.get('location') || '') }); setMarkMessage(result.ok ? t('directEmployer.permanentSubmitted') : t('directEmployer.permanentSubmitError')); } catch { setMarkMessage(t('directEmployer.permanentSubmitError')); } }
  return <PageFrame eyebrow={t('directEmployer.applyEyebrow')} title={t('directEmployer.applyTitle')} intro={t('directEmployer.applyIntro')}>{state === 'loading' && <p className="rounded-2xl border border-edge bg-surface p-5 text-sm text-subtle" role="status">{t('directEmployer.loading')}</p>}{state === 'error' && <StatusNotice tone="danger">{t('directEmployer.contactUnavailable')}</StatusNotice>}{state === 'ready' && <><div className="rounded-2xl border border-edge bg-surface p-5 shadow-sm"><h2 className="font-display text-xl font-semibold text-heading">{t('directEmployer.contactEmployer')}</h2><div className="mt-5 flex flex-wrap gap-3">{email && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent" href={`mailto:${email}`}><Mail size={16} aria-hidden="true" />{t('directEmployer.emailEmployer')}</a>}{phone && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong" href={`tel:${phone}`}><Phone size={16} aria-hidden="true" />{t('directEmployer.callEmployer')}</a>}</div></div><form onSubmit={markEmployer} className="mt-8 rounded-2xl border border-edge bg-surface p-5 shadow-sm"><h2 className="font-display text-xl font-semibold text-heading">{t('directEmployer.permanentMarkTitle')}</h2><p className="mt-2 text-sm leading-6 text-subtle">{t('directEmployer.permanentMarkIntro')}</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><Field id="apply-company" label={t('directEmployer.companyName')}><input id="apply-company" name="companyName" className={inputClass} required /></Field><Field id="apply-website" label={t('directEmployer.website')}><input id="apply-website" name="website" className={inputClass} type="url" placeholder="https://" required /></Field><Field id="apply-location" label={t('directEmployer.location')} hint={t('directEmployer.optional')}><input id="apply-location" name="location" className={inputClass} /></Field></div>{markMessage && <p className="mt-4 text-sm text-body" role="status">{markMessage}</p>}<button type="submit" className="mt-5 min-h-11 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong">{t('directEmployer.permanentMarkSubmit')}</button></form></>}</PageFrame>;
}

export function DirectEmployerApplyPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerApplyContent /></TranslationNamespaceGate>; }

void loadNamespaceTranslations('publisher');
