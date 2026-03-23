import fs from 'node:fs';
import path from 'node:path';

import { detectLanguage } from './detect-language.mjs';
import { freeTranslateWithRetry } from './free-translate.mjs';
import { translateTextWithLocalPipeline } from './job-localization-pipeline.mjs';
import { hardenJobsWithStructuredSalary } from './structured-salary.mjs';
import {
  DEFAULT_JOB_LOCALES,
  detectJobTitleLang,
  detectJobTitleLocaleDetails,
  detectTextLocale,
} from './job-locale-utils.mjs';

const DEFAULT_LOCALES = DEFAULT_JOB_LOCALES;

async function translateJobFieldWithFallback({
  text,
  sourceLang,
  targetLang,
  kind,
  context = {},
  minChars = 0,
}) {
  const local = await translateTextWithLocalPipeline({
    text,
    sourceLang,
    targetLang,
    kind,
    context,
    minChars,
  });
  if (local) return local;

  const translated = await freeTranslateWithRetry({
    text,
    sourceLang,
    targetLang,
    maxRetries: kind === 'title' ? 1 : 2,
  });
  if (translated) return translated;

  if (kind === 'title') {
    const heuristicTitle = heuristicTranslateJobTitle(String(text || ''), targetLang);
    if (heuristicTitle && normalize(heuristicTitle) !== normalize(text)) {
      return heuristicTitle;
    }
    // Do NOT fall back to source text — storing wrong-language content is worse than empty.
    return null;
  }
  return null;
}

export function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const GERMAN_SLUG_WORDS =
  /(?:^|-)(?:als|und|fur|oder|frau|mann|fach|stelle|lehrstelle|lehre|mitarbeiter|leiter|stellvertretend|verkauf|lernend|chauffeu|gartencenter|befristet|ablosen|disponentin|disponent|ladenleit|logistiker|projektleiter|elektroinstallateur|elektroplaner|unterhaltsfachmann|servicetechniker|immobilienberater|bauleiter|zeichner|fachrichtung|ingenieurbau|tunnelbau|tiefbau|innendienst|generalagentur|vorsorge|vermogen|wissenschaftlich|detailhandels|bekampfung|japankafer|lager)(?:-|$)/i;
const FRENCH_SLUG_WORDS =
  /(?:^|-)(?:apprentissage|gestionnaire|adjoint|auxiliaire|temporaire|vendeur|vendeuse|postes|vacants|gerante|gerant)(?:-|$)/i;
const FEDERAL_PLACEHOLDER_SLUG_RE =
  /(?:^|-)(?:eidgenossisches-departement|departement-federal|dipartimento-federale)(?:-|$)/i;

const GERMAN_TITLE_WORDS =
  /\b(?:als|und|fur|oder|lehre|lehrstelle|mitarbeiter|leiter|logistiker|projektleiter|elektroinstallateur|elektroplaner|unterhaltsfachmann|servicetechniker|immobilienberater|nachwuchskader|bauleiter|zeichner|fachrichtung|ingenieurbau|tunnelbau|tiefbau|innendienst|generalagentur|vorsorge|verm[öo]gen|wissenschaftlich|detailhandels|bek[äa]mpfung|japank[äa]fer|lager)\b/i;
const FRENCH_TITLE_WORDS =
  /\b(?:apprentissage|gestionnaire|adjoint|auxiliaire|temporaire|vendeur|vendeuse|gerante|gerant)\b/i;

function slugifyLocalizedLabel(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function needsItalianSlugRepair(slug = '') {
  const clean = String(slug || '').trim();
  if (!clean) return false;
  return GERMAN_SLUG_WORDS.test(clean) || FRENCH_SLUG_WORDS.test(clean);
}

function needsCanonicalCompanySlugRepair(slug = '', company = '') {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug || !FEDERAL_PLACEHOLDER_SLUG_RE.test(cleanSlug)) return false;
  const companySlug = slugifyLocalizedLabel(company);
  if (!companySlug) return false;
  return !cleanSlug.includes(companySlug);
}

function normalizeRepairText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function needsItalianTitleRepair(title = '') {
  const clean = normalizeRepairText(title);
  if (!clean) return false;
  return GERMAN_TITLE_WORDS.test(clean) || FRENCH_TITLE_WORDS.test(clean);
}

export function heuristicTranslateJobTitle(title = '', locale = 'it') {
  let out = String(title || '').trim();
  if (!out) return out;

  const dictionaries = {
    it: [
      [/\bWissenschaftlich-technische\/r Mitarbeiter\/in\b/gi, 'Collaboratore/trice scientifico-tecnico/a'],
      [/\bDetailhandelsfachfrau\/-mann\b/gi, 'Impiegato/a del commercio al dettaglio'],
      [/\bDetailhandelsfachmann\/-frau\b/gi, 'Addetto/a al commercio al dettaglio'],
      [/\bDetailhandelsassistent\/in\b/gi, 'Assistente del commercio al dettaglio'],
      [/\bDetailhandelsassistent\/-in\b/gi, 'Assistente del commercio al dettaglio'],
      [/\bAuxiliaire de vente\b/gi, 'Assistente alle vendite'],
      [/\bVendeur secteur vert\b/gi, 'Venditore settore verde'],
      [/\bICT Developer CRM\b/gi, 'Sviluppatore/trice ICT CRM'],
      [/\bEntwickler(?:\/in|:in)?\s+(?:für|fur)\s+CRM(?:-|\s*)Systeme\b/gi, 'Sviluppatore/trice per sistemi CRM'],
      [/\b[eé]tudiant\/e\b/gi, 'studente/studentessa'],
      [/\bCDD d['']avril à juin\b/gi, 'contratto a termine da aprile a giugno'],
      [/\bEFZ\b/g, 'CFC'],
      [/\bEBA\b/g, 'AFP'],
      [/\bLebensmittel\b/gi, 'alimentari'],
      [/\bLernende(?:\/-r)?\b/gi, 'Apprendista'],
      [/\bStrassentransportfachmann\/-frau\b/gi, 'Specialista in trasporti stradali'],
      [/\bLogistiker\/-in\b/gi, 'Impiegato/a in logistica'],
      [/\bLehre:\s*/gi, 'Apprendistato: '],
      [/\bein Projekt\b/gi, 'un progetto'],
      [/\bzur Bek[äa]mpfung\b/gi, 'per la lotta contro'],
      [/\bdes Japank[äa]fers\b/gi, 'il coleottero giapponese'],
      [/\bLager\b/gi, 'magazzino'],
      [/\bNachwuchskader Verkauf\b/gi, 'Responsabile junior vendita'],
      [/\bElektroplaner oder Elektroinstallateur(?:\/in|:in|\s+in)? in Zusatzlehre als Elektroplaner \/ Elektroinstallateur EFZ mit planerischer Erfahrung\b/gi, 'Progettista elettrico/a o installatore/trice elettrico/a in formazione complementare come progettista elettrico/a / installatore/trice elettrico/a EFZ con esperienza di pianificazione'],
      [/\bProjektleiter\/in Installationen oder Junior Projektleiter\/in\b/gi, 'Responsabile di progetto installazioni o Junior responsabile di progetto'],
      [/\bUnterhaltsfachmann\/frau,\s*Servicetechniker\/in\b/gi, 'Addetto/a manutenzione, Tecnico/a di servizio'],
      [/\bLehrstelle als\b/gi, 'Apprendistato come'],
      [/\bLehrstelle\b/gi, 'Apprendistato'],
      [/\bLehre als\b/gi, 'Apprendistato come'],
      [/\bLogistiker:in\b/gi, 'impiegata/impiegato in logistica'],
      [/\bDistribution gemischte Zustellung\b/gi, 'Distribuzione recapito misto'],
      [/\bBriefe und Pakete\b/gi, 'lettere e pacchi'],
      [/\bImmobilienberater\/in\b/gi, 'Consulente immobiliare'],
      [/\bg[ée]rante[- ]adjointe\s*\/\s*g[ée]rant[- ]adjoint\b/gi, 'Vicegerente / Gerente aggiunto/a'],
      [/\bvendeuse\s*\/\s*vendeur\b/gi, 'Venditrice / Venditore'],
      [/\bSenior Projektleiter:in Bauherrenunterstützung\b/gi, 'Responsabile di progetto senior supporto alla committenza'],
      [/\bProjektleiter:in Nationalstrassenbau\b/gi, 'Responsabile di progetto costruzione strade nazionali'],
      [/\bProjektleiter:in Bahnbau\b/gi, 'Responsabile di progetto costruzione ferroviaria'],
      [/\bProjektleiter:in Kunstbauten\b/gi, "Responsabile di progetto opere d'arte"],
      [/\bProjektingenieur:in Kunstbauten\b/gi, "Ingegnere/a di progetto opere d'arte"],
      [/\bZeichner:in Tiefbau \/ Kunstbau\b/gi, "Disegnatore/trice ingegneria civile / opere d'arte"],
      [/\bBauleiter:in\b/gi, 'Direttore/trice lavori'],
      [/\bZeichner:in\b/gi, 'Disegnatore/trice'],
      [/\bZeichner\/in\b/gi, 'Disegnatore/trice'],
      [/\bLeiter:in\b/gi, 'Responsabile'],
      [/\bLeiter\/in\b/gi, 'Responsabile'],
      [/\bLeiter\/-in\b/gi, 'Responsabile'],
      [/\bMitarbeiter:in\b/gi, 'Collaboratore/trice'],
      [/\bProjektleiter:in\b/gi, 'Responsabile di progetto'],
      [/\bProjektleiter\/in\b/gi, 'Responsabile di progetto'],
      [/\bJunior Projektleiter\/in\b/gi, 'Junior responsabile di progetto'],
      [/\bBauherrenunterstützung\b/gi, 'supporto alla committenza'],
      [/\bElektroinstallateur\b/gi, 'Installatore/trice elettrico/a'],
      [/\bElektroinstallateur\/in\b/gi, 'Installatore/trice elettrico/a'],
      [/\bElektroplaner\b/gi, 'Progettista elettrico/a'],
      [/\bZusatzlehre\b/gi, 'formazione complementare'],
      [/\bFachrichtung\b/gi, 'specializzazione'],
      [/\bIngenieurbau\b/gi, 'ingegneria civile'],
      [/\bTunnelbau\b/gi, 'costruzione gallerie'],
      [/\bTiefbau\b/gi, 'genio civile'],
      [/\bInnendienst\b/gi, 'servizio interno'],
      [/\bGeneralagentur\b/gi, 'agenzia generale'],
      [/\bVorsorge\b/gi, 'previdenza'],
      [/\bVerm[öo]gen\b/gi, 'patrimonio'],
      [/\bmit planerischer Erfahrung\b/gi, 'con esperienza di pianificazione'],
      [/\bmit Flair für\b/gi, 'con predisposizione per'],
      [/\bTelematik\b/gi, 'telematica'],
      [/\bUnterhaltsfachmann\/frau\b/gi, 'Addetto/a manutenzione'],
      [/\bServicetechniker\/in\b/gi, 'Tecnico/a di servizio'],
      [/\bInstallationen\b/gi, 'installazioni'],
      [/\bVendeuse\/vendeur\b/gi, 'Venditore/Venditrice'],
      [/\bAuxiliaire temporaire de caisse\b/gi, 'Addetto/a cassa temporaneo/a'],
      [/\bCDD d'avril à août\b/gi, 'contratto a termine da aprile ad agosto'],
      [/\bCDD d'avril à mai\b/gi, 'contratto a termine da aprile a maggio'],
      [/\bf\/h\/d\b/gi, 'f/m/d'],
      [/\bh\/f\/d\b/gi, 'f/m/d'],
      [/\bals\b/gi, 'come'],
      [/\boder\b/gi, 'o'],
      [/\bmit\b/gi, 'con'],
      [/\bfür\b/gi, 'per'],
      [/\bdie\b/gi, 'la'],
      [/\bund\b/gi, 'e'],
    ],
    de: [
      // Italian machining/industrial job titles → German (operator, not machine)
      [/\bFresatore\b/gi, 'Fräser'],
      [/\bTornitore\b/gi, 'Dreher'],
      [/\bSmerigliatore\b/gi, 'Schleifer'],
    ],
    en: [
      // Italian machining/industrial job titles → English (operator, not machine)
      [/\bFresatore\b/gi, 'Milling Operator'],
      [/\bTornitore\b/gi, 'Lathe Operator'],
      [/\bSmerigliatore\b/gi, 'Grinding Operator'],
      [/\bMitarbeiter:in\b/gi, 'Associate'],
      [/\bProjektleiter:in\b/gi, 'Project Manager'],
      [/\bProjektleiter\/in\b/gi, 'Project Manager'],
      [/\bBauherrenunterstützung\b/gi, 'Client Support'],
      [/\bElektroinstallateur\/in\b/gi, 'Electrical Installer'],
      [/\bElektroplaner\b/gi, 'Electrical Planner'],
      [/\bZusatzlehre\b/gi, 'Additional Apprenticeship'],
      [/\bTelematik\b/gi, 'Telematics'],
      [/\bUnterhaltsfachmann\/frau\b/gi, 'Maintenance Specialist'],
      [/\bServicetechniker\/in\b/gi, 'Service Technician'],
      [/\bVendeuse\/vendeur\b/gi, 'Salesperson'],
      [/\bAuxiliaire temporaire de caisse\b/gi, 'Temporary Cashier Assistant'],
      [/\bCDD d'avril à août\b/gi, 'fixed-term contract from April to August'],
      [/\bCDD d'avril à mai\b/gi, 'fixed-term contract from April to May'],
    ],
    fr: [
      // Italian machining/industrial job titles → French (operator, not machine)
      [/\bFresatore\b/gi, 'Fraiseur'],
      [/\bTornitore\b/gi, 'Tourneur'],
      [/\bSmerigliatore\b/gi, 'Rectifieur'],
      [/\bMitarbeiter:in\b/gi, 'Collaborateur/trice'],
      [/\bProjektleiter:in\b/gi, 'Chef de projet'],
      [/\bProjektleiter\/in\b/gi, 'Chef de projet'],
      [/\bBauherrenunterstützung\b/gi, "assistance à la maîtrise d'ouvrage"],
      [/\bElektroinstallateur\/in\b/gi, 'Installateur/trice électricien/ne'],
      [/\bElektroplaner\b/gi, 'Planificateur/trice électrique'],
      [/\bZusatzlehre\b/gi, 'formation complémentaire'],
      [/\bTelematik\b/gi, 'télématique'],
      [/\bUnterhaltsfachmann\/frau\b/gi, 'Spécialiste maintenance'],
      [/\bServicetechniker\/in\b/gi, 'Technicien/ne de service'],
      [/\bVendeuse\/vendeur\b/gi, 'Vendeur/Vendeuse'],
      [/\bAuxiliaire temporaire de caisse\b/gi, 'Auxiliaire temporaire de caisse'],
    ],
  };

  for (const [pattern, replacement] of (dictionaries[locale] || [])) {
    out = out.replace(pattern, replacement);
  }

  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([-/])/g, ' $1')
    .replace(/([-/])\s+/g, '$1 ')
    .trim();
}

/**
 * Detect if a description contains code/script artifacts instead of real content.
 * Returns { isCode: boolean, reason: string } if code detected.
 */
const CODE_PATTERNS = [
  { re: /\bvar\s+\w+\s*=\s*(?:new\s|['"\[\{])/i, label: 'JavaScript variable declaration' },
  { re: /\bfunction\s*\w*\s*\([^)]*\)\s*\{/i, label: 'JavaScript function' },
  { re: /\bdocument\.(getElementById|querySelector|cookie|write)/i, label: 'DOM API call' },
  { re: /\bwindow\.(location|addEventListener|onload)/i, label: 'window API call' },
  { re: /background-image:\s*url\(/i, label: 'CSS background-image' },
  { re: /\{[\s\S]{0,20}display\s*:\s*(none|block|flex|inline)/i, label: 'CSS display rule' },
  { re: /\bimport\s+\{[^}]+\}\s+from\s+['"]/i, label: 'JS import statement' },
  { re: /\bconsole\.(log|warn|error)\s*\(/i, label: 'console.log' },
  { re: /\$\(\s*['"][#.]/i, label: 'jQuery selector' },
  { re: /\.addEventListener\s*\(\s*['"]/i, label: 'addEventListener' },
  { re: /\bnew\s+(Array|Object|Date|Map|Set)\s*\(/i, label: 'JS constructor' },
  { re: /<\/?(script|style|noscript)[\s>]/i, label: 'HTML script/style tag' },
];

export function detectCodeInDescription(description = '') {
  const text = String(description || '');
  if (text.length < 50) return { isCode: false, reason: '' };

  const matches = [];
  for (const { re, label } of CODE_PATTERNS) {
    if (re.test(text)) matches.push(label);
  }

  // Threshold: 2+ code patterns = definitely code contamination
  if (matches.length >= 2) {
    return { isCode: true, reason: `Code detected: ${matches.join(', ')}` };
  }
  return { isCode: false, reason: '' };
}

export function detectLang(text = '', fallback = 'it') {
  return detectLanguage(text, fallback);
}

const COMPANY_BOILERPLATE_IT = {
  'PEMSA': `PEMSA è da oltre 30 anni un punto di riferimento nel mercato svizzero per il reclutamento e la gestione di professionisti qualificati nei settori della costruzione, impiantistica, elettrotecnica e meccanica industriale. Offriamo contratti fissi e temporanei, con la sicurezza di un partner stabile e la flessibilità che cerchi.\n\nVantaggi: consulenza personalizzata, accesso a cantieri di prestigio in tutta la Svizzera, supporto amministrativo completo, retribuzione competitiva e opportunità di formazione continua.`,
  'ReleWant': `ReleWant è una società di consulenza IT con sede in Ticino, specializzata in soluzioni informatiche innovative per il settore bancario e finanziario. Offriamo servizi di consulenza, sviluppo software e gestione di progetti IT complessi per le principali istituzioni finanziarie in Svizzera.\n\nOffriamo un ambiente di lavoro stimolante, progetti sfidanti nel settore fintech, formazione continua, flessibilità lavorativa e condizioni d'impiego competitive.`,
  'Lombardi Group': `Lombardi Group è una società di ingegneria svizzera di primo piano con sede a Minusio (Ticino), attiva nella progettazione di grandi opere infrastrutturali: tunnel, dighe, centrali idroelettriche, ponti e edifici complessi. Con oltre 700 collaboratori e progetti in tutto il mondo, offriamo un ambiente multidisciplinare e internazionale.\n\nVantaggi: progetti di grande scala, team multiculturale, formazione specialistica, condizioni d'impiego competitive e possibilità di crescita professionale.`,
  'MTIC Group': `MTIC Group è un gruppo internazionale attivo nel settore delle certificazioni, ispezioni e prove tecniche. Con sede principale a Lugano Paradiso, operiamo in settori come energia, industria, trasporti e costruzioni, garantendo qualità e sicurezza attraverso standard internazionali.\n\nOffriamo un ambiente professionale stimolante, progetti diversificati, formazione continua e possibilità di carriera in un contesto internazionale.`,
  'Convit Holding GmbH': `Convit Holding GmbH è una società attiva nella consulenza finanziaria e previdenziale in Svizzera. Operiamo nel settore della previdenza professionale (2° pilastro) e previdenza privata (3° pilastro), offrendo consulenza personalizzata ai clienti.\n\nOffriamo formazione completa per nuovi ingressi, un sistema retributivo attrattivo con possibilità di guadagno elevato, flessibilità lavorativa e concrete possibilità di sviluppo professionale.`,
  'Allianz Suisse': `Allianz Suisse è una delle principali compagnie assicurative in Svizzera, parte del gruppo Allianz internazionale. Offriamo soluzioni assicurative complete per privati e aziende: assicurazioni vita, non-vita, previdenza e investimenti.\n\nVantaggi: formazione eccellente, ambiente di lavoro dinamico, benefit aziendali competitivi e opportunità di carriera in un gruppo globale leader nel settore assicurativo.`,
  'Centiel': `Centiel è un'azienda svizzera specializzata nella progettazione e produzione di sistemi di alimentazione ininterrotta (UPS) ad alta efficienza. Con sede in Ticino, sviluppiamo soluzioni tecnologiche all'avanguardia per data center, ospedali, infrastrutture critiche e industria.\n\nOffriamo un ambiente innovativo, progetti tecnologici sfidanti e condizioni d'impiego competitive.`,
  'Boggi Milano': `Boggi Milano è un brand italiano di moda maschile di alta qualità, presente con oltre 200 negozi in tutto il mondo. Proponiamo collezioni che uniscono design italiano, tessuti pregiati e vestibilità contemporanea per l'uomo moderno.\n\nOffriamo un ambiente dinamico nel settore fashion retail, formazione specialistica, sconti dipendenti e concrete opportunità di crescita professionale in un brand in espansione.`,
  'Stollwerck GmbH': `Stollwerck GmbH è un'azienda leader nella produzione di cioccolato e dolciumi, parte del gruppo Baronie. Produciamo marchi iconici come Stollwerck, Sarotti e Alpia, distribuiti in tutta Europa.\n\nOffriamo un ambiente internazionale, progetti stimolanti nel settore FMCG e condizioni d'impiego competitive.`,
  'USI – Università della Svizzera italiana': `L'Università della Svizzera italiana (USI) è un'università pubblica svizzera con campus a Lugano e Mendrisio. Offriamo formazione e ricerca d'eccellenza nelle aree di comunicazione, economia, informatica, scienze biomediche e architettura.\n\nVantaggi: ambiente accademico internazionale, ricerca all'avanguardia, campus moderno e condizioni d'impiego secondo gli standard universitari svizzeri.`,
  'Denner SA': `Denner SA è uno dei principali discount alimentari della Svizzera, con oltre 800 filiali. Parte del gruppo Migros, offriamo prodotti di qualità a prezzi convenienti.\n\nOffriamo un ambiente di lavoro dinamico nel settore retail, formazione continua, sconti dipendenti e concrete opportunità di carriera.`,
  'Amministrazione Cantonale Ticino': `L'Amministrazione Cantonale del Cantone Ticino è il principale datore di lavoro pubblico del cantone. Offriamo posizioni in tutti i settori dell'amministrazione pubblica con condizioni d'impiego stabili e competitive.\n\nVantaggi: stabilità lavorativa, orari regolari, formazione continua, previdenza professionale vantaggiosa e possibilità di crescita all'interno dell'amministrazione.`,
  'AGIE Charmilles SA': `AGIE Charmilles SA, parte di GF Machining Solutions e del gruppo Georg Fischer, sviluppa macchine utensili di alta precisione per elettroerosione, fresatura, laser e additive manufacturing. La sede di Losone rappresenta un polo tecnologico di riferimento per il Ticino industriale.\n\nOffriamo un ambiente internazionale, progetti ad alto contenuto tecnico, collaborazione con team di engineering specializzati e concrete opportunità di crescita professionale.`,
  'AFRY': `AFRY è una multinazionale europea dell'ingegneria, progettazione e consulenza, attiva in infrastrutture, energia, industria, telecomunicazioni e sostenibilità. In Svizzera opera su progetti complessi per mobilità, opere civili, impianti tecnici e transizione energetica.\n\nOffriamo un contesto tecnico multidisciplinare, clienti di primo piano, formazione continua e percorsi di crescita in un'organizzazione internazionale con forte presenza locale.`,
  'Manor AG': `Manor AG è una delle principali catene di grandi magazzini in Svizzera, con attività nei settori moda, beauty, casa, food e ristorazione Manora. Le sedi ticinesi offrono ruoli operativi e commerciali in contesti retail dinamici e orientati al servizio.\n\nOffriamo formazione sul posto, benefit aziendali, opportunità di sviluppo interno e un ambiente di lavoro strutturato a diretto contatto con la clientela.`,
  'VOLG': `VOLG è il marchio di prossimità della cooperativa fenaco, specializzato nei negozi di paese e nei piccoli punti vendita della Svizzera. Il lavoro combina servizio al cliente, gestione della merce, supporto operativo e forte autonomia sul punto vendita.\n\nOffriamo un ambiente familiare, formazione pratica, benefit dipendenti, sostegno ai percorsi di apprendistato e concrete possibilità di crescita nel commercio al dettaglio.`,
  'MKS PAMP': `MKS PAMP è un gruppo internazionale attivo nella raffinazione e trasformazione di metalli preziosi, con una presenza strategica a Castel San Pietro. Le posizioni aperte coprono operation, manutenzione, sicurezza, controllo e ruoli tecnici ad alto contenuto industriale.\n\nOffriamo un contesto produttivo avanzato, standard elevati di qualità e sicurezza, processi strutturati e opportunità di sviluppo in una realtà industriale globale.`,
  'Grand Hotel Kronenhof': `Il Grand Hotel Kronenhof di Pontresina è uno degli hotel di lusso più prestigiosi dell'Engadina, con ruoli in hotellerie, ristorazione, spa e servizi al cliente. La struttura opera in un contesto premium, internazionale e fortemente orientato alla qualità del servizio.\n\nOffriamo un ambiente professionale di alto livello, benefit per il personale, possibilità di crescita stagionale e pluriennale e un'esperienza formativa solida nell'ospitalità svizzera.`,
  'Kulm Hotel St. Moritz': `Il Kulm Hotel St. Moritz è una struttura iconica dell'Engadina, con opportunità in ristorazione, front office, housekeeping, eventi e guest experience. Il lavoro si svolge in un contesto internazionale, premium e ad alta intensità di servizio.\n\nOffriamo formazione continua, benefit per il personale, contatto con una clientela internazionale e concrete opportunità di crescita nel settore alberghiero svizzero di fascia alta.`,
  'Ticino Premium Properties SA': `Ticino Premium Properties SA è la realtà Engel & Völkers attiva nel mercato immobiliare di pregio in Ticino, con consulenza su compravendita, locazione e valorizzazione di proprietà residenziali e d'investimento. Il team opera in un contesto premium, orientato alla relazione con il cliente e alla qualità dell'esperienza consulenziale.\n\nOffriamo un ambiente internazionale, formazione sul brand, strumenti commerciali strutturati e concrete opportunità di crescita nel real estate di fascia alta.`,
};

/**
 * Find and return IT boilerplate for a company, or null.
 */
export function getCompanyBoilerplateIT(company = '') {
  for (const [key, text] of Object.entries(COMPANY_BOILERPLATE_IT)) {
    if (company === key || company.includes(key) || key.includes(company)) return text;
  }
  return null;
}

/**
 * Detect whether a description is a known placeholder (not actual job content).
 * Returns true if the text is a short boilerplate template that should be cleared.
 * Patterns: recruiter portal notices, "full description available at", etc.
 */
export function isPlaceholderDescription(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length >= 500) return false; // Long texts likely have real content
  const PLACEHOLDER_PATTERNS = [
    /la descrizione completa[^\n]{0,60}(portale|societ|sito)/i,
    /full (job )?description (is )?available (at|on)/i,
    /vollst[äa]ndige (stellen)?beschreibung[^\n]{0,50}(portal|website|webseite)/i,
    /description complète[^\n]{0,60}(disponible|portail)/i,
    /pubblica questa opportunit[aà] nel suo portale/i,
    /per candidature e informazioni visita(re)? il sito/i,
  ];
  return PLACEHOLDER_PATTERNS.some(re => re.test(clean));
}

/**
 * Enrich thin IT descriptions with company boilerplate. Mutates jobs in-place.
 * Returns count of enriched jobs.
 */
export function enrichThinDescriptions(jobs, threshold = 300) {
  let count = 0;
  for (const j of jobs) {
    const itDesc = String(j.descriptionByLocale?.it || j.description || '');
    if (itDesc.length >= threshold) continue;
    const bp = getCompanyBoilerplateIT(j.company);
    if (!bp) continue;
    const title = j.titleByLocale?.it || j.title || '';
    const loc = j.location || '';
    const canton = j.canton || j.addressRegion || '';
    const enriched = itDesc.includes('##')
      ? `${itDesc}\n\n${bp}`
      : `## ${title}\n\n**${j.company}** — ${loc}${canton ? ` (${canton})` : ''}\n\n${itDesc}\n\n${bp}`;
    if (!j.descriptionByLocale) j.descriptionByLocale = {};
    j.descriptionByLocale.it = enriched;
    count++;
  }
  return count;
}

export function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

const COOP_GROUP_APPRENTICESHIP_SLUG_RE =
  /^detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-(coop|jumbo|interdiscount)-grigioni(?:-\d+)?$/i;
const COOP_GROUP_APPRENTICESHIP_IT_TITLE =
  'Specialista del commercio al dettaglio AFC "Creazione di esperienze di acquisto"';

function getCoopGroupItalianApprenticeshipSlug(job = {}) {
  const candidates = [
    String(job?.slugByLocale?.it || '').trim(),
    String(job?.slug || '').trim(),
    String(job?.slugByLocale?.de || '').trim(),
    String(job?.slugByLocale?.en || '').trim(),
  ];
  for (const candidate of candidates) {
    const match = candidate.match(COOP_GROUP_APPRENTICESHIP_SLUG_RE);
    if (match) {
      return `specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-${match[1].toLowerCase()}-grigioni`;
    }
  }
  return '';
}

const THIN_SOURCE_UI_NOISE_RE =
  /(stampa|dillo a un amico|tell a friend|segnalazione|report|you applied to this job|sei iscritto\/a a questo annuncio|verifica la tua compatibilit|verify your compatibility|powered by|invia|envoyer|send)/i;

const THIN_SOURCE_METADATA_LINE_RE =
  /^(luogo di lavoro|work location|settore|sector|ruolo|role|data di scadenza|expiry date|data ultimo aggiornamento|date of last update)\s*:/i;

function classifyThinSource(job, minSourceDescriptionCharsForHardValidation) {
  const source = String(job?.description || '').trim();
  const sourceLen = source.length;
  const reasons = [];
  if (sourceLen === 0) reasons.push('empty_source_description');
  if (sourceLen > 0 && THIN_SOURCE_UI_NOISE_RE.test(source)) reasons.push('ui_noise_in_source_description');

  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0 && lines.every((line) => THIN_SOURCE_METADATA_LINE_RE.test(line))) {
    reasons.push('metadata_only_source_description');
  }

  const suspicious =
    reasons.length > 0 ||
    (sourceLen > 0 && sourceLen < Math.max(40, Math.floor(minSourceDescriptionCharsForHardValidation * 0.2)));

  return { suspicious, reasons, sourceLen };
}

function toNormalizedKeyList(value) {
  return String(value || '')
    .split(',')
    .map((x) => normalizeKey(x))
    .filter(Boolean);
}

function toNormalizedSet(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.flatMap((x) => toNormalizedKeyList(String(x || ''))))];
}

/**
 * Run the shared crawler pipeline in-process instead of spawning a subprocess.
 * Temporarily injects the env vars that the old subprocess would receive,
 * then restores the original values after the pipeline completes.
 */
async function runSharedCrawlerInProcess({ root, env }) {
  // Save original env values we're about to override
  const overrides = {};
  const originals = {};
  for (const [key, value] of Object.entries(env)) {
    if (key in process.env && process.env[key] !== value) {
      originals[key] = process.env[key];
    }
    overrides[key] = value;
  }

  // Apply env overrides
  Object.assign(process.env, overrides);

  try {
    // Dynamic import to avoid loading 7k-line module at parse time
    const { runSharedCrawlerPipeline } = await import('./shared-jobs-crawler.mjs');
    await runSharedCrawlerPipeline();
  } finally {
    // Restore original env values
    for (const [key, value] of Object.entries(originals)) {
      process.env[key] = value;
    }
    // Remove keys that weren't in the original env
    for (const key of Object.keys(overrides)) {
      if (!(key in originals) && !(key in process.env)) {
        delete process.env[key];
      }
    }
  }
}

function inferPublicJobsPath(dataJobsPath) {
  const dataDir = path.dirname(dataJobsPath);
  const root = path.resolve(dataDir, '..');
  return path.resolve(root, 'public', 'data', 'jobs.json');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function shouldDropLocalizedValue({
  value,
  locale,
  sourceLocale,
  sourceValue,
  minCharsForDetection = 0,
  minConfidence = 0.35,
  checkScoreRatio = false,
}) {
  const clean = String(value || '').trim();
  if (!clean || locale === sourceLocale) return false;
  if (sourceValue && normalize(clean) === normalize(sourceValue)) return true;
  if (clean.length < minCharsForDetection) return false;
  const detected = detectTextLocale(clean, sourceLocale);
  if (detected.confidence >= minConfidence && detected.lang !== locale) return true;
  // For substantial content with mixed-language text (e.g. partial translations where only
  // the heading was translated but the body stayed in source language), standard confidence
  // may be too low. Use score ratio: if source-language score dominates target-language score
  // by 2x, the content is overwhelmingly in the wrong language.
  if (checkScoreRatio && detected.scores) {
    const sourceScore = detected.scores[sourceLocale] ?? 0;
    const targetScore = detected.scores[locale] ?? 0;
    if (sourceScore > 0 && targetScore > 0 && detected.lang !== locale && sourceScore > targetScore * 1.5) {
      return true;
    }
  }
  return false;
}

function maybeRehomeLocalizedValue({
  map,
  locale,
  detectedLocale,
  minChars = 12,
}) {
  const clean = String(map?.[locale] || '').trim();
  if (!clean || !detectedLocale || detectedLocale === locale || clean.length < minChars) {
    return false;
  }

  if (!String(map?.[detectedLocale] || '').trim()) {
    map[detectedLocale] = clean;
  }
  delete map[locale];
  return true;
}

/** Check if a slug plausibly matches a title (first 3+ words overlap). */
function slugMatchesTitle(slug, title) {
  const slugified = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Compare the first 30 chars — enough to detect title renames
  const prefix = slugified.slice(0, 30);
  return prefix.length >= 5 && slug.startsWith(prefix);
}

export function hardenJobLocaleFields({ dataJobsPath }) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) {
    return { changed: false, repaired: 0, total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    return { changed: false, repaired: 0, total: 0 };
  }

  let changed = false;
  let repaired = 0;

  for (const job of raw) {
    let jobChanged = false;

    // Snapshot all current slugs before hardening so we can detect renames
    const slugsBefore = new Set();
    if (job.slug) slugsBefore.add(String(job.slug).trim());
    if (job.slugByLocale && typeof job.slugByLocale === 'object') {
      for (const s of Object.values(job.slugByLocale)) {
        if (s) slugsBefore.add(String(s).trim());
      }
    }

    const baseTitle = String(job.title || '').trim();
    const baseDesc = String(job.description || '').trim();
    const baseSlug = String(job.slug || '').trim();
    const detectedSourceLang = detectLang(baseDesc || baseTitle, 'it');
    let titleSourceLang = detectJobTitleLang(baseTitle, detectedSourceLang);
    const sourceLang = detectTextLocale(baseDesc || baseTitle, titleSourceLang).lang;
    if (baseTitle && titleSourceLang === 'it' && sourceLang !== 'it' && needsItalianTitleRepair(baseTitle)) {
      titleSourceLang = sourceLang;
    }

    if (!job.titleByLocale || typeof job.titleByLocale !== 'object') {
      job.titleByLocale = {};
      jobChanged = true;
    }
    if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') {
      job.descriptionByLocale = {};
      jobChanged = true;
    }
    if (!job.slugByLocale || typeof job.slugByLocale !== 'object') {
      job.slugByLocale = {};
      jobChanged = true;
    }
    if (String(job.sourceLang || '').trim() !== sourceLang) {
      job.sourceLang = sourceLang;
      jobChanged = true;
    }

    if (baseTitle && normalize(String(job.titleByLocale[titleSourceLang] || '')) !== normalize(baseTitle)) {
      job.titleByLocale[titleSourceLang] = baseTitle;
      jobChanged = true;
    }
    if (
      baseTitle &&
      sourceLang !== titleSourceLang &&
      !String(job.titleByLocale[sourceLang] || '').trim()
    ) {
      job.titleByLocale[sourceLang] = String(job.titleByLocale[titleSourceLang] || baseTitle).trim();
      jobChanged = true;
    }
    if (baseDesc && !String(job.descriptionByLocale[sourceLang] || '').trim()) {
      // Only copy baseDesc if it's substantial content, not page chrome/boilerplate/placeholder
      const isGarbage = baseDesc.length < 80 ||
        /^(Zum Hauptinhalt|Skip to|Aller au|Vai al)/i.test(baseDesc) ||
        isPlaceholderDescription(baseDesc);
      if (!isGarbage) {
        job.descriptionByLocale[sourceLang] = baseDesc;
        jobChanged = true;
      }
    }

    // Mark jobs whose base description is a known placeholder so callers can handle them.
    if (baseDesc && isPlaceholderDescription(baseDesc)) {
      if (job.descriptionStatus !== 'placeholder') {
        job.descriptionStatus = 'placeholder';
        jobChanged = true;
      }
    } else if (job.descriptionStatus === 'placeholder') {
      delete job.descriptionStatus;
      jobChanged = true;
    }

    const repairedCoopGroupItSlug = getCoopGroupItalianApprenticeshipSlug(job);
    if (repairedCoopGroupItSlug) {
      if (String(job.titleByLocale.it || '').trim() !== COOP_GROUP_APPRENTICESHIP_IT_TITLE) {
        job.titleByLocale.it = COOP_GROUP_APPRENTICESHIP_IT_TITLE;
        jobChanged = true;
      }
      if (String(job.slugByLocale.it || '').trim() !== repairedCoopGroupItSlug) {
        job.slugByLocale.it = repairedCoopGroupItSlug;
        jobChanged = true;
      }
    }

    for (const locale of DEFAULT_LOCALES) {
      const titleValue = String(job.titleByLocale[locale] || '').trim();
      if (titleValue) {
        const detectedTitleLocale = detectJobTitleLocaleDetails(titleValue, titleSourceLang);
        if (locale !== detectedTitleLocale.lang && detectedTitleLocale.confidence >= 0.55) {
          if (maybeRehomeLocalizedValue({
            map: job.titleByLocale,
            locale,
            detectedLocale: detectedTitleLocale.lang,
            minChars: 24,
          })) {
            jobChanged = true;
          }
        }
      }

      if (
        locale !== sourceLang &&
        shouldDropLocalizedValue({
          value: job.titleByLocale[locale],
          locale,
          sourceLocale: titleSourceLang,
          sourceValue: baseTitle,
          minCharsForDetection: 32,
          minConfidence: 0.65,
        })
      ) {
        delete job.titleByLocale[locale];
        jobChanged = true;
      }
      {
        const descValue = String(job.descriptionByLocale[locale] || '').trim();
        // Drop known placeholder descriptions (recruiter portal notices, etc.)
        if (isPlaceholderDescription(descValue)) {
          delete job.descriptionByLocale[locale];
          jobChanged = true;
          continue;
        }
        const isSubstantialTranslation = descValue.length >= 120 &&
          normalize(descValue) !== normalize(baseDesc);
        // Drop descriptions that are in the wrong language.
        // - Short/garbage descriptions: low confidence threshold (0.25) to catch obvious errors.
        // - Substantial descriptions in wrong language (e.g. entire DE text stored under IT):
        //   use higher confidence threshold (0.70) to avoid false positives on multilingual content.
        const dropMinChars = isSubstantialTranslation ? 200 : 80;
        const dropMinConfidence = isSubstantialTranslation ? 0.70 : 0.25;
        if (shouldDropLocalizedValue({
          value: descValue,
          locale,
          sourceLocale: sourceLang,
          sourceValue: baseDesc,
          minCharsForDetection: dropMinChars,
          minConfidence: dropMinConfidence,
          checkScoreRatio: isSubstantialTranslation,
        })) {
          delete job.descriptionByLocale[locale];
          jobChanged = true;
        }
      }
      const currentSlug = String(job.slugByLocale[locale] || '').trim();
      if (!currentSlug && baseSlug) {
        job.slugByLocale[locale] = baseSlug;
        jobChanged = true;
      }
      // Re-derive slug from current title when the existing slug is stale.
      // Covers both source locale (title updated by company) and non-source
      // locales (slug still matches untranslated base).
      {
        const existingSlug = String(job.slugByLocale[locale] || '').trim();
        const localizedTitle = String(job.titleByLocale[locale] || '').trim();
        const isSourceLocale = locale === titleSourceLang;
        const isStaleSlug = isSourceLocale
          // Source locale: re-derive if slug doesn't start with a slug-ified prefix of current title
          ? existingSlug && localizedTitle && !slugMatchesTitle(existingSlug, localizedTitle)
          // Non-source locale: re-derive if slug still equals the untranslated base
          : existingSlug && existingSlug === baseSlug && localizedTitle && localizedTitle !== baseTitle;
        if (isStaleSlug) {
          const company = String(job.company || '').trim();
          const location = String(job.addressLocality || job.location || '').trim();
          const parts = [localizedTitle, company, location].filter(Boolean).join('-');
          const derived = parts
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 120);
          if (derived && derived !== existingSlug) {
            job.slugByLocale[locale] = derived;
            jobChanged = true;
          }
        }
      }
    }

    const sourceTitleFallback = String(
      job.titleByLocale[titleSourceLang] ||
      job.titleByLocale[sourceLang] ||
      baseTitle
    ).trim();
    if (sourceTitleFallback) {
      for (const locale of DEFAULT_LOCALES) {
        if (!String(job.titleByLocale[locale] || '').trim()) {
          job.titleByLocale[locale] = sourceTitleFallback;
          jobChanged = true;
        }
      }
    }

    for (const locale of DEFAULT_LOCALES) {
      if (locale === titleSourceLang) continue;
      const currentTitle = String(job.titleByLocale[locale] || '').trim();
      const shouldRepairTitle =
        !currentTitle ||
        normalize(currentTitle) === normalize(sourceTitleFallback) ||
        detectJobTitleLocaleDetails(currentTitle, titleSourceLang).lang !== locale ||
        (locale === 'it' && needsItalianTitleRepair(currentTitle));
      if (!shouldRepairTitle) continue;

      const heuristicallyLocalized = heuristicTranslateJobTitle(sourceTitleFallback, locale);
      if (heuristicallyLocalized && normalize(heuristicallyLocalized) !== normalize(sourceTitleFallback)) {
        if (String(job.titleByLocale[locale] || '').trim() !== heuristicallyLocalized) {
          job.titleByLocale[locale] = heuristicallyLocalized;
          jobChanged = true;
        }
      }
    }

    for (const locale of DEFAULT_LOCALES) {
      const localizedTitle = String(job.titleByLocale[locale] || '').trim();
      const localizedSlug = String(job.slugByLocale[locale] || '').trim();
      if (!localizedTitle) continue;

      const company = String(job.company || '').trim();
      const location = String(job.addressLocality || job.location || '').trim();
      const nextSlug = slugifyLocalizedLabel([localizedTitle, company, location].filter(Boolean).join(' '));
      const shouldRefreshSlug =
        !localizedSlug ||
        localizedSlug === baseSlug ||
        (locale === 'it' && needsItalianSlugRepair(localizedSlug)) ||
        needsCanonicalCompanySlugRepair(localizedSlug, company);

      if (shouldRefreshSlug && nextSlug && nextSlug !== localizedSlug) {
        job.slugByLocale[locale] = nextSlug;
        jobChanged = true;
      }
    }

    const canonicalItSlug = String(job.slugByLocale.it || '').trim();
    if (canonicalItSlug) {
      const currentCanonicalSlug = String(job.slug || '').trim();
      if (!currentCanonicalSlug || currentCanonicalSlug === baseSlug || needsItalianSlugRepair(currentCanonicalSlug)) {
        if (currentCanonicalSlug !== canonicalItSlug) {
          job.slug = canonicalItSlug;
          jobChanged = true;
        }
      }
    }

    // Preserve old slugs as aliases when slugs change (prevents 404s for renamed jobs)
    if (jobChanged) {
      const slugsAfter = new Set();
      if (job.slug) slugsAfter.add(String(job.slug).trim());
      if (job.slugByLocale && typeof job.slugByLocale === 'object') {
        for (const s of Object.values(job.slugByLocale)) {
          if (s) slugsAfter.add(String(s).trim());
        }
      }
      // Any slug that existed before but is no longer current → preserve as alias
      const lost = [...slugsBefore].filter((s) => s && !slugsAfter.has(s));
      if (lost.length > 0) {
        if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
        const existing = new Set(job.previousSlugs);
        // Also exclude current slugs from previousSlugs
        for (const s of slugsAfter) existing.delete(s);
        for (const s of lost) {
          if (!slugsAfter.has(s)) existing.add(s);
        }
        job.previousSlugs = [...existing].slice(0, 20); // cap at 20 aliases
      }

      changed = true;
      repaired += 1;
    }
  }

  // Enrich thin IT descriptions with company boilerplate
  const enriched = enrichThinDescriptions(raw);
  if (enriched > 0) {
    changed = true;
    console.log(`📝 Enriched ${enriched} thin IT descriptions with company boilerplate.`);
  }

  if (!changed) {
    return { changed: false, repaired: 0, total: raw.length };
  }

  writeJson(dataJobsPath, raw);
  const publicJobsPath = inferPublicJobsPath(dataJobsPath);
  if (fs.existsSync(publicJobsPath)) {
    writeJson(publicJobsPath, raw);
  }
  return { changed: true, repaired, total: raw.length };
}

/**
 * Translate missing locale fields (title and description) for all jobs.
 * Uses the free translation cascade (DeepL → MyMemory → Google Translate).
 *
 * Unlike hardenJobLocaleFields (which only copies/heuristic-replaces),
 * this function actually translates content using external APIs.
 *
 * @param {Object} options
 * @param {string} options.dataJobsPath - Path to data/jobs.json
 * @param {function} [options.isTargetJob] - Optional filter to only translate specific jobs
 * @param {number} [options.maxJobs=0] - Max jobs to translate (0 = all)
 * @returns {Promise<{changed: boolean, translated: number, total: number, details: Array}>}
 */
export async function translateMissingJobLocales({ dataJobsPath, isTargetJob, maxJobs = 0, minDescriptionChars = 120 }) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) {
    return { changed: false, translated: 0, total: 0, details: [] };
  }
  hardenJobLocaleFields({ dataJobsPath });
  const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    return { changed: false, translated: 0, total: 0, details: [] };
  }

  let changed = false;
  let translated = 0;
  const details = [];
  const concurrency = Math.max(1, Math.min(6, Number(process.env.JOBS_LOCALE_TRANSLATION_CONCURRENCY || 3)));

  const candidates = isTargetJob ? raw.filter(isTargetJob) : raw;
  const limit = maxJobs > 0 ? Math.min(maxJobs, candidates.length) : candidates.length;
  let cursor = 0;

  const worker = async () => {
    while (cursor < limit) {
      const i = cursor;
      cursor += 1;
      const job = candidates[i];
      const baseTitle = String(job.title || '').trim();
      const baseDesc = String(job.description || '').trim();
      const titleSourceLang = detectJobTitleLang(baseTitle, detectLang(baseDesc || baseTitle, 'it'));
      let sourceLang = detectTextLocale(baseDesc || baseTitle, titleSourceLang).lang;
      let jobTranslated = false;

      if (!job.titleByLocale || typeof job.titleByLocale !== 'object') job.titleByLocale = {};
      if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') job.descriptionByLocale = {};

      if (baseTitle && normalize(String(job.titleByLocale[titleSourceLang] || '')) !== normalize(baseTitle)) {
        job.titleByLocale[titleSourceLang] = baseTitle;
      }
      const currentSourceDesc = String(job.descriptionByLocale[sourceLang] || '').trim();
      const shouldRestoreSourceDesc =
        !!baseDesc &&
        baseDesc.length >= minDescriptionChars &&
        currentSourceDesc.length < minDescriptionChars;
      if (shouldRestoreSourceDesc) {
        job.descriptionByLocale[sourceLang] = baseDesc;
        jobTranslated = true;
      } else if (baseDesc && !currentSourceDesc) {
        job.descriptionByLocale[sourceLang] = baseDesc;
        jobTranslated = true;
      }

      const sourceTitle = String(job.titleByLocale[titleSourceLang] || baseTitle).trim();
      let sourceDesc = String(job.descriptionByLocale[sourceLang] || baseDesc).trim();

      // If the detected source description is garbage (same as base which is page chrome),
      // look for the best available translation to use as the actual source for translations.
      const sourceIsGarbage = sourceDesc.length < 120 ||
        normalize(sourceDesc) === normalize(baseDesc) && /^(Zum Hauptinhalt|Skip to|Aller au|Vai al|Springe)/i.test(baseDesc);
      if (sourceIsGarbage) {
        let bestLang = sourceLang;
        let bestLen = 0;
        for (const l of DEFAULT_LOCALES) {
          const d = String(job.descriptionByLocale[l] || '').trim();
          if (d.length > bestLen && normalize(d) !== normalize(baseDesc)) {
            bestLen = d.length;
            bestLang = l;
          }
        }
        if (bestLen >= 120 && bestLang !== sourceLang) {
          const prevSourceLang = sourceLang;
          sourceLang = bestLang;
          sourceDesc = String(job.descriptionByLocale[bestLang]).trim();
          console.log(`  ℹ️ ${baseTitle}: using [${bestLang}] (${bestLen} chars) as translation source instead of garbage [${prevSourceLang}]`);
        }
      }

      for (const locale of DEFAULT_LOCALES) {
        const currentTitle = String(job.titleByLocale[locale] || '').trim();
        const currentDesc = String(job.descriptionByLocale[locale] || '').trim();
        const titleNeedsWork =
          !currentTitle ||
          (locale !== titleSourceLang && normalize(currentTitle) === normalize(sourceTitle));
        const sourceDescriptionIsRich = sourceDesc.length >= minDescriptionChars;
        const isGarbageCopy = currentDesc && normalize(currentDesc) === normalize(baseDesc) &&
          baseDesc.length < 400 && /^(Zum Hauptinhalt|Skip to|Aller au|Vai al|Springe)/i.test(baseDesc);
        // Quality gate: translation is suspiciously thin — less than 30% of source length
        // while source is substantial (≥500 chars). Indicates the translation pipeline
        // produced a fallback boilerplate sentence instead of translating the full content.
        const isThinTranslation =
          locale !== sourceLang &&
          currentDesc.length > 0 &&
          sourceDesc.length >= 500 &&
          currentDesc.length < sourceDesc.length * 0.3;
        const descNeedsWork =
          !currentDesc ||
          isGarbageCopy ||
          isThinTranslation ||
          (sourceDescriptionIsRich && currentDesc.length < minDescriptionChars) ||
          (locale !== sourceLang && normalize(currentDesc) === normalize(sourceDesc));

        if (locale === titleSourceLang) {
          if (!String(job.titleByLocale[locale] || '').trim() && sourceTitle) {
            job.titleByLocale[locale] = sourceTitle;
            jobTranslated = true;
          }
        } else if (titleNeedsWork && sourceTitle) {
          const translatedTitle = await translateJobFieldWithFallback({
            text: sourceTitle,
            sourceLang: titleSourceLang,
            targetLang: locale,
            kind: 'title',
            context: {
              title: sourceTitle,
              company: job.company || '',
              location: job.location || '',
            },
            minChars: 2,
          });
          if (translatedTitle) {
            job.titleByLocale[locale] = String(translatedTitle).trim();
            jobTranslated = true;
          }
        }

        if (locale === sourceLang) {
          if (descNeedsWork && sourceDesc) {
            job.descriptionByLocale[locale] = sourceDesc;
            jobTranslated = true;
          }
        } else if (descNeedsWork && sourceDesc) {
          const translatedDesc = await translateJobFieldWithFallback({
            text: sourceDesc,
            sourceLang,
            targetLang: locale,
            kind: 'description',
            context: {
              title: sourceTitle,
              company: job.company || '',
              location: job.location || '',
            },
            minChars: Math.max(minDescriptionChars, 40),
          });
          if (translatedDesc) {
            job.descriptionByLocale[locale] = translatedDesc;
            jobTranslated = true;
          }
        }
      }

      if (jobTranslated) {
        changed = true;
        translated += 1;
        details.push({ company: job.company, slug: job.slug, sourceLang });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, limit || 1) }, () => worker())
  );

  // Post-translation: re-derive Italian slugs that still contain foreign words.
  // This catches cases where hardenJobLocaleFields ran before translations were available.
  const GERMAN_SLUG_RE = /(?:^|-)(?:als|und|fur|oder|frau|mann|fach|stelle|lehrstelle|lehre|mitarbeiter|leiter|stellvertretend|verkauf|lernend|chauffeu|gartencenter|befristet|ablosen|disponentin|disponent|ladenleit|logistiker|projektleiter|elektroinstallateur|elektroplaner|unterhaltsfachmann|servicetechniker|immobilienberater|bauleiter|zeichner|fachrichtung|ingenieurbau|tunnelbau|tiefbau|innendienst|generalagentur|vorsorge|vermogen|wissenschaftlich|detailhandels|bekampfung|japankafer|lager)(?:-|$)/i;
  const FRENCH_SLUG_RE = /(?:^|-)(?:apprentissage|gestionnaire|adjoint|auxiliaire|temporaire|vendeur|vendeuse|postes|vacants|gerante|gerant)(?:-|$)/i;
  for (const job of candidates) {
    const itSlug = String(job.slugByLocale?.it || '').trim();
    if (itSlug.length <= 20) continue;
    // Extract title portion of slug (strip company suffix)
    const companySuffix = (job.company || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    let titlePart = itSlug;
    if (companySuffix.length >= 5) {
      const idx = itSlug.indexOf(companySuffix.substring(0, Math.min(10, companySuffix.length)));
      if (idx > 3) titlePart = itSlug.substring(0, idx).replace(/-+$/, '');
    }
    if (!GERMAN_SLUG_RE.test(titlePart) && !FRENCH_SLUG_RE.test(titlePart)) continue;

    const itTitle = String(job.titleByLocale?.it || '').trim();
    if (!itTitle) continue;
    const company = String(job.company || '').trim();
    const location = String(job.addressLocality || job.location || '').trim();
    const parts = [itTitle, company, location].filter(Boolean).join('-');
    const derived = parts.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    if (derived && derived !== itSlug) {
      job.slugByLocale.it = derived;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, translated: 0, total: candidates.length, details: [] };
  }

  writeJson(dataJobsPath, raw);
  const publicJobsPath = inferPublicJobsPath(dataJobsPath);
  if (fs.existsSync(publicJobsPath)) {
    writeJson(publicJobsPath, raw);
  }
  return { changed: true, translated, total: candidates.length, details };
}

export function hardenJobsRichResultsData({ dataJobsPath }) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) {
    return { changed: false, updated: 0, total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    return { changed: false, updated: 0, total: 0 };
  }

  const { jobs: hardened, changed, updated, total } = hardenJobsWithStructuredSalary(raw);

  if (!changed) {
    return { changed: false, updated: 0, total };
  }

  writeJson(dataJobsPath, hardened);
  const publicJobsPath = inferPublicJobsPath(dataJobsPath);
  if (fs.existsSync(publicJobsPath)) {
    writeJson(publicJobsPath, hardened);
  }
  return { changed: true, updated, total, publicJobsPath };
}

/**
 * Run the shared crawler core with scoped company keys.
 */
export async function runDedicatedBaseCrawler({
  root,
  companyKeys,
  localizeOnlyCompanyKeys,
  forceLocalizeKeys,
  extraEnv = {},
  disableWorkdayForce = false,
  forceLocalizationWhenAiEnabledOnly = false,
  localizeExistingOnly = false,
}) {
  const scopedCompanyKeys = toNormalizedSet(companyKeys);
  if (scopedCompanyKeys.length === 0) {
    throw new Error('runDedicatedBaseCrawler requires at least one company key');
  }

  const localizeOnlyKeys = toNormalizedSet(
    localizeOnlyCompanyKeys === undefined ? scopedCompanyKeys : localizeOnlyCompanyKeys
  );
  const forcedKeys = toNormalizedSet(
    forceLocalizeKeys === undefined ? scopedCompanyKeys : forceLocalizeKeys
  );

  const existingRequested = toNormalizedKeyList(
    process.env.JOBS_CRAWLER_COMPANY_KEYS || process.env.JOBS_CRAWLER_COMPANY_KEY || ''
  );
  const mergedCompanyKeys = [...new Set([...existingRequested, ...scopedCompanyKeys])].join(',');

  const existingForced = toNormalizedKeyList(process.env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS || '');
  const mergedForcedKeys = [...new Set([...existingForced, ...forcedKeys])].join(',');

  const aiEnabled = String(process.env.JOBS_AI_LOCALIZATION_ENABLED || '1') !== '0';
  const shouldApplyForceLocalization = !forceLocalizationWhenAiEnabledOnly || aiEnabled;

  const env = {
    ...process.env,
    JOBS_CRAWLER_COMPANY_KEYS: mergedCompanyKeys,
    JOBS_AI_LOCALIZATION_ENABLED: process.env.JOBS_AI_LOCALIZATION_ENABLED || '1',
    JOBS_AI_MAX_JOBS_PER_RUN: process.env.JOBS_AI_MAX_JOBS_PER_RUN || '1200',
    // Dedicated crawlers write their own summary — skip the generic one from shared-jobs-crawler
    JOBS_SKIP_CRAWL_CHANGE_SUMMARY: '1',
    ...extraEnv,
  };

  if (disableWorkdayForce) {
    env.JOBS_FORCE_LOCALIZE_WORKDAY = '0';
  }

  if (shouldApplyForceLocalization) {
    if (mergedForcedKeys) {
      env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS = mergedForcedKeys;
    }
    if (localizeOnlyKeys.length > 0) {
      env.JOBS_CRAWLER_LOCALIZE_ONLY_COMPANY_KEYS = localizeOnlyKeys.join(',');
    }
  }

  if (localizeExistingOnly) {
    env.JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY = '1';
  }

  await runSharedCrawlerInProcess({ root, env });
}

export function validateDedicatedLocaleCoverage({
  strictEnvVar,
  label,
  dataJobsPath,
  jobsPath,
  isTargetJob,
  locales = DEFAULT_LOCALES,
  minTitleChars = 3,
  minDescriptionChars = 120,
  checkSlug = true,
  detectSourceLang = (text) => detectLang(text, 'it'),
  deriveSlug = deriveLocalizedSlug,
  isTrustedDomain,
  untrustedDomainReason,
  failOnMissingJobsFile = false,
  failWhenNoJobs = false,
  noJobsMessage,
  untranslatedCheck = true,
  sampleLimit = 30,
  minSourceDescriptionCharsForHardValidation = minDescriptionChars,
  maxToleratedMissingDescriptions = 0,
}) {
  const resolvedDataJobsPath = dataJobsPath || jobsPath;

  // Auto-repair missing locale fields before validation
  const localeHardening = hardenJobLocaleFields({ dataJobsPath: resolvedDataJobsPath });
  if (localeHardening.changed) {
    console.log(`🛡️ Locale hardening: repaired ${localeHardening.repaired}/${localeHardening.total} jobs (filled missing titleByLocale/descriptionByLocale/slugByLocale).`);
  }
  const hardening = hardenJobsRichResultsData({ dataJobsPath: resolvedDataJobsPath });
  if (hardening.changed) {
    console.log(`🛡️ Shared hardening: baseSalary fixed for ${hardening.updated}/${hardening.total} jobs.`);
  }

  const strict = String(process.env[strictEnvVar] || '1') !== '0';
  if (!strict) return;

  if (!resolvedDataJobsPath || !fs.existsSync(resolvedDataJobsPath)) {
    if (failOnMissingJobsFile) {
      throw new Error(`Missing ${resolvedDataJobsPath}`);
    }
    console.log('ℹ️ jobs.json non trovato — skip validazione locale.');
    return;
  }

  const raw = JSON.parse(fs.readFileSync(resolvedDataJobsPath, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw.filter(isTargetJob) : [];
  if (jobs.length === 0) {
    const message = noJobsMessage || `No ${label} jobs found after crawl.`;
    if (failWhenNoJobs) {
      throw new Error(message);
    }
    console.log(`ℹ️ ${message}`);
    return;
  }

  const blockingIssues = [];
  const softIssues = [];
  const thinSourceBySlug = new Map();
  for (const job of jobs) {
    const baseDesc = String(job?.description || '');
    const baseDescTrimmed = baseDesc.trim();
    const baseDescIsThin = baseDescTrimmed.length < minSourceDescriptionCharsForHardValidation;
    const baseTitle = String(job?.title || '').trim();
    const sourceLang = detectSourceLang(`${job?.title || ''} ${baseDesc}`, job);
    const titleSourceLang = detectJobTitleLang(
      String(job?.titleByLocale?.[sourceLang] || baseTitle),
      sourceLang,
    );
    if (typeof isTrustedDomain === 'function' && !isTrustedDomain(String(job?.url || ''))) {
      blockingIssues.push({
        slug: job.slug,
        locale: 'all',
        reason: untrustedDomainReason || 'untrusted_domain',
      });
    }

    for (const locale of locales) {
      const title = String(job?.titleByLocale?.[locale] || '');
      const desc = String(job?.descriptionByLocale?.[locale] || '');
      if (title.trim().length < minTitleChars) {
        blockingIssues.push({ slug: job.slug, locale, reason: 'missing_title' });
      }
      if (desc.trim().length < minDescriptionChars) {
        const issue = { slug: job.slug, locale, reason: 'missing_description' };
        if (baseDescIsThin) {
          softIssues.push(issue);
          if (!thinSourceBySlug.has(job.slug)) {
            thinSourceBySlug.set(job.slug, {
              job,
              issueReasons: new Set(),
            });
          }
          thinSourceBySlug.get(job.slug).issueReasons.add(issue.reason);
        } else blockingIssues.push(issue);
      }
      if (checkSlug) {
        const slug = deriveSlug(job, locale);
        if (!slug) {
          blockingIssues.push({ slug: job.slug, locale, reason: 'missing_slug' });
        }
      }
      if (
        untranslatedCheck &&
        locale !== sourceLang &&
        desc.trim() &&
        normalize(desc) === normalize(baseDesc)
      ) {
        const issue = { slug: job.slug, locale, reason: 'untranslated_description' };
        if (baseDescIsThin) {
          softIssues.push(issue);
          if (!thinSourceBySlug.has(job.slug)) {
            thinSourceBySlug.set(job.slug, {
              job,
              issueReasons: new Set(),
            });
          }
          thinSourceBySlug.get(job.slug).issueReasons.add(issue.reason);
        } else blockingIssues.push(issue);
      }
      // Check for untranslated titles (title identical to source-language title)
      if (
        untranslatedCheck &&
        locale !== sourceLang &&
        locale !== titleSourceLang &&
        title.trim() &&
        normalize(title) === normalize(String(job?.titleByLocale?.[titleSourceLang] || baseTitle || ''))
      ) {
        const locSlug = String(job?.slugByLocale?.[locale] || '');
        const srcSlug = String(job?.slugByLocale?.[titleSourceLang] || job?.slug || '');
        const hasLocalizedSlug =
          checkSlug &&
          locSlug &&
          srcSlug &&
          normalize(locSlug) !== normalize(srcSlug);
        if (!hasLocalizedSlug) {
          softIssues.push({ slug: job.slug, locale, reason: 'untranslated_title' });
        }
      }
      // Check for untranslated slugs (slug identical to source-language slug)
      if (
        untranslatedCheck &&
        checkSlug &&
        locale !== sourceLang &&
        locale !== titleSourceLang
      ) {
        const locSlug = String(job?.slugByLocale?.[locale] || '');
        const srcSlug = String(job?.slugByLocale?.[titleSourceLang] || job?.slug || '');
        if (locSlug && srcSlug && normalize(locSlug) === normalize(srcSlug)) {
          softIssues.push({ slug: job.slug, locale, reason: 'untranslated_slug' });
        }
      }
    }
  }

  if (blockingIssues.length > 0) {
    // Tolerate a small number of missing/untranslated description issues (translation providers are flaky)
    if (maxToleratedMissingDescriptions > 0) {
      const descIssues = blockingIssues.filter((i) => i.reason === 'missing_description' || i.reason === 'untranslated_description');
      const otherIssues = blockingIssues.filter((i) => i.reason !== 'missing_description' && i.reason !== 'untranslated_description');
      if (descIssues.length <= maxToleratedMissingDescriptions && otherIssues.length === 0) {
        const slugs = descIssues.map((i) => `${i.slug} [${i.locale}]`).join(', ');
        console.warn(`⚠️  Tolerating ${descIssues.length} missing/untranslated description(s) (max ${maxToleratedMissingDescriptions}): ${slugs}`);
        softIssues.push(...descIssues);
        blockingIssues.length = 0;
      }
    }
  }

  if (blockingIssues.length > 0) {
    const sample = blockingIssues
      .slice(0, sampleLimit)
      .map((i) => `- ${i.slug} [${i.locale}] ${i.reason}`)
      .join('\n');
    throw new Error(
      `${label} localization validation failed (${blockingIssues.length} issues).\n${sample}\nSet ${strictEnvVar}=0 to skip strict validation.`
    );
  }

  if (softIssues.length > 0) {
    const thinDiagnostics = [...thinSourceBySlug.values()].map(({ job, issueReasons }) => {
      const diagnosis = classifyThinSource(job, minSourceDescriptionCharsForHardValidation);
      return {
        slug: job?.slug || 'unknown',
        url: String(job?.url || ''),
        sourceLen: diagnosis.sourceLen,
        suspicious: diagnosis.suspicious,
        diagnosisReasons: diagnosis.reasons,
        issueReasons: [...issueReasons],
      };
    });
    const suspiciousThin = thinDiagnostics.filter((d) => d.suspicious);
    if (suspiciousThin.length > 0) {
      const sample = suspiciousThin
        .slice(0, sampleLimit)
        .map((d) => `- ${d.slug} len=${d.sourceLen} issues=${d.issueReasons.join(',')} diagnosis=${d.diagnosisReasons.join(',') || 'ultra_thin'} url=${d.url}`)
        .join('\n');
      throw new Error(
        `${label} thin-source investigation failed (${suspiciousThin.length} suspected crawl issues).\n${sample}\nInvestigate crawler extraction for these URLs before disabling strict validation.`
      );
    }

    const localeQualityIssues = softIssues.filter((i) => i.reason === 'untranslated_title' || i.reason === 'untranslated_slug');
    const thinSourceIssues = softIssues.filter((i) => i.reason !== 'untranslated_title' && i.reason !== 'untranslated_slug');
    if (thinSourceIssues.length > 0) {
      const sample = thinSourceIssues
        .slice(0, sampleLimit)
        .map((i) => `- ${i.slug} [${i.locale}] ${i.reason}`)
        .join('\n');
      const diagSample = thinDiagnostics
        .slice(0, sampleLimit)
        .map((d) => `- ${d.slug} len=${d.sourceLen} issues=${d.issueReasons.join(',')} url=${d.url}`)
        .join('\n');
      console.log(
        `⚠️ ${label} localization soft issues (${thinSourceIssues.length}) kept as warning: source descriptions are short (<${minSourceDescriptionCharsForHardValidation} chars) but no crawl-bug signal detected.\n${sample}\n🔎 Thin-source diagnostics:\n${diagSample}`
      );
    }
    if (localeQualityIssues.length > 0) {
      const sample = localeQualityIssues
        .slice(0, sampleLimit)
        .map((i) => `- ${i.slug} [${i.locale}] ${i.reason}`)
        .join('\n');
      console.log(
        `⚠️ ${label} locale quality issues (${localeQualityIssues.length}): untranslated titles or slugs detected — re-run crawler with forced re-localization.\n${sample}`
      );
    }
  }

  console.log(`✅ ${label} localization validation passed for ${jobs.length} jobs (${locales.length} locales).`);
}
