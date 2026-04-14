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

 // Welcome email (social sign-in)
 welcomeSubject: 'Benvenuto su Frontaliere Ticino! 🎉',
 welcomeTitle: 'Benvenuto! 🎉',
 welcomeGreetingName: 'Ciao {name},',
 welcomeGreetingDefault: 'Benvenuto su Frontaliere Ticino,',
 welcomeIntro: 'Grazie per esserti registrato su <strong>Frontaliere Ticino</strong>! Il tuo account è già attivo. Ecco cosa puoi fare subito:',
 welcomeFeature1: '📊 <strong>Simula il tuo stipendio netto</strong> con il calcolatore fiscale',
 welcomeFeature2: '💼 <strong>Cerca offerte di lavoro</strong> in Ticino aggiornate ogni giorno',
 welcomeFeature3: '🏥 <strong>Confronta le casse malati</strong> LAMal per la tua situazione',
 welcomeFeature4: '📰 <strong>Ricevi la newsletter settimanale</strong> con cambio, guide e offerte',
 welcomeCta: 'Inizia a esplorare',
 welcomeNewsletterNote: 'Sei iscritto anche alla newsletter settimanale. Ogni lunedì riceverai il cambio CHF/EUR, guide pratiche e le migliori offerte di lavoro.',

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

 welcomeSubject: 'Welcome to Frontaliere Ticino! 🎉',
 welcomeTitle: 'Welcome! 🎉',
 welcomeGreetingName: 'Hi {name},',
 welcomeGreetingDefault: 'Welcome to Frontaliere Ticino,',
 welcomeIntro: 'Thanks for signing up to <strong>Frontaliere Ticino</strong>! Your account is already active. Here\'s what you can do:',
 welcomeFeature1: '📊 <strong>Simulate your net salary</strong> with the tax calculator',
 welcomeFeature2: '💼 <strong>Search job offers</strong> in Ticino updated daily',
 welcomeFeature3: '🏥 <strong>Compare health insurers</strong> LAMal for your situation',
 welcomeFeature4: '📰 <strong>Get the weekly newsletter</strong> with rates, guides and offers',
 welcomeCta: 'Start exploring',
 welcomeNewsletterNote: 'You\'re also subscribed to the weekly newsletter. Every Monday you\'ll receive the CHF/EUR rate, practical guides and the best job offers.',

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

 welcomeSubject: 'Willkommen bei Frontaliere Ticino! 🎉',
 welcomeTitle: 'Willkommen! 🎉',
 welcomeGreetingName: 'Hallo {name},',
 welcomeGreetingDefault: 'Willkommen bei Frontaliere Ticino,',
 welcomeIntro: 'Danke für Ihre Registrierung bei <strong>Frontaliere Ticino</strong>! Ihr Konto ist bereits aktiv. Folgendes können Sie sofort tun:',
 welcomeFeature1: '📊 <strong>Nettolohn simulieren</strong> mit dem Steuerrechner',
 welcomeFeature2: '💼 <strong>Stellenangebote suchen</strong> im Tessin, täglich aktualisiert',
 welcomeFeature3: '🏥 <strong>Krankenkassen vergleichen</strong> LAMal für Ihre Situation',
 welcomeFeature4: '📰 <strong>Wöchentlichen Newsletter erhalten</strong> mit Kursen, Ratgebern und Angeboten',
 welcomeCta: 'Jetzt entdecken',
 welcomeNewsletterNote: 'Sie haben auch den wöchentlichen Newsletter abonniert. Jeden Montag erhalten Sie den CHF/EUR-Kurs, praktische Ratgeber und die besten Stellenangebote.',

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

 welcomeSubject: 'Bienvenue sur Frontaliere Ticino ! 🎉',
 welcomeTitle: 'Bienvenue ! 🎉',
 welcomeGreetingName: 'Bonjour {name},',
 welcomeGreetingDefault: 'Bienvenue sur Frontaliere Ticino,',
 welcomeIntro: 'Merci de vous être inscrit sur <strong>Frontaliere Ticino</strong> ! Votre compte est déjà actif. Voici ce que vous pouvez faire :',
 welcomeFeature1: '📊 <strong>Simulez votre salaire net</strong> avec le calculateur fiscal',
 welcomeFeature2: '💼 <strong>Recherchez des offres d\'emploi</strong> au Tessin, mises à jour quotidiennement',
 welcomeFeature3: '🏥 <strong>Comparez les caisses maladie</strong> LAMal pour votre situation',
 welcomeFeature4: '📰 <strong>Recevez la newsletter hebdomadaire</strong> avec taux, guides et offres',
 welcomeCta: 'Commencer à explorer',
 welcomeNewsletterNote: 'Vous êtes également abonné à la newsletter hebdomadaire. Chaque lundi vous recevrez le taux CHF/EUR, des guides pratiques et les meilleures offres d\'emploi.',

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
