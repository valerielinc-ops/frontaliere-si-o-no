/**
 * SubscriptionPreferencesController
 *
 * Reusable card cluster that lets a user manage:
 *   1. Newsletter subscription (subscribe / unsubscribe)
 *   2. Job alerts (list + delete each)
 *   3. Auto-login from email links
 *
 * Two operating modes:
 *   - 'token': used by the public /preferenze-newsletter page. All reads/writes
 *     go through the HMAC-authed Cloud Function (newsletterManageSubscription).
 *     No Firebase Auth session is required.
 *   - 'auth': used inside an authenticated user profile page. Reads/writes go
 *     directly to Firestore using the Firebase SDK; security rules gate access.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Bell, Mail, Loader2, CheckCircle2, AlertCircle, Trash2, Key } from 'lucide-react';
import {
 getFullSubscriptionStatus,
 toggleNewsletterSubscription,
 toggleAutologin,
 deleteJobAlert,
 type SubscriptionAlertSummary,
} from '@/services/newsletterSubscribers';
import { getLocale, type Locale } from '@/services/i18n';

// ─── Types ──────────────────────────────────────────────────

export type SubscriptionPreferencesMode = 'token' | 'auth';

export interface SubscriptionPreferencesControllerProps {
 mode: SubscriptionPreferencesMode;
 email: string;
 /** Required when mode === 'token'. */
 token?: string;
 /** Required when mode === 'auth'. Firebase Auth UID. */
 userId?: string;
 /** Optional locale override. Defaults to current site locale. */
 locale?: Locale;
 /** Optional error reporter — for embedding in profile pages. */
 onError?: (msg: string) => void;
}

type LoadStatus = 'loading' | 'ready' | 'error';

// ─── i18n ───────────────────────────────────────────────────

interface SectionStrings {
 newsletterTitle: string;
 newsletterDesc: string;
 newsletterStateOn: string;
 newsletterStateOff: string;
 alertsTitle: string;
 alertsDesc: string;
 alertsEmpty: string;
 alertDelete: string;
 alertDeleting: string;
 alertConfirmDelete: string;
 alertCancel: string;
 frequencyDaily: string;
 frequencyWeekly: string;
 frequencyOther: string;
 keywordsLabel: string;
 locationsLabel: string;
 sectorsLabel: string;
 noFilters: string;
 autologinTitle: string;
 autologinDesc: string;
 autologinOn: string;
 autologinOff: string;
 readError: string;
 saveError: string;
 saved: string;
 currentState: string;
}

const STRINGS: Record<Locale, SectionStrings> = {
 it: {
 newsletterTitle: 'Iscrizione alla newsletter',
 newsletterDesc:
 'Ricevi gli aggiornamenti settimanali per i frontalieri: cambio CHF/EUR, novità fiscali, traffico alle dogane e nuovi annunci di lavoro.',
 newsletterStateOn: 'Iscritto',
 newsletterStateOff: 'Non iscritto',
 alertsTitle: 'I tuoi avvisi lavoro',
 alertsDesc:
 'Ti avvisiamo via email quando appaiono offerte che corrispondono ai tuoi criteri. Puoi eliminare i singoli avvisi qui.',
 alertsEmpty: 'Non hai alert lavoro attivi.',
 alertDelete: 'Elimina',
 alertDeleting: 'Elimino…',
 alertConfirmDelete: 'Sicuro di voler eliminare questo avviso?',
 alertCancel: 'Annulla',
 frequencyDaily: 'giornaliero',
 frequencyWeekly: 'settimanale',
 frequencyOther: 'periodico',
 keywordsLabel: 'Parole chiave',
 locationsLabel: 'Luoghi',
 sectorsLabel: 'Settori',
 noFilters: 'Nessun filtro impostato',
 autologinTitle: 'Auto-login dai link email',
 autologinDesc:
 'Quando è attivo, i link nelle nostre email ti fanno entrare nel tuo profilo senza password. Disattivalo se inoltri o condividi le email.',
 autologinOn: 'Attivo',
 autologinOff: 'Disattivato',
 readError: 'Impossibile caricare le preferenze. Riprova più tardi.',
 saveError: 'Salvataggio fallito. Riprova.',
 saved: 'Salvato',
 currentState: 'Stato attuale:',
 },
 en: {
 newsletterTitle: 'Newsletter subscription',
 newsletterDesc:
 'Get the weekly cross-border worker briefing: CHF/EUR rate, tax changes, border traffic, and fresh job postings.',
 newsletterStateOn: 'Subscribed',
 newsletterStateOff: 'Not subscribed',
 alertsTitle: 'Your job alerts',
 alertsDesc:
 'We email you when matching jobs are posted. Manage individual alerts here.',
 alertsEmpty: 'You have no active job alerts.',
 alertDelete: 'Delete',
 alertDeleting: 'Deleting…',
 alertConfirmDelete: 'Delete this alert?',
 alertCancel: 'Cancel',
 frequencyDaily: 'daily',
 frequencyWeekly: 'weekly',
 frequencyOther: 'periodic',
 keywordsLabel: 'Keywords',
 locationsLabel: 'Locations',
 sectorsLabel: 'Sectors',
 noFilters: 'No filters set',
 autologinTitle: 'Auto-login from email links',
 autologinDesc:
 'When enabled, links in our emails sign you in without a password. Disable it if you forward or share emails.',
 autologinOn: 'Enabled',
 autologinOff: 'Disabled',
 readError: 'Unable to load your preferences. Please try again later.',
 saveError: 'Saving failed. Please try again.',
 saved: 'Saved',
 currentState: 'Current state:',
 },
 de: {
 newsletterTitle: 'Newsletter-Abo',
 newsletterDesc:
 'Wöchentlicher Überblick für Grenzgänger: CHF/EUR-Kurs, Steueränderungen, Grenzverkehr und neue Stellen.',
 newsletterStateOn: 'Abonniert',
 newsletterStateOff: 'Nicht abonniert',
 alertsTitle: 'Deine Job-Alerts',
 alertsDesc:
 'Wir benachrichtigen dich per E-Mail bei passenden Stellen. Verwalte einzelne Alerts hier.',
 alertsEmpty: 'Du hast keine aktiven Job-Alerts.',
 alertDelete: 'Löschen',
 alertDeleting: 'Lösche…',
 alertConfirmDelete: 'Diesen Alert löschen?',
 alertCancel: 'Abbrechen',
 frequencyDaily: 'täglich',
 frequencyWeekly: 'wöchentlich',
 frequencyOther: 'regelmässig',
 keywordsLabel: 'Suchbegriffe',
 locationsLabel: 'Orte',
 sectorsLabel: 'Branchen',
 noFilters: 'Keine Filter gesetzt',
 autologinTitle: 'Auto-Login über E-Mail-Links',
 autologinDesc:
 'Wenn aktiviert, melden dich Links in unseren E-Mails ohne Passwort an. Deaktiviere es, wenn du E-Mails weiterleitest oder teilst.',
 autologinOn: 'Aktiv',
 autologinOff: 'Deaktiviert',
 readError: 'Einstellungen konnten nicht geladen werden. Bitte später erneut versuchen.',
 saveError: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
 saved: 'Gespeichert',
 currentState: 'Aktueller Status:',
 },
 fr: {
 newsletterTitle: 'Abonnement newsletter',
 newsletterDesc:
 'Reçois le résumé hebdomadaire frontalier : taux CHF/EUR, fiscalité, douanes et nouvelles offres d\u2019emploi.',
 newsletterStateOn: 'Abonné',
 newsletterStateOff: 'Non abonné',
 alertsTitle: 'Tes alertes emploi',
 alertsDesc:
 'Nous t\u2019envoyons un email quand des offres correspondent. Gère chaque alerte ici.',
 alertsEmpty: 'Tu n\u2019as aucune alerte emploi active.',
 alertDelete: 'Supprimer',
 alertDeleting: 'Suppression…',
 alertConfirmDelete: 'Supprimer cette alerte ?',
 alertCancel: 'Annuler',
 frequencyDaily: 'quotidien',
 frequencyWeekly: 'hebdomadaire',
 frequencyOther: 'périodique',
 keywordsLabel: 'Mots-clés',
 locationsLabel: 'Lieux',
 sectorsLabel: 'Secteurs',
 noFilters: 'Aucun filtre défini',
 autologinTitle: 'Auto-connexion depuis les liens email',
 autologinDesc:
 'Quand c\u2019est activé, les liens dans nos emails te connectent sans mot de passe. Désactive-le si tu transfères ou partages tes emails.',
 autologinOn: 'Activé',
 autologinOff: 'Désactivé',
 readError: 'Impossible de charger les préférences. Réessaie plus tard.',
 saveError: 'Échec de l\u2019enregistrement. Réessaie.',
 saved: 'Enregistré',
 currentState: 'État actuel :',
 },
};

function formatFrequency(freq: string, S: SectionStrings): string {
 const f = (freq || '').toLowerCase();
 if (f === 'daily') return S.frequencyDaily;
 if (f === 'weekly') return S.frequencyWeekly;
 return S.frequencyOther;
}

// ─── Auth-mode Firestore helpers (lazy-loaded) ───────────────

async function authLoadFullStatus(email: string): Promise<{
 newsletter: { subscribed: boolean; autologinEnabled: boolean };
 alerts: SubscriptionAlertSummary[];
}> {
 const { getFirestore, doc, getDoc, collection, getDocs } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 const subDocRef = doc(db, 'newsletter_subscribers', key);
 const subSnap = await getDoc(subDocRef);
 let newsletter = { subscribed: false, autologinEnabled: true };
 if (subSnap.exists()) {
 const data = subSnap.data() || {};
 const status = data.status;
 const hasUnsubAt = !!data.unsubscribed_at;
 const isActive = data.isActive === true || data.active === true;
 newsletter = {
 subscribed:
 status !== 'unsubscribed' &&
 !hasUnsubAt &&
 (isActive || status === 'confirmed' || status === 'pending'),
 autologinEnabled: data.autologin_enabled !== false,
 };
 }

 const alertsCol = collection(doc(db, 'job_alert_subscribers', key), 'alerts');
 const alertsSnap = await getDocs(alertsCol);
 const alerts: SubscriptionAlertSummary[] = [];
 alertsSnap.forEach((d) => {
 const a = d.data() || {};
 if (a.active === false) return;
 const created = a.createdAt;
 alerts.push({
 id: d.id,
 keywords: Array.isArray(a.keywords) ? a.keywords.map(String) : [],
 locations: Array.isArray(a.locations) ? a.locations.map(String) : [],
 sectors: Array.isArray(a.sectors) ? a.sectors.map(String) : [],
 frequency: typeof a.frequency === 'string' ? a.frequency : 'weekly',
 active: a.active !== false,
 createdAt:
 created && typeof created.toMillis === 'function' ? created.toMillis() : null,
 });
 });

 return { newsletter, alerts };
}

async function authToggleNewsletter(email: string, subscribed: boolean): Promise<void> {
 const { getFirestore, doc, setDoc, addDoc, collection, serverTimestamp, deleteField } =
 await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 if (subscribed) {
 await setDoc(
 doc(db, 'newsletter_subscribers', key),
 {
 email: key,
 status: 'subscribed',
 isActive: true,
 active: true,
 resubscribed_at: serverTimestamp(),
 unsubscribed_at: deleteField(),
 updated_at: serverTimestamp(),
 updatedAt: serverTimestamp(),
 },
 { merge: true },
 );
 } else {
 await setDoc(
 doc(db, 'newsletter_subscribers', key),
 {
 email: key,
 status: 'unsubscribed',
 isActive: false,
 active: false,
 unsubscribed_at: serverTimestamp(),
 updated_at: serverTimestamp(),
 updatedAt: serverTimestamp(),
 },
 { merge: true },
 );
 }

 await addDoc(collection(doc(db, 'newsletter_subscribers', key), 'events'), {
 email: key,
 event_type: subscribed ? 'subscription_resubscribed' : 'subscription_unsubscribed',
 source_channel: 'user_profile',
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 }).catch(() => {});
}

async function authToggleAutologin(email: string, enabled: boolean): Promise<void> {
 const { getFirestore, doc, setDoc, addDoc, collection, serverTimestamp } = await import(
 'firebase/firestore'
 );
 const { getApp } = await import('@/services/firebase');
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 await setDoc(
 doc(db, 'newsletter_subscribers', key),
 {
 email: key,
 autologin_enabled: enabled,
 updated_at: serverTimestamp(),
 updatedAt: serverTimestamp(),
 },
 { merge: true },
 );

 await addDoc(collection(doc(db, 'newsletter_subscribers', key), 'events'), {
 email: key,
 event_type: enabled ? 'autologin_enabled' : 'autologin_disabled',
 source_channel: 'user_profile',
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 }).catch(() => {});
}

async function authDeleteAlert(email: string, alertId: string): Promise<void> {
 const { getFirestore, doc, deleteDoc, addDoc, collection, serverTimestamp } = await import(
 'firebase/firestore'
 );
 const { getApp } = await import('@/services/firebase');
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();
 await deleteDoc(doc(db, 'job_alert_subscribers', key, 'alerts', alertId));
 await addDoc(collection(doc(db, 'newsletter_subscribers', key), 'events'), {
 email: key,
 event_type: 'job_alert_deleted',
 source_channel: 'user_profile',
 meta: { alert_id: alertId },
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 }).catch(() => {});
}

// ─── Toggle button ──────────────────────────────────────────

interface ToggleProps {
 enabled: boolean;
 saving: boolean;
 onClick: () => void;
 ariaLabel: string;
}

const Toggle: React.FC<ToggleProps> = ({ enabled, saving, onClick, ariaLabel }) => {
 return (
 <button
 type="button"
 onClick={onClick}
 disabled={saving}
 aria-label={ariaLabel}
 aria-pressed={enabled}
 className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
 enabled ? 'bg-accent' : 'bg-surface-raised'
 } ${saving ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
 >
 <span
 className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
 enabled ? 'translate-x-6' : 'translate-x-1'
 }`}
 />
 </button>
 );
};

// ─── Alert row ──────────────────────────────────────────────

interface AlertRowProps {
 alert: SubscriptionAlertSummary;
 S: SectionStrings;
 deleting: boolean;
 onDelete: () => void;
}

const AlertRow: React.FC<AlertRowProps> = ({ alert, S, deleting, onDelete }) => {
 const [confirming, setConfirming] = useState(false);

 const filterParts: Array<{ label: string; values: string[] }> = [];
 if (alert.keywords.length) filterParts.push({ label: S.keywordsLabel, values: alert.keywords });
 if (alert.locations.length)
 filterParts.push({ label: S.locationsLabel, values: alert.locations });
 if (alert.sectors.length) filterParts.push({ label: S.sectorsLabel, values: alert.sectors });

 return (
 <div className="border border-edge rounded-xl p-4 bg-surface-alt">
 <div className="flex items-start justify-between gap-3">
 <div className="flex-1 min-w-0 space-y-2">
 {filterParts.length === 0 ? (
 <div className="text-sm text-muted italic">{S.noFilters}</div>
 ) : (
 filterParts.map((part) => (
 <div key={part.label} className="text-sm text-body">
 <span className="font-semibold text-heading">{part.label}: </span>
 <span className="break-words">{part.values.join(', ')}</span>
 </div>
 ))
 )}
 <div className="flex flex-wrap items-center gap-2 mt-1">
 <span className="px-2 py-0.5 bg-accent-subtle text-accent text-xs font-bold rounded-md">
 {formatFrequency(alert.frequency, S)}
 </span>
 {!alert.active && (
 <span className="px-2 py-0.5 bg-surface-raised text-muted text-xs font-bold rounded-md">
 {S.autologinOff}
 </span>
 )}
 </div>
 </div>
 {!confirming ? (
 <button
 type="button"
 onClick={() => setConfirming(true)}
 disabled={deleting}
 aria-label={S.alertDelete}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-danger-subtle text-danger text-xs font-bold rounded-lg hover:bg-danger-subtle transition-colors disabled:opacity-60"
 >
 {deleting ? (
 <Loader2 size={12} className="animate-spin" />
 ) : (
 <Trash2 size={12} />
 )}
 {deleting ? S.alertDeleting : S.alertDelete}
 </button>
 ) : (
 <div className="flex flex-col items-end gap-1">
 <span className="text-xs text-danger font-medium">{S.alertConfirmDelete}</span>
 <div className="flex gap-1.5">
 <button
 type="button"
 onClick={() => {
 setConfirming(false);
 onDelete();
 }}
 disabled={deleting}
 className="px-2 py-1 bg-danger-strong text-on-accent text-xs font-bold rounded-md hover:bg-danger-strong-hover transition-colors disabled:opacity-60"
 >
 {S.alertDelete}
 </button>
 <button
 type="button"
 onClick={() => setConfirming(false)}
 disabled={deleting}
 className="px-2 py-1 bg-surface-raised text-body text-xs font-bold rounded-md hover:bg-surface-raised transition-colors"
 >
 {S.alertCancel}
 </button>
 </div>
 </div>
 )}
 </div>
 </div>
 );
};

// ─── Main controller ────────────────────────────────────────

export function SubscriptionPreferencesController({
 mode,
 email,
 token,
 locale,
 onError,
}: SubscriptionPreferencesControllerProps) {
 const activeLocale: Locale = locale || getLocale();
 const S = useMemo(() => STRINGS[activeLocale] || STRINGS.it, [activeLocale]);

 const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
 const [errorMsg, setErrorMsg] = useState<string>('');
 const [newsletterSubscribed, setNewsletterSubscribed] = useState<boolean>(false);
 const [autologinEnabled, setAutologinEnabledState] = useState<boolean>(true);
 const [alerts, setAlerts] = useState<SubscriptionAlertSummary[]>([]);

 const [savingNewsletter, setSavingNewsletter] = useState(false);
 const [savingAutologin, setSavingAutologin] = useState(false);
 const [deletingAlertId, setDeletingAlertId] = useState<string | null>(null);
 const [savedTickKey, setSavedTickKey] = useState<string | null>(null);

 const reportError = useCallback(
 (msg: string) => {
 setErrorMsg(msg);
 if (onError) onError(msg);
 },
 [onError],
 );

 // Load on mount.
 useEffect(() => {
 let cancelled = false;
 (async () => {
 try {
 if (mode === 'token') {
 if (!email || !token) {
 if (!cancelled) {
 setLoadStatus('error');
 reportError(S.readError);
 }
 return;
 }
 const result = await getFullSubscriptionStatus(email, token);
 if (cancelled) return;
 if (!result.success) {
 setLoadStatus('error');
 reportError(S.readError);
 return;
 }
 setNewsletterSubscribed(result.newsletter?.subscribed === true);
 setAutologinEnabledState(result.newsletter?.autologinEnabled !== false);
 setAlerts(result.alerts || []);
 setLoadStatus('ready');
 } else {
 // auth mode
 if (!email) {
 if (!cancelled) {
 setLoadStatus('error');
 reportError(S.readError);
 }
 return;
 }
 const result = await authLoadFullStatus(email);
 if (cancelled) return;
 setNewsletterSubscribed(result.newsletter.subscribed);
 setAutologinEnabledState(result.newsletter.autologinEnabled);
 setAlerts(result.alerts);
 setLoadStatus('ready');
 }
 } catch (err: any) {
 if (cancelled) return;
 console.warn('[SubscriptionPreferencesController] Load failed:', err?.message);
 setLoadStatus('error');
 reportError(S.readError);
 }
 })();
 return () => {
 cancelled = true;
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [mode, email, token]);

 const flashSaved = (key: string) => {
 setSavedTickKey(key);
 setTimeout(() => {
 setSavedTickKey((current) => (current === key ? null : current));
 }, 2500);
 };

 const handleToggleNewsletter = async () => {
 const next = !newsletterSubscribed;
 setSavingNewsletter(true);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await toggleNewsletterSubscription(email, token, next);
 if (!result.success) throw new Error(result.error || 'write_failed');
 setNewsletterSubscribed(result.subscribed === true);
 } else {
 await authToggleNewsletter(email, next);
 setNewsletterSubscribed(next);
 }
 flashSaved('newsletter');
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Toggle newsletter failed:', err?.message);
 reportError(S.saveError);
 } finally {
 setSavingNewsletter(false);
 }
 };

 const handleToggleAutologin = async () => {
 const next = !autologinEnabled;
 setSavingAutologin(true);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await toggleAutologin(email, token, next);
 if (!result.success) throw new Error(result.error || 'write_failed');
 setAutologinEnabledState(result.enabled === true);
 } else {
 await authToggleAutologin(email, next);
 setAutologinEnabledState(next);
 }
 flashSaved('autologin');
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Toggle autologin failed:', err?.message);
 reportError(S.saveError);
 } finally {
 setSavingAutologin(false);
 }
 };

 const handleDeleteAlert = async (alertId: string) => {
 setDeletingAlertId(alertId);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await deleteJobAlert(email, token, alertId);
 if (!result.success) throw new Error(result.error || 'delete_failed');
 } else {
 await authDeleteAlert(email, alertId);
 }
 setAlerts((prev) => prev.filter((a) => a.id !== alertId));
 flashSaved(`alert:${alertId}`);
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Delete alert failed:', err?.message);
 reportError(S.saveError);
 } finally {
 setDeletingAlertId(null);
 }
 };

 if (loadStatus === 'loading') {
 return (
 <div className="flex items-center gap-2 text-muted py-8 justify-center">
 <Loader2 className="animate-spin" size={18} />
 <span>{S.alertsTitle}…</span>
 </div>
 );
 }

 if (loadStatus === 'error') {
 return (
 <div
 role="alert"
 className="bg-danger-subtle border border-danger-border rounded-xl p-4 text-sm text-danger flex gap-3"
 >
 <AlertCircle size={18} className="shrink-0 mt-0.5" />
 <div>{errorMsg || S.readError}</div>
 </div>
 );
 }

 return (
 <div className="space-y-5">
 {errorMsg && (
 <div
 role="alert"
 className="bg-danger-subtle border border-danger-border rounded-xl p-3 text-sm text-danger flex gap-2"
 >
 <AlertCircle size={16} className="shrink-0 mt-0.5" />
 <div>{errorMsg}</div>
 </div>
 )}

 {/* ── Newsletter subscription card ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface">
 <div className="flex items-start justify-between gap-4">
 <div className="flex-1">
 <div className="flex items-center gap-2 mb-1">
 <Mail size={16} className="text-muted" />
 <h2 className="font-semibold text-heading">{S.newsletterTitle}</h2>
 </div>
 <p className="text-sm text-muted leading-relaxed">{S.newsletterDesc}</p>
 </div>
 <Toggle
 enabled={newsletterSubscribed}
 saving={savingNewsletter}
 onClick={handleToggleNewsletter}
 ariaLabel={S.newsletterTitle}
 />
 </div>
 <div className="mt-3 text-xs text-muted">
 {S.currentState}{' '}
 <span
 className={`font-semibold ${newsletterSubscribed ? 'text-success' : 'text-muted'}`}
 >
 {newsletterSubscribed ? S.newsletterStateOn : S.newsletterStateOff}
 </span>
 {savedTickKey === 'newsletter' && (
 <span className="ml-2 inline-flex items-center gap-1 text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </section>

 {/* ── Job alerts card ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface">
 <div className="flex items-center gap-2 mb-1">
 <Bell size={16} className="text-muted" />
 <h2 className="font-semibold text-heading">{S.alertsTitle}</h2>
 </div>
 <p className="text-sm text-muted leading-relaxed mb-4">{S.alertsDesc}</p>

 {alerts.length === 0 ? (
 <div className="text-sm text-muted italic py-3 text-center bg-surface-alt rounded-lg border border-edge">
 {S.alertsEmpty}
 </div>
 ) : (
 <div className="space-y-3">
 {alerts.map((alert) => (
 <AlertRow
 key={alert.id}
 alert={alert}
 S={S}
 deleting={deletingAlertId === alert.id}
 onDelete={() => handleDeleteAlert(alert.id)}
 />
 ))}
 </div>
 )}
 </section>

 {/* ── Auto-login card ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface">
 <div className="flex items-start justify-between gap-4">
 <div className="flex-1">
 <div className="flex items-center gap-2 mb-1">
 <Key size={16} className="text-muted" />
 <h2 className="font-semibold text-heading">{S.autologinTitle}</h2>
 </div>
 <p className="text-sm text-muted leading-relaxed">{S.autologinDesc}</p>
 </div>
 <Toggle
 enabled={autologinEnabled}
 saving={savingAutologin}
 onClick={handleToggleAutologin}
 ariaLabel={S.autologinTitle}
 />
 </div>
 <div className="mt-3 text-xs text-muted">
 {S.currentState}{' '}
 <span className={`font-semibold ${autologinEnabled ? 'text-success' : 'text-muted'}`}>
 {autologinEnabled ? S.autologinOn : S.autologinOff}
 </span>
 {savedTickKey === 'autologin' && (
 <span className="ml-2 inline-flex items-center gap-1 text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </section>
 </div>
 );
}

export default SubscriptionPreferencesController;
