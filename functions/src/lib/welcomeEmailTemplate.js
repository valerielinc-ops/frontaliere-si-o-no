/**
 * welcomeEmailTemplate.js — SINGLE SOURCE of the post-signup welcome email
 * (sent within seconds of signup, before the weekly newsletter or the
 * onboarding drip ever get a chance to fire). Segment-aware copy: job /
 * salary / utility / publisher / general — see buildWelcomeEmail() below.
 *
 * Cloud Functions deploy only the `functions/` directory (firebase.json
 * `source: "functions"`, `firebase deploy --only functions`, no predeploy
 * copy/rsync step) — so this file CANNOT import `services/*.mjs` from the
 * repo root the way the SPA / scripts / vitest suite do. The two pieces of
 * shared logic this module needs therefore live under functions/src/lib/
 * (the canonical home, not services/), with thin re-export shims left at
 * the historical services/ paths so every other importer keeps resolving
 * unchanged:
 *   - locale path data          → functions/src/lib/newsletterUrlPaths.js
 *     LOCALE_PATH_MAP (superset of services/newsletter-template.mjs's map +
 *     the publisher-only routes from services/routeSlugs.data.ts, which the
 *     newsletter template never needed). This file keeps its OWN
 *     `directUrlSlashed`/`localizedUrlSlashed` (trailing-slash behavior, unlike the
 *     newsletter template's bare-path version) and only imports the map.
 *   - the "Consigliato per te" card → functions/src/lib/recommendedBlock.js,
 *     which reads the live enable gate from
 *     functions/src/lib/affiliatePartnersRegistry.js — the same partner
 *     selection/rotation logic used by the weekly newsletter and onboarding
 *     drip, so a partner disabled there disappears from this email too.
 *
 * HTML shell / brand constants are still a deliberate, documented duplicate
 * of services/newsletter/onboardingDrip.mjs (no shared module for those —
 * out of scope for this fix).
 *
 * Segment names are owned by the sibling contract module
 * functions/src/lib/welcomeSegment.js (built in the same batch) — this file
 * only consumes the segment string, it does not import that module.
 */

import { LOCALE_PATH_MAP } from './newsletterUrlPaths.js';
import { renderRecommendedBlock } from './recommendedBlock.js';
import { dataControllerFooterLine } from './dataControllerIdentity.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const WHITE = '#ffffff';
const TEXT_COLOR = '#334155';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';
const CARD_BG = '#f8fafc';

const LOCALES = ['it', 'en', 'de', 'fr'];

function normLocale(raw) {
  if (!raw) return 'it';
  const lang = String(raw).toLowerCase().split(/[-_]/)[0];
  return LOCALES.includes(lang) ? lang : 'it';
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function directUrlSlashed(path) {
  if (/^https?:\/\//i.test(path)) return ensureTrailingSlash(path);
  const full = `${BASE_URL}${path.startsWith('/') ? path : '/' + path}`;
  return ensureTrailingSlash(full);
}

function localizedUrlSlashed(itPath, locale) {
  const lang = normLocale(locale);
  const variants = LOCALE_PATH_MAP[itPath];
  const path = variants ? (variants[lang] || variants.it) : itPath;
  return directUrlSlashed(path);
}

// ── Greeting ───────────────────────────────────────────────────────
const GREETING = {
  it: (name) => (name ? `Ciao ${escapeHtml(name)},` : 'Benvenuto,'),
  en: (name) => (name ? `Hi ${escapeHtml(name)},` : 'Welcome,'),
  de: (name) => (name ? `Hallo ${escapeHtml(name)},` : 'Willkommen,'),
  fr: (name) => (name ? `Bonjour ${escapeHtml(name)},` : 'Bienvenue,'),
};

const WELCOME_LABEL = { it: 'Benvenuto', en: 'Welcome', de: 'Willkommen', fr: 'Bienvenue' };

// ── Sector labels (SECTOR_KEYS contract: health, admin, retail,
// hospitality, logistics, finance, tech, industry, education, construction,
// transport, cleaning, other) ─────────────────────────────────────
const SECTOR_LABELS = {
  it: {
    health: 'sanità', admin: 'amministrazione', retail: 'retail',
    hospitality: 'ristorazione e hotellerie', logistics: 'logistica',
    finance: 'finanza', tech: 'tech', industry: 'industria',
    education: 'istruzione', construction: 'edilizia', transport: 'trasporti',
    cleaning: 'pulizie', other: 'il tuo settore',
  },
  en: {
    health: 'healthcare', admin: 'admin', retail: 'retail',
    hospitality: 'hospitality', logistics: 'logistics', finance: 'finance',
    tech: 'tech', industry: 'industry', education: 'education',
    construction: 'construction', transport: 'transport', cleaning: 'cleaning',
    other: 'your field',
  },
  de: {
    health: 'Gesundheitswesen', admin: 'Verwaltung', retail: 'Handel',
    hospitality: 'Gastgewerbe', logistics: 'Logistik', finance: 'Finanzen',
    tech: 'Tech', industry: 'Industrie', education: 'Bildung',
    construction: 'Bauwesen', transport: 'Transport', cleaning: 'Reinigung',
    other: 'deinem Bereich',
  },
  fr: {
    health: 'santé', admin: 'administration', retail: 'commerce',
    hospitality: 'hôtellerie-restauration', logistics: 'logistique',
    finance: 'finance', tech: 'tech', industry: 'industrie',
    education: 'éducation', construction: 'construction', transport: 'transport',
    cleaning: 'nettoyage', other: 'ton secteur',
  },
};

function sectorLabel(locale, sectorKey) {
  if (!sectorKey) return null;
  const lang = normLocale(locale);
  return SECTOR_LABELS[lang]?.[sectorKey] || SECTOR_LABELS.it[sectorKey] || null;
}

// ── Job segment: one sentence template, a composed descriptor — never a
// template with holes, always a full sentence regardless of which of
// company/sectorKey/locationLabel survived. ─────────────────────────
const JOB_DESCRIPTOR_WORDS = {
  it: { job: 'un’offerta', ofCompany: (c) => ` di ${c}`, inSector: (s) => ` nel settore ${s}`, inLocation: (l) => ` a ${l}`, generic: 'le offerte per frontalieri' },
  en: { job: 'a job', ofCompany: (c) => ` at ${c}`, inSector: (s) => ` in the ${s} sector`, inLocation: (l) => ` in ${l}`, generic: 'the cross-border job listings' },
  de: { job: 'eine Stelle', ofCompany: (c) => ` bei ${c}`, inSector: (s) => ` im Bereich ${s}`, inLocation: (l) => ` in ${l}`, generic: 'die Stellenangebote für Grenzgänger' },
  fr: { job: 'une offre', ofCompany: (c) => ` chez ${c}`, inSector: (s) => ` dans le secteur ${s}`, inLocation: (l) => ` à ${l}`, generic: 'les offres pour frontaliers' },
};

function buildJobDescriptor(locale, { company, sectorKey, locationLabel }) {
  const lang = normLocale(locale);
  const w = JOB_DESCRIPTOR_WORDS[lang];
  const sLabel = sectorLabel(lang, sectorKey);
  const safeCompany = company ? escapeHtml(company) : null;
  const safeLocation = locationLabel ? escapeHtml(locationLabel) : null;
  if (!safeCompany && !sLabel && !safeLocation) return w.generic;
  let phrase = w.job;
  if (safeCompany) phrase += w.ofCompany(safeCompany);
  if (sLabel) phrase += w.inSector(sLabel);
  if (safeLocation) phrase += w.inLocation(safeLocation);
  return phrase;
}

const JOB_HOOK_TEMPLATE = {
  it: (d) => `Ti sei iscritto mentre guardavi ${d}. Da ora non devi più controllare a mano: crea un job alert con questi criteri e ti scriviamo appena esce qualcosa di nuovo.`,
  en: (d) => `You signed up while looking at ${d}. From now on you don’t have to keep checking by hand: set up a job alert with these criteria and we’ll email you the moment something new comes up.`,
  de: (d) => `Du hast dich angemeldet, während du dir ${d} angesehen hast. Ab jetzt musst du nicht mehr manuell nachsehen: Richte einen Job-Alert mit diesen Kriterien ein, und wir schreiben dir, sobald etwas Neues erscheint.`,
  fr: (d) => `Tu t’es inscrit en consultant ${d}. Tu n’as plus besoin de vérifier à la main : crée une alerte emploi avec ces critères et on t’écrit dès qu’une nouveauté correspond.`,
};

// Alerts are created automatically at signup by the
// backfillJobAlertOnNewsletterSignup trigger, so for most `job` arrivals the
// alert is ALREADY live when this email lands. Asking them to "create a job
// alert" would request something already done, so the copy switches to
// confirming it and offering to refine it instead.
const JOB_HOOK_ACTIVE_TEMPLATE = {
  it: (d) => `Ti sei iscritto mentre guardavi ${d}. Gli avvisi sono già attivi su questi criteri: da ora ti scriviamo noi appena esce un’offerta che corrisponde, non devi più controllare a mano.`,
  en: (d) => `You signed up while looking at ${d}. Your alerts are already running on those criteria: from now on we email you the moment a matching role appears, so you don’t have to keep checking.`,
  de: (d) => `Du hast dich angemeldet, während du dir ${d} angesehen hast. Deine Job-Alerts laufen bereits mit diesen Kriterien: Ab jetzt schreiben wir dir, sobald eine passende Stelle erscheint — manuelles Nachsehen entfällt.`,
  fr: (d) => `Tu t’es inscrit en consultant ${d}. Tes alertes sont déjà actives sur ces critères : à partir de maintenant on t’écrit dès qu’une offre correspond, plus besoin de vérifier à la main.`,
};

const JOB_SUBJECT_ACTIVE = {
  it: 'Sei dentro: gli avvisi lavoro sono attivi',
  en: 'You’re in: your job alerts are live',
  de: 'Du bist dabei: deine Job-Alerts laufen',
  fr: 'C’est fait : tes alertes emploi sont actives',
};

const JOB_PREHEADER_ACTIVE = {
  it: 'Ti scriviamo noi appena esce un’offerta che corrisponde ai tuoi criteri.',
  en: 'We’ll email you the moment a role matching your criteria shows up.',
  de: 'Wir melden uns, sobald eine Stelle zu deinen Kriterien passt.',
  fr: 'On t’écrit dès qu’une offre correspond à tes critères.',
};

const JOB_HEADING_ACTIVE = {
  it: 'I tuoi avvisi sono già attivi',
  en: 'Your job alerts are already on',
  de: 'Deine Job-Alerts sind schon aktiv',
  fr: 'Tes alertes sont déjà actives',
};

// The alert is already live, so the ask is never to manage/pause/edit it —
// that page only invites the opposite (pause, delete, unsubscribe). The CTA
// stays a pure traffic-back-to-the-site action: browse today's board, the
// same ad-carrying, tool-linking page the inactive variant points to.
const JOB_CTA_ACTIVE = {
  it: 'Vedi le offerte di oggi →',
  en: 'See today’s listings →',
  de: 'Aktuelle Stellen ansehen →',
  fr: 'Voir les offres du jour →',
};

// ── Utility segment tool naming (TOOL_KEYS contract: lamal, wizard,
// leadmagnet, selfcert, calculator, comparator) ─────────────────────
const TOOL_LABELS = {
  it: { lamal: 'il confronto LAMal', wizard: 'il wizard fiscale', leadmagnet: 'la guida scaricabile', selfcert: 'l’autocertificazione', calculator: 'il calcolatore stipendio', comparator: 'il comparatore cambio' },
  en: { lamal: 'the LAMal comparison', wizard: 'the tax wizard', leadmagnet: 'the downloadable guide', selfcert: 'the self-certification tool', calculator: 'the salary calculator', comparator: 'the exchange rate comparator' },
  de: { lamal: 'den KVG-Vergleich', wizard: 'den Steuer-Wizard', leadmagnet: 'den herunterladbaren Ratgeber', selfcert: 'das Selbstzertifizierungs-Tool', calculator: 'den Gehaltsrechner', comparator: 'den Wechselkursvergleich' },
  fr: { lamal: 'la comparaison LAMal', wizard: 'l’assistant fiscal', leadmagnet: 'le guide téléchargeable', selfcert: 'l’outil d’autocertification', calculator: 'le calculateur de salaire', comparator: 'le comparateur de change' },
};

// ── Static per-segment copy ──────────────────────────────────────────
const SUBJECT = {
  job: { it: 'Fatti avvisare, non cercare più a mano', en: 'Get notified, stop searching by hand', de: 'Lass dich benachrichtigen, nicht mehr suchen', fr: 'Sois averti, arrête de chercher à la main' },
  salary: { it: 'Il netto è solo metà della storia', en: 'Net pay is only half the story', de: 'Der Nettolohn ist nur die halbe Geschichte', fr: 'Le net, ce n’est que la moitié de l’histoire' },
  utility: { it: 'Hai trovato uno strumento. Ecco gli altri', en: 'You found one tool. Here are the others', de: 'Du hast ein Tool gefunden. Hier sind die anderen', fr: 'Tu as trouvé un outil. Voici les autres' },
  publisher: { it: 'Il tuo account pubblisher è attivo', en: 'Your publisher account is active', de: 'Dein Publisher-Konto ist aktiv', fr: 'Ton compte publisher est actif' },
  general: { it: 'Iscrizione attiva. Ecco cosa arriva', en: 'Subscription active. Here’s what’s coming', de: 'Anmeldung aktiv. Das kommt auf dich zu', fr: 'Inscription active. Voici ce qui arrive' },
};

const PREHEADER = {
  job: { it: 'Crea un job alert con i tuoi criteri e ricevi un avviso appena esce l’offerta giusta.', en: 'Set up a job alert with your criteria and get pinged the moment the right listing appears.', de: 'Richte einen Job-Alert mit deinen Kriterien ein und wir melden uns, sobald etwas Passendes erscheint.', fr: 'Crée une alerte emploi avec tes critères et reçois un signal dès qu’une offre correspond.' },
  salary: { it: 'Cassa malati, imposta alla fonte e cambio: ecco cosa manca al calcolo rapido.', en: 'Health insurance, withholding tax and FX: here’s what the quick calculation leaves out.', de: 'Krankenkasse, Quellensteuer und Kurs: das fehlt der Schnellrechnung.', fr: 'Caisse maladie, impôt à la source et change : ce qui manque au calcul rapide.' },
  utility: { it: 'Cinque strumenti gratuiti in più, pensati per chi vive tra Italia e Svizzera.', en: 'Five more free tools, built for people living between Italy and Switzerland.', de: 'Fünf weitere kostenlose Tools für alle, die zwischen Italien und der Schweiz leben.', fr: 'Cinq autres outils gratuits, pensés pour ceux qui vivent entre l’Italie et la Suisse.' },
  publisher: { it: 'Ecco come funziona la pubblicazione e cosa vedono i candidati che cercano lavoro.', en: 'Here’s how publishing works and exactly what job seekers see.', de: 'So funktioniert die Veröffentlichung und das sehen Jobsuchende genau.', fr: 'Voici comment fonctionne la publication et ce que voient les candidats.' },
  general: { it: 'Ecco esattamente cosa ricevi e quando: niente sorprese, niente email a caso.', en: 'Here’s exactly what you’ll get and when: no surprises, no random emails.', de: 'Das bekommst du und wann: keine Überraschungen, keine wahllosen E-Mails.', fr: 'Voici exactement ce que tu reçois et quand : pas de surprise, pas de hasard.' },
};

const HEADING = {
  job: { it: 'Fatti avvisare, non cercare più a mano', en: 'Get notified, stop searching by hand', de: 'Lass dich benachrichtigen, nicht mehr manuell suchen', fr: 'Sois averti, arrête de chercher à la main' },
  salary: { it: 'Il netto è solo metà della storia', en: 'Net pay is only half the story', de: 'Der Nettolohn ist nur die halbe Geschichte', fr: 'Le net n’est que la moitié de l’histoire' },
  utility: { it: 'Hai trovato uno strumento. Ecco gli altri.', en: 'You found one tool. Here are the others.', de: 'Du hast ein Tool gefunden. Hier sind die anderen.', fr: 'Tu as trouvé un outil. Voici les autres.' },
  publisher: { it: 'Il tuo account pubblisher è attivo', en: 'Your publisher account is active', de: 'Dein Publisher-Konto ist aktiv', fr: 'Ton compte publisher est actif' },
  general: { it: 'Iscrizione attiva. Ecco cosa arriva.', en: 'Subscription active. Here’s what’s coming.', de: 'Anmeldung aktiv. Das kommt auf dich zu.', fr: 'Inscription active. Voici ce qui arrive.' },
};

const HOOK = {
  salary: { it: 'Hai appena calcolato il lordo. Ma quello che ti resta davvero in tasca dipende anche da cassa malati, imposta alla fonte e tasso di cambio CHF/EUR — tre variabili che il calcolo rapido non mostra tutte insieme. Apri la versione completa e guarda il quadro intero.', en: 'You just ran the gross numbers. What you actually keep also depends on health insurance, withholding tax and the CHF/EUR rate — three variables the quick calculation doesn’t show together. Open the full version for the complete picture.', de: 'Du hast gerade das Brutto berechnet. Was wirklich bleibt, hängt auch von Krankenkasse, Quellensteuer und dem CHF/EUR-Kurs ab — drei Faktoren, die die Schnellrechnung nicht zusammen zeigt. Öffne die vollständige Version für das ganze Bild.', fr: 'Tu viens de calculer le brut. Ce qu’il te reste vraiment dépend aussi de la caisse maladie, de l’impôt à la source et du taux CHF/EUR — trois variables que le calcul rapide ne montre pas ensemble. Ouvre la version complète pour voir le tableau entier.' },
  utilityGeneric: { it: 'Hai usato uno dei nostri strumenti gratuiti. Ce ne sono altri cinque — cassa malati, cambio, stipendio, fisco — pensati per chi vive tra Italia e Svizzera. Vale la pena dare un’occhiata.', en: 'You used one of our free tools. There are five more — health insurance, FX, salary, tax — built for people living between Italy and Switzerland. Worth a look.', de: 'Du hast eines unserer kostenlosen Tools genutzt. Es gibt noch fünf weitere — Krankenkasse, Wechselkurs, Gehalt, Steuern — für alle, die zwischen Italien und der Schweiz leben. Ein Blick lohnt sich.', fr: 'Tu as utilisé l’un de nos outils gratuits. Il y en a cinq autres — caisse maladie, change, salaire, fiscalité — pensés pour ceux qui vivent entre l’Italie et la Suisse. Ça vaut le coup d’y jeter un œil.' },
  utilityWithTool: {
    it: (tool) => `Hai appena usato ${tool}. È uno dei sei strumenti gratuiti che teniamo aggiornati per chi vive tra Italia e Svizzera — cassa malati, cambio, stipendio, fisco. Vale la pena dare un’occhiata agli altri.`,
    en: (tool) => `You just used ${tool}. It’s one of six free tools we keep up to date for people living between Italy and Switzerland — health insurance, FX, salary, tax. Worth a look at the rest.`,
    de: (tool) => `Du hast gerade ${tool} genutzt. Das ist eines von sechs kostenlosen Tools, die wir für Menschen zwischen Italien und der Schweiz aktuell halten — Krankenkasse, Wechselkurs, Gehalt, Steuern. Ein Blick auf die anderen lohnt sich.`,
    fr: (tool) => `Tu viens d’utiliser ${tool}. C’est l’un des six outils gratuits que nous tenons à jour pour ceux qui vivent entre l’Italie et la Suisse — caisse maladie, change, salaire, fiscalité. Ça vaut le coup de regarder les autres.`,
  },
  publisher: { it: 'Hai appena creato un account per pubblicare offerte su Frontaliere Ticino. Le tue offerte arrivano davanti a chi cerca lavoro in Svizzera dall’Italia — un pubblico che nessuna bacheca generalista intercetta allo stesso modo. Ecco come funziona la pubblicazione e cosa vedono i candidati.', en: 'You just created an account to post jobs on Frontaliere Ticino. Your listings reach people looking for work in Switzerland from Italy — an audience no generic job board reaches the same way. Here’s how publishing works and what candidates see.', de: 'Du hast gerade ein Konto erstellt, um Stellen auf Frontaliere Ticino zu veröffentlichen. Deine Anzeigen erreichen Menschen, die von Italien aus einen Job in der Schweiz suchen — ein Publikum, das keine generische Jobbörse auf dieselbe Weise erreicht. So funktioniert die Veröffentlichung, und das sehen Kandidaten.', fr: 'Tu viens de créer un compte pour publier des offres sur Frontaliere Ticino. Tes annonces touchent des personnes qui cherchent un emploi en Suisse depuis l’Italie — un public qu’aucun site généraliste n’atteint de la même façon. Voici comment fonctionne la publication et ce que voient les candidats.' },
  general: { it: 'Ti sei iscritto a Frontaliere Ticino. Non sai ancora cosa aspettarti? Ecco esattamente cosa ricevi e quando — niente sorprese, niente email a caso.', en: 'You subscribed to Frontaliere Ticino. Not sure what to expect? Here’s exactly what you’ll receive and when — no surprises, no random emails.', de: 'Du hast dich bei Frontaliere Ticino angemeldet. Nicht sicher, was dich erwartet? Hier siehst du genau, was du wann bekommst — keine Überraschungen, keine wahllosen E-Mails.', fr: 'Tu t’es inscrit sur Frontaliere Ticino. Tu ne sais pas encore à quoi t’attendre ? Voici exactement ce que tu reçois et quand — pas de surprise, pas d’e-mails au hasard.' },
};

const CTA_LABEL = {
  job: { it: 'Crea il tuo job alert →', en: 'Create your job alert →', de: 'Job-Alert erstellen →', fr: 'Créer ton alerte emploi →' },
  salary: { it: 'Apri il calcolatore completo →', en: 'Open the full calculator →', de: 'Vollständigen Rechner öffnen →', fr: 'Ouvrir le calculateur complet →' },
  utility: { it: 'Scopri tutti gli strumenti →', en: 'Discover all the tools →', de: 'Alle Tools entdecken →', fr: 'Découvrir tous les outils →' },
  publisher: { it: 'Pubblica la tua prima offerta →', en: 'Publish your first listing →', de: 'Veröffentliche deine erste Stelle →', fr: 'Publie ta première offre →' },
  general: { it: 'Scopri gli strumenti →', en: 'Discover the tools →', de: 'Tools entdecken →', fr: 'Découvrir les outils →' },
};

const LINKS = {
  backToJob: { it: 'Torna all’offerta che stavi guardando', en: 'Back to the listing you were viewing', de: 'Zurück zur Stelle, die du dir angesehen hast', fr: 'Retour à l’offre que tu consultais' },
  allJobs: { it: 'Vedi tutte le offerte', en: 'See all listings', de: 'Alle Stellen ansehen', fr: 'Voir toutes les offres' },
  calcNet: { it: 'Calcola il tuo netto', en: 'Calculate your net pay', de: 'Dein Netto berechnen', fr: 'Calcule ton net' },
  compareLamal: { it: 'Confronta la LAMal', en: 'Compare health insurance (LAMal)', de: 'KVG vergleichen', fr: 'Comparer la LAMal' },
  compareFx: { it: 'Confronta il cambio CHF/EUR', en: 'Compare the CHF/EUR rate', de: 'CHF/EUR-Kurs vergleichen', fr: 'Comparer le taux CHF/EUR' },
  searchJobsCh: { it: 'Cerca lavoro in Svizzera', en: 'Search jobs in Switzerland', de: 'Stellen in der Schweiz suchen', fr: 'Chercher un emploi en Suisse' },
  howPublishing: { it: 'Come funziona la pubblicazione', en: 'How publishing works', de: 'So funktioniert die Veröffentlichung', fr: 'Comment fonctionne la publication' },
  publishListing: { it: 'Pubblica un’offerta', en: 'Post a listing', de: 'Stelle veröffentlichen', fr: 'Publier une offre' },
  myListings: { it: 'I miei annunci', en: 'My listings', de: 'Meine Anzeigen', fr: 'Mes annonces' },
};

// ── "Cosa ricevi" expectation box (anti-spam-complaint lever) ────────
const EXPECT = {
  heading: { it: 'Cosa ricevi', en: 'What you’ll get', de: 'Das bekommst du', fr: 'Ce que tu reçois' },
  consumer: {
    it: ['Ogni lunedì: cambio CHF/EUR, nuove offerte di lavoro e una guida pratica.', 'Solo quando conta: alert lavoro, promemoria degli strumenti, aggiornamenti fiscali rilevanti.', 'Mai spam. Puoi disiscriverti in un clic, quando vuoi.'],
    en: ['Every Monday: the CHF/EUR rate, new job listings and a practical guide.', 'Only when it matters: job alerts, tool reminders, relevant tax updates.', 'Never spam. Unsubscribe in one click, whenever you want.'],
    de: ['Jeden Montag: der CHF/EUR-Kurs, neue Stellenangebote und ein praktischer Ratgeber.', 'Nur wenn es zählt: Job-Alerts, Tool-Erinnerungen, relevante Steuer-Updates.', 'Nie Spam. Jederzeit mit einem Klick abmelden.'],
    fr: ['Chaque lundi : le taux CHF/EUR, de nouvelles offres d’emploi et un guide pratique.', 'Seulement quand ça compte : alertes emploi, rappels d’outils, mises à jour fiscales pertinentes.', 'Jamais de spam. Désinscription en un clic, quand tu veux.'],
  },
  publisher: {
    it: ['Conferme e promemoria quando un’offerta sta per scadere.', 'Aggiornamenti sulle candidature e sulle statistiche del tuo annuncio.', 'Mai spam. Puoi disiscriverti in un clic, quando vuoi.'],
    en: ['Confirmations and reminders when a listing is about to expire.', 'Updates on applications and your listing’s stats.', 'Never spam. Unsubscribe in one click, whenever you want.'],
    de: ['Bestätigungen und Erinnerungen, wenn eine Anzeige bald abläuft.', 'Updates zu Bewerbungen und den Statistiken deiner Anzeige.', 'Nie Spam. Jederzeit mit einem Klick abmelden.'],
    fr: ['Confirmations et rappels quand une offre est sur le point d’expirer.', 'Mises à jour sur les candidatures et les statistiques de ton annonce.', 'Jamais de spam. Désinscription en un clic, quand tu veux.'],
  },
};

// ── Credibility line (only verifiable numbers — public/data/jobs.json) ──
const CREDIBILITY = {
  consumer: {
    it: 'Oltre 22.000 offerte di lavoro indicizzate su tutta la Svizzera, aggiornate ogni giorno.',
    en: 'Over 22,000 job listings indexed across Switzerland, updated every day.',
    de: 'Über 22.000 indexierte Stellenangebote in der ganzen Schweiz, täglich aktualisiert.',
    fr: 'Plus de 22 000 offres d’emploi indexées dans toute la Suisse, mises à jour chaque jour.',
  },
  publisher: {
    it: 'Il tuo annuncio si affianca a oltre 22.000 offerte indicizzate su tutta la Svizzera, aggiornate ogni giorno.',
    en: 'Your listing sits alongside over 22,000 indexed jobs across Switzerland, updated every day.',
    de: 'Deine Anzeige steht neben über 22.000 indexierten Stellen in der ganzen Schweiz, täglich aktualisiert.',
    fr: 'Ton annonce côtoie plus de 22 000 offres indexées dans toute la Suisse, mises à jour chaque jour.',
  },
};

// ── Deliverability ask ────────────────────────────────────────────
const DELIVERABILITY = {
  consumer: {
    it: 'Aggiungi newsletter@frontaliereticino.ch ai tuoi contatti così non perdi le prossime email, e rispondi pure a questa: leggiamo tutto.',
    en: 'Add newsletter@frontaliereticino.ch to your contacts so you never miss the next email, and feel free to reply to this one — we read everything.',
    de: 'Füge newsletter@frontaliereticino.ch zu deinen Kontakten hinzu, damit dir keine E-Mail entgeht, und antworte gerne auf diese — wir lesen alles.',
    fr: 'Ajoute newsletter@frontaliereticino.ch à tes contacts pour ne rater aucun prochain email, et n’hésite pas à répondre à celui-ci — on lit tout.',
  },
  publisher: {
    it: 'Rispondi pure a questa email se hai domande: leggiamo tutto.',
    en: 'Feel free to reply to this email if you have questions — we read everything.',
    de: 'Antworte gerne auf diese E-Mail, wenn du Fragen hast — wir lesen alles.',
    fr: 'N’hésite pas à répondre à cet email si tu as des questions — on lit tout.',
  },
};

// ── "Consigliato per te" card: real registry-backed block, shared with the
// weekly newsletter + onboarding drip — see functions/src/lib/recommendedBlock.js.
// Maps this email's welcome segment to the INTERESTS bucket
// (services/newsletter-segments.mjs) recommendedBlock.js ranks candidates
// against. `salary` maps to 'utility' (calculator/tool-usage segment, same
// bucket as the utility welcome segment).
const SEGMENT_INTEREST = {
  job: 'jobs',
  salary: 'utility',
  utility: 'utility',
  general: 'general',
};

// ── Footer ────────────────────────────────────────────────────────
const UNSUB_LABEL = { it: 'Disiscriviti', en: 'Unsubscribe', de: 'Abmelden', fr: 'Se désinscrire' };
const PREFS_LABEL = { it: 'Gestisci preferenze', en: 'Manage preferences', de: 'Einstellungen verwalten', fr: 'Gérer le préférences' };
const FOOTER_REASON = { it: 'Ricevi questa email perché ti sei iscritto su', en: 'You receive this email because you subscribed on', de: 'Du erhältst diese E-Mail, weil du dich angemeldet hast auf', fr: 'Tu reçois cet email car tu t’es inscrit sur' };

function renderFooter(locale, unsubscribeUrl, preferencesUrl) {
  const lang = normLocale(locale);
  // Legal/necessary links only — never CTAs, so they stay exactly as they
  // were: unsubscribe and preferences, both untouched by the CTA rework.
  const prefsLine = preferencesUrl
    ? `<div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;"><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(preferencesUrl)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${escapeHtml(PREFS_LABEL[lang])}</a></div>`
    : '';
  return `
    <tr><td class="footer-pad" bgcolor="${BRAND_DARK}" style="background:${BRAND_DARK};padding:28px;text-align:center;">
      <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;">${escapeHtml(FOOTER_REASON[lang])} <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}/" style="color:${BRAND_ORANGE};text-decoration:underline;">frontaliereticino.ch</a></div>
      <div style="font-size:11px;color:#475569;margin-top:8px;">${escapeHtml(dataControllerFooterLine(lang))}</div>
      <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;"><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${escapeHtml(UNSUB_LABEL[lang])}</a></div>
      ${prefsLine}
      <div style="font-size:12px;color:#475569;margin-top:12px;">Frontaliere Ticino</div>
    </td></tr>`;
}

// ── Section renderers ────────────────────────────────────────────
function renderBrandBar(locale) {
  return `
    <tr><td class="section-pad" bgcolor="${BRAND_DARK}" style="background:${BRAND_DARK};padding:16px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:900;color:${BRAND_ORANGE};letter-spacing:-0.3px;">Frontaliere Ticino</td>
        <td align="right" style="font-size:11px;color:${MUTED_COLOR};">${escapeHtml(WELCOME_LABEL[locale])}</td>
      </tr></table>
    </td></tr>`;
}

// Full-width, high-contrast, generously padded button — the "unmistakably
// the main thing" CTA. Rendered twice per email (hero + repeated lower
// down): a repeated CTA measurably lifts clicks in longer emails, and both
// instances always carry the identical label/href so there is only ever one
// primary action being asked for. Table-based so Outlook (which ignores
// `display:inline-block` sizing and CSS on <a>) still renders a solid,
// correctly colored, tappable block via the bgcolor attribute.
function renderCtaButton(href, label) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
      <tr><td align="center" bgcolor="${BRAND_ORANGE}" style="background:${BRAND_ORANGE};border-radius:10px;">
        <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}" style="display:block;width:100%;box-sizing:border-box;padding:17px 24px;font-size:16px;line-height:20px;font-weight:800;color:#ffffff;text-decoration:none;text-align:center;border-radius:10px;">${escapeHtml(label)}</a>
      </td></tr>
    </table>`;
}

function renderExpectBox(heading, bullets) {
  // Checkmark prefix instead of the default disc bullet — same information,
  // reads as a scannable checklist rather than a generic <ul>.
  const items = bullets.map((b) => `<li style="margin:0 0 8px;list-style:none;"><span style="color:${BRAND_ORANGE};font-weight:800;">&#10003;&nbsp;</span>${escapeHtml(b)}</li>`).join('');
  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;">
      <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-top:3px solid ${BRAND_ORANGE};border-radius:12px;padding:18px 20px;">
        <div style="font-size:13px;font-weight:800;color:${BRAND_DARK};margin:0 0 10px;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(heading)}</div>
        <ul style="margin:0;padding-left:0;font-size:13px;color:${TEXT_COLOR};line-height:1.55;">${items}</ul>
      </div>
    </td></tr>`;
}

const QUICKLINKS_HEADING = { it: 'Continua da qui', en: 'Keep exploring', de: 'Hier geht’s weiter', fr: 'Continue par ici' };

function renderQuickLinks(links) {
  // Each row is its own mini-table so the whole card — label AND the arrow
  // badge — is inside the single <a>, giving a real ≥44px tap target with
  // clear tappable affordance instead of a plain text row.
  const rows = links.map((l) => `
    <tr><td style="padding:0 0 10px;">
      <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(l.href)}" style="display:block;text-decoration:none;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-left:4px solid ${BRAND_ORANGE};border-radius:10px;">
          <tr>
            <td bgcolor="${CARD_BG}" style="padding:14px 12px 14px 16px;font-size:14px;font-weight:700;color:${BRAND_DARK};">${escapeHtml(l.label)}</td>
            <td width="34" align="center" style="padding:14px 14px 14px 0;">
              <div style="width:26px;height:26px;border-radius:50%;background:${BRAND_ORANGE};color:#ffffff;font-size:13px;font-weight:700;line-height:26px;text-align:center;">&#8594;</div>
            </td>
          </tr>
        </table>
      </a>
    </td></tr>`).join('');
  return rows;
}

function renderQuickLinksSection(heading, links) {
  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:4px 28px 4px;">
      <div style="font-size:11px;font-weight:800;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:1px;margin:0 0 10px;">${escapeHtml(heading)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renderQuickLinks(links)}</table>
    </td></tr>`;
}

function renderCredibility(text) {
  return `<tr><td class="section-pad" style="padding:0 28px 16px;"><div style="font-size:12px;color:${MUTED_COLOR};text-align:center;">${escapeHtml(text)}</div></td></tr>`;
}

const CONSULTING = {
  it: {
    title: 'Hai una situazione che non torna?',
    body: 'Doppia imposizione, permesso, rientro dei redditi, telelavoro oltre soglia: se il tuo caso non lo risolve un calcolatore, puoi parlarne con noi in una consulenza dedicata.',
    cta: 'Vedi come funziona la consulenza',
  },
  en: {
    title: 'Got a situation the tools can’t settle?',
    body: 'Double taxation, permits, declaring Swiss income in Italy, remote work past the threshold: when a calculator isn’t enough, you can talk it through with us in a one-to-one session.',
    cta: 'See how a consultation works',
  },
  de: {
    title: 'Ein Fall, den kein Rechner löst?',
    body: 'Doppelbesteuerung, Bewilligung, Deklaration in Italien, Homeoffice über der Schwelle: Wenn ein Rechner nicht reicht, kannst du deinen Fall in einer persönlichen Beratung besprechen.',
    cta: 'So läuft eine Beratung ab',
  },
  fr: {
    title: 'Une situation que les outils ne règlent pas ?',
    body: 'Double imposition, permis, déclaration des revenus en Italie, télétravail au-delà du seuil : quand un calculateur ne suffit pas, tu peux en parler avec nous lors d’une consultation dédiée.',
    cta: 'Voir comment se passe une consultation',
  },
};

function renderConsulting(locale) {
  const c = CONSULTING[locale] || CONSULTING.it;
  const href = localizedUrlSlashed('/consulenza', locale);
  // Own paid product — a revenue block, so the CTA is a real button (not a
  // plain text link) to give it visual weight and a proper tap target.
  return `<tr><td class="section-pad" style="padding:0 28px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${CARD_BG}" style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-top:3px solid ${BRAND_DARK};border-radius:12px;">
        <tr><td style="padding:18px;">
          <div style="font-size:14px;font-weight:800;color:${BRAND_DARK};padding-bottom:6px;">${escapeHtml(c.title)}</div>
          <div style="font-size:13px;line-height:1.6;color:${TEXT_COLOR};padding-bottom:14px;">${escapeHtml(c.body)}</div>
          <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND_ORANGE};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px;">${escapeHtml(c.cta)} →</a>
        </td></tr>
      </table>
    </td></tr>`;
}

function renderDeliverability(text) {
  return `<tr><td class="section-pad" style="padding:0 28px 20px;"><div style="font-size:12px;color:${MUTED_COLOR};text-align:center;line-height:1.5;">${escapeHtml(text)}</div></td></tr>`;
}

// ── Per-segment content builders ─────────────────────────────────
function buildJobContent(locale, { company, sectorKey, locationLabel, jobBackPath, jobAlertActive }) {
  const descriptor = buildJobDescriptor(locale, { company, sectorKey, locationLabel });
  // Alerts already live vs. not yet created is the only thing that changes
  // the copy — the CTA target (job board) is the same either way, so unlike
  // the old preferences-page CTA this no longer needs a signed link to exist.
  const alertsOn = Boolean(jobAlertActive);
  const hook = (alertsOn ? JOB_HOOK_ACTIVE_TEMPLATE : JOB_HOOK_TEMPLATE)[locale](descriptor);
  const quickLinks = [];
  if (jobBackPath) {
    quickLinks.push({ label: LINKS.backToJob[locale], href: directUrlSlashed(jobBackPath) });
  } else {
    quickLinks.push({ label: LINKS.allJobs[locale], href: localizedUrlSlashed('/cerca-lavoro-svizzera', locale) });
  }
  quickLinks.push({ label: LINKS.calcNet[locale], href: localizedUrlSlashed('/calcola-stipendio', locale) });
  quickLinks.push({ label: LINKS.compareLamal[locale], href: localizedUrlSlashed('/compara-servizi/confronta-casse-malati', locale) });

  return {
    subject: alertsOn ? JOB_SUBJECT_ACTIVE[locale] : SUBJECT.job[locale],
    preheader: alertsOn ? JOB_PREHEADER_ACTIVE[locale] : PREHEADER.job[locale],
    heading: alertsOn ? JOB_HEADING_ACTIVE[locale] : HEADING.job[locale],
    hook,
    ctaLabel: alertsOn ? JOB_CTA_ACTIVE[locale] : CTA_LABEL.job[locale],
    ctaHref: localizedUrlSlashed('/cerca-lavoro-svizzera', locale),
    quickLinks,
  };
}

function buildSalaryContent(locale) {
  return {
    subject: SUBJECT.salary[locale],
    preheader: PREHEADER.salary[locale],
    heading: HEADING.salary[locale],
    hook: HOOK.salary[locale],
    ctaLabel: CTA_LABEL.salary[locale],
    ctaHref: localizedUrlSlashed('/calcola-stipendio', locale),
    quickLinks: [
      { label: LINKS.compareLamal[locale], href: localizedUrlSlashed('/compara-servizi/confronta-casse-malati', locale) },
      { label: LINKS.compareFx[locale], href: localizedUrlSlashed('/compara-servizi/cambio-franco-euro', locale) },
      { label: LINKS.searchJobsCh[locale], href: localizedUrlSlashed('/cerca-lavoro-svizzera', locale) },
    ],
  };
}

function buildUtilityContent(locale, { toolKey }) {
  const toolLabel = toolKey ? TOOL_LABELS[locale]?.[toolKey] : null;
  const hook = toolLabel ? HOOK.utilityWithTool[locale](toolLabel) : HOOK.utilityGeneric[locale];
  // Point at a DIFFERENT tool than the one they just used (lamal → fx
  // comparator; comparator/anything else → the LAMal comparator).
  const ctaHref = toolKey === 'lamal'
    ? localizedUrlSlashed('/compara-servizi/cambio-franco-euro', locale)
    : localizedUrlSlashed('/compara-servizi/confronta-casse-malati', locale);

  return {
    subject: SUBJECT.utility[locale],
    preheader: PREHEADER.utility[locale],
    heading: HEADING.utility[locale],
    hook,
    ctaLabel: CTA_LABEL.utility[locale],
    ctaHref,
    quickLinks: [
      { label: LINKS.calcNet[locale], href: localizedUrlSlashed('/calcola-stipendio', locale) },
      { label: LINKS.compareLamal[locale], href: localizedUrlSlashed('/compara-servizi/confronta-casse-malati', locale) },
      { label: LINKS.compareFx[locale], href: localizedUrlSlashed('/compara-servizi/cambio-franco-euro', locale) },
    ],
  };
}

function buildPublisherContent(locale) {
  return {
    subject: SUBJECT.publisher[locale],
    preheader: PREHEADER.publisher[locale],
    heading: HEADING.publisher[locale],
    hook: HOOK.publisher[locale],
    ctaLabel: CTA_LABEL.publisher[locale],
    ctaHref: localizedUrlSlashed('/pubblica-offerta', locale),
    quickLinks: [
      { label: LINKS.howPublishing[locale], href: localizedUrlSlashed('/per-le-aziende', locale) },
      { label: LINKS.publishListing[locale], href: localizedUrlSlashed('/pubblica-offerta', locale) },
      { label: LINKS.myListings[locale], href: localizedUrlSlashed('/i-miei-annunci', locale) },
    ],
  };
}

function buildGeneralContent(locale) {
  return {
    subject: SUBJECT.general[locale],
    preheader: PREHEADER.general[locale],
    heading: HEADING.general[locale],
    hook: HOOK.general[locale],
    ctaLabel: CTA_LABEL.general[locale],
    ctaHref: localizedUrlSlashed('/calcola-stipendio', locale),
    quickLinks: [
      { label: LINKS.calcNet[locale], href: localizedUrlSlashed('/calcola-stipendio', locale) },
      { label: LINKS.searchJobsCh[locale], href: localizedUrlSlashed('/cerca-lavoro-svizzera', locale) },
      { label: LINKS.compareLamal[locale], href: localizedUrlSlashed('/compara-servizi/confronta-casse-malati', locale) },
    ],
  };
}

const SEGMENT_BUILDERS = {
  job: buildJobContent,
  salary: buildSalaryContent,
  utility: buildUtilityContent,
  publisher: buildPublisherContent,
  general: buildGeneralContent,
};

// Hidden-preheader padding: enough zero-width/nbsp filler that mail clients
// don't spill the real body copy into the inbox preview snippet.
const PREHEADER_PAD = '&#847;&zwnj;&nbsp;'.repeat(40);

/**
 * Build the welcome email sent within seconds of signup.
 * @param {{
 *   segment: 'job'|'salary'|'utility'|'publisher'|'general',
 *   locale?: string,
 *   firstName?: string|null,
 *   company?: string|null,
 *   sectorKey?: string|null,
 *   locationLabel?: string|null,
 *   jobBackPath?: string|null,
 *   toolKey?: string|null,
 *   unsubscribeUrl: string,
 *   preferencesUrl?: string|null,
 *   acquisitionSource?: string|null,
 * }} args
 * @returns {{ subject: string, preheader: string, html: string }}
 */
export function buildWelcomeEmail({
  segment,
  locale,
  firstName = null,
  company = null,
  sectorKey = null,
  locationLabel = null,
  jobBackPath = null,
  toolKey = null,
  jobAlertActive = false,
  unsubscribeUrl,
  preferencesUrl = null,
  acquisitionSource = null,
}) {
  const lang = normLocale(locale);
  const seg = SEGMENT_BUILDERS[segment] ? segment : 'general';
  const content = SEGMENT_BUILDERS[seg](lang, {
    company, sectorKey, locationLabel, jobBackPath, toolKey, jobAlertActive, preferencesUrl,
  });
  const isPublisher = seg === 'publisher';

  const unsub = unsubscribeUrl || `${BASE_URL}/?action=unsubscribe`;
  const greeting = GREETING[lang](firstName || null);
  const expectBullets = (isPublisher ? EXPECT.publisher : EXPECT.consumer)[lang];
  const credibilityText = (isPublisher ? CREDIBILITY.publisher : CREDIBILITY.consumer)[lang];
  const deliverabilityText = (isPublisher ? DELIVERABILITY.publisher : DELIVERABILITY.consumer)[lang];
  // Publisher is a different audience (employer, not job seeker) — never a
  // consumer affiliate offer in their welcome email.
  // Paid 1:1 consulting — our own service, so it sits above the affiliate
  // block and is offered to consumers only (an employer posting a job is the
  // wrong audience for cross-border tax advice).
  const consultingHtml = isPublisher ? '' : renderConsulting(lang);

  const recommendedHtml = isPublisher
    ? ''
    : renderRecommendedBlock({
        locale: lang,
        interest: SEGMENT_INTEREST[seg] || 'general',
        acquisitionSource,
        campaign: 'welcome',
      });

  // Hero → expectation box → quick links → repeated CTA → trust line → own
  // consulting product → deliverability ask → affiliate block → footer. The
  // CTA button is rendered twice with the IDENTICAL label/href (a repeated
  // CTA measurably lifts clicks in longer emails) — once right under the
  // hook, once again after the quick links, before the reader reaches the
  // supporting/trust content lower down.
  const ctaButtonHtml = renderCtaButton(content.ctaHref, content.ctaLabel);

  const bodyHtml = `
    ${renderBrandBar(lang)}
    <tr><td class="section-pad" bgcolor="${WHITE}" style="background:${WHITE};padding:32px 28px 24px;">
      <div style="font-size:14px;color:${TEXT_COLOR};margin:0 0 10px;">${greeting}</div>
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:${BRAND_DARK};line-height:1.28;">${escapeHtml(content.heading)}</h1>
      <p style="font-size:14px;color:${TEXT_COLOR};line-height:1.65;margin:0 0 24px;">${content.hook}</p>
      ${ctaButtonHtml}
    </td></tr>
    ${renderExpectBox(EXPECT.heading[lang], expectBullets)}
    ${renderQuickLinksSection(QUICKLINKS_HEADING[lang], content.quickLinks)}
    <tr><td class="section-pad" style="background:${WHITE};padding:4px 28px 28px;">
      ${ctaButtonHtml}
    </td></tr>
    ${renderCredibility(credibilityText)}
    ${consultingHtml}
    ${renderDeliverability(deliverabilityText)}
    ${recommendedHtml}
    ${renderFooter(lang, unsub, preferencesUrl)}
  `;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(content.subject)}</title>
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    img{border:0;max-width:100%;}
    @media only screen and (max-width:620px){.section-pad{padding-left:16px!important;padding-right:16px!important;}.footer-pad{padding:20px 16px!important;}}
  </style>
</head>
<body style="margin:0;padding:0;background:${LIGHT_BG};">
  <div style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;opacity:0;">${escapeHtml(content.preheader)}${PREHEADER_PAD}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${LIGHT_BG}" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" bgcolor="${WHITE}" style="width:100%;max-width:620px;background:${WHITE};">
        ${bodyHtml}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: content.subject, preheader: content.preheader, html };
}
