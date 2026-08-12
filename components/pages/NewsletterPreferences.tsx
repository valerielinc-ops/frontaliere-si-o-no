import React, { useEffect, useMemo, useState } from 'react';
import { Key, AlertCircle, ArrowLeft } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { getLocale, type Locale } from '@/services/i18n';
import SubscriptionPreferencesController from '@/components/preferences/SubscriptionPreferencesController';
// The published data-controller contact (#5675) — reused here rather than
// re-typed so the page and the email footers can never name two addresses.
import { DATA_CONTROLLER_EMAIL } from '../../functions/src/lib/dataControllerIdentity.js';

type Status = 'loading' | 'ready' | 'invalid';

const STRINGS: Record<Locale, {
 back: string;
 title: string;
 subtitle: string;
 invalidLink: string;
 /**
  * #5684 point 4 — the way out for someone who no longer has the email.
  *
  * The page is HMAC-token-gated, so without a signed link it rendered
  * `invalidLink` and nothing else: a dead end whose only instruction was "open
  * this page from one of our emails", addressed to a person who deleted them.
  * That is the exact population that writes to the provider's abuse desk
  * instead, which is what produced the complaint this issue comes from. Two
  * routes, because neither covers everyone: signing in reaches the same centre
  * with the full set of controls, and the data-controller address reaches a
  * monitored human for whoever has no account.
  */
 invalidHelpTitle: string;
 invalidHelpSignIn: string;
 invalidHelpContact: string;
 email: string;
 footer: string;
}> = {
 it: {
 back: 'Torna alla Home',
 title: 'Preferenze Newsletter',
 subtitle: 'Gestisci la tua iscrizione, gli avvisi lavoro e l\u2019auto-login dalle email.',
 invalidLink: 'Link non valido. Apri questa pagina dal link nel piè di pagina di una email.',
 invalidHelpTitle: 'Non hai più quell\u2019email? Puoi comunque smettere di ricevere le nostre:',
 invalidHelpSignIn: 'Accedi al tuo profilo: trovi lo stesso centro preferenze, con tutti i canali.',
 invalidHelpContact: 'Oppure scrivi al titolare del trattamento e ci pensiamo noi:',
 email: 'Email',
 footer:
 'Puoi cambiare queste preferenze in qualsiasi momento. Per disiscriverti completamente dalla newsletter, usa il toggle sopra.',
 },
 en: {
 back: 'Back to Home',
 title: 'Newsletter preferences',
 subtitle: 'Manage your subscription, job alerts and auto-login from email links.',
 invalidLink: 'Invalid link. Open this page from the footer link in one of our emails.',
 invalidHelpTitle: 'No longer have that email? You can still stop receiving ours:',
 invalidHelpSignIn: 'Sign in to your profile: the same preference centre, with every channel.',
 invalidHelpContact: 'Or write to the data controller and we will take care of it:',
 email: 'Email',
 footer:
 'You can change these preferences at any time. To unsubscribe entirely, use the toggle above.',
 },
 de: {
 back: 'Zurück zur Startseite',
 title: 'Newsletter-Einstellungen',
 subtitle:
 'Verwalte dein Abo, deine Job-Alerts und den Auto-Login über E-Mail-Links.',
 invalidLink: 'Ungültiger Link. Öffne diese Seite über den Link in der Fußzeile einer E-Mail.',
 invalidHelpTitle: 'Du hast diese E-Mail nicht mehr? Du kannst unsere trotzdem abbestellen:',
 invalidHelpSignIn: 'Melde dich in deinem Profil an: dasselbe Einstellungszentrum, mit allen Kanälen.',
 invalidHelpContact: 'Oder schreib an die verantwortliche Person, wir erledigen das:',
 email: 'E-Mail',
 footer:
 'Du kannst diese Einstellungen jederzeit ändern. Um dich vollständig abzumelden, nutze den Schalter oben.',
 },
 fr: {
 back: 'Retour à l\u2019accueil',
 title: 'Préférences newsletter',
 subtitle:
 'Gère ton abonnement, tes alertes emploi et l\u2019auto-connexion depuis les liens email.',
 invalidLink: 'Lien invalide. Ouvre cette page depuis le pied de page d\u2019un email.',
 invalidHelpTitle: 'Tu n\u2019as plus cet email ? Tu peux quand même arrêter de recevoir les nôtres :',
 invalidHelpSignIn: 'Connecte-toi à ton profil : le même centre de préférences, avec tous les canaux.',
 invalidHelpContact: 'Ou écris au responsable du traitement et nous nous en occupons :',
 email: 'Email',
 footer:
 'Tu peux changer ces préférences à tout moment. Pour te désabonner complètement, utilise l\u2019interrupteur ci-dessus.',
 },
};

export const NewsletterPreferences: React.FC = () => {
 const nav = useNavigation();
 const locale = getLocale();
 const S = useMemo(() => STRINGS[locale] || STRINGS.it, [locale]);

 const [status, setStatus] = useState<Status>('loading');
 const [email, setEmail] = useState('');
 const [token, setToken] = useState('');

 useEffect(() => {
 const params = new URLSearchParams(window.location.search);
 const e = (params.get('email') || '').trim().toLowerCase();
 const t = (params.get('token') || '').trim();
 if (!e || !e.includes('@') || !t) {
 setStatus('invalid');
 return;
 }
 setEmail(e);
 setToken(t);
 setStatus('ready');
 }, []);

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
 <div className="flex items-center gap-4 mb-6">
 <div className="p-3 bg-accent-subtle rounded-2xl">
 <Key className="text-accent" size={28} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-light font-display text-heading">{S.title}</h1>
 <p className="text-sm text-muted mt-1">{S.subtitle}</p>
 </div>
 </div>

 {status === 'invalid' && (
 <>
 <div className="bg-danger-subtle border border-danger-border rounded-xl p-4 text-sm text-danger flex gap-3">
 <AlertCircle size={18} className="shrink-0 mt-0.5" />
 <div>{S.invalidLink}</div>
 </div>
 <div className="mt-4 border border-edge rounded-xl p-4 text-sm">
 <p className="font-semibold text-heading mb-2">{S.invalidHelpTitle}</p>
 <ul className="space-y-2 text-muted leading-relaxed">
 <li>
 <button
 type="button"
 onClick={() => nav.navigateTo('profile')}
 className="text-accent font-semibold hover:underline text-left"
 >
 {S.invalidHelpSignIn}
 </button>
 </li>
 <li>
 {S.invalidHelpContact}{' '}
 <a
 href={`mailto:${DATA_CONTROLLER_EMAIL}`}
 className="text-accent font-semibold hover:underline break-all"
 >
 {DATA_CONTROLLER_EMAIL}
 </a>
 </li>
 </ul>
 </div>
 </>
 )}

 {status === 'ready' && (
 <>
 <div className="bg-accent-subtle/40 border border-edge rounded-xl p-4 text-sm mb-5">
 <div className="font-semibold text-heading mb-1">{S.email}</div>
 <div className="text-muted break-all">{email}</div>
 </div>

 <SubscriptionPreferencesController
 mode="token"
 email={email}
 token={token}
 locale={locale}
 />

 <div className="text-xs text-muted leading-relaxed mt-5">{S.footer}</div>
 </>
 )}
 </div>
 </div>
 );
};

export default NewsletterPreferences;
