import React, { useEffect, useMemo, useState } from 'react';
import { Key, CheckCircle2, AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { getAutologinStatus, toggleAutologin } from '@/services/newsletterSubscribers';
import { getLocale, type Locale } from '@/services/i18n';

type Status = 'loading' | 'ready' | 'invalid' | 'saving' | 'error';

const STRINGS: Record<Locale, {
 back: string;
 title: string;
 subtitle: string;
 loading: string;
 invalidLink: string;
 invalidToken: string;
 readError: string;
 saveError: string;
 email: string;
 sectionTitle: string;
 sectionDesc: string;
 currentState: string;
 stateOn: string;
 stateOff: string;
 saved: string;
 toggleEnable: string;
 toggleDisable: string;
 footer: string;
}> = {
 it: {
 back: 'Torna alla Home',
 title: 'Preferenze Newsletter',
 subtitle: 'Gestisci come ricevi i link dalle nostre email',
 loading: 'Caricamento…',
 invalidLink: 'Link non valido. Apri questa pagina dal link nel piè di pagina di una email.',
 invalidToken: 'Link non valido o scaduto. Richiedine uno nuovo dalla prossima email.',
 readError: 'Impossibile caricare le preferenze. Riprova più tardi.',
 saveError: 'Salvataggio fallito. Riprova.',
 email: 'Email',
 sectionTitle: 'Auto-login dai link email',
 sectionDesc:
 'Quando è attivo, i link nelle nostre email ti fanno entrare nel tuo profilo senza richiedere una password. Disattivalo se inoltri o condividi le email, o se preferisci accedere manualmente. La tua iscrizione alla newsletter e agli avvisi lavoro resta attiva.',
 currentState: 'Stato attuale:',
 stateOn: 'Attivo',
 stateOff: 'Disattivato',
 saved: 'Salvato',
 toggleEnable: 'Attiva auto-login',
 toggleDisable: 'Disattiva auto-login',
 footer:
 'Puoi cambiare questa preferenza in qualsiasi momento. Per disiscriverti completamente, usa il link "Disiscrivimi" nel piè di pagina delle email.',
 },
 en: {
 back: 'Back to Home',
 title: 'Newsletter preferences',
 subtitle: 'Manage how you receive links in our emails',
 loading: 'Loading…',
 invalidLink: 'Invalid link. Open this page from the footer link in one of our emails.',
 invalidToken: 'Invalid or expired link. Request a new one from the next email.',
 readError: 'Unable to load your preferences. Please try again later.',
 saveError: 'Saving failed. Please try again.',
 email: 'Email',
 sectionTitle: 'Auto-login from email links',
 sectionDesc:
 'When enabled, links in our emails sign you into your profile without a password. Disable it if you forward or share emails, or if you prefer to sign in manually. Your newsletter and job alert subscriptions remain active.',
 currentState: 'Current state:',
 stateOn: 'Enabled',
 stateOff: 'Disabled',
 saved: 'Saved',
 toggleEnable: 'Enable auto-login',
 toggleDisable: 'Disable auto-login',
 footer:
 'You can change this preference at any time. To unsubscribe entirely, use the "Unsubscribe" link in the email footer.',
 },
 de: {
 back: 'Zurück zur Startseite',
 title: 'Newsletter-Einstellungen',
 subtitle: 'Verwalte, wie du Links in unseren E-Mails erhältst',
 loading: 'Wird geladen…',
 invalidLink: 'Ungültiger Link. Öffne diese Seite über den Link in der Fußzeile einer E-Mail.',
 invalidToken: 'Link ungültig oder abgelaufen. Fordere einen neuen aus der nächsten E-Mail an.',
 readError: 'Einstellungen konnten nicht geladen werden. Bitte später erneut versuchen.',
 saveError: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
 email: 'E-Mail',
 sectionTitle: 'Auto-Login über E-Mail-Links',
 sectionDesc:
 'Wenn aktiviert, melden dich die Links in unseren E-Mails ohne Passwort in deinem Profil an. Deaktiviere es, wenn du E-Mails weiterleitest oder teilst oder dich lieber manuell anmelden möchtest. Dein Newsletter- und Job-Alert-Abo bleibt aktiv.',
 currentState: 'Aktueller Status:',
 stateOn: 'Aktiv',
 stateOff: 'Deaktiviert',
 saved: 'Gespeichert',
 toggleEnable: 'Auto-Login aktivieren',
 toggleDisable: 'Auto-Login deaktivieren',
 footer:
 'Du kannst diese Einstellung jederzeit ändern. Um dich vollständig abzumelden, nutze den Link „Abmelden" in der Fußzeile.',
 },
 fr: {
 back: 'Retour à l\u2019accueil',
 title: 'Préférences newsletter',
 subtitle: 'Gère la façon dont tu reçois les liens dans nos emails',
 loading: 'Chargement…',
 invalidLink: 'Lien invalide. Ouvre cette page depuis le pied de page d\u2019un email.',
 invalidToken: 'Lien invalide ou expiré. Demande-en un nouveau dans le prochain email.',
 readError: 'Impossible de charger les préférences. Réessaie plus tard.',
 saveError: 'Échec de l\u2019enregistrement. Réessaie.',
 email: 'Email',
 sectionTitle: 'Auto-connexion depuis les liens email',
 sectionDesc:
 'Quand c\u2019est activé, les liens dans nos emails te connectent à ton profil sans mot de passe. Désactive-le si tu transfères ou partages tes emails, ou si tu préfères te connecter manuellement. Ton abonnement newsletter et alertes emploi reste actif.',
 currentState: 'État actuel :',
 stateOn: 'Activé',
 stateOff: 'Désactivé',
 saved: 'Enregistré',
 toggleEnable: 'Activer l\u2019auto-connexion',
 toggleDisable: 'Désactiver l\u2019auto-connexion',
 footer:
 'Tu peux changer cette préférence à tout moment. Pour te désabonner complètement, utilise le lien « Se désabonner » dans le pied de page.',
 },
};

export const NewsletterPreferences: React.FC = () => {
 const nav = useNavigation();
 const locale = getLocale();
 const S = useMemo(() => STRINGS[locale] || STRINGS.it, [locale]);

 const [status, setStatus] = useState<Status>('loading');
 const [email, setEmail] = useState('');
 const [token, setToken] = useState('');
 const [autologinEnabled, setAutologinEnabled] = useState(true);
 const [errorMsg, setErrorMsg] = useState<string>('');
 const [savedTick, setSavedTick] = useState(false);

 useEffect(() => {
 const params = new URLSearchParams(window.location.search);
 const e = (params.get('email') || '').trim().toLowerCase();
 const t = (params.get('token') || '').trim();
 if (!e || !e.includes('@') || !t) {
 setStatus('invalid');
 setErrorMsg(S.invalidLink);
 return;
 }
 setEmail(e);
 setToken(t);
 (async () => {
 const result = await getAutologinStatus(e, t);
 if (!result.success) {
 setStatus('invalid');
 setErrorMsg(result.error === 'invalid_token' ? S.invalidToken : S.readError);
 return;
 }
 setAutologinEnabled(result.enabled !== false);
 setStatus('ready');
 })();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const handleToggle = async (next: boolean) => {
 setStatus('saving');
 setSavedTick(false);
 const result = await toggleAutologin(email, token, next);
 if (!result.success) {
 setErrorMsg(S.saveError);
 setStatus('error');
 return;
 }
 setAutologinEnabled(result.enabled === true);
 setStatus('ready');
 setSavedTick(true);
 setTimeout(() => setSavedTick(false), 2500);
 };

 return (
 <div className="max-w-2xl mx-auto px-4 py-8 animate-fade-in">
 <button
 onClick={() => nav.navigateTo('calculator')}
 className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
 >
 <ArrowLeft size={16} />
 {S.back}
 </button>

 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-stripe-lg">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-accent-subtle rounded-2xl">
 <Key className="text-accent" size={28} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-light font-display text-heading">{S.title}</h1>
 <p className="text-sm text-muted mt-1">{S.subtitle}</p>
 </div>
 </div>

 {status === 'loading' && (
 <div className="flex items-center gap-2 text-muted py-8 justify-center">
 <Loader2 className="animate-spin" size={18} /> {S.loading}
 </div>
 )}

 {(status === 'invalid' || status === 'error') && (
 <div className="bg-danger-subtle border border-danger-border rounded-xl p-4 text-sm text-danger flex gap-3">
 <AlertCircle size={18} className="shrink-0 mt-0.5" />
 <div>{errorMsg}</div>
 </div>
 )}

 {(status === 'ready' || status === 'saving') && (
 <div className="space-y-5">
 <div className="bg-accent-subtle/40 border border-edge rounded-xl p-4 text-sm">
 <div className="font-semibold text-heading mb-1">{S.email}</div>
 <div className="text-muted break-all">{email}</div>
 </div>

 <div className="border border-edge rounded-xl p-5">
 <div className="flex items-start justify-between gap-4">
 <div className="flex-1">
 <h2 className="font-semibold text-heading mb-1">{S.sectionTitle}</h2>
 <p className="text-sm text-muted leading-relaxed">{S.sectionDesc}</p>
 </div>
 <button
 onClick={() => handleToggle(!autologinEnabled)}
 disabled={status === 'saving'}
 aria-label={autologinEnabled ? S.toggleDisable : S.toggleEnable}
 aria-pressed={autologinEnabled}
 className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${autologinEnabled ? 'bg-accent' : 'bg-surface-raised'} ${status === 'saving' ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
 >
 <span
 className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${autologinEnabled ? 'translate-x-6' : 'translate-x-1'}`}
 />
 </button>
 </div>

 <div className="mt-3 text-xs text-muted">
 {S.currentState}{' '}
 <span className={`font-semibold ${autologinEnabled ? 'text-success' : 'text-muted'}`}>
 {autologinEnabled ? S.stateOn : S.stateOff}
 </span>
 {savedTick && (
 <span className="ml-2 inline-flex items-center gap-1 text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </div>

 <div className="text-xs text-muted leading-relaxed">{S.footer}</div>
 </div>
 )}
 </div>
 </div>
 );
};

export default NewsletterPreferences;
