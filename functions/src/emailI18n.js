/**
 * emailI18n.js — Shared translations for all newsletter/transactional emails.
 *
 * Supports 4 locales: it, en, de, fr.
 * Falls back to Italian for unknown locales.
 */

const TRANSLATIONS = {
 it: {
 // Confirmation email
 confirmSubject: 'Conferma la tua iscrizione alla newsletter – Frontaliere Ticino',
 confirmTitle: 'Conferma la tua iscrizione ✉️',
 confirmIntro: 'Grazie per esserti iscritto alla newsletter di <strong>Frontaliere Ticino</strong>! Per attivare la tua iscrizione e ricevere aggiornamenti settimanali su tasso di cambio, offerte di lavoro, novità fiscali e guide pratiche, conferma cliccando il pulsante qui sotto.',
 confirmButton: 'Conferma iscrizione',
 confirmAltLink: 'Oppure copia e incolla questo link nel browser:',
 confirmWeeklyTitle: '<strong>Cosa riceverai ogni settimana:</strong>',
 confirmWeeklyExchange: '📊 Tasso di cambio CHF-EUR aggiornato',
 confirmWeeklyJobs: '💼 Nuove offerte di lavoro in Ticino',
 confirmWeeklyTax: '📋 Aggiornamenti fiscali e normativi',
 confirmWeeklyGuides: '📖 Guide pratiche per frontalieri',
 confirmNotYou: '<strong>Non ti sei iscritto?</strong> Ignora questa email in tutta sicurezza. Il link è valido per 7 giorni.',

 // Solleciti (#5692) — la CORNICE, non un testo nuovo. Chi non ha confermato
 // non ha acconsentito: sopra e sotto queste righe c'è la stessa identica email
 // di conferma, con lo stesso identico link. Niente offerte, niente urgenza.
 confirmReminderSubject: 'Promemoria: conferma la tua iscrizione alla newsletter – Frontaliere Ticino',
 confirmReminderLastSubject: 'Ultimo promemoria: conferma la tua iscrizione alla newsletter – Frontaliere Ticino',
 confirmReminderLead: 'Ti avevamo scritto {when} per chiederti di confermare l\'iscrizione alla newsletter, e non abbiamo ricevuto risposta. Il link qui sotto è ancora valido, se vuoi confermare adesso.',
 confirmReminderWhenDated: 'il {date}',
 confirmReminderWhenUndated: 'qualche giorno fa',
 confirmReminderLastNotice: '<strong>Questo è l\'ultimo promemoria.</strong> Se non confermi non riceverai altro da noi, e non devi fare nulla perché sia così.',

 // Welcome email (social sign-in): moved to functions/src/lib/welcomeEmailTemplate.js (buildWelcomeEmail) — segment-aware, no longer key-based i18n.

 // Verification email (password sign-up)
 verifySubject: 'Conferma la tua email – Frontaliere Ticino',
 verifyTitle: 'Conferma la tua email ✉️',
 verifyIntro: 'Grazie per esserti iscritto a <strong>Frontaliere Ticino</strong>! Per completare la registrazione e accedere a tutti gli strumenti (simulatore fiscale, comparatori, permessi e tanto altro), conferma il tuo indirizzo email cliccando sul pulsante qui sotto.',
 verifyButton: 'Conferma email',
 verifyAltLink: 'Oppure copia e incolla questo link nel browser:',
 verifyNotYou: '<strong>Non hai creato un account?</strong> Ignora questa email in tutta sicurezza. Il link scade entro 24 ore.',

 // Manage subscription page
 manageUnsubscribeTitle: 'Disiscrizione completata',
 manageUnsubscribeBody: 'Sei stato disiscritto dalla newsletter di Frontaliere Ticino.',
 manageUnsubscribeNote: 'Se hai cambiato idea, puoi',
 manageResubscribeLink: 'reiscriverti qui',
 manageResubscribeTitle: 'Iscrizione riattivata!',
 manageResubscribeBody: 'La tua iscrizione alla newsletter è stata riattivata.',
 manageResubscribeNote: 'Riceverai la prossima newsletter lunedì.',
 // #5711 — la riattivazione richiede un POST: queste due pagine sono quelle
 // che un GET e una richiesta rifiutata ricevono al posto della riattivazione.
 manageResubscribeConfirmTitle: 'Conferma la riattivazione',
 manageResubscribeConfirmBody: 'per riattivare l\'iscrizione alla newsletter premi il pulsante qui sotto. Nessuna modifica è stata ancora applicata.',
 manageResubscribeRefusedTitle: 'Riattivazione non applicata',
 manageResubscribeRefusedBody: 'la richiesta è arrivata pochi istanti dopo la disiscrizione, quindi non è stata applicata: la tua disiscrizione resta valida. Se sei stato tu, premi di nuovo il pulsante qui sotto.',
 manageErrorTitle: 'Errore',
 manageErrorInvalidToken: 'Link non valido o scaduto.',
 manageErrorInvalidAction: 'Azione non valida.',
 manageErrorMissingParams: 'Parametri mancanti.',
 manageAlreadyUnsubscribed: 'Eri già disiscritto.',
 manageBackToSite: 'Torna al sito',

 // Shared
 brandName: 'Frontaliere Ticino',
 brandTagline: 'Il portale dei frontalieri',
 copyright: '© {year} Frontaliere Ticino',
 },

 en: {
 confirmSubject: 'Confirm your newsletter subscription – Frontaliere Ticino',
 confirmTitle: 'Confirm your subscription ✉️',
 confirmIntro: 'Thank you for subscribing to the <strong>Frontaliere Ticino</strong> newsletter! To activate your subscription and receive weekly updates on exchange rates, job offers, tax news and practical guides, please click the button below.',
 confirmButton: 'Confirm subscription',
 confirmAltLink: 'Or copy and paste this link into your browser:',
 confirmWeeklyTitle: '<strong>What you\'ll receive every week:</strong>',
 confirmWeeklyExchange: '📊 Updated CHF-EUR exchange rate',
 confirmWeeklyJobs: '💼 New job offers in Ticino',
 confirmWeeklyTax: '📋 Tax and regulatory updates',
 confirmWeeklyGuides: '📖 Practical guides for cross-border workers',
 confirmNotYou: '<strong>Didn\'t subscribe?</strong> You can safely ignore this email. The link is valid for 7 days.',

 confirmReminderSubject: 'Reminder: confirm your newsletter subscription – Frontaliere Ticino',
 confirmReminderLastSubject: 'Last reminder: confirm your newsletter subscription – Frontaliere Ticino',
 confirmReminderLead: 'We wrote to you {when} to ask you to confirm your newsletter subscription, and we have not heard back. The link below is still valid, if you would like to confirm now.',
 confirmReminderWhenDated: 'on {date}',
 confirmReminderWhenUndated: 'a few days ago',
 confirmReminderLastNotice: '<strong>This is the last reminder.</strong> If you do not confirm you will not hear from us again, and you do not have to do anything for that to be the case.',

 // Welcome email (social sign-in): moved to functions/src/lib/welcomeEmailTemplate.js (buildWelcomeEmail) — segment-aware, no longer key-based i18n.

 verifySubject: 'Verify your email – Frontaliere Ticino',
 verifyTitle: 'Verify your email ✉️',
 verifyIntro: 'Thanks for signing up to <strong>Frontaliere Ticino</strong>! To complete your registration and access all tools (tax simulator, comparators, permits and more), please verify your email by clicking the button below.',
 verifyButton: 'Verify email',
 verifyAltLink: 'Or copy and paste this link into your browser:',
 verifyNotYou: '<strong>Didn\'t create an account?</strong> You can safely ignore this email. The link expires in 24 hours.',

 manageUnsubscribeTitle: 'Unsubscribed successfully',
 manageUnsubscribeBody: 'You have been unsubscribed from the Frontaliere Ticino newsletter.',
 manageUnsubscribeNote: 'Changed your mind? You can',
 manageResubscribeLink: 'resubscribe here',
 manageResubscribeTitle: 'Resubscribed!',
 manageResubscribeBody: 'Your newsletter subscription has been reactivated.',
 manageResubscribeNote: 'You\'ll receive the next newsletter on Monday.',
 manageResubscribeConfirmTitle: 'Confirm your reactivation',
 manageResubscribeConfirmBody: 'to resume your newsletter subscription, press the button below. Nothing has been changed yet.',
 manageResubscribeRefusedTitle: 'Reactivation not applied',
 manageResubscribeRefusedBody: 'the request arrived moments after the unsubscribe, so it was not applied: your unsubscribe still stands. If it really was you, press the button below again.',
 manageErrorTitle: 'Error',
 manageErrorInvalidToken: 'Invalid or expired link.',
 manageErrorInvalidAction: 'Invalid action.',
 manageErrorMissingParams: 'Missing parameters.',
 manageAlreadyUnsubscribed: 'You were already unsubscribed.',
 manageBackToSite: 'Back to site',

 brandName: 'Frontaliere Ticino',
 brandTagline: 'The cross-border workers portal',
 copyright: '© {year} Frontaliere Ticino',
 },

 de: {
 confirmSubject: 'Newsletter-Anmeldung bestätigen – Frontaliere Ticino',
 confirmTitle: 'Anmeldung bestätigen ✉️',
 confirmIntro: 'Vielen Dank für Ihre Anmeldung zum <strong>Frontaliere Ticino</strong>-Newsletter! Um Ihr Abonnement zu aktivieren und wöchentliche Updates zu Wechselkursen, Stellenangeboten, Steuernews und praktischen Ratgebern zu erhalten, klicken Sie bitte auf den Button unten.',
 confirmButton: 'Anmeldung bestätigen',
 confirmAltLink: 'Oder kopieren Sie diesen Link in Ihren Browser:',
 confirmWeeklyTitle: '<strong>Was Sie jede Woche erhalten:</strong>',
 confirmWeeklyExchange: '📊 Aktueller CHF-EUR-Wechselkurs',
 confirmWeeklyJobs: '💼 Neue Stellenangebote im Tessin',
 confirmWeeklyTax: '📋 Steuer- und Rechts-Updates',
 confirmWeeklyGuides: '📖 Praktische Ratgeber für Grenzgänger',
 confirmNotYou: '<strong>Nicht angemeldet?</strong> Sie können diese E-Mail ignorieren. Der Link ist 7 Tage gültig.',

 confirmReminderSubject: 'Erinnerung: Newsletter-Anmeldung bestätigen – Frontaliere Ticino',
 confirmReminderLastSubject: 'Letzte Erinnerung: Newsletter-Anmeldung bestätigen – Frontaliere Ticino',
 confirmReminderLead: 'Wir haben Ihnen {when} geschrieben und Sie gebeten, Ihre Newsletter-Anmeldung zu bestätigen; eine Antwort haben wir nicht erhalten. Der Link unten ist weiterhin gültig, falls Sie jetzt bestätigen möchten.',
 confirmReminderWhenDated: 'am {date}',
 confirmReminderWhenUndated: 'vor einigen Tagen',
 confirmReminderLastNotice: '<strong>Dies ist die letzte Erinnerung.</strong> Wenn Sie nicht bestätigen, hören Sie nichts mehr von uns — und dafür müssen Sie nichts tun.',

 // Welcome email (social sign-in): moved to functions/src/lib/welcomeEmailTemplate.js (buildWelcomeEmail) — segment-aware, no longer key-based i18n.

 verifySubject: 'E-Mail bestätigen – Frontaliere Ticino',
 verifyTitle: 'E-Mail bestätigen ✉️',
 verifyIntro: 'Danke für Ihre Anmeldung bei <strong>Frontaliere Ticino</strong>! Um die Registrierung abzuschliessen und alle Tools nutzen zu können, bestätigen Sie bitte Ihre E-Mail-Adresse.',
 verifyButton: 'E-Mail bestätigen',
 verifyAltLink: 'Oder kopieren Sie diesen Link in Ihren Browser:',
 verifyNotYou: '<strong>Kein Konto erstellt?</strong> Sie können diese E-Mail ignorieren. Der Link läuft in 24 Stunden ab.',

 manageUnsubscribeTitle: 'Abmeldung erfolgreich',
 manageUnsubscribeBody: 'Sie wurden vom Frontaliere Ticino Newsletter abgemeldet.',
 manageUnsubscribeNote: 'Meinung geändert? Sie können sich',
 manageResubscribeLink: 'hier erneut anmelden',
 manageResubscribeTitle: 'Wieder angemeldet!',
 manageResubscribeBody: 'Ihr Newsletter-Abonnement wurde reaktiviert.',
 manageResubscribeNote: 'Sie erhalten den nächsten Newsletter am Montag.',
 manageResubscribeConfirmTitle: 'Reaktivierung bestätigen',
 manageResubscribeConfirmBody: 'um Ihr Newsletter-Abonnement wieder zu aktivieren, klicken Sie auf die Schaltfläche unten. Es wurde noch nichts geändert.',
 manageResubscribeRefusedTitle: 'Reaktivierung nicht ausgeführt',
 manageResubscribeRefusedBody: 'die Anfrage kam nur Augenblicke nach der Abmeldung und wurde deshalb nicht ausgeführt: Ihre Abmeldung bleibt bestehen. Falls Sie es wirklich waren, klicken Sie die Schaltfläche unten erneut an.',
 manageErrorTitle: 'Fehler',
 manageErrorInvalidToken: 'Ungültiger oder abgelaufener Link.',
 manageErrorInvalidAction: 'Ungültige Aktion.',
 manageErrorMissingParams: 'Fehlende Parameter.',
 manageAlreadyUnsubscribed: 'Sie waren bereits abgemeldet.',
 manageBackToSite: 'Zurück zur Seite',

 brandName: 'Frontaliere Ticino',
 brandTagline: 'Das Grenzgängerportal',
 copyright: '© {year} Frontaliere Ticino',
 },

 fr: {
 confirmSubject: 'Confirmez votre inscription à la newsletter – Frontaliere Ticino',
 confirmTitle: 'Confirmez votre inscription ✉️',
 confirmIntro: 'Merci de vous être inscrit à la newsletter de <strong>Frontaliere Ticino</strong> ! Pour activer votre abonnement et recevoir des mises à jour hebdomadaires sur les taux de change, les offres d\'emploi, les actualités fiscales et des guides pratiques, cliquez sur le bouton ci-dessous.',
 confirmButton: 'Confirmer l\'inscription',
 confirmAltLink: 'Ou copiez et collez ce lien dans votre navigateur :',
 confirmWeeklyTitle: '<strong>Ce que vous recevrez chaque semaine :</strong>',
 confirmWeeklyExchange: '📊 Taux de change CHF-EUR à jour',
 confirmWeeklyJobs: '💼 Nouvelles offres d\'emploi au Tessin',
 confirmWeeklyTax: '📋 Mises à jour fiscales et réglementaires',
 confirmWeeklyGuides: '📖 Guides pratiques pour frontaliers',
 confirmNotYou: '<strong>Vous ne vous êtes pas inscrit ?</strong> Vous pouvez ignorer cet e-mail en toute sécurité. Le lien est valable 7 jours.',

 confirmReminderSubject: 'Rappel : confirmez votre inscription à la newsletter – Frontaliere Ticino',
 confirmReminderLastSubject: 'Dernier rappel : confirmez votre inscription à la newsletter – Frontaliere Ticino',
 confirmReminderLead: 'Nous vous avons écrit {when} pour vous demander de confirmer votre inscription à la newsletter, et nous n\'avons pas eu de réponse. Le lien ci-dessous est toujours valable, si vous souhaitez confirmer maintenant.',
 confirmReminderWhenDated: 'le {date}',
 confirmReminderWhenUndated: 'il y a quelques jours',
 confirmReminderLastNotice: '<strong>Ceci est le dernier rappel.</strong> Si vous ne confirmez pas, vous n\'aurez plus de nouvelles de notre part, et vous n\'avez rien à faire pour cela.',

 // Welcome email (social sign-in): moved to functions/src/lib/welcomeEmailTemplate.js (buildWelcomeEmail) — segment-aware, no longer key-based i18n.

 verifySubject: 'Vérifiez votre e-mail – Frontaliere Ticino',
 verifyTitle: 'Vérifiez votre e-mail ✉️',
 verifyIntro: 'Merci de vous être inscrit sur <strong>Frontaliere Ticino</strong> ! Pour compléter votre inscription et accéder à tous les outils, veuillez vérifier votre adresse e-mail en cliquant ci-dessous.',
 verifyButton: 'Vérifier l\'e-mail',
 verifyAltLink: 'Ou copiez et collez ce lien dans votre navigateur :',
 verifyNotYou: '<strong>Vous n\'avez pas créé de compte ?</strong> Vous pouvez ignorer cet e-mail. Le lien expire dans 24 heures.',

 manageUnsubscribeTitle: 'Désinscription réussie',
 manageUnsubscribeBody: 'Vous avez été désinscrit de la newsletter Frontaliere Ticino.',
 manageUnsubscribeNote: 'Changé d\'avis ? Vous pouvez vous',
 manageResubscribeLink: 'réinscrire ici',
 manageResubscribeTitle: 'Réinscrit !',
 manageResubscribeBody: 'Votre abonnement à la newsletter a été réactivé.',
 manageResubscribeNote: 'Vous recevrez la prochaine newsletter lundi.',
 manageResubscribeConfirmTitle: 'Confirmez la réactivation',
 manageResubscribeConfirmBody: 'pour réactiver votre abonnement à la newsletter, appuyez sur le bouton ci-dessous. Rien n\'a encore été modifié.',
 manageResubscribeRefusedTitle: 'Réactivation non appliquée',
 manageResubscribeRefusedBody: 'la demande est arrivée quelques instants après la désinscription : elle n\'a donc pas été appliquée et votre désinscription reste valable. Si c\'était bien vous, appuyez à nouveau sur le bouton ci-dessous.',
 manageErrorTitle: 'Erreur',
 manageErrorInvalidToken: 'Lien invalide ou expiré.',
 manageErrorInvalidAction: 'Action invalide.',
 manageErrorMissingParams: 'Paramètres manquants.',
 manageAlreadyUnsubscribed: 'Vous étiez déjà désinscrit.',
 manageBackToSite: 'Retour au site',

 brandName: 'Frontaliere Ticino',
 brandTagline: 'Le portail des frontaliers',
 copyright: '© {year} Frontaliere Ticino',
 },
};

/**
 * Normalize locale to one of the 4 supported: it, en, de, fr.
 * Handles formats like 'it-IT', 'en-US', 'de-CH', 'fr-FR', etc.
 */
export function normalizeLocale(raw) {
 if (!raw) return 'it';
 const lang = String(raw).toLowerCase().split(/[-_]/)[0];
 if (lang === 'en' || lang === 'de' || lang === 'fr') return lang;
 return 'it';
}

/**
 * Get a translation string for the given locale and key.
 * Supports {variable} interpolation.
 */
export function t(locale, key, vars = {}) {
 const lang = normalizeLocale(locale);
 const value = TRANSLATIONS[lang]?.[key] || TRANSLATIONS.it[key] || key;
 return Object.entries(vars).reduce(
 (str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? '')),
 value,
 );
}

/**
 * Get the HTML lang attribute value for a locale.
 */
export function htmlLang(locale) {
 const lang = normalizeLocale(locale);
 return lang;
}
