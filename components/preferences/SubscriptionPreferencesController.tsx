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
import { Bell, BellOff, Bookmark, Mail, Loader2, CheckCircle2, AlertCircle, Trash2, Key, Pencil, Plus, Save, X, Pause, Play, Sunrise } from 'lucide-react';
import {
 getFullSubscriptionStatus,
 toggleNewsletterSubscription,
 toggleAutologin,
 deleteJobAlert,
 updateJobAlert,
 createJobAlert,
 setDailyBriefFrequency,
 DAILY_BRIEF_FREQUENCIES,
 type DailyBriefFrequency,
 type SubscriptionAlertSummary,
 type JobAlertFrequency,
 type JobAlertPatch,
 type JobAlertCreatePayload,
} from '@/services/newsletterSubscribers';
import { getLocale, type Locale } from '@/services/i18n';
import { resilientImport } from '@/services/resilientImport';

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
 /**
  * #5012 phase 2 — the CompanyAlert cadence. Without its own label a
  * followed employer rendered as `frequencyOther` ("periodico"), which is
  * the one thing an immediate alert is not.
  */
 frequencyImmediate: string;
 frequencyOther: string;
 keywordsLabel: string;
 /** #5012 — label for a CompanyAlert row (`specificCompanyKey`). */
 companyLabel: string;
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
 edit: string;
 cancel: string;
 save: string;
 saving: string;
 addNewAlert: string;
 frequencyLabel: string;
 keywordsPlaceholder: string;
 locationsPlaceholder: string;
 sectorsPlaceholder: string;
 alertLimitReached: string;
 atLeastOneFilter: string;
 frequencyAuto: string;
 frequencyAutoHint: string;
 frequencyPinned: string;
 frequencyResetToAuto: string;
 frequencyCreateHint: string;
 addMoreSearchesHint: string;
 alertPaused: string;
 alertPause: string;
 alertResume: string;
 briefTitle: string;
 briefDesc: string;
 briefCurrent: string;
 briefAuto: string;
 briefAutoHint: string;
 briefOptions: Record<DailyBriefFrequency, string>;
 /**
  * #5684 point 2 — what "off" means. Every control in this cluster is
  * channel-scoped: `daily_brief_frequency_override: 'off'` stops the bulletin
  * and leaves the newsletter and the job alerts running. That was documented
  * in the code and nowhere the reader could see it, so someone who flipped one
  * switch believing they had unsubscribed from everything kept receiving the
  * rest — and wrote to the provider's abuse desk instead of to us. Stated once,
  * above the cards, rather than repeated inside each one.
  */
 scopeNote: string;
 /** The "stop everything" shortcut that makes the all-off case a single action. */
 stopAll: string;
 stopAllHint: string;
 stopAllWorking: string;
 /** #5684 point 1 — the saved-jobs digest, previously switchable only from its own email. */
 digestTitle: string;
 digestDesc: string;
 digestOn: string;
 digestOff: string;
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
 'Ti avvisiamo via email quando appaiono offerte che corrispondono ai tuoi criteri. Aggiungi più ricerche per non perderti occasioni: puoi sempre modificarle o metterle in pausa.',
 alertsEmpty: 'Non hai ancora nessuna ricerca salvata. Aggiungine una per ricevere le offerte giuste via email.',
 alertDelete: 'Elimina',
 alertDeleting: 'Elimino…',
 alertConfirmDelete: 'Sicuro di voler eliminare questo avviso? Puoi anche modificarlo invece di rimuoverlo.',
 alertCancel: 'Annulla',
 frequencyDaily: 'giornaliero',
 frequencyWeekly: 'settimanale',
 frequencyImmediate: 'immediato',
 frequencyOther: 'periodico',
 keywordsLabel: 'Parole chiave',
 companyLabel: 'Azienda seguita',
 locationsLabel: 'Luoghi',
 sectorsLabel: 'Settori',
 noFilters: 'Nessun filtro impostato',
 scopeNote:
 'Ogni interruttore vale solo per il suo canale: spegnerne uno non ferma gli altri. Per non ricevere più nulla, usa «Ferma tutte le email».',
 stopAll: 'Ferma tutte le email',
 stopAllHint:
 'Disattiva newsletter, bollettino, avvisi lavoro e promemoria dei lavori salvati in una volta sola.',
 stopAllWorking: 'Disattivo tutto…',
 digestTitle: 'Promemoria dei lavori salvati',
 digestDesc:
 'Ogni settimana ti ricordiamo via email gli annunci che hai salvato, con qualche proposta simile. Vale solo per questo promemoria: newsletter, bollettino e avvisi lavoro restano come sono.',
 digestOn: 'Attivo',
 digestOff: 'Disattivato',
 autologinTitle: 'Auto-login dai link email',
 autologinDesc:
 'Quando è attivo, i link nelle nostre email ti fanno entrare nel tuo profilo senza password. Disattivalo se inoltri o condividi le email.',
 autologinOn: 'Attivo',
 autologinOff: 'Disattivato',
 readError: 'Impossibile caricare le preferenze. Riprova più tardi.',
 saveError: 'Salvataggio fallito. Riprova.',
 saved: 'Salvato',
 currentState: 'Stato attuale:',
 edit: 'Modifica',
 cancel: 'Annulla',
 save: 'Salva',
 saving: 'Salvataggio…',
 addNewAlert: 'Aggiungi nuova ricerca',
 frequencyLabel: 'Frequenza',
 keywordsPlaceholder: 'es. Software Engineer, Designer',
 locationsPlaceholder: 'es. Lugano, Mendrisio',
 sectorsPlaceholder: 'es. Banca / Finanza, IT',
 alertLimitReached: 'Hai raggiunto il limite di 10 alert',
 atLeastOneFilter: 'Inserisci almeno una parola chiave o un luogo',
 frequencyAuto: 'Automatico',
 frequencyAutoHint: 'la cadenza si adatta a quanto apri/clicchi',
 frequencyPinned: 'fissata manualmente',
 frequencyResetToAuto: 'Torna ad automatico',
 frequencyCreateHint:
 'Potrai passare ad automatico (la cadenza si adatta a quanto apri o clicchi) dopo la creazione.',
 addMoreSearchesHint: 'Più ricerche aggiungi, meno occasioni ti sfuggono.',
 alertPaused: 'In pausa',
 alertPause: 'Metti in pausa',
 alertResume: 'Riattiva',
 briefTitle: 'Bollettino quotidiano',
 briefDesc:
 'Il bollettino del frontaliere: code ai valichi, benzina, cambio e lavoro, ogni mattina presto. La frequenza si adatta a quanto lo apri e clicchi \u2014 qui puoi fissarla tu o disattivarlo, senza toccare newsletter e avvisi lavoro.',
 briefCurrent: 'Frequenza attuale',
 briefAuto: 'Automatica',
 briefAutoHint: 'segue quanto apri e clicchi il bollettino',
 briefOptions: {
 daily: 'Ogni giorno',
 'every-2': 'Ogni 2 giorni',
 'every-3': 'Ogni 3 giorni',
 'every-5': 'Ogni 5 giorni',
 weekly: 'Una volta a settimana',
 off: 'Non inviarmelo',
 },
 },
 en: {
 newsletterTitle: 'Newsletter subscription',
 newsletterDesc:
 'Get the weekly cross-border worker briefing: CHF/EUR rate, tax changes, border traffic, and fresh job postings.',
 newsletterStateOn: 'Subscribed',
 newsletterStateOff: 'Not subscribed',
 alertsTitle: 'Your job alerts',
 alertsDesc:
 'We email you when matching jobs are posted. Add more searches to catch every opportunity — you can always edit or pause them.',
 alertsEmpty: "You haven't saved any searches yet. Add one to get matching jobs by email.",
 alertDelete: 'Delete',
 alertDeleting: 'Deleting…',
 alertConfirmDelete: 'Delete this alert? You can edit it instead of removing it.',
 alertCancel: 'Cancel',
 frequencyDaily: 'daily',
 frequencyWeekly: 'weekly',
 frequencyImmediate: 'immediate',
 frequencyOther: 'periodic',
 keywordsLabel: 'Keywords',
 companyLabel: 'Company followed',
 locationsLabel: 'Locations',
 sectorsLabel: 'Sectors',
 noFilters: 'No filters set',
 scopeNote:
 'Each switch covers its own channel only: turning one off does not stop the others. To receive nothing at all, use “Stop all emails”.',
 stopAll: 'Stop all emails',
 stopAllHint:
 'Turns off the newsletter, the daily brief, your job alerts and the saved-jobs reminder in one go.',
 stopAllWorking: 'Turning everything off…',
 digestTitle: 'Saved-jobs reminder',
 digestDesc:
 'Once a week we email you the jobs you saved, plus a few similar ones. This switch covers that reminder only: the newsletter, the daily brief and your job alerts stay as they are.',
 digestOn: 'On',
 digestOff: 'Off',
 autologinTitle: 'Auto-login from email links',
 autologinDesc:
 'When enabled, links in our emails sign you in without a password. Disable it if you forward or share emails.',
 autologinOn: 'Enabled',
 autologinOff: 'Disabled',
 readError: 'Unable to load your preferences. Please try again later.',
 saveError: 'Saving failed. Please try again.',
 saved: 'Saved',
 currentState: 'Current state:',
 edit: 'Edit',
 cancel: 'Cancel',
 save: 'Save',
 saving: 'Saving…',
 addNewAlert: 'Add new alert',
 frequencyLabel: 'Frequency',
 keywordsPlaceholder: 'e.g. Software Engineer, Designer',
 locationsPlaceholder: 'e.g. Lugano, Mendrisio',
 sectorsPlaceholder: 'e.g. Banking / Finance, IT',
 alertLimitReached: "You've reached the 10-alert limit",
 atLeastOneFilter: 'Enter at least one keyword or location',
 frequencyAuto: 'Automatic',
 frequencyAutoHint: 'cadence adapts to how much you open/click',
 frequencyPinned: 'manually pinned',
 frequencyResetToAuto: 'Switch back to automatic',
 frequencyCreateHint:
 'You can switch to automatic (cadence adapts to how much you open or click) after creating it.',
 addMoreSearchesHint: 'The more searches you add, the fewer opportunities you miss.',
 alertPaused: 'Paused',
 alertPause: 'Pause',
 alertResume: 'Resume',
 briefTitle: 'Daily brief',
 briefDesc:
 'The cross-border daily brief: border waits, fuel, exchange rate and jobs, early every morning. Its frequency follows how often you open and click it \u2014 pin it yourself here, or turn it off, without touching the newsletter or your job alerts.',
 briefCurrent: 'Current frequency',
 briefAuto: 'Automatic',
 briefAutoHint: 'follows how often you open and click the brief',
 briefOptions: {
 daily: 'Every day',
 'every-2': 'Every 2 days',
 'every-3': 'Every 3 days',
 'every-5': 'Every 5 days',
 weekly: 'Once a week',
 off: 'Do not send it',
 },
 },
 de: {
 newsletterTitle: 'Newsletter-Abo',
 newsletterDesc:
 'Wöchentlicher Überblick für Grenzgänger: CHF/EUR-Kurs, Steueränderungen, Grenzverkehr und neue Stellen.',
 newsletterStateOn: 'Abonniert',
 newsletterStateOff: 'Nicht abonniert',
 alertsTitle: 'Deine Job-Alerts',
 alertsDesc:
 'Wir benachrichtigen dich per E-Mail bei passenden Stellen. Füge weitere Suchen hinzu, um keine Chance zu verpassen — du kannst sie jederzeit bearbeiten oder pausieren.',
 alertsEmpty: 'Du hast noch keine Suche gespeichert. Füge eine hinzu, um passende Stellen per E-Mail zu erhalten.',
 alertDelete: 'Löschen',
 alertDeleting: 'Lösche…',
 alertConfirmDelete: 'Diesen Alert löschen? Du kannst ihn stattdessen auch bearbeiten.',
 alertCancel: 'Abbrechen',
 frequencyDaily: 'täglich',
 frequencyWeekly: 'wöchentlich',
 frequencyImmediate: 'sofort',
 frequencyOther: 'regelmässig',
 keywordsLabel: 'Suchbegriffe',
 companyLabel: 'Gefolgtes Unternehmen',
 locationsLabel: 'Orte',
 sectorsLabel: 'Branchen',
 noFilters: 'Keine Filter gesetzt',
 scopeNote:
 'Jeder Schalter gilt nur für seinen eigenen Kanal: einen abzuschalten stoppt die anderen nicht. Wenn du gar nichts mehr erhalten willst, nutze «Alle E-Mails stoppen».',
 stopAll: 'Alle E-Mails stoppen',
 stopAllHint:
 'Schaltet Newsletter, Tagesbulletin, Job-Alerts und die Erinnerung an gespeicherte Stellen auf einmal ab.',
 stopAllWorking: 'Alles wird abgeschaltet…',
 digestTitle: 'Erinnerung an gespeicherte Stellen',
 digestDesc:
 'Einmal pro Woche erinnern wir dich per E-Mail an deine gespeicherten Stellen, samt ähnlicher Vorschläge. Dieser Schalter gilt nur dafür: Newsletter, Tagesbulletin und Job-Alerts bleiben unverändert.',
 digestOn: 'Aktiv',
 digestOff: 'Abgeschaltet',
 autologinTitle: 'Auto-Login über E-Mail-Links',
 autologinDesc:
 'Wenn aktiviert, melden dich Links in unseren E-Mails ohne Passwort an. Deaktiviere es, wenn du E-Mails weiterleitest oder teilst.',
 autologinOn: 'Aktiv',
 autologinOff: 'Deaktiviert',
 readError: 'Einstellungen konnten nicht geladen werden. Bitte später erneut versuchen.',
 saveError: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
 saved: 'Gespeichert',
 currentState: 'Aktueller Status:',
 edit: 'Bearbeiten',
 cancel: 'Abbrechen',
 save: 'Speichern',
 saving: 'Speichere…',
 addNewAlert: 'Neuen Alert hinzufügen',
 frequencyLabel: 'Frequenz',
 keywordsPlaceholder: 'z. B. Software Engineer, Designer',
 locationsPlaceholder: 'z. B. Lugano, Mendrisio',
 sectorsPlaceholder: 'z. B. Bank / Finanz, IT',
 alertLimitReached: 'Du hast das Limit von 10 Alerts erreicht',
 atLeastOneFilter: 'Gib mindestens einen Suchbegriff oder Ort an',
 frequencyAuto: 'Automatisch',
 frequencyAutoHint: 'Häufigkeit passt sich an dein Öffnen/Klicken an',
 frequencyPinned: 'manuell festgelegt',
 frequencyResetToAuto: 'Zurück zu automatisch',
 frequencyCreateHint:
 'Du kannst nach dem Erstellen auf automatisch umschalten (Häufigkeit passt sich an, wie oft du öffnest oder klickst).',
 addMoreSearchesHint: 'Je mehr Suchen du hinzufügst, desto weniger Chancen verpasst du.',
 alertPaused: 'Pausiert',
 alertPause: 'Pausieren',
 alertResume: 'Fortsetzen',
 briefTitle: 'Tagesbulletin',
 briefDesc:
 'Das Grenzg\u00e4nger-Tagesbulletin: Wartezeiten, Benzin, Wechselkurs und Stellen, jeden Morgen fr\u00fch. Die Frequenz richtet sich danach, wie oft Sie es \u00f6ffnen und anklicken \u2014 hier k\u00f6nnen Sie sie selbst festlegen oder das Bulletin abschalten, ohne Newsletter und Job-Alerts zu ber\u00fchren.',
 briefCurrent: 'Aktuelle Frequenz',
 briefAuto: 'Automatisch',
 briefAutoHint: 'richtet sich danach, wie oft Sie das Bulletin \u00f6ffnen und anklicken',
 briefOptions: {
 daily: 'T\u00e4glich',
 'every-2': 'Alle 2 Tage',
 'every-3': 'Alle 3 Tage',
 'every-5': 'Alle 5 Tage',
 weekly: 'Einmal pro Woche',
 off: 'Nicht senden',
 },
 },
 fr: {
 newsletterTitle: 'Abonnement newsletter',
 newsletterDesc:
 'Reçois le résumé hebdomadaire frontalier : taux CHF/EUR, fiscalité, douanes et nouvelles offres d\u2019emploi.',
 newsletterStateOn: 'Abonné',
 newsletterStateOff: 'Non abonné',
 alertsTitle: 'Tes alertes emploi',
 alertsDesc:
 'Nous t\u2019envoyons un email quand des offres correspondent. Ajoute d\u2019autres recherches pour ne rater aucune opportunité — tu peux toujours les modifier ou les mettre en pause.',
 alertsEmpty: 'Tu n\u2019as encore aucune recherche enregistrée. Ajoutes-en une pour recevoir les offres par email.',
 alertDelete: 'Supprimer',
 alertDeleting: 'Suppression…',
 alertConfirmDelete: 'Supprimer cette alerte ? Tu peux aussi la modifier au lieu de la supprimer.',
 alertCancel: 'Annuler',
 frequencyDaily: 'quotidien',
 frequencyWeekly: 'hebdomadaire',
 frequencyImmediate: 'immédiat',
 frequencyOther: 'périodique',
 keywordsLabel: 'Mots-clés',
 companyLabel: 'Entreprise suivie',
 locationsLabel: 'Lieux',
 sectorsLabel: 'Secteurs',
 noFilters: 'Aucun filtre défini',
 scopeNote:
 'Chaque interrupteur ne vaut que pour son propre canal : en désactiver un n’arrête pas les autres. Pour ne plus rien recevoir, utilise « Arrêter tous les emails ».',
 stopAll: 'Arrêter tous les emails',
 stopAllHint:
 'Désactive la newsletter, le bulletin quotidien, tes alertes emploi et le rappel des offres enregistrées en une seule fois.',
 stopAllWorking: 'Tout est en cours de désactivation…',
 digestTitle: 'Rappel des offres enregistrées',
 digestDesc:
 'Chaque semaine nous te rappelons par email les offres que tu as enregistrées, avec quelques suggestions similaires. Cet interrupteur ne concerne que ce rappel : la newsletter, le bulletin et tes alertes emploi restent inchangés.',
 digestOn: 'Actif',
 digestOff: 'Désactivé',
 autologinTitle: 'Auto-connexion depuis les liens email',
 autologinDesc:
 'Quand c\u2019est activé, les liens dans nos emails te connectent sans mot de passe. Désactive-le si tu transfères ou partages tes emails.',
 autologinOn: 'Activé',
 autologinOff: 'Désactivé',
 readError: 'Impossible de charger les préférences. Réessaie plus tard.',
 saveError: 'Échec de l\u2019enregistrement. Réessaie.',
 saved: 'Enregistré',
 currentState: 'État actuel :',
 edit: 'Modifier',
 cancel: 'Annuler',
 save: 'Enregistrer',
 saving: 'Enregistrement…',
 addNewAlert: 'Ajouter une nouvelle alerte',
 frequencyLabel: 'Fréquence',
 keywordsPlaceholder: 'ex. Software Engineer, Designer',
 locationsPlaceholder: 'ex. Lugano, Mendrisio',
 sectorsPlaceholder: 'ex. Banque / Finance, IT',
 alertLimitReached: 'Tu as atteint la limite de 10 alertes',
 atLeastOneFilter: 'Saisis au moins un mot-clé ou un lieu',
 frequencyAuto: 'Automatique',
 frequencyAutoHint: 'la fréquence s\'adapte à tes ouvertures/clics',
 frequencyPinned: 'fixée manuellement',
 frequencyResetToAuto: 'Repasser en automatique',
 frequencyCreateHint:
 'Tu pourras passer en automatique (la fréquence s\'adapte à tes ouvertures/clics) après la création.',
 addMoreSearchesHint: 'Plus tu ajoutes de recherches, moins tu rates d\u2019opportunités.',
 alertPaused: 'En pause',
 alertPause: 'Mettre en pause',
 alertResume: 'Réactiver',
 briefTitle: 'Bulletin quotidien',
 briefDesc:
 "Le bulletin du frontalier : attentes aux douanes, essence, taux de change et emploi, t\u00f4t chaque matin. Sa fr\u00e9quence suit la fa\u00e7on dont vous l'ouvrez et le cliquez \u2014 vous pouvez la fixer ici, ou le d\u00e9sactiver, sans toucher \u00e0 la newsletter ni aux alertes emploi.",
 briefCurrent: 'Fr\u00e9quence actuelle',
 briefAuto: 'Automatique',
 briefAutoHint: "suit la fa\u00e7on dont vous ouvrez et cliquez le bulletin",
 briefOptions: {
 daily: 'Chaque jour',
 'every-2': 'Tous les 2 jours',
 'every-3': 'Tous les 3 jours',
 'every-5': 'Tous les 5 jours',
 weekly: 'Une fois par semaine',
 off: "Ne pas me l'envoyer",
 },
 },
};

function formatFrequency(freq: string, S: SectionStrings): string {
 const f = (freq || '').toLowerCase();
 if (f === 'daily') return S.frequencyDaily;
 if (f === 'weekly') return S.frequencyWeekly;
 // #5012 phase 2: routed to scripts/send-company-alerts.mjs, not the digest.
 if (f === 'immediate') return S.frequencyImmediate;
 return S.frequencyOther;
}

// ─── Auth-mode Firestore helpers (lazy-loaded) ───────────────

async function authLoadFullStatus(email: string): Promise<{
 newsletter: {
 subscribed: boolean;
 autologinEnabled: boolean;
 dailyBriefFrequency: DailyBriefFrequency | null;
 dailyBriefTier: number | null;
 };
 alerts: SubscriptionAlertSummary[];
}> {
 const { getFirestore, doc, getDoc, collection, getDocs } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 const subDocRef = doc(db, 'newsletter_subscribers', key);
 const subSnap = await getDoc(subDocRef);
 let newsletter = {
 subscribed: false,
 autologinEnabled: true,
 dailyBriefFrequency: null as DailyBriefFrequency | null,
 dailyBriefTier: null as number | null,
 };
 if (subSnap.exists()) {
 const data = subSnap.data() || {};
 const status = data.status;
 // Both spellings — see functions/src/newsletterSubscriptionManagement.js's
 // get_full_status, which this mirrors token-for-token (#5673).
 const hasUnsubAt = !!(data.unsubscribed_at || data.unsubscribedAt);
 const isActive = data.isActive === true || data.active === true;
 newsletter = {
 subscribed:
 status !== 'unsubscribed' &&
 !hasUnsubAt &&
 (isActive || status === 'confirmed' || status === 'pending'),
 autologinEnabled: data.autologin_enabled !== false,
 dailyBriefFrequency: DAILY_BRIEF_FREQUENCIES.includes(data.daily_brief_frequency_override)
 ? data.daily_brief_frequency_override
 : null,
 dailyBriefTier: typeof data.daily_brief_tier === 'number' ? data.daily_brief_tier : null,
 };
 }

 const alertsCol = collection(doc(db, 'job_alert_subscribers', key), 'alerts');
 const alertsSnap = await getDocs(alertsCol);
 const alerts: SubscriptionAlertSummary[] = [];
 alertsSnap.forEach((d) => {
 const a = d.data() || {};
 // Issue #4298 follow-up fix: `active` is SOLELY the soft-delete flag written
 // by services/jobAlertService.ts's deleteAlert() — a soft-deleted doc must
 // never reappear here. Pause is tracked by the dedicated, orthogonal `paused`
 // field written by authUpdateAlert; a paused (active:true, paused:true) alert
 // stays visible so the user can resume it.
 if (a.active === false) return;
 const created = a.createdAt;
 alerts.push({
 id: d.id,
 keywords: Array.isArray(a.keywords) ? a.keywords.map(String) : [],
 locations: Array.isArray(a.locations) ? a.locations.map(String) : [],
 sectors: Array.isArray(a.sectors) ? a.sectors.map(String) : [],
 frequency: typeof a.frequency === 'string' ? a.frequency : 'weekly',
 frequencyOverride: a.frequencyOverride === true,
 active: true,
 paused: a.paused === true,
 specificCompanyKey: typeof a.specificCompanyKey === 'string' && a.specificCompanyKey
 ? a.specificCompanyKey
 : null,
 specificJobId: typeof a.specificJobId === 'string' && a.specificJobId ? a.specificJobId : null,
 createdAt:
 created && typeof created.toMillis === 'function' ? created.toMillis() : null,
 });
 });

 return { newsletter, alerts };
}

/**
 * Auth-mode twin of `setDailyBriefFrequency` (#5415 §3.7): a signed-in reader
 * writes their own subscriber doc directly, the same way authToggleNewsletter
 * does, instead of round-tripping through the HMAC token endpoint they have no
 * token for.
 */
async function authSetBriefFrequency(email: string, frequency: DailyBriefFrequency | null): Promise<void> {
 const { getFirestore, doc, setDoc, addDoc, collection, serverTimestamp, deleteField } =
 await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 await setDoc(
 doc(db, 'newsletter_subscribers', key),
 {
 email: key,
 daily_brief_frequency_override: frequency === null ? deleteField() : frequency,
 daily_brief_override_updated_at: serverTimestamp(),
 },
 { merge: true },
 );
 await addDoc(collection(db, 'newsletter_subscribers', key, 'events'), {
 email: key,
 event_type: 'daily_brief_frequency_set',
 frequency,
 source_channel: 'preferences_auth',
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });
}

/**
 * The engine's tier, in days, named with the same label the pinned options use —
 * so "Automatic" tells the reader what it actually produced for them rather than
 * leaving the cadence invisible. Mirrors FREQUENCY_OVERRIDES in
 * scripts/lib/dailyBriefCadence.mjs.
 */
function briefTierToOption(days: number): DailyBriefFrequency {
 if (days <= 1) return 'daily';
 if (days <= 2) return 'every-2';
 if (days <= 3) return 'every-3';
 if (days <= 5) return 'every-5';
 return 'weekly';
}

/**
 * Saved-jobs digest opt-out (#5684 point 1).
 *
 * The channel's kill switch is `users/{uid}.savedJobsDigest.optedOut`, read by
 * scripts/send-saved-jobs-digest.mjs and — until this change — written from
 * exactly one place: functions/src/savedJobsDigestUnsubscribe.js, i.e. the link
 * inside the digest itself. That is the situation the issue names as
 * disqualifying: a channel that can only be switched off from its own email is
 * invisible to anyone who arrives from the profile or deleted the message.
 *
 * Auth mode only, and that is sufficient rather than a compromise: the sender
 * iterates `users/{uid}/savedJobs`, so every possible recipient of this channel
 * is a signed-in account by construction. Token mode has an address and no uid,
 * and Firestore rules key this doc by uid — bridging the two needs a Cloud
 * Function, tracked separately. The digest's own "manage" link already points
 * at the profile, so the loop closes there.
 */
async function authLoadSavedJobsDigest(userId: string): Promise<boolean> {
 const { getFirestore, doc, getDoc } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 const snap = await getDoc(doc(db, 'users', userId));
 // Absent doc / absent field = receiving, matching the sender, which skips only
 // on an explicit `optedOut === true`.
 return snap.exists() ? (snap.data() || {}).savedJobsDigest?.optedOut !== true : true;
}

async function authSetSavedJobsDigest(userId: string, enabled: boolean): Promise<void> {
 const { getFirestore, doc, setDoc, serverTimestamp } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 // Merge, and only under `savedJobsDigest` — services/savedJobsService.ts's
 // ensureUserProfileDoc deliberately never rewrites this key after creation so
 // a server-side unsubscribe cannot be clobbered by a re-login; a shallow
 // overwrite here would reintroduce exactly that.
 await setDoc(
 doc(db, 'users', userId),
 {
 savedJobsDigest: {
 optedOut: !enabled,
 // Same provenance fields savedJobsDigestUnsubscribe.js records, so an
 // LPD art. 25 request gets one answer regardless of which surface the
 // reader used.
 unsubscribe_method: enabled ? null : 'preference_center',
 optedOutAt: enabled ? null : serverTimestamp(),
 },
 },
 { merge: true },
 );
}

async function authToggleNewsletter(email: string, subscribed: boolean): Promise<void> {
 const { getFirestore, doc, setDoc, addDoc, collection, serverTimestamp, deleteField } =
 await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
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
 // Both spellings of the RE-OPT-IN stamp, and neither opt-out stamp is
 // deleted (#5711). scripts/send-newsletter.mjs drops a row carrying
 // either spelling of the opt-out, so the lift has to be visible to it —
 // it now compares the two stamps (`isNewsletterOptOutBinding`,
 // services/newsletterOptOut.mjs) instead of requiring the opt-out to be
 // erased. Erasing it destroyed the only record that the person had
 // unsubscribed, which is the half of the problem #5711 is about.
 resubscribed_at: serverTimestamp(),
 resubscribedAt: serverTimestamp(),
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
 // Both spellings, so every opt-out writer leaves the same observable
 // state whichever path the recipient used (#5673).
 unsubscribedAt: serverTimestamp(),
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
 const { getFirestore, doc, setDoc, addDoc, collection, serverTimestamp } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
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

async function authUpdateAlert(
 email: string,
 alertId: string,
 patch: JobAlertPatch,
): Promise<SubscriptionAlertSummary> {
 const { getFirestore, doc, setDoc, getDoc, addDoc, collection, serverTimestamp } =
 await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 const ref = doc(db, 'job_alert_subscribers', key, 'alerts', alertId);
 const update: Record<string, any> = { email: key, updatedAt: serverTimestamp() };
 if (patch.keywords !== undefined) update.keywords = patch.keywords;
 if (patch.locations !== undefined) update.locations = patch.locations;
 if (patch.sectors !== undefined) update.sectors = patch.sectors;
 if (patch.frequency !== undefined) update.frequency = patch.frequency;
 // `in` (not `!== undefined`) so callers can deliberately reset to
 // engine-managed (`false`), not just pin (`true`) — see
 // handleResetToAuto below.
 if ('frequencyOverride' in patch) update.frequencyOverride = patch.frequencyOverride === true;
 // Issue #4298 follow-up fix: never write `active` here — that field is
 // SOLELY the soft-delete flag. Pause/resume writes the dedicated `paused`
 // field, which can never collide with a real delete.
 if ('paused' in patch) update.paused = patch.paused === true;
 await setDoc(ref, update, { merge: true });

 await addDoc(collection(doc(db, 'newsletter_subscribers', key), 'events'), {
 email: key,
 event_type: 'job_alert_updated',
 source_channel: 'user_profile',
 meta: { alert_id: alertId, fields: Object.keys(patch) },
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 }).catch(() => {});

 const fresh = await getDoc(ref);
 const data = fresh.exists() ? fresh.data() : update;
 const created = data?.createdAt;
 return {
 id: alertId,
 keywords: Array.isArray(data?.keywords) ? data.keywords.map(String) : [],
 locations: Array.isArray(data?.locations) ? data.locations.map(String) : [],
 sectors: Array.isArray(data?.sectors) ? data.sectors.map(String) : [],
 frequency: typeof data?.frequency === 'string' ? data.frequency : 'weekly',
 frequencyOverride: data?.frequencyOverride === true,
 active: data?.active !== false,
 paused: data?.paused === true,
 specificCompanyKey: typeof data?.specificCompanyKey === 'string' && data.specificCompanyKey
 ? data.specificCompanyKey
 : null,
 specificJobId: typeof data?.specificJobId === 'string' && data.specificJobId
 ? data.specificJobId
 : null,
 createdAt: created && typeof created.toMillis === 'function' ? created.toMillis() : null,
 };
}

async function authCreateAlert(
 email: string,
 payload: JobAlertCreatePayload,
): Promise<SubscriptionAlertSummary> {
 const { getFirestore, doc, addDoc, collection, serverTimestamp, getDoc } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const app = await getApp();
 const db = getFirestore(app as any);
 const key = email.trim().toLowerCase();

 const docData = {
 keywords: payload.keywords,
 locations: payload.locations,
 sectors: payload.sectors,
 frequency: payload.frequency,
 // Creation always shows an explicit frequency picker — the pick is a
 // manual pin from the start, same as the create_alert action handler
 // in functions/src/newsletterSubscriptionManagement.js.
 frequencyOverride: true,
 active: true,
 // Pinned scope (#5012) — null, never undefined (Firestore rejects it).
 specificCompanyKey: payload.specificCompanyKey || null,
 specificJobId: payload.specificJobId || null,
 email: key,
 createdAt: serverTimestamp(),
 };
 const newRef = await addDoc(
 collection(doc(db, 'job_alert_subscribers', key), 'alerts'),
 docData,
 );

 await addDoc(collection(doc(db, 'newsletter_subscribers', key), 'events'), {
 email: key,
 event_type: 'job_alert_created',
 source_channel: 'user_profile',
 meta: { alert_id: newRef.id },
 timestamp: serverTimestamp(),
 occurred_at: new Date().toISOString(),
 }).catch(() => {});

 const fresh = await getDoc(newRef);
 const data = fresh.exists() ? fresh.data() : docData;
 const created = data?.createdAt;
 return {
 id: newRef.id,
 keywords: payload.keywords,
 locations: payload.locations,
 sectors: payload.sectors,
 frequency: payload.frequency,
 frequencyOverride: true,
 active: true,
 paused: false,
 specificCompanyKey: payload.specificCompanyKey || null,
 specificJobId: payload.specificJobId || null,
 createdAt:
 created && typeof created.toMillis === 'function' ? created.toMillis() : Date.now(),
 };
}

async function authDeleteAlert(email: string, alertId: string): Promise<void> {
 const { getFirestore, doc, deleteDoc, addDoc, collection, serverTimestamp } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
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

// ─── Alert editor (shared by Edit + Create) ─────────────────

interface AlertEditorProps {
 S: SectionStrings;
 initial: { keywords: string[]; locations: string[]; sectors: string[]; frequency: string };
 saving: boolean;
 showFrequency?: boolean;
 /** Shows a forward-looking auto-frequency hint — create-only, since an
 * existing alert's real auto/pinned state is already shown in AlertRow. */
 isCreate?: boolean;
 onSave: (values: {
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: JobAlertFrequency;
 }) => void;
 onCancel: () => void;
 requireAtLeastOneFilter?: boolean;
}

function csvFromArray(arr: string[]): string {
 return arr.join(', ');
}

function arrayFromCsv(value: string): string[] {
 return value
 .split(',')
 .map((v) => v.trim())
 .filter(Boolean)
 .slice(0, 20)
 .map((v) => v.slice(0, 60));
}

const AlertEditor: React.FC<AlertEditorProps> = ({
 S,
 initial,
 saving,
 showFrequency = false,
 isCreate = false,
 onSave,
 onCancel,
 requireAtLeastOneFilter = false,
}) => {
 const [keywordsText, setKeywordsText] = useState(csvFromArray(initial.keywords));
 const [locationsText, setLocationsText] = useState(csvFromArray(initial.locations));
 const [sectorsText, setSectorsText] = useState(csvFromArray(initial.sectors));
 const [freq, setFreq] = useState<JobAlertFrequency>(
 (initial.frequency || '').toLowerCase() === 'daily' ? 'daily' : 'weekly',
 );
 const [validationError, setValidationError] = useState<string>('');

 const handleSave = () => {
 const kw = arrayFromCsv(keywordsText);
 const loc = arrayFromCsv(locationsText);
 const sec = arrayFromCsv(sectorsText);
 if (requireAtLeastOneFilter && kw.length === 0 && loc.length === 0) {
 setValidationError(S.atLeastOneFilter);
 return;
 }
 setValidationError('');
 onSave({ keywords: kw, locations: loc, sectors: sec, frequency: freq });
 };

 return (
 <div className="space-y-3">
 <div>
 <label className="block text-xs font-semibold text-heading mb-1">
 {S.keywordsLabel}
 </label>
 <input
 type="text"
 value={keywordsText}
 onChange={(e) => setKeywordsText(e.target.value)}
 placeholder={S.keywordsPlaceholder}
 disabled={saving}
 className="w-full px-3 py-2 text-sm border border-edge rounded-lg bg-surface text-body placeholder:text-muted focus:outline-none focus:border-accent"
 />
 </div>
 <div>
 <label className="block text-xs font-semibold text-heading mb-1">
 {S.locationsLabel}
 </label>
 <input
 type="text"
 value={locationsText}
 onChange={(e) => setLocationsText(e.target.value)}
 placeholder={S.locationsPlaceholder}
 disabled={saving}
 className="w-full px-3 py-2 text-sm border border-edge rounded-lg bg-surface text-body placeholder:text-muted focus:outline-none focus:border-accent"
 />
 </div>
 <div>
 <label className="block text-xs font-semibold text-heading mb-1">
 {S.sectorsLabel}
 </label>
 <input
 type="text"
 value={sectorsText}
 onChange={(e) => setSectorsText(e.target.value)}
 placeholder={S.sectorsPlaceholder}
 disabled={saving}
 className="w-full px-3 py-2 text-sm border border-edge rounded-lg bg-surface text-body placeholder:text-muted focus:outline-none focus:border-accent"
 />
 </div>
 {showFrequency && (
 <div>
 <span className="block text-xs font-semibold text-heading mb-1">
 {S.frequencyLabel}
 </span>
 <FrequencyToggle
 value={freq}
 saving={saving}
 onChange={(next) => setFreq(next)}
 S={S}
 />
 {isCreate && (
 <p className="text-xs text-muted mt-1">{S.frequencyCreateHint}</p>
 )}
 </div>
 )}
 {validationError && (
 <div role="alert" className="text-xs text-danger font-medium">
 {validationError}
 </div>
 )}
 <div className="flex gap-2 justify-end">
 <button
 type="button"
 onClick={onCancel}
 disabled={saving}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-raised text-body text-xs font-bold rounded-lg hover:bg-surface-raised transition-colors disabled:opacity-60"
 >
 <X size={12} />
 {S.cancel}
 </button>
 <button
 type="button"
 onClick={handleSave}
 disabled={saving}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-on-accent text-xs font-bold rounded-lg hover:bg-accent transition-colors disabled:opacity-60"
 >
 {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
 {saving ? S.saving : S.save}
 </button>
 </div>
 </div>
 );
};

// ─── Frequency segmented control ────────────────────────────

interface FrequencyToggleProps {
 value: JobAlertFrequency | string;
 saving: boolean;
 onChange: (next: JobAlertFrequency) => void;
 S: SectionStrings;
}

const FrequencyToggle: React.FC<FrequencyToggleProps> = ({ value, saving, onChange, S }) => {
 const normalized = (value || '').toLowerCase() === 'daily' ? 'daily' : 'weekly';
 return (
 <div role="group" aria-label={S.frequencyLabel} className="flex flex-wrap w-full shrink-0 border border-edge rounded-lg overflow-hidden bg-surface">
 <button
 type="button"
 onClick={() => normalized !== 'daily' && onChange('daily')}
 disabled={saving}
 aria-pressed={normalized === 'daily'}
 className={`flex-1 min-w-[100px] px-3 py-1 text-xs font-bold transition-colors ${
 normalized === 'daily' ? 'bg-accent text-on-accent' : 'text-body hover:bg-surface-alt'
 } ${saving ? 'opacity-60 cursor-wait' : ''}`}
 >
 {S.frequencyDaily}
 </button>
 <button
 type="button"
 onClick={() => normalized !== 'weekly' && onChange('weekly')}
 disabled={saving}
 aria-pressed={normalized === 'weekly'}
 className={`flex-1 min-w-[100px] px-3 py-1 text-xs font-bold transition-colors ${
 normalized === 'weekly' ? 'bg-accent text-on-accent' : 'text-body hover:bg-surface-alt'
 } ${saving ? 'opacity-60 cursor-wait' : ''}`}
 >
 {S.frequencyWeekly}
 </button>
 </div>
 );
};

// ─── Alert row ──────────────────────────────────────────────

interface AlertRowProps {
 alert: SubscriptionAlertSummary;
 S: SectionStrings;
 deleting: boolean;
 saving: boolean;
 editing: boolean;
 onDelete: () => void;
 onStartEdit: () => void;
 onCancelEdit: () => void;
 onSaveEdit: (values: {
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: JobAlertFrequency;
 }) => void;
 onChangeFrequency: (next: JobAlertFrequency) => void;
 onResetToAuto: () => void;
 onTogglePause: () => void;
}

const AlertRow: React.FC<AlertRowProps> = ({
 alert,
 S,
 deleting,
 saving,
 editing,
 onDelete,
 onStartEdit,
 onCancelEdit,
 onSaveEdit,
 onChangeFrequency,
 onResetToAuto,
 onTogglePause,
}) => {
 const [confirming, setConfirming] = useState(false);

 const filterParts: Array<{ label: string; values: string[] }> = [];
 // CompanyAlert (#5012): a followed employer IS the filter — surfaced first
 // so the row never reads "Nessun filtro impostato" for an alert that is in
 // fact tightly scoped, and so the user can unfollow from here.
 if (alert.specificCompanyKey) {
 filterParts.push({ label: S.companyLabel, values: [alert.specificCompanyKey] });
 }
 if (alert.keywords.length) filterParts.push({ label: S.keywordsLabel, values: alert.keywords });
 if (alert.locations.length)
 filterParts.push({ label: S.locationsLabel, values: alert.locations });
 if (alert.sectors.length) filterParts.push({ label: S.sectorsLabel, values: alert.sectors });

 return (
 <div className="border border-edge rounded-xl p-4 bg-surface-alt">
 {editing ? (
 <AlertEditor
 S={S}
 initial={{
 keywords: alert.keywords,
 locations: alert.locations,
 sectors: alert.sectors,
 frequency: alert.frequency,
 }}
 saving={saving}
 showFrequency
 onSave={onSaveEdit}
 onCancel={onCancelEdit}
 />
 ) : (
 <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
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
 <div className="mt-1 space-y-1.5">
 <div className="flex flex-wrap items-center gap-2">
 <FrequencyToggle
 value={alert.frequency}
 saving={saving}
 onChange={onChangeFrequency}
 S={S}
 />
 {alert.paused && (
 <span className="px-2 py-0.5 bg-surface-raised text-muted text-xs font-bold rounded-md">
 {S.alertPaused}
 </span>
 )}
 </div>
 <div className="flex flex-wrap items-center gap-2">
 {alert.frequencyOverride ? (
 <>
 <span className="text-[10px] sm:text-xs px-1.5 py-0.5 rounded-full bg-surface-raised text-muted border border-edge">
 {S.frequencyPinned}
 </span>
 <button
 type="button"
 onClick={onResetToAuto}
 disabled={saving}
 className="text-xs text-accent underline underline-offset-2 hover:no-underline disabled:opacity-60"
 >
 {S.frequencyResetToAuto}
 </button>
 </>
 ) : (
 <>
 <span className="text-[10px] sm:text-xs px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent border border-accent-border">
 {S.frequencyAuto}
 </span>
 <span className="text-xs text-muted">{S.frequencyAutoHint}</span>
 </>
 )}
 </div>
 </div>
 </div>
 <div className="flex flex-col items-stretch sm:items-end justify-end gap-2 shrink-0">
 <button
 type="button"
 onClick={onTogglePause}
 disabled={saving || deleting}
 aria-label={alert.paused ? S.alertResume : S.alertPause}
 className="flex items-center justify-center gap-1.5 w-full sm:w-auto h-11 sm:h-auto px-3 py-1.5 bg-surface-raised text-body text-xs font-bold rounded-lg hover:bg-surface-raised transition-colors disabled:opacity-60 whitespace-nowrap"
 >
 {alert.paused ? <Play size={14} /> : <Pause size={14} />}
 {alert.paused ? S.alertResume : S.alertPause}
 </button>
 <button
 type="button"
 onClick={onStartEdit}
 disabled={saving || deleting}
 aria-label={S.edit}
 className="flex items-center justify-center gap-1.5 w-full sm:w-auto h-11 sm:h-auto px-3 py-1.5 bg-surface-raised text-body text-xs font-bold rounded-lg hover:bg-surface-raised transition-colors disabled:opacity-60 whitespace-nowrap"
 >
 <Pencil size={14} />
 {S.edit}
 </button>
 {!confirming ? (
 <button
 type="button"
 onClick={() => setConfirming(true)}
 disabled={deleting}
 aria-label={S.alertDelete}
 className="flex items-center justify-center gap-1.5 w-full sm:w-auto h-11 sm:h-auto px-3 py-1.5 bg-danger-subtle text-danger text-xs font-bold rounded-lg hover:bg-danger-subtle transition-colors disabled:opacity-60 whitespace-nowrap"
 >
 {deleting ? (
 <Loader2 size={14} className="animate-spin" />
 ) : (
 <Trash2 size={14} />
 )}
 {deleting ? S.alertDeleting : S.alertDelete}
 </button>
 ) : (
 <div className="flex flex-col items-stretch sm:items-end gap-1.5 w-full sm:w-auto">
 <span className="text-xs text-danger font-medium text-center sm:text-right">{S.alertConfirmDelete}</span>
 <div className="flex gap-1.5">
 <button
 type="button"
 onClick={() => {
 setConfirming(false);
 onDelete();
 }}
 disabled={deleting}
 className="flex-1 sm:flex-none h-11 sm:h-auto px-2 py-1 bg-danger-strong text-on-accent text-xs font-bold rounded-md hover:bg-danger-strong-hover transition-colors disabled:opacity-60 whitespace-nowrap"
 >
 {S.alertDelete}
 </button>
 <button
 type="button"
 onClick={() => setConfirming(false)}
 disabled={deleting}
 className="flex-1 sm:flex-none h-11 sm:h-auto px-2 py-1 bg-surface-raised text-body text-xs font-bold rounded-md hover:bg-surface-raised transition-colors whitespace-nowrap"
 >
 {S.alertCancel}
 </button>
 </div>
 </div>
 )}
 </div>
 </div>
 )}
 </div>
 );
};

// ─── Main controller ────────────────────────────────────────

export function SubscriptionPreferencesController({
 mode,
 email,
 token,
 // Declared in the props interface and passed by UserProfile.tsx since the
 // component was written, but never destructured until #5684 — auth mode keyed
 // everything off `email` alone. The saved-jobs digest is the first control
 // whose document is keyed by uid, so this is where it starts being read.
 userId,
 locale,
 onError,
}: SubscriptionPreferencesControllerProps) {
 const activeLocale: Locale = locale || getLocale();
 const S = useMemo(() => STRINGS[activeLocale] || STRINGS.it, [activeLocale]);

 const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
 const [errorMsg, setErrorMsg] = useState<string>('');
 const [newsletterSubscribed, setNewsletterSubscribed] = useState<boolean>(false);
 const [autologinEnabled, setAutologinEnabledState] = useState<boolean>(true);
 // null = the engagement engine picks the cadence (#5415 §3.7).
 const [briefFrequency, setBriefFrequency] = useState<DailyBriefFrequency | null>(null);
 const [briefTier, setBriefTier] = useState<number | null>(null);
 const [savingBrief, setSavingBrief] = useState(false);
 const [alerts, setAlerts] = useState<SubscriptionAlertSummary[]>([]);

 const [digestEnabled, setDigestEnabled] = useState<boolean>(true);
 /** Auth mode only — token mode has no uid to key `users/{uid}` by. See authLoadSavedJobsDigest. */
 const [digestAvailable, setDigestAvailable] = useState<boolean>(false);
 const [savingDigest, setSavingDigest] = useState(false);
 const [stoppingAll, setStoppingAll] = useState(false);
 const [savingNewsletter, setSavingNewsletter] = useState(false);
 const [savingAutologin, setSavingAutologin] = useState(false);
 const [deletingAlertId, setDeletingAlertId] = useState<string | null>(null);
 const [savedTickKey, setSavedTickKey] = useState<string | null>(null);
 const [editingAlertId, setEditingAlertId] = useState<string | null>(null);
 const [savingAlertId, setSavingAlertId] = useState<string | null>(null);
 const [creatingAlert, setCreatingAlert] = useState<boolean>(false);
 const [savingNewAlert, setSavingNewAlert] = useState<boolean>(false);

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
 setBriefFrequency(result.newsletter?.dailyBriefFrequency ?? null);
 setBriefTier(result.newsletter?.dailyBriefTier ?? null);
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
 setBriefFrequency(result.newsletter.dailyBriefFrequency ?? null);
 setBriefTier(result.newsletter.dailyBriefTier ?? null);
 setAlerts(result.alerts);
 // The digest read is best-effort and deliberately non-fatal: it lives in a
 // different collection under different rules, and a failure there must not
 // cost the reader the newsletter and job-alert controls that did load.
 if (userId) {
 try {
 const enabled = await authLoadSavedJobsDigest(userId);
 if (!cancelled) {
 setDigestEnabled(enabled);
 setDigestAvailable(true);
 }
 } catch (digestErr: any) {
 console.warn('[SubscriptionPreferencesController] Saved-jobs digest read failed:', digestErr?.message);
 }
 }
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
 }, [mode, email, token, userId]);

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

 const handleSetBriefFrequency = async (next: DailyBriefFrequency | null) => {
 const previous = briefFrequency;
 setBriefFrequency(next);
 setSavingBrief(true);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await setDailyBriefFrequency(email, token, next);
 if (!result.success) throw new Error(result.error || 'write_failed');
 setBriefFrequency(result.dailyBriefFrequency ?? null);
 } else {
 await authSetBriefFrequency(email, next);
 setBriefFrequency(next);
 }
 flashSaved('daily-brief');
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Set brief frequency failed:', err?.message);
 setBriefFrequency(previous);
 reportError(S.saveError);
 } finally {
 setSavingBrief(false);
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

 const handleChangeFrequency = async (alertId: string, next: JobAlertFrequency) => {
 // Optimistic flip + revert on error. A manual frequency pick always pins
 // the alert (frequencyOverride: true) — see handleResetToAuto below for
 // the reverse.
 const previous = alerts.find((a) => a.id === alertId);
 if (!previous) return;
 if ((previous.frequency || '').toLowerCase() === next) return;
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequency: next, frequencyOverride: true } : a)),
 );
 setSavingAlertId(alertId);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await updateJobAlert(email, token, alertId, {
 frequency: next,
 frequencyOverride: true,
 });
 if (!result.success) throw new Error(result.error || 'write_failed');
 if (result.alert) {
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...result.alert! } : a)));
 }
 } else {
 const fresh = await authUpdateAlert(email, alertId, { frequency: next, frequencyOverride: true });
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...fresh } : a)));
 }
 flashSaved(`alert:${alertId}`);
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Change frequency failed:', err?.message);
 setAlerts((prev) =>
 prev.map((a) =>
 a.id === alertId
 ? { ...a, frequency: previous.frequency, frequencyOverride: previous.frequencyOverride }
 : a,
 ),
 );
 reportError(S.saveError);
 } finally {
 setSavingAlertId(null);
 }
 };

 const handleResetToAuto = async (alertId: string) => {
 // Un-pin: hand the alert back to the engagement-tier engine.
 const previous = alerts.find((a) => a.id === alertId);
 if (!previous) return;
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequencyOverride: false } : a)),
 );
 setSavingAlertId(alertId);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await updateJobAlert(email, token, alertId, { frequencyOverride: false });
 if (!result.success) throw new Error(result.error || 'write_failed');
 if (result.alert) {
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...result.alert! } : a)));
 }
 } else {
 const fresh = await authUpdateAlert(email, alertId, { frequencyOverride: false });
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...fresh } : a)));
 }
 flashSaved(`alert:${alertId}`);
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Reset to auto failed:', err?.message);
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequencyOverride: previous.frequencyOverride } : a)),
 );
 reportError(S.saveError);
 } finally {
 setSavingAlertId(null);
 }
 };

 const handleToggleDigest = async () => {
 if (!digestAvailable || !userId) return;
 const next = !digestEnabled;
 setDigestEnabled(next);
 setSavingDigest(true);
 setErrorMsg('');
 try {
 await authSetSavedJobsDigest(userId, next);
 flashSaved('saved-jobs-digest');
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Toggle saved-jobs digest failed:', err?.message);
 setDigestEnabled(!next);
 reportError(S.saveError);
 } finally {
 setSavingDigest(false);
 }
 };

 /**
  * "Stop all emails" (#5684 point 2).
  *
  * Every other control here is channel-scoped on purpose, and the reader is now
  * told so. That statement is only honest if the all-off case is also reachable
  * — otherwise "off" means one thing in the copy and another in the reader's
  * inbox, which is how someone ends up at the provider's abuse desk convinced
  * they were ignored. Composed strictly from the primitives already used by the
  * individual controls: no new endpoint, no new field, nothing this component
  * could not already write.
  *
  * Job alerts are PAUSED, not deleted: pausing stops every send
  * (scripts/send-job-alerts.mjs and, as of this change, send-company-alerts.mjs
  * both skip `paused`) and is reversible, whereas the delete primitive here is a
  * hard delete. Silence must not cost the reader their saved searches.
  *
  * Best-effort per channel, and deliberately so — a failure on one must not
  * abandon the rest half-done. Anything that did not take is reported and stays
  * visibly on in the UI.
  */
 const handleStopAll = async () => {
 setStoppingAll(true);
 setErrorMsg('');
 const failed: string[] = [];

 if (newsletterSubscribed) {
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await toggleNewsletterSubscription(email, token, false);
 if (!result.success) throw new Error(result.error || 'write_failed');
 } else {
 await authToggleNewsletter(email, false);
 }
 setNewsletterSubscribed(false);
 } catch (err: any) {
 failed.push('newsletter');
 console.warn('[SubscriptionPreferencesController] Stop-all newsletter failed:', err?.message);
 }
 }

 if (briefFrequency !== 'off') {
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await setDailyBriefFrequency(email, token, 'off');
 if (!result.success) throw new Error(result.error || 'write_failed');
 } else {
 await authSetBriefFrequency(email, 'off');
 }
 setBriefFrequency('off');
 } catch (err: any) {
 failed.push('daily-brief');
 console.warn('[SubscriptionPreferencesController] Stop-all daily brief failed:', err?.message);
 }
 }

 for (const alert of alerts) {
 if (alert.paused) continue;
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await updateJobAlert(email, token, alert.id, { paused: true });
 if (!result.success) throw new Error(result.error || 'write_failed');
 } else {
 await authUpdateAlert(email, alert.id, { paused: true });
 }
 setAlerts((prev) => prev.map((a) => (a.id === alert.id ? { ...a, paused: true } : a)));
 } catch (err: any) {
 failed.push(`alert:${alert.id}`);
 console.warn('[SubscriptionPreferencesController] Stop-all pause failed:', err?.message);
 }
 }

 if (digestAvailable && userId && digestEnabled) {
 try {
 await authSetSavedJobsDigest(userId, false);
 setDigestEnabled(false);
 } catch (err: any) {
 failed.push('saved-jobs-digest');
 console.warn('[SubscriptionPreferencesController] Stop-all digest failed:', err?.message);
 }
 }

 if (failed.length > 0) reportError(S.saveError);
 else flashSaved('stop-all');
 setStoppingAll(false);
 };

 const handleTogglePause = async (alertId: string, nextPaused: boolean) => {
 // Issue #4298 follow-up fix: pause/resume flips the dedicated `paused`
 // field, never `active` (that stays SOLELY the soft-delete flag). Same
 // optimistic-update + revert-on-error shape as handleChangeFrequency.
 const previous = alerts.find((a) => a.id === alertId);
 if (!previous) return;
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, paused: nextPaused } : a)));
 setSavingAlertId(alertId);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await updateJobAlert(email, token, alertId, { paused: nextPaused });
 if (!result.success) throw new Error(result.error || 'write_failed');
 if (result.alert) {
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...result.alert! } : a)));
 }
 } else {
 const fresh = await authUpdateAlert(email, alertId, { paused: nextPaused });
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...fresh } : a)));
 }
 flashSaved(`alert:${alertId}`);
 // Lazy import mirrors JobAlertForm.tsx's Analytics.trackJobAlertDeleted() call —
 // keeps analytics out of this route's eager bundle.
 import('@/services/analytics')
 .then(({ Analytics }) => Analytics.trackJobAlertPauseToggled(nextPaused))
 .catch(() => {});
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Toggle pause failed:', err?.message);
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, paused: previous.paused } : a)));
 reportError(S.saveError);
 } finally {
 setSavingAlertId(null);
 }
 };

 const handleSaveEdit = async (
 alertId: string,
 values: { keywords: string[]; locations: string[]; sectors: string[]; frequency: JobAlertFrequency },
 ) => {
 setSavingAlertId(alertId);
 setErrorMsg('');
 // Editing always shows the frequency picker (showFrequency), so a save
 // here is an explicit frequency affirmation — pin it.
 const patch = { ...values, frequencyOverride: true };
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await updateJobAlert(email, token, alertId, patch);
 if (!result.success) throw new Error(result.error || 'write_failed');
 const updated = result.alert;
 setAlerts((prev) =>
 prev.map((a) =>
 a.id === alertId
 ? {
 ...a,
 keywords: values.keywords,
 locations: values.locations,
 sectors: values.sectors,
 frequency: values.frequency,
 frequencyOverride: true,
 ...(updated ? updated : {}),
 }
 : a,
 ),
 );
 } else {
 const fresh = await authUpdateAlert(email, alertId, patch);
 setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...fresh } : a)));
 }
 flashSaved(`alert:${alertId}`);
 setEditingAlertId(null);
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Save edit failed:', err?.message);
 reportError(S.saveError);
 } finally {
 setSavingAlertId(null);
 }
 };

 const handleCreateAlert = async (values: {
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: JobAlertFrequency;
 }) => {
 setSavingNewAlert(true);
 setErrorMsg('');
 try {
 if (mode === 'token') {
 if (!token) throw new Error('missing_token');
 const result = await createJobAlert(email, token, values);
 if (!result.success || !result.alert) throw new Error(result.error || 'create_failed');
 const created = result.alert;
 setAlerts((prev) => [
 {
 id: created.id,
 keywords: created.keywords,
 locations: created.locations,
 sectors: created.sectors,
 frequency: typeof created.frequency === 'string' ? created.frequency : 'weekly',
 frequencyOverride: created.frequencyOverride === true,
 active: created.active !== false,
 paused: false,
 createdAt: typeof created.createdAt === 'number' ? created.createdAt : null,
 },
 ...prev,
 ]);
 } else {
 const fresh = await authCreateAlert(email, values);
 setAlerts((prev) => [fresh, ...prev]);
 }
 flashSaved('new_alert');
 setCreatingAlert(false);
 } catch (err: any) {
 console.warn('[SubscriptionPreferencesController] Create alert failed:', err?.message);
 reportError(S.saveError);
 } finally {
 setSavingNewAlert(false);
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
 <div className="space-y-5 pb-20 md:pb-0">
 {/* ── What "off" means, stated once above the cards (#5684 point 2) ── */}
 <section className="border border-edge rounded-xl p-4 bg-surface-subtle">
 <p className="text-sm text-body leading-relaxed">{S.scopeNote}</p>
 <button
 type="button"
 disabled={stoppingAll}
 onClick={handleStopAll}
 className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-danger-border text-sm font-semibold text-danger hover:bg-danger-subtle transition-colors disabled:opacity-60"
 >
 {stoppingAll ? <Loader2 size={14} className="animate-spin" /> : <BellOff size={14} />}
 {stoppingAll ? S.stopAllWorking : S.stopAll}
 </button>
 <p className="mt-2 text-xs text-muted leading-relaxed">{S.stopAllHint}</p>
 {savedTickKey === 'stop-all' && (
 <span className="mt-2 inline-flex items-center gap-1 text-xs text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </section>

 {errorMsg && (
 <div
 role="alert"
 className="bg-danger-subtle border border-danger-border rounded-xl p-3 text-sm text-danger flex gap-2"
 >
 <AlertCircle size={16} className="shrink-0 mt-0.5" />
 <div>{errorMsg}</div>
 </div>
 )}

 {/* ── Job alerts card ── (shown first: this page is reached from the
 "Gestisci alert" link in job-alert emails, so the alerts a user came to
 manage are the first thing they see) */}
 <section className="border border-edge rounded-xl p-5 bg-surface scroll-mt-20">
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
 saving={savingAlertId === alert.id}
 editing={editingAlertId === alert.id}
 onDelete={() => handleDeleteAlert(alert.id)}
 onStartEdit={() => setEditingAlertId(alert.id)}
 onCancelEdit={() => setEditingAlertId(null)}
 onSaveEdit={(values) => handleSaveEdit(alert.id, values)}
 onChangeFrequency={(next) => handleChangeFrequency(alert.id, next)}
 onResetToAuto={() => handleResetToAuto(alert.id)}
 onTogglePause={() => handleTogglePause(alert.id, !alert.paused)}
 />
 ))}
 </div>
 )}

 {/* ── Add new alert ── */}
 <div className="mt-4">
 {creatingAlert ? (
 <div className="border border-edge rounded-xl p-4 bg-surface-alt">
 <AlertEditor
 S={S}
 initial={{ keywords: [], locations: [], sectors: [], frequency: 'weekly' }}
 saving={savingNewAlert}
 showFrequency
 isCreate
 requireAtLeastOneFilter
 onSave={handleCreateAlert}
 onCancel={() => setCreatingAlert(false)}
 />
 </div>
 ) : alerts.length >= 10 ? (
 <div className="text-xs text-muted italic text-center">
 {S.alertLimitReached}
 </div>
 ) : (
 <>
 {alerts.length > 0 && (
 <p className="text-xs text-muted mb-2">{S.addMoreSearchesHint}</p>
 )}
 <button
 type="button"
 onClick={() => setCreatingAlert(true)}
 className="flex items-center gap-1.5 px-3 py-2 bg-accent-subtle text-accent text-sm font-bold rounded-lg hover:bg-accent-subtle transition-colors"
 >
 <Plus size={14} />
 {S.addNewAlert}
 </button>
 </>
 )}
 {savedTickKey === 'new_alert' && (
 <span className="ml-2 inline-flex items-center gap-1 text-success text-xs">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </section>

 {/* ── Newsletter subscription card ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface scroll-mt-20">
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

 {/* ── Daily brief cadence card (#5415 §3.7) ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface scroll-mt-20">
 <div className="flex items-center gap-2 mb-1">
 <Sunrise size={16} className="text-muted" />
 <h2 className="font-semibold text-heading">{S.briefTitle}</h2>
 </div>
 <p className="text-sm text-muted leading-relaxed">{S.briefDesc}</p>

 <div className="mt-4 flex flex-wrap gap-2">
 <button
 type="button"
 disabled={savingBrief}
 onClick={() => handleSetBriefFrequency(null)}
 aria-pressed={briefFrequency === null}
 className={`px-3 py-1.5 rounded-lg border text-sm transition-colors disabled:opacity-60 ${
 briefFrequency === null
 ? 'border-accent bg-accent-subtle text-accent font-semibold'
 : 'border-edge text-body hover:border-accent-border'
 }`}
 >
 {S.briefAuto}
 </button>
 {DAILY_BRIEF_FREQUENCIES.map((option) => (
 <button
 key={option}
 type="button"
 disabled={savingBrief}
 onClick={() => handleSetBriefFrequency(option)}
 aria-pressed={briefFrequency === option}
 className={`px-3 py-1.5 rounded-lg border text-sm transition-colors disabled:opacity-60 ${
 briefFrequency === option
 ? 'border-accent bg-accent-subtle text-accent font-semibold'
 : 'border-edge text-body hover:border-accent-border'
 }`}
 >
 {S.briefOptions[option]}
 </button>
 ))}
 </div>

 <div className="mt-3 text-xs text-muted">
 {S.briefCurrent}{' '}
 <span className="font-semibold text-body">
 {briefFrequency === null
 ? `${S.briefAuto}${briefTier ? ` — ${S.briefOptions[briefTierToOption(briefTier)]}` : ''}`
 : S.briefOptions[briefFrequency]}
 </span>
 {briefFrequency === null && <span className="ml-1">({S.briefAutoHint})</span>}
 {savingBrief && <Loader2 size={14} className="ml-2 inline animate-spin" />}
 {savedTickKey === 'daily-brief' && (
 <span className="ml-2 inline-flex items-center gap-1 text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </section>

 {/* ── Saved-jobs digest card (#5684 point 1) ── */}
 {digestAvailable && (
 <section className="border border-edge rounded-xl p-5 bg-surface scroll-mt-20">
 <div className="flex items-start justify-between gap-4">
 <div className="flex-1">
 <div className="flex items-center gap-2 mb-1">
 <Bookmark size={16} className="text-muted" />
 <h2 className="font-semibold text-heading">{S.digestTitle}</h2>
 </div>
 <p className="text-sm text-muted leading-relaxed">{S.digestDesc}</p>
 </div>
 <Toggle
 enabled={digestEnabled}
 saving={savingDigest}
 onClick={handleToggleDigest}
 ariaLabel={S.digestTitle}
 />
 </div>
 <div className="mt-3 text-xs text-muted">
 {S.currentState}{' '}
 <span className={`font-semibold ${digestEnabled ? 'text-success' : 'text-muted'}`}>
 {digestEnabled ? S.digestOn : S.digestOff}
 </span>
 {savedTickKey === 'saved-jobs-digest' && (
 <span className="ml-2 inline-flex items-center gap-1 text-success">
 <CheckCircle2 size={14} /> {S.saved}
 </span>
 )}
 </div>
 </section>
 )}

 {/* ── Auto-login card ── */}
 <section className="border border-edge rounded-xl p-5 bg-surface scroll-mt-20">
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
