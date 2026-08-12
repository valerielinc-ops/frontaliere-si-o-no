/**
 * PdfDownloadGate — global click-delegation gate for [data-pdf-gate] anchors.
 *
 * Static SSG pages (e.g. the self-certification forms landing) link directly
 * to PDF templates with a real, crawlable `href` plus `data-pdf-gate` +
 * `data-pdf-gate-source` + `data-pdf-gate-label` attributes. This component
 * intercepts the click, asks for an email (or social sign-in) once per
 * visitor, then triggers the real download — mirrors the
 * OfferwallNewsletterGate/LeadMagnetCTA pattern (upsertNewsletterSubscriber +
 * markNewsletterSubscribedLocally), but keyed off a DOM attribute instead of
 * the Offerwall registry, since these are static build-time files rather than
 * a client-generated PDF.
 *
 * Already-subscribed/authenticated visitors bypass the gate entirely (same
 * `newsletter_subscribed` / `firebase:authUser:*` check as the Offerwall
 * gate), so the click behaves like a plain download link for them.
 *
 * IT-only copy: the only pages that render [data-pdf-gate] anchors today
 * (self-certification forms) are IT-only static pages.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileDown, Loader2, CheckCircle2 } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { consentProof } from '@/services/consentTexts';
import { reportCaughtError } from '@/services/errorReporter';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import { useAuth } from '@/services/authService';
import { getFirestoreLazy } from '@/services/firebase';
import {
  upsertNewsletterSubscriber,
  markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';

function hasGateAccess(): boolean {
  try {
    if (localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true') return true;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('firebase:authUser:') === 0) return true;
    }
  } catch { /* localStorage unavailable */ }
  return false;
}

function triggerDownload(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type PendingDownload = { href: string; source: string; label: string };

const PdfDownloadGate: React.FC = () => {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDownload | null>(null);
  const [email, setEmail] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const pendingRef = useRef<PendingDownload | null>(null);
  pendingRef.current = pending;

  const closeGate = useCallback(() => {
    setPending(null);
    setEmail('');
    setConsentChecked(false);
    setStatus('idle');
    setErrorMessage('');
  }, []);

  const grantAndDownload = useCallback((download: PendingDownload) => {
    markNewsletterSubscribedLocally();
    triggerDownload(download.href);
  }, []);

  // Delegated click listener: cheap on every page (no-op unless a
  // [data-pdf-gate] anchor exists), mirrors NewsletterMount's DOM-scan model.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[data-pdf-gate]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (hasGateAccess()) return; // already a subscriber/signed-in — let the native download proceed
      e.preventDefault();
      const href = anchor.getAttribute('href') || '';
      if (!href) return;
      const download: PendingDownload = {
        href,
        source: anchor.getAttribute('data-pdf-gate-source') || 'self_cert',
        label: anchor.getAttribute('data-pdf-gate-label') || anchor.textContent || 'documento',
      };
      setEmail('');
      setConsentChecked(false);
      setStatus('idle');
      setErrorMessage('');
      setPending(download);
      try { Analytics.trackUIInteraction('pdf_download_gate', 'modal', 'show', download.source); } catch { /* no-op */ }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, []);

  // Social sign-in completes in-page (Google One Tap/GIS) → user flips → grant + download.
  useEffect(() => {
    if (pending && user) {
      const download = pending;
      try { Analytics.trackUIInteraction('pdf_download_gate', 'social', 'access_granted', download.source); } catch { /* no-op */ }
      grantAndDownload(download);
      closeGate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const download = pendingRef.current;
    if (!download) return;
    const check = validateEmailStrict(email);
    if (!check.valid) {
      setErrorMessage('Inserisci un indirizzo email valido.');
      setStatus('error');
      return;
    }
    if (!consentChecked) {
      setErrorMessage('Spunta il consenso per continuare.');
      setStatus('error');
      return;
    }
    setStatus('loading');
    try {
      const firestore = await getFirestoreLazy('pdfDownloadGate.firestoreInit');
      if (!firestore) throw new Error('firestore_unavailable');
      await upsertNewsletterSubscriber(firestore as any, {
        email,
        name: null,
        preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false, jobs: true },
        source: `lead_magnet_${download.source}`,
        sourceChannel: 'lead_magnet',
        sourcePage: window.location.pathname,
        sourceCta: download.source,
        sourceComponent: 'PdfDownloadGate',
        locale: 'it',
        // Deliberately NOT in CONFIRMED_NEWSLETTER_SOURCES → starts `pending`
        // and triggers the double opt-in confirmation email. The PDF download
        // is granted immediately regardless, same as the Offerwall gate.
        // The checkbox below renders this exact string; both sides come from
        // consentDisplayText (#5712/#5718). IT-only gate, like the rest of
        // this component (`locale: 'it'` above).
        ...consentProof('communicationsOptIn', 'email_checkbox', 'it'),
        consentGiven: true,
      });
      try { Analytics.trackUIInteraction('pdf_download_gate', 'form', 'subscribe', 'success'); } catch { /* no-op */ }
      setStatus('success');
      setTimeout(() => {
        grantAndDownload(download);
        closeGate();
      }, 900);
    } catch (err: any) {
      reportCaughtError(err, 'pdfDownloadGate.submit');
      setErrorMessage('Iscrizione non riuscita. Riprova.');
      setStatus('error');
    }
  };

  if (!pending) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-gate-title"
    >
      <div className="relative w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl border border-edge">
        <button
          type="button"
          onClick={closeGate}
          className="absolute right-3 top-3 rounded-full p-1 text-muted hover:text-heading"
          aria-label="Chiudi"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="mb-3 flex items-center gap-2 text-info">
          <FileDown className="h-6 w-6" aria-hidden="true" />
          <h2 id="pdf-gate-title" className="text-lg font-semibold text-heading">
            Scarica gratis: {pending.label}
          </h2>
        </div>

        {status === 'success' ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden="true" />
            <p className="text-body">Fatto! Il download parte tra un istante.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted">Registrati gratis con la tua email per scaricare il modulo e ricevere via mail il link, comodo se lo compili più tardi o lo riusi per altre candidature.</p>

            <SocialSignInButtons
              locale="it"
              errorContext="pdfDownloadGate"
              googleWidth={360}
            />

            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-edge" /></div>
              <div className="relative flex justify-center">
                <span className="px-2 bg-surface text-xs text-muted uppercase tracking-wider">oppure con email</span>
              </div>
            </div>

            <EmailInput
              value={email}
              onChange={setEmail}
              ariaLabel="Email per scaricare il PDF"
              required
              className="w-full px-4 py-2.5 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent text-strong text-sm"
            />

            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5"
              />
              <ConsentNotice consentKey="communicationsOptIn" locale="it" />
            </label>

            {status === 'error' && errorMessage && (
              <p className="text-sm text-danger" role="alert">{errorMessage}</p>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-info-strong px-4 py-2.5 font-semibold text-on-accent hover:bg-info-strong-hover disabled:opacity-60"
            >
              {status === 'loading' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Registrati e scarica
            </button>

            <button
              type="button"
              onClick={closeGate}
              className="w-full text-center text-xs text-muted hover:text-heading"
            >
              Annulla
            </button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default PdfDownloadGate;
