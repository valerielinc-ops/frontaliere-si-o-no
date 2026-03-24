import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { detectLanguage } from './detect-language.mjs';
import { freeTranslateWithRetry } from './free-translate.mjs';
import {
  translateTextWithLocalPipeline,
  localizeJobContentWithPipeline,
} from './job-localization-pipeline.mjs';
import { hardenJobsWithStructuredSalary } from './structured-salary.mjs';
import { normalizeCantonCode, isTargetSwissLocation, TICINO_CITIES } from './target-swiss-locations.mjs';
let _aiModels = null;
try { _aiModels = await import('./ai-models.mjs'); } catch { /* ai-models not available */ }
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

/** Known company boilerplate fragments that leak into slugs when description text
 *  is accidentally included in the slug source. */
const SLUG_BOILERPLATE_RE = /permette-di-combinare-efficacemente|garantendo-alla-popolaz|visione-d-insieme-garantendo|approccio-locale-e-visione/;
function needsBoilerplateSlugRepair(slug = '') {
  return SLUG_BOILERPLATE_RE.test(String(slug || '').trim());
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
      // English-source job titles → Italian (merged from shared-jobs-crawler)
      [/\bInternship Program\b/gi, 'Programma di stage'],
      [/\bIntern\b/gi, 'Tirocinante'],
      [/\bCoordinator\b/gi, 'Coordinatore'],
      [/\bSpecialist\b/gi, 'Specialista'],
      [/\bAnalyst\b/gi, 'Analista'],
      [/\bEngineer\b/gi, 'Ingegnere'],
      [/\bMaternity Cover\b/gi, 'Sostituzione maternità'],
      [/\bPaid Media\b/gi, 'Media a pagamento'],
      [/\bFull[\s-]?time\b/gi, 'Tempo pieno'],
      [/\bPart[\s-]?time\b/gi, 'Part-time'],
      [/\bDirector\b/gi, 'Direttore'],
      [/\bDeveloper\b/gi, 'Sviluppatore'],
      [/\bSoftware Developer\b/gi, 'Sviluppatore Software'],
      [/\bConsultant\b/gi, 'Consulente'],
      [/\bAdvisor\b/gi, 'Consulente'],
      [/\bAccountant\b/gi, 'Contabile'],
      [/\bSupervisor\b/gi, 'Supervisore'],
      [/\bOperator\b/gi, 'Operatore'],
      [/\bArchitect\b/gi, 'Architetto'],
      [/\bHead of\b/gi, 'Responsabile'],
      [/\bTeam Lead\b/gi, 'Capo Team'],
      [/\bHuman Resources\b/gi, 'Risorse Umane'],
      [/\bHR\b/g, 'Risorse Umane'],
      [/\bFinance\b/gi, 'Finanza'],
      [/\bSupply Chain\b/gi, 'Supply Chain'],
      [/\bLogistics\b/gi, 'Logistica'],
      [/\bCustomer Service\b/gi, 'Servizio Clienti'],
      [/\bResearch\b/gi, 'Ricerca'],
      [/\bTrainee\b/gi, 'Apprendista'],
      [/\bApprenticeship\b/gi, 'Apprendistato'],
    ],
    de: [
      // Italian machining/industrial job titles → German (operator, not machine)
      [/\bFresatore\b/gi, 'Fräser'],
      [/\bTornitore\b/gi, 'Dreher'],
      [/\bSmerigliatore\b/gi, 'Schleifer'],
      // English-source job titles → German (merged from shared-jobs-crawler)
      [/\bInternship Program\b/gi, 'Praktikumsprogramm'],
      [/\bIntern\b/gi, 'Praktikant'],
      [/\bCoordinator\b/gi, 'Koordinator'],
      [/\bSpecialist\b/gi, 'Spezialist'],
      [/\bAnalyst\b/gi, 'Analyst'],
      [/\bEngineer\b/gi, 'Ingenieur'],
      [/\bAssistant\b/gi, 'Assistent'],
      [/\bMaternity Cover\b/gi, 'Mutterschaftsvertretung'],
      [/\bFull[\s-]?time\b/gi, 'Vollzeit'],
      [/\bPart[\s-]?time\b/gi, 'Teilzeit'],
      [/\bDirector\b/gi, 'Direktor'],
      [/\bDeveloper\b/gi, 'Entwickler'],
      [/\bSoftware Developer\b/gi, 'Softwareentwickler'],
      [/\bConsultant\b/gi, 'Berater'],
      [/\bAdvisor\b/gi, 'Berater'],
      [/\bAccountant\b/gi, 'Buchhalter'],
      [/\bSupervisor\b/gi, 'Vorgesetzter'],
      [/\bTechnician\b/gi, 'Techniker'],
      [/\bHead of\b/gi, 'Leiter'],
      [/\bTeam Lead\b/gi, 'Teamleiter'],
      [/\bHuman Resources\b/gi, 'Personalwesen'],
      [/\bHR\b/g, 'Personalwesen'],
      [/\bFinance\b/gi, 'Finanzen'],
      [/\bSupply Chain\b/gi, 'Lieferkette'],
      [/\bLogistics\b/gi, 'Logistik'],
      [/\bCustomer Service\b/gi, 'Kundendienst'],
      [/\bQuality\b/gi, 'Qualität'],
      [/\bResearch\b/gi, 'Forschung'],
      [/\bTrainee\b/gi, 'Auszubildender'],
      [/\bApprenticeship\b/gi, 'Ausbildung'],
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
      // English-source job titles → French (merged from shared-jobs-crawler)
      [/\bInternship Program\b/gi, 'Programme de stage'],
      [/\bIntern\b/gi, 'Stagiaire'],
      [/\bCoordinator\b/gi, 'Coordinateur'],
      [/\bSpecialist\b/gi, 'Spécialiste'],
      [/\bAnalyst\b/gi, 'Analyste'],
      [/\bEngineer\b/gi, 'Ingénieur'],
      [/\bAssistant\b/gi, 'Assistant'],
      [/\bMaternity Cover\b/gi, 'Remplacement maternité'],
      [/\bPaid Media\b/gi, 'Médias payants'],
      [/\bFull[\s-]?time\b/gi, 'Temps plein'],
      [/\bPart[\s-]?time\b/gi, 'Temps partiel'],
      [/\bDirector\b/gi, 'Directeur'],
      [/\bDeveloper\b/gi, 'Développeur'],
      [/\bSoftware Developer\b/gi, 'Développeur logiciel'],
      [/\bConsultant\b/gi, 'Consultant'],
      [/\bAdvisor\b/gi, 'Conseiller'],
      [/\bAccountant\b/gi, 'Comptable'],
      [/\bSupervisor\b/gi, 'Superviseur'],
      [/\bTechnician\b/gi, 'Technicien'],
      [/\bOperator\b/gi, 'Opérateur'],
      [/\bArchitect\b/gi, 'Architecte'],
      [/\bHead of\b/gi, 'Responsable'],
      [/\bTeam Lead\b/gi, "Chef d'équipe"],
      [/\bHuman Resources\b/gi, 'Ressources Humaines'],
      [/\bHR\b/g, 'Ressources Humaines'],
      [/\bFinance\b/gi, 'Finance'],
      [/\bSupply Chain\b/gi, "Chaîne d'approvisionnement"],
      [/\bLogistics\b/gi, 'Logistique'],
      [/\bCustomer Service\b/gi, 'Service Client'],
      [/\bQuality\b/gi, 'Qualité'],
      [/\bResearch\b/gi, 'Recherche'],
      [/\bTrainee\b/gi, 'Apprenti'],
      [/\bApprenticeship\b/gi, 'Apprentissage'],
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
    delete map[locale];  // Only delete source when we successfully moved to target
    return true;
  }
  // Target already has content — can't rehome without overwriting. Leave source intact.
  return false;
}

/** Check if a slug plausibly matches a title (prefix or first 4 words overlap). */
function slugMatchesTitle(slug, title) {
  const slugified = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Compare the first 50 chars — wider window to tolerate minor title variations
  const prefix = slugified.slice(0, 50);
  if (prefix.length >= 8 && slug.startsWith(prefix)) return true;
  // Fallback: the first 4 words of the title must appear in the slug
  const titleWords = slugified.split('-').slice(0, 4).join('-');
  return titleWords.length >= 10 && slug.includes(titleWords);
}

export function hardenJobLocaleFields({ dataJobsPath }) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) {
    return { changed: false, repaired: 0, total: 0 };
  }
  const parsed = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
  // Support both flat array format and { jobs: [...] } wrapper format
  const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : null);
  const isWrapped = !Array.isArray(parsed) && Array.isArray(parsed?.jobs);
  if (!raw) {
    return { changed: false, repaired: 0, total: 0 };
  }

  let changed = false;
  let repaired = 0;
  const slugChangeCount = {};

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
        // Don't delete — keeping wrong-language placeholder is better than empty.
        // Deploy has no AI access; deleting here would leave the locale empty and
        // block the deploy gate. Flag for retranslation; the translate pipeline
        // will delete-and-retranslate when AI is available.
        job.needsRetranslation = true;
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
          // Don't delete — keeping wrong-language placeholder is better than empty.
          // Deploy has no AI access; deleting here would leave the locale empty and
          // block the deploy gate. Flag for retranslation; the translate pipeline
          // will delete-and-retranslate when AI is available.
          job.needsRetranslation = true;
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
      // locales (slug still matches untranslated base or contains foreign words).
      {
        const existingSlug = String(job.slugByLocale[locale] || '').trim();
        const localizedTitle = String(job.titleByLocale[locale] || '').trim();
        const isSourceLocale = locale === titleSourceLang;
        // FRO-284: Detect foreign words in slug (e.g. German compound words in IT slug)
        // German compound words are typically 15+ chars without hyphens
        const FOREIGN_WORD_PATTERN = /(?:^|-)([a-z]{15,})(?:-|$)/;
        const hasForeignWord = !isSourceLocale && existingSlug && FOREIGN_WORD_PATTERN.test(existingSlug);
        const isStaleSlug = isSourceLocale
          // Source locale: re-derive if slug doesn't start with a slug-ified prefix of current title
          ? existingSlug && localizedTitle && !slugMatchesTitle(existingSlug, localizedTitle)
          // Non-source locale: re-derive if slug matches untranslated base OR contains foreign words
          : (existingSlug && existingSlug === baseSlug && localizedTitle && localizedTitle !== baseTitle)
            || (hasForeignWord && localizedTitle);
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
            const reason = 'stale_slug';
            slugChangeCount[reason] = (slugChangeCount[reason] || 0) + 1;
            console.log(`  🔄 SLUG [${locale}] ${reason}: ${job.companyKey || job.company} | ${existingSlug} → ${derived}`);
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
          // FRO-263: Don't blindly copy foreign-language title as a fallback for
          // a different locale (e.g. DE title → IT field). This was causing
          // Coop Grigioni DE titles to appear under titleByLocale.it.
          // Only copy if the source language matches this locale OR if it's the
          // source language slot itself.
          if (locale === sourceLang || locale === titleSourceLang) {
            job.titleByLocale[locale] = sourceTitleFallback;
            jobChanged = true;
          }
          // Other locales left empty — will be filled by AI translation pipeline
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
      const isSlugMeaningful = localizedSlug && localizedSlug.length >= 15;
      const shouldRefreshSlug =
        !localizedSlug ||
        (!isSlugMeaningful && localizedSlug === baseSlug) ||
        (locale === 'it' && needsItalianSlugRepair(localizedSlug)) ||
        needsCanonicalCompanySlugRepair(localizedSlug, company) ||
        needsBoilerplateSlugRepair(localizedSlug);

      if (shouldRefreshSlug && nextSlug && nextSlug !== localizedSlug) {
        const reason = !localizedSlug ? 'missing'
          : (!isSlugMeaningful && localizedSlug === baseSlug) ? 'short_base_match'
          : (locale === 'it' && needsItalianSlugRepair(localizedSlug)) ? 'italian_repair'
          : needsBoilerplateSlugRepair(localizedSlug) ? 'boilerplate_repair'
          : 'company_repair';
        slugChangeCount[reason] = (slugChangeCount[reason] || 0) + 1;
        console.log(`  🔄 SLUG [${locale}] ${reason}: ${job.companyKey || job.company} | ${localizedSlug || '(empty)'} → ${nextSlug}`);
        job.slugByLocale[locale] = nextSlug;
        jobChanged = true;
      }
    }

    const canonicalItSlug = String(job.slugByLocale.it || '').trim();
    if (canonicalItSlug) {
      const currentCanonicalSlug = String(job.slug || '').trim();
      if (!currentCanonicalSlug || currentCanonicalSlug === baseSlug || needsItalianSlugRepair(currentCanonicalSlug) || needsBoilerplateSlugRepair(currentCanonicalSlug)) {
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

  // Log slug change summary
  const totalSlugChanges = Object.values(slugChangeCount).reduce((a, b) => a + b, 0);
  if (totalSlugChanges > 0) {
    console.log(`📊 Slug changes this run: ${totalSlugChanges} total — ${JSON.stringify(slugChangeCount)}`);
  }

  // Alert for jobs approaching the previousSlugs cap (20)
  const instableJobs = raw.filter(j => Array.isArray(j.previousSlugs) && j.previousSlugs.length >= 10);
  if (instableJobs.length > 0) {
    console.warn(`⚠️  SLUG INSTABILITY ALERT: ${instableJobs.length} job(s) with 10+ previousSlugs:`);
    for (const job of instableJobs.slice(0, 10)) {
      console.warn(`  - ${job.company}: ${job.slug} (${job.previousSlugs.length} alias)`);
    }
    if (instableJobs.length > 10) {
      console.warn(`  ... and ${instableJobs.length - 10} more`);
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
 * @param {string} [options.companySlug] - Company slug for translation cache file name
 * @returns {Promise<{changed: boolean, translated: number, total: number, details: Array}>}
 */

// ── Translation Cache (FRO-324) ──────────────────────────────────────────
// Avoids re-translating jobs whose title+description haven't changed.
// Cache lives in data/translation-cache/{companySlug}.json.
// TTL: 30 days — after that, force re-translation.
const TRANSLATION_CACHE_DIR = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'translation-cache');
const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function computeContentHash(title, description) {
  return createHash('sha256').update(`${title || ''}|${description || ''}`).digest('hex');
}

function loadTranslationCache(companySlug) {
  const filePath = path.join(TRANSLATION_CACHE_DIR, `${companySlug}.json`);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveTranslationCache(companySlug, cache) {
  if (!fs.existsSync(TRANSLATION_CACHE_DIR)) {
    fs.mkdirSync(TRANSLATION_CACHE_DIR, { recursive: true });
  }
  const filePath = path.join(TRANSLATION_CACHE_DIR, `${companySlug}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

function deriveCompanySlug(jobs) {
  const company = (jobs[0]?.company || 'unknown').trim();
  return company.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isTranslationCacheValid(entry) {
  if (!entry || !entry.hash || !entry.cachedAt) return false;
  return (Date.now() - new Date(entry.cachedAt).getTime()) < TRANSLATION_CACHE_TTL_MS;
}

function applyTranslationCache(job, cacheEntry) {
  const translations = cacheEntry.translations || {};
  let applied = false;
  for (const locale of DEFAULT_LOCALES) {
    if (translations.titles?.[locale] && !String(job.titleByLocale?.[locale] || '').trim()) {
      if (!job.titleByLocale) job.titleByLocale = {};
      job.titleByLocale[locale] = translations.titles[locale];
      applied = true;
    }
    if (translations.descriptions?.[locale] && !String(job.descriptionByLocale?.[locale] || '').trim()) {
      if (!job.descriptionByLocale) job.descriptionByLocale = {};
      job.descriptionByLocale[locale] = translations.descriptions[locale];
      applied = true;
    }
  }
  return applied;
}

function buildCacheEntry(job, hash) {
  const titles = {};
  const descriptions = {};
  for (const locale of DEFAULT_LOCALES) {
    const t = String(job.titleByLocale?.[locale] || '').trim();
    const d = String(job.descriptionByLocale?.[locale] || '').trim();
    if (t) titles[locale] = t;
    if (d) descriptions[locale] = d;
  }
  return { hash, translations: { titles, descriptions }, cachedAt: new Date().toISOString() };
}

// ────────────────────────────────────────────────────────────────────────────
// FRO-234: Localization pipeline — extracted from shared-jobs-crawler.mjs
// ────────────────────────────────────────────────────────────────────────────

const MAX_DESC_CHARS = 12000;

/**
 * Strip HTML tags and decode common entities (basic version for localization pipeline).
 */
export function stripHtmlBasic(s) {
  return normalize(
    String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

export function stripCodeFenceJson(text = '') {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** Known noise phrases that mark the end of useful job description content. */
const DESCRIPTION_NOISE_PATTERNS = [
  // IT
  /\bCandidati ora\b.*$/is,
  /\bInvia la tua candidatura\b.*$/is,
  /\bAvvia la candidatura con LinkedIn.*$/is,
  /\bInformazioni per le agenzie di reclutamento\b.*$/is,
  /\bRespingiamo ogni responsabilità sia per candidature non richieste.*$/is,
  /\bTrova offerte simili\s*:.*$/is,
  // EN
  /\bApply now\s*[»>].*$/is,
  /\bStart application with LinkedIn.*$/is,
  /\bInformation for recruitment agencies\b.*$/is,
  /\bWe reject all responsibility for unsolicited applications.*$/is,
  /\bFind similar offers\s*:.*$/is,
  // DE
  /\bJetzt bewerben\s*[»>].*$/is,
  /\bBewerbung mit LinkedIn starten.*$/is,
  /\bInformationen für Personalvermittlungsagenturen\b.*$/is,
  /\bWir lehnen jede Verantwortung für unaufgeforderte Bewerbungen.*$/is,
  /\bÄhnliche Angebote finden\s*:.*$/is,
  // FR
  /\bPostuler maintenant\s*[»>].*$/is,
  /\bDémarrer la candidature avec LinkedIn.*$/is,
  /\bInformations pour les agences de recrutement\b.*$/is,
  /\bNous déclinons toute responsabilité pour les candidatures non sollicitées.*$/is,
  /\bTrouver des offres similaires\s*:.*$/is,
  // Generic tail fragments (nav links / legal)
  /\s*-\s*Privacy\s*-\s*Terms of Use\s*-\s*Cookies\s*$/i,
  /\s*-\s*Confidentialité\s*-\s*Conditions d'utilisation\s*-\s*Cookies\s*$/i,
  /\s*-\s*Datenschutz\s*-\s*Nutzungsbedingungen\s*-\s*Cookies\s*$/i,
  /\s*-\s*Privacy\s*-\s*Termini di utilizzo\s*-\s*Cookies\s*$/i,
  // Rexx Systems ATS (concorsi.ti.ch) — footer nav and noise
  /\bIndietro\b\s*\n?\s*\bcandidatura online\s*[»>]?\s*$/is,
  /\bcandidatura online\s*[»>]?\s*$/is,
  /\bIndietro\b\s*$/i,
  /\bStampa\s*$/i,
  /\bJavascript non riconosciuto\b.*$/is,
  /\bFoglio Ufficiale\s*(?:n[.°]?\s*\d+)?.*$/im,
];

function stripDescriptionBoilerplate(text) {
  let cleaned = text;
  for (const re of DESCRIPTION_NOISE_PATTERNS) {
    cleaned = cleaned.replace(re, '').trim();
  }
  cleaned = cleaned.replace(/[\s·•|\-]+$/, '').trim();
  return cleaned;
}

/**
 * Clean a job description: strip HTML, boilerplate, and normalize whitespace.
 */
export function cleanDescriptionDCC(desc) {
  let text = stripHtmlBasic(desc);
  text = text
    .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
    .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
    .replace(/\*{2,}([^*]+)\*{2,}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  text = stripDescriptionBoilerplate(text);
  if (text.length > MAX_DESC_CHARS) text = text.slice(0, MAX_DESC_CHARS).trim();
  return text;
}

/**
 * Extract requirement bullets from a description text.
 */
export function extractRequirementsFromText(description) {
  const text = normalize(description);
  if (!text) return [];
  const lines = text
    .split(/[\n\r•·]+|(?<=[.!?;:])\s+/)
    .map((x) => normalize(String(x || '').replace(/^[)\]}\-–—:.,\s]+/, '')))
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.length < 14 || line.length > 120) continue;
    if (!/[a-zà-öø-ÿ]{3,}/i.test(line)) continue;
    if (/\b(streamlined recruitment process|interview|privacy|cookie|wishlist|newsletter|all rights reserved|hiring manager|recruiter|business case)\b/i.test(line)) continue;
    if (/\b(how you will make a difference|skills that will make you succeed|skills for success|eligibility requirements)\b/i.test(line)) continue;
    if (/^[)\]}\-–—:.,\s]+$/.test(line)) continue;
    if (!/(esperienza|experience|skills?|requirements?|requisiti|laurea|degree|language|lingua|english|italian|tedesco|francese|deutsch|français|python|java|excel|sap|sql|communication|teamwork|problem solving|analytical)/i.test(line)) continue;
    out.push(line);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Convert HTML to structured text (markdown-like) for descriptions.
 * @param {string} html
 * @param {function} [cleanFn] - optional cleanDescription function override
 */
export function htmlToStructuredTextDCC(html, cleanFn) {
  if (!html) return '';
  const clean = cleanFn || cleanDescriptionDCC;
  let text = String(html)
    .replace(/<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi, '\n## $1\n')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return clean(text);
}

// ── Localization pipeline context ──
// These functions accept a `ctx` object with SJC's internal state:
//   ctx.buildAiCacheKey(prefix, parts)
//   ctx.getCachedAiResponse(cacheKey)
//   ctx.setCachedAiResponse(cacheKey, value)
//   ctx.AI_CACHE_RAW_SENTINEL
//   ctx.LOCALES
//   ctx.FORCE_LOCALIZE_COMPANY_KEYS  (Set)
//   ctx.FORCE_LOCALIZE_WORKDAY       (boolean)
//   ctx.LOCALIZE_ONLY_COMPANY_KEYS   (Set)
//   ctx.cleanDescription(desc)
//   ctx.stripCodeFenceJson(text)
//   ctx.normalizeSpace(s)
//   ctx.normalizeHost(host)
//   ctx.hostOf(url)
//   ctx.normalizeCompanyKey(input)
//   ctx.isLowQualityLocalizedTitle(value)
//   ctx.mergeRequirements(a, b)
//   ctx.callLLM(messages, opts)
//   ctx.isAnyModelAvailable()
//   ctx.extractRequirements(desc)
//   ctx.structureJobDescription(rawText)
//   ctx.htmlToStructuredText(html)
//   ctx.aiEnrichThinDescription(job)
//   ctx.aiLocalizationCalls (getter/setter via ctx.getAiLocalizationCalls() / ctx.incrAiLocalizationCalls())
//   ctx.deeplFallbackToLlm (getter/setter via ctx.getDeeplFallbackToLlm() / ctx.incrDeeplFallbackToLlm())

export function shouldForceLocalizationForJob(job = {}, ctx = {}) {
  const { FORCE_LOCALIZE_COMPANY_KEYS, FORCE_LOCALIZE_WORKDAY, normalizeCompanyKey: nck, normalizeHost: nh, hostOf: ho } = ctx;
  if (!FORCE_LOCALIZE_COMPANY_KEYS || !nck) return false;
  const key = nck(job.companyKey || job.company || '');
  if (key && FORCE_LOCALIZE_COMPANY_KEYS.has(key)) return true;
  const host = nh(ho(job.url || ''));
  if (FORCE_LOCALIZE_COMPANY_KEYS.has(nck(host))) return true;
  if (FORCE_LOCALIZE_WORKDAY && (/(^|[.-])vfc\.com$/.test(host) || host.includes('myworkdayjobs.com'))) return true;
  return false;
}

export function isLocalizationAllowedForJob(job = {}, ctx = {}) {
  const { LOCALIZE_ONLY_COMPANY_KEYS, normalizeCompanyKey: nck, normalizeHost: nh, hostOf: ho } = ctx;
  if (!(LOCALIZE_ONLY_COMPANY_KEYS instanceof Set) || LOCALIZE_ONLY_COMPANY_KEYS.size === 0) return true;
  const key = nck(job.companyKey || job.company || '');
  if (key && LOCALIZE_ONLY_COMPANY_KEYS.has(key)) return true;
  const host = nh(ho(job.url || ''));
  if (LOCALIZE_ONLY_COMPANY_KEYS.has(nck(host))) return true;
  return false;
}

export function hasUntranslatedLocaleDescriptions(job = {}, ctx = {}) {
  const clean = ctx.cleanDescription || cleanDescriptionDCC;
  const LOCALES = ctx.LOCALES || DEFAULT_LOCALES;
  const sourceDesc = clean(job?.description || '');
  if (!sourceDesc) return false;
  const sourceLang = detectLanguage(sourceDesc, 'en');
  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const localized = clean(job?.descriptionByLocale?.[locale] || '');
    if (!localized) return true;
    if (localized.toLowerCase() === sourceDesc.toLowerCase()) return true;
  }
  return false;
}

export function hasUntranslatedLocaleTitles(job = {}, ctx = {}) {
  const LOCALES = ctx.LOCALES || DEFAULT_LOCALES;
  const ns = ctx.normalizeSpace || ((s) => String(s || '').replace(/\s+/g, ' ').trim());
  const sourceTitle = ns(job?.title || '');
  if (!sourceTitle) return false;
  const sourceLang = detectJobTitleLang(sourceTitle, detectLanguage(job?.description || '', 'en'));
  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const localized = ns(job?.titleByLocale?.[locale] || '');
    if (!localized) return true;
    if (localized.toLowerCase() === sourceTitle.toLowerCase()) return true;
  }
  return false;
}

export async function aiTranslateJobDescriptionDCC({ description, locale, sourceLang = 'en', minChars = 120 }, ctx = {}) {
  const {
    cleanDescription: clean, buildAiCacheKey, getCachedAiResponse, setCachedAiResponse,
    AI_CACHE_RAW_SENTINEL, callLLM, isAnyModelAvailable, stripCodeFenceJson: scfj,
  } = ctx;
  const floor = Math.max(minChars, 40);
  const cleanDesc = (clean || cleanDescriptionDCC)(description || '');
  if (!cleanDesc || cleanDesc.length < floor) return '';
  if (locale === sourceLang) return cleanDesc;

  // Local pipeline first
  const localPipeline = await translateTextWithLocalPipeline({
    text: cleanDesc, sourceLang, targetLang: locale, kind: 'description', minChars: floor,
  });
  if (localPipeline && localPipeline.toLowerCase() !== cleanDesc.toLowerCase()) return localPipeline;

  // AI cache check
  if (buildAiCacheKey && getCachedAiResponse) {
    const cacheKey = buildAiCacheKey('translate-desc-v2', [cleanDesc, locale, sourceLang]);
    const fromCache = getCachedAiResponse(cacheKey);
    if (typeof fromCache === 'string') {
      if (fromCache !== AI_CACHE_RAW_SENTINEL) return fromCache;
      const sentinelFallback = await freeTranslateWithRetry({ text: cleanDesc, sourceLang, targetLang: locale });
      if (sentinelFallback && sentinelFallback.length >= floor && sentinelFallback.toLowerCase() !== cleanDesc.toLowerCase()) {
        setCachedAiResponse(cacheKey, sentinelFallback);
        return sentinelFallback;
      }
      return '';
    }
    // DeepL first
    const deepl = await freeTranslateWithRetry({ text: cleanDesc, sourceLang, targetLang: locale });
    if (deepl && deepl.length >= floor) {
      setCachedAiResponse(cacheKey, deepl);
      return deepl;
    }
    // LLM fallback
    const prompt = [
      `Translate this job description from ${sourceLang} to ${locale}.`,
      'Rules:',
      '- Keep company names, product names, acronyms unchanged.',
      '- Do not invent or add new facts.',
      '- Preserve the COMPLETE content — translate every paragraph, section, and detail without summarizing or shortening.',
      '- Keep clear paragraphs and preserve meaning.',
      '- Return only translated text, no markdown, no quotes.',
      '',
      cleanDesc,
    ].join('\n');
    if (isAnyModelAvailable && isAnyModelAvailable()) {
      if (ctx.incrDeeplFallbackToLlm) ctx.incrDeeplFallbackToLlm();
      try {
        const text = await callLLM([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 8192, jsonMode: false });
        const translated = (clean || cleanDescriptionDCC)((scfj || stripCodeFenceJson)(String(text || '')));
        if (translated.length >= floor && translated.toLowerCase() !== cleanDesc.toLowerCase()) {
          setCachedAiResponse(cacheKey, translated);
          return translated;
        }
      } catch { /* fallback below */ }
    }
    const fallback = await freeTranslateWithRetry({ text: cleanDesc, sourceLang, targetLang: locale });
    if (fallback && fallback.length >= floor && fallback.toLowerCase() !== cleanDesc.toLowerCase()) {
      setCachedAiResponse(cacheKey, fallback);
      return fallback;
    }
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return '';
  }

  // No cache — simple free-translate fallback
  const simple = await freeTranslateWithRetry({ text: cleanDesc, sourceLang, targetLang: locale });
  return (simple && simple.length >= floor) ? simple : '';
}

export async function aiTranslateJobTitleDCC({ title, locale, sourceLang = 'en' }, ctx = {}) {
  const {
    buildAiCacheKey, getCachedAiResponse, setCachedAiResponse,
    AI_CACHE_RAW_SENTINEL, callLLM, isAnyModelAvailable,
    isLowQualityLocalizedTitle, normalizeSpace: ns,
  } = ctx;
  const cleanTitle = (ns || normalize)(title || '');
  if (!cleanTitle || locale === sourceLang) return cleanTitle;

  // Local pipeline first
  const localPipeline = await translateTextWithLocalPipeline({
    text: cleanTitle, sourceLang, targetLang: locale, kind: 'title', context: { title: cleanTitle }, minChars: 2,
  });
  if (localPipeline && localPipeline.toLowerCase() !== cleanTitle.toLowerCase()) return localPipeline;

  if (buildAiCacheKey && getCachedAiResponse) {
    const cacheKey = buildAiCacheKey('translate-title-v2', [cleanTitle, locale, sourceLang]);
    const fromCache = getCachedAiResponse(cacheKey);
    if (typeof fromCache === 'string') {
      if (fromCache !== AI_CACHE_RAW_SENTINEL) return fromCache;
      const sentinelFallback = await freeTranslateWithRetry({ text: cleanTitle, sourceLang, targetLang: locale });
      if (sentinelFallback && sentinelFallback.toLowerCase() !== cleanTitle.toLowerCase() &&
          !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(sentinelFallback))) {
        setCachedAiResponse(cacheKey, sentinelFallback);
        return sentinelFallback;
      }
      return cleanTitle;
    }
    // DeepL first
    const deepl = await freeTranslateWithRetry({ text: cleanTitle, sourceLang, targetLang: locale });
    if (deepl && deepl.length >= 2 && !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(deepl))) {
      setCachedAiResponse(cacheKey, deepl);
      return deepl;
    }
    // LLM fallback
    if (isAnyModelAvailable && isAnyModelAvailable()) {
      if (ctx.incrDeeplFallbackToLlm) ctx.incrDeeplFallbackToLlm();
      const prompt = [
        `Translate this job title from ${sourceLang} to ${locale}.`,
        'Rules:',
        '- Keep brand names/acronyms unchanged.',
        '- Translate role words naturally for the target locale.',
        '- Return only the translated title, no quotes, no extra text.',
        `Title: ${cleanTitle}`,
      ].join('\n');
      try {
        const text = await callLLM([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 80, jsonMode: false });
        const translated = (ns || normalize)(String(text || '').replace(/^["']|["']$/g, ''));
        if (translated && translated.toLowerCase() !== cleanTitle.toLowerCase() &&
            !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(translated))) {
          setCachedAiResponse(cacheKey, translated);
          return translated;
        }
      } catch { /* fallback below */ }
    }
    const fallback = await freeTranslateWithRetry({ text: cleanTitle, sourceLang, targetLang: locale });
    if (fallback) {
      setCachedAiResponse(cacheKey, fallback);
      return fallback;
    }
    const heuristic = heuristicTranslateJobTitle(cleanTitle, locale);
    if (heuristic && !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(heuristic))) {
      setCachedAiResponse(cacheKey, heuristic);
      return heuristic;
    }
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return cleanTitle;
  }

  // No cache — simple fallback
  const simple = await freeTranslateWithRetry({ text: cleanTitle, sourceLang, targetLang: locale });
  if (simple) return simple;
  return heuristicTranslateJobTitle(cleanTitle, locale) || cleanTitle;
}

export async function aiLocalizeJobContentDCC({ title, company, location, description, requirements, sourceLang, maxLocales = 4, minChars = 120 }, ctx = {}) {
  const {
    cleanDescription: clean, buildAiCacheKey, getCachedAiResponse, setCachedAiResponse,
    AI_CACHE_RAW_SENTINEL, callLLM, isAnyModelAvailable, stripCodeFenceJson: scfj,
    normalizeSpace: ns, LOCALES,
  } = ctx;
  const cleanFn = clean || cleanDescriptionDCC;
  const nsFn = ns || normalize;
  const scfjFn = scfj || stripCodeFenceJson;
  const locales = LOCALES || DEFAULT_LOCALES;
  const floor = Math.max(minChars, 40);
  if (!description || description.length < Math.max(floor, 180)) return null;
  const targetLocales = locales.slice(0, maxLocales).filter((l) => l !== sourceLang);

  // Local pipeline first
  const localPipeline = await localizeJobContentWithPipeline({
    title, company, location, description, requirements, sourceLang, targetLocales,
  });
  if (localPipeline) return localPipeline;

  if (!buildAiCacheKey || !getCachedAiResponse) return null;

  const cacheKey = buildAiCacheKey('localize-job-v2', [
    nsFn(title || ''), nsFn(company || ''), nsFn(location || ''),
    sourceLang || 'en', targetLocales.join(','),
    JSON.stringify((requirements || []).map((x) => nsFn(String(x))).filter(Boolean).slice(0, 16)),
    cleanFn(description || ''),
  ]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (fromCache === AI_CACHE_RAW_SENTINEL) {
    const cleanedSource = cleanFn(description || '');
    if (cleanedSource.length < floor) return null;
    const sentinelOut = {
      [sourceLang]: {
        title,
        description: cleanedSource,
        requirements: Array.isArray(requirements) ? requirements.map((x) => nsFn(String(x))).filter(Boolean).slice(0, 8) : [],
      },
    };
    for (const locale of targetLocales) {
      // eslint-disable-next-line no-await-in-loop
      const desc = await freeTranslateWithRetry({ text: cleanedSource, sourceLang: sourceLang || 'en', targetLang: locale });
      if (desc && desc.length >= floor) {
        // eslint-disable-next-line no-await-in-loop
        const localizedTitle = await freeTranslateWithRetry({ text: title, sourceLang: sourceLang || 'en', targetLang: locale });
        sentinelOut[locale] = { title: localizedTitle || title, description: desc, requirements: [] };
      }
    }
    if (Object.keys(sentinelOut).length > 1) {
      setCachedAiResponse(cacheKey, sentinelOut);
      return sentinelOut;
    }
    return null;
  }
  if (fromCache && typeof fromCache === 'object' && !Array.isArray(fromCache)) return fromCache;

  if (!(isAnyModelAvailable && isAnyModelAvailable())) {
    const cleanedSource = cleanFn(description || '');
    if (cleanedSource.length < floor) return null;
    const out = {
      [sourceLang]: {
        title,
        description: cleanedSource,
        requirements: Array.isArray(requirements) ? requirements.map((x) => nsFn(String(x))).filter(Boolean).slice(0, 8) : [],
      },
    };
    for (const locale of targetLocales) {
      // eslint-disable-next-line no-await-in-loop
      const desc = await freeTranslateWithRetry({ text: cleanedSource, sourceLang: sourceLang || 'en', targetLang: locale });
      if (desc && desc.length >= floor) {
        // eslint-disable-next-line no-await-in-loop
        const localizedTitle = await freeTranslateWithRetry({ text: title, sourceLang: sourceLang || 'en', targetLang: locale });
        out[locale] = { title: localizedTitle || title, description: desc, requirements: [] };
      }
    }
    return Object.keys(out).length > 1 ? out : null;
  }

  const prompt = [
    'You are a multilingual job content editor for SEO.',
    `Translate this job posting into these locales: ${targetLocales.join(', ')}. Do NOT include the source locale (${sourceLang}) — it will be kept as-is.`,
    'CRITICAL: preserve the COMPLETE original content — every section, paragraph, bullet point, and detail MUST appear in each translation. Do NOT omit, condense, or truncate any part of the description.',
    'Keep company, role, location and requirements consistent with source.',
    `Return STRICT JSON only with keys: ${targetLocales.join(',')}.`,
    'Each locale object must contain:',
    '- title: localized job title in the TARGET locale language (do not keep source language title unless it is only brand/acronym), concise, no embellishments',
    '- description: FULL translation of the complete description preserving all paragraphs and sections (use \\n\\n between paragraphs)',
    '- requirements: array of max 8 concise bullet strings',
    '',
    `title: ${title}`,
    `company: ${company}`,
    `location: ${location}`,
    `sourceLanguage: ${sourceLang}`,
    `requirements: ${JSON.stringify((requirements || []).slice(0, 8))}`,
    `description: ${description}`,
  ].join('\n');

  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 16384, jsonMode: true });
    const parsed = JSON.parse(scfjFn(text));
    const out = {};
    const cleanedSource = cleanFn(description || '');
    if (cleanedSource.length >= floor) {
      out[sourceLang] = {
        title,
        description: cleanedSource,
        requirements: Array.isArray(requirements) ? requirements.map((x) => nsFn(String(x))).filter(Boolean).slice(0, 8) : [],
      };
    }
    for (const locale of targetLocales) {
      const item = parsed?.[locale];
      if (!item || typeof item !== 'object') continue;
      const localizedTitle = nsFn(item.title || '');
      const desc = cleanFn(item.description || '');
      const req = Array.isArray(item.requirements)
        ? item.requirements.map((x) => nsFn(String(x))).filter(Boolean).slice(0, 8)
        : [];
      if (desc.length >= floor) out[locale] = { title: localizedTitle || title, description: desc, requirements: req };
    }
    const missingLocales = targetLocales.filter((l) => !out[l]);
    if (missingLocales.length > 0 && cleanedSource.length >= floor) {
      for (const locale of missingLocales) {
        // eslint-disable-next-line no-await-in-loop
        const desc = await freeTranslateWithRetry({ text: cleanedSource, sourceLang: sourceLang || 'en', targetLang: locale });
        if (desc && desc.length >= floor) {
          // eslint-disable-next-line no-await-in-loop
          const localizedTitle = await freeTranslateWithRetry({ text: title, sourceLang: sourceLang || 'en', targetLang: locale });
          out[locale] = { title: localizedTitle || title, description: desc, requirements: [] };
        }
      }
    }
    if (Object.keys(out).length > 0) {
      setCachedAiResponse(cacheKey, out);
      return out;
    }
  } catch {
    const cleanedFallback = cleanFn(description || '');
    if (cleanedFallback.length >= floor) {
      const fallbackOut = {
        [sourceLang]: {
          title,
          description: cleanedFallback,
          requirements: Array.isArray(requirements) ? requirements.map((x) => nsFn(String(x))).filter(Boolean).slice(0, 8) : [],
        },
      };
      for (const locale of targetLocales) {
        // eslint-disable-next-line no-await-in-loop
        const desc = await freeTranslateWithRetry({ text: cleanedFallback, sourceLang: sourceLang || 'en', targetLang: locale });
        if (desc && desc.length >= floor) {
          // eslint-disable-next-line no-await-in-loop
          const localizedTitle = await freeTranslateWithRetry({ text: title, sourceLang: sourceLang || 'en', targetLang: locale });
          fallbackOut[locale] = { title: localizedTitle || title, description: desc, requirements: [] };
        }
      }
      if (Object.keys(fallbackOut).length > 1) {
        setCachedAiResponse(cacheKey, fallbackOut);
        return fallbackOut;
      }
    }
  }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return null;
}

/**
 * Orchestrate full locale enrichment for a single job.
 * This is the main localization entry point.
 * @param {object} job
 * @param {object} crawlerConfig
 * @param {object} ctx - localization pipeline context (see comment above)
 */
export async function enrichJobLocalesDCC(job, crawlerConfig, ctx = {}) {
  const {
    LOCALES, cleanDescription: clean, normalizeSpace: ns, mergeRequirements: mr,
    isLowQualityLocalizedTitle, isAnyModelAvailable, extractRequirements: exReq,
    htmlToStructuredText: h2st, structureJobDescription: strDesc, aiEnrichThinDescription: enrichThin,
  } = ctx;
  const locales = LOCALES || DEFAULT_LOCALES;
  const cleanFn = clean || cleanDescriptionDCC;
  const nsFn = ns || normalize;
  const mrFn = mr || ((a, b) => [...new Set([...(a || []), ...(b || [])])]);
  const exReqFn = exReq || extractRequirementsFromText;
  const h2stFn = h2st || htmlToStructuredTextDCC;

  const out = { ...job };
  const titleByLocale = (out.titleByLocale && typeof out.titleByLocale === 'object') ? { ...out.titleByLocale } : {};
  const currentByLocale = (out.descriptionByLocale && typeof out.descriptionByLocale === 'object') ? { ...out.descriptionByLocale } : {};
  const sourceLang = detectLanguage(out.description || '', 'en');
  const forceLocalization = shouldForceLocalizationForJob(out, ctx);
  const titleSourceLang = detectJobTitleLang(out.title || '', sourceLang);
  const sourceTitle = nsFn(titleByLocale[titleSourceLang] || out.title || '');
  if (sourceTitle) titleByLocale[titleSourceLang] = sourceTitle;

  const titleNeedsLocalization = locales
    .filter((l) => l !== titleSourceLang)
    .some((locale) => {
      const localizedTitle = nsFn(titleByLocale[locale] || '');
      if (!localizedTitle) return true;
      return sourceTitle && localizedTitle.toLowerCase() === sourceTitle.toLowerCase();
    });

  const localeDescFloor = crawlerConfig?.minDescriptionChars || 120;
  const coverage = locales.filter((l) => nsFn(currentByLocale[l] || '').length >= localeDescFloor).length;
  const hasBudget = (ctx.getAiLocalizationCalls ? ctx.getAiLocalizationCalls() : 0) < (crawlerConfig?.aiLocalizationMaxJobsPerRun || 0) || forceLocalization;
  const canUseAi = isAnyModelAvailable ? isAnyModelAvailable() : false;
  const localizationEnabled = Boolean(crawlerConfig?.aiLocalizationEnabled) || forceLocalization;

  const shouldRunDescriptionLocalization =
    localizationEnabled && hasBudget && (coverage < locales.length || forceLocalization) &&
    (out.description || '').length >= Math.max(localeDescFloor, 80) && (canUseAi || forceLocalization);

  const shouldRunTitleLocalization =
    localizationEnabled && sourceTitle.length >= 3 && (titleNeedsLocalization || forceLocalization);

  if (!shouldRunDescriptionLocalization && !shouldRunTitleLocalization) return out;

  // ── SKIP_AI_TRANSLATION: skip AI enrichment, mark for later translation ──
  if (process.env.SKIP_AI_TRANSLATION === '1') {
    out.titleByLocale = titleByLocale;
    out.descriptionByLocale = currentByLocale;
    out.needsRetranslation = true;
    return out;
  }

  // Structure flat descriptions before AI localization
  const rawDesc = out.description || '';
  const hasMarkdownStructure = /^## /m.test(rawDesc) && ((rawDesc.match(/\n/g) || []).length >= 3);
  if (shouldRunDescriptionLocalization && rawDesc.length >= 100 && !hasMarkdownStructure) {
    const hasHtml = /<[^>]+>/.test(rawDesc);
    if (hasHtml) {
      const structuredFromHtml = h2stFn(rawDesc);
      if (structuredFromHtml && structuredFromHtml.length >= 120) {
        out.description = structuredFromHtml;
        currentByLocale[sourceLang] = structuredFromHtml;
      }
    } else if (strDesc) {
      const structured = await strDesc(rawDesc);
      if (structured !== rawDesc) {
        out.description = structured;
        currentByLocale[sourceLang] = structured;
      }
    }
  }

  // Centralized thin-description enrichment
  const currentDesc = nsFn(out.description || '');
  const hasExtractedData =
    (Array.isArray(out._migrosResponsibilities) && out._migrosResponsibilities.length > 0) ||
    (Array.isArray(out._migrosBenefits) && out._migrosBenefits.length > 0) ||
    (Array.isArray(out.requirements) && out.requirements.length > 0);
  if (shouldRunDescriptionLocalization && currentDesc.length < 500 && hasExtractedData && canUseAi && enrichThin) {
    const enrichedDesc = await enrichThin(out);
    if (enrichedDesc && enrichedDesc !== out.description && enrichedDesc.length > currentDesc.length) {
      out.description = enrichedDesc;
      currentByLocale[sourceLang] = enrichedDesc;
    }
  }

  const aiLocalized = shouldRunDescriptionLocalization && canUseAi
    ? await aiLocalizeJobContentDCC({
        title: out.title, company: out.company, location: out.location,
        description: out.description, requirements: out.requirements || [],
        sourceLang, minChars: localeDescFloor,
      }, ctx)
    : null;
  if (shouldRunDescriptionLocalization && ctx.incrAiLocalizationCalls) ctx.incrAiLocalizationCalls();

  const reqByLocale = (out.requirementsByLocale && typeof out.requirementsByLocale === 'object') ? { ...out.requirementsByLocale } : {};
  if (aiLocalized) {
    for (const locale of locales) {
      const localized = aiLocalized[locale];
      if (!localized) continue;
      if (localized.title && localized.title.length >= 4 && !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(localized.title))) {
        titleByLocale[locale] = localized.title;
      }
      if (localized.description && localized.description.length >= localeDescFloor) {
        currentByLocale[locale] = localized.description;
      }
      const mergedReq = mrFn(reqByLocale[locale] || [], localized.requirements || []);
      if (mergedReq.length > 0) reqByLocale[locale] = mergedReq;
    }
  }
  if (shouldRunTitleLocalization) {
    for (const locale of locales) {
      if (locale === titleSourceLang) continue;
      const localizedTitle = nsFn(titleByLocale[locale] || '');
      if (localizedTitle && localizedTitle.toLowerCase() !== sourceTitle.toLowerCase() &&
          !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(localizedTitle))) continue;
      const forced = await aiTranslateJobTitleDCC({ title: sourceTitle, locale, sourceLang: titleSourceLang }, ctx);
      if (forced && forced.toLowerCase() !== sourceTitle.toLowerCase() &&
          !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(forced))) {
        titleByLocale[locale] = forced;
        continue;
      }
      const fallback = heuristicTranslateJobTitle(sourceTitle, locale);
      if (fallback && fallback.toLowerCase() !== sourceTitle.toLowerCase() &&
          !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(fallback))) {
        titleByLocale[locale] = fallback;
      }
    }
  }

  // Strict fallback for forced companies
  if (forceLocalization) {
    for (const locale of locales) {
      const curDesc = cleanFn(currentByLocale[locale] || '');
      const sourceDesc = cleanFn(out.description || '');
      const needsDesc =
        locale !== sourceLang &&
        (!curDesc || curDesc.length < localeDescFloor || curDesc.toLowerCase() === sourceDesc.toLowerCase());
      if (needsDesc) {
        // eslint-disable-next-line no-await-in-loop
        const translatedDesc = await aiTranslateJobDescriptionDCC({
          description: out.description || '', locale, sourceLang, minChars: localeDescFloor,
        }, ctx);
        if (translatedDesc) {
          currentByLocale[locale] = translatedDesc;
          const mergedReq = mrFn(reqByLocale[locale] || [], exReqFn(translatedDesc));
          if (mergedReq.length > 0) reqByLocale[locale] = mergedReq;
        }
      }
      const currentTitle = nsFn(titleByLocale[locale] || '');
      if (locale !== titleSourceLang && (!currentTitle || currentTitle.toLowerCase() === sourceTitle.toLowerCase())) {
        // eslint-disable-next-line no-await-in-loop
        const translatedTitle = await aiTranslateJobTitleDCC({ title: sourceTitle, locale, sourceLang: titleSourceLang }, ctx);
        if (translatedTitle && translatedTitle.toLowerCase() !== sourceTitle.toLowerCase() &&
            !(isLowQualityLocalizedTitle && isLowQualityLocalizedTitle(translatedTitle))) {
          titleByLocale[locale] = translatedTitle;
        }
      }
    }
  }

  // Inline truncation detection
  const TRUNCATION_RATIO = 0.40;
  const sourceDescLen = cleanFn(out.description || '').length;
  if (sourceDescLen >= 200) {
    for (const locale of locales) {
      if (locale === sourceLang) continue;
      const localized = cleanFn(currentByLocale[locale] || '');
      if (localized.length > 0 && localized.length < sourceDescLen * TRUNCATION_RATIO) {
        // eslint-disable-next-line no-await-in-loop
        const retranslated = await aiTranslateJobDescriptionDCC({
          description: out.description || '', locale, sourceLang, minChars: localeDescFloor,
        }, ctx);
        if (retranslated && cleanFn(retranslated).length > localized.length) {
          currentByLocale[locale] = retranslated;
        }
      }
    }
  }

  // Cross-locale copy detection
  const sourceDescNorm = cleanFn(out.description || '').toLowerCase();
  if (sourceDescNorm.length >= localeDescFloor) {
    for (const locale of locales) {
      if (locale === sourceLang) continue;
      const localizedNorm = cleanFn(currentByLocale[locale] || '').toLowerCase();
      if (localizedNorm && localizedNorm === sourceDescNorm) {
        // eslint-disable-next-line no-await-in-loop
        const translated = await aiTranslateJobDescriptionDCC({
          description: out.description || '', locale, sourceLang, minChars: localeDescFloor,
        }, ctx);
        if (translated && cleanFn(translated).toLowerCase() !== sourceDescNorm) {
          currentByLocale[locale] = translated;
        }
      }
    }
  }

  out.titleByLocale = titleByLocale;
  out.descriptionByLocale = currentByLocale;
  out.requirementsByLocale = reqByLocale;
  return out;
}

export async function enrichJobLocalesWithRetryDCC(job, crawlerConfig, ctx = {}, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await enrichJobLocalesDCC(job, crawlerConfig, ctx);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '').toLowerCase();
      const quotaExhausted =
        msg.includes('all ai models failed') ||
        msg.includes('daily request limit') ||
        msg.includes('daily quota') ||
        msg.includes('exceeded your current quota') ||
        msg.includes('plan and billing details');
      if (quotaExhausted) break;
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  const slug = job?.slug || job?.id || 'unknown';
  const message = lastError?.message || String(lastError || 'unknown error');
  console.warn(`\u26a0\ufe0f  Localization failed for ${slug}: ${message}`);
  return job;
}

// ── End FRO-234: Localization pipeline ──────────────────────────────────

export async function translateMissingJobLocales({ dataJobsPath, isTargetJob = null, maxJobs = 0, minDescriptionChars = 120, companySlug = '' }) {
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

  const filtered = isTargetJob ? raw.filter(isTargetJob) : raw;
  // FRO-327: prioritize jobs marked for retranslation (failed in a previous run)
  const candidates = filtered.sort((a, b) => {
    const aNeedsRetranslation = a.needsRetranslation ? 1 : 0;
    const bNeedsRetranslation = b.needsRetranslation ? 1 : 0;
    return bNeedsRetranslation - aNeedsRetranslation;
  });
  const retranslationCount = candidates.filter(j => j.needsRetranslation).length;
  if (retranslationCount > 0) {
    console.log(`  🔁 ${retranslationCount} jobs marked for retranslation — processing first`);
  }
  const limit = maxJobs > 0 ? Math.min(maxJobs, candidates.length) : candidates.length;

  // ── Translation cache (FRO-324) ──
  // Disable cache during tests to avoid cross-run interference
  const cacheEnabled = !process.env.VITEST;
  const slug = companySlug || (candidates.length > 0 ? deriveCompanySlug(candidates) : 'unknown');
  const translationCache = cacheEnabled ? loadTranslationCache(slug) : {};
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheUpdated = false;

  // ── SKIP_AI_TRANSLATION mode ──
  // When SKIP_AI_TRANSLATION=1 (set by orchestrator), cache hits still apply
  // but cache misses skip AI calls and mark jobs with needsRetranslation.
  // The centralized translate-pending pipeline handles them later.
  const skipAiTranslation = process.env.SKIP_AI_TRANSLATION === '1';
  let skipAiMarkedCount = 0;

  let cursor = 0;

  const worker = async () => {
    while (cursor < limit) {
      const i = cursor;
      cursor += 1;
      const job = candidates[i];
      const baseTitle = String(job.title || '').trim();
      const baseDesc = String(job.description || '').trim();

      // ── Translation cache check (FRO-324) ──
      const jobCacheKey = job.slug || job.id || `job-${i}`;
      const contentHash = computeContentHash(baseTitle, baseDesc);
      const cached = translationCache[jobCacheKey];
      // FRO-327: skip cache for jobs needing retranslation
      if (cached && cached.hash === contentHash && isTranslationCacheValid(cached) && !job.needsRetranslation) {
        // Content unchanged and cache is fresh — apply cached translations
        if (!job.titleByLocale || typeof job.titleByLocale !== 'object') job.titleByLocale = {};
        if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') job.descriptionByLocale = {};
        const cacheApplied = applyTranslationCache(job, cached);
        if (cacheApplied) {
          changed = true;
          translated += 1;
          details.push({ company: job.company, slug: job.slug, sourceLang: 'cache' });
        }
        cacheHits += 1;
        continue;
      }
      cacheMisses += 1;

      // ── SKIP_AI_TRANSLATION: cache miss → mark for retranslation, skip AI ──
      if (skipAiTranslation) {
        if (!job.titleByLocale || typeof job.titleByLocale !== 'object') job.titleByLocale = {};
        if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') job.descriptionByLocale = {};
        // Ensure source locale slots are populated
        const titleLang = detectJobTitleLang(baseTitle, detectLang(baseDesc || baseTitle, 'it'));
        const descLang = detectTextLocale(baseDesc || baseTitle, titleLang).lang;
        if (baseTitle && !job.titleByLocale[titleLang]) job.titleByLocale[titleLang] = baseTitle;
        if (baseDesc && !job.descriptionByLocale[descLang]) job.descriptionByLocale[descLang] = baseDesc;
        job.needsRetranslation = true;
        skipAiMarkedCount += 1;
        changed = true;
        continue;
      }

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
            // FRO-327: clear retranslation flag on success
            if (job.needsRetranslation) delete job.needsRetranslation;
          } else if (!String(job.titleByLocale[locale] || '').trim()) {
            // AI translation failed — leave locale empty (not source copy) so the deploy
            // gate catches it. Mark for retranslation on next run with fresh quota.
            job.titleByLocale[locale] = '';
            job.needsRetranslation = true;
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
          } else if (!String(job.descriptionByLocale[locale] || '').trim() && sourceDesc) {
            // AI translation failed — leave locale empty (not source copy) so the deploy
            // gate catches it. Mark for retranslation on next run with fresh quota.
            job.descriptionByLocale[locale] = '';
            job.needsRetranslation = true;
            jobTranslated = true;
          }
        }
      }

      // ── Update translation cache (FRO-324) ──
      // Always cache the current state (even if no translation happened this run)
      // so future runs can skip the "needs work" checks entirely.
      translationCache[jobCacheKey] = buildCacheEntry(job, contentHash);
      cacheUpdated = true;

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

  // ── Save translation cache (FRO-324) ──
  if (cacheEnabled && cacheUpdated) {
    try {
      saveTranslationCache(slug, translationCache);
    } catch (e) {
      console.warn(`  ⚠️ Failed to save translation cache for [${slug}]:`, e.message);
    }
  }
  if (cacheHits > 0 || cacheMisses > 0) {
    console.log(`  📦 Translation cache [${slug}]: ${cacheHits} hits, ${cacheMisses} misses (${cacheHits + cacheMisses} total)`);
  }
  if (skipAiTranslation && skipAiMarkedCount > 0) {
    console.log(`  ℹ️ SKIP_AI_TRANSLATION=1 — using cache only, ${skipAiMarkedCount} jobs need retranslation`);
  }

  if (!changed) {
    return { changed: false, translated: 0, total: candidates.length, details: [], cacheHits, cacheMisses };
  }

  writeJson(dataJobsPath, raw);
  const publicJobsPath = inferPublicJobsPath(dataJobsPath);
  if (fs.existsSync(publicJobsPath)) {
    writeJson(publicJobsPath, raw);
  }
  return { changed: true, translated, total: candidates.length, details, cacheHits, cacheMisses };
}

export function hardenJobsRichResultsData({ dataJobsPath }) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) {
    return { changed: false, updated: 0, total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    return { changed: false, updated: 0, total: 0 };
  }

  const { jobs: hardened, changed: salaryChanged, updated: salaryUpdated, total } = hardenJobsWithStructuredSalary(raw);

  // ── PostalCode enrichment from swiss-postal-codes.json ──
  let postalFilled = 0;
  const plzPath = path.join(path.dirname(dataJobsPath), 'swiss-postal-codes.json');
  if (fs.existsSync(plzPath)) {
    const plz = JSON.parse(fs.readFileSync(plzPath, 'utf-8'));
    const cantonCapitals = { TI: '6500', GR: '7000', VS: '1950', ZH: '8001', BE: '3001', SG: '9000', LU: '6003', AG: '5000' };
    for (const job of hardened) {
      if (job.postalCode) continue;
      const loc = (job.addressLocality || job.location || '').trim();
      if (!loc) continue;
      // Direct match
      if (plz[loc]) { job.postalCode = plz[loc]; postalFilled++; continue; }
      // First segment (e.g. "Chur, Graubünden" → "Chur")
      const parts = loc.split(/[,·\-/]/).map(s => s.trim()).filter(Boolean);
      let found = false;
      for (const part of parts) {
        if (plz[part]) { job.postalCode = plz[part]; postalFilled++; found = true; break; }
      }
      if (found) continue;
      // Extract 4-digit PLZ from location string
      const plzMatch = loc.match(/\b(\d{4})\b/);
      // Skip years (2020-2039) that look like postal codes
      if (plzMatch && Number(plzMatch[1]) >= 2020 && Number(plzMatch[1]) <= 2039) plzMatch[1] = '';
      if (plzMatch) { job.postalCode = plzMatch[1]; postalFilled++; continue; }
      // Canton capital fallback
      const canton = (job.canton || '').toUpperCase();
      if (canton && cantonCapitals[canton]) { job.postalCode = cantonCapitals[canton]; postalFilled++; }
    }
    if (postalFilled > 0) {
      console.log(`  📮 PostalCode enrichment: filled ${postalFilled} jobs from swiss-postal-codes.json`);
    }
  }

  const changed = salaryChanged || postalFilled > 0;
  const updated = salaryUpdated + postalFilled;

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
    // Detect AI/translation provider quota exhaustion — if all providers are exhausted,
    // missing translations are expected and should be tolerated (they'll be retried next run)
    // FRO-424: when ALL models are 429'd, tolerate ALL translation issues (not just descriptions)
    const TRANSLATION_ISSUES = new Set([
      'missing_description', 'untranslated_description',
      'missing_title', 'untranslated_title',
    ]);
    let effectiveTolerance = maxToleratedMissingDescriptions;
    let allAiExhausted = false;
    if (_aiModels) {
      try {
        const stats = _aiModels.getStats();
        allAiExhausted = !_aiModels.isAnyModelAvailable();
        if (allAiExhausted || (stats.exhaustedModels && stats.exhaustedModels.length >= 3)) {
          // AI quota exhausted — do NOT raise tolerance. Jobs with incomplete translations
          // are saved with needsRetranslation flag and empty locale slots. The deploy gate
          // (validate-translation-completeness.mjs) will block deploy until they're translated.
          const translationIssueCount = blockingIssues.filter((i) => TRANSLATION_ISSUES.has(i.reason)).length;
          console.warn(`⚠️  AI quota exhaustion detected (${stats.exhaustedModels?.length || 0} models exhausted). ` +
            `${translationIssueCount} jobs have incomplete translations — saved with needsRetranslation flag. ` +
            `Run translate-pending workflow before deploying.`);
        }
      } catch { /* stats not available */ }
    }

    // Tolerate translation-related issues up to the base tolerance (FRO-317)
    // AI exhaustion no longer inflates tolerance — incomplete jobs are saved with
    // needsRetranslation flag and the deploy gate blocks until they're translated.
    if (effectiveTolerance > 0) {
      const translationIssues = blockingIssues.filter((i) => TRANSLATION_ISSUES.has(i.reason));
      const otherIssues = blockingIssues.filter((i) => !TRANSLATION_ISSUES.has(i.reason));
      if (translationIssues.length <= effectiveTolerance && otherIssues.length === 0) {
        const sample = translationIssues.slice(0, 10).map((i) => `${i.slug} [${i.locale}] ${i.reason}`).join(', ');
        const suffix = translationIssues.length > 10 ? ` ... and ${translationIssues.length - 10} more` : '';
        if (allAiExhausted) {
          console.warn(`⚠️  AI quota exhausted — ${translationIssues.length} jobs saved with needsRetranslation flag`);
        }
        console.warn(`⚠️  Tolerating ${translationIssues.length} translation issue(s) (tolerance ${effectiveTolerance}): ${sample}${suffix}`);
        softIssues.push(...translationIssues);
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

// ---------------------------------------------------------------------------
// Job classification utilities (migrated from shared-jobs-crawler — FRO-188)
// ---------------------------------------------------------------------------

const CONTRACT_MAP = {
  full_time: 'full-time',
  fulltime: 'full-time',
  full: 'full-time',
  fulltimeemployment: 'full-time',
  part_time: 'part-time',
  parttime: 'part-time',
  temporary: 'temporary',
  temp: 'temporary',
  intern: 'internship',
  internship: 'internship',
  contractor: 'contract',
  contract: 'contract',
};

export function guessCategory(title = '', description = '') {
  const t = `${title} ${description}`.toLowerCase();
  if (/(nurse|doctor|clinica|ospedal|healthcare|health\s*care|medical|infermier|farmac|medico|psicologo|psichiatr|sanitari|terapist|chirurg|ostetr|ortoped|salute\s+mentale|curante)\b/.test(t)) return 'health';
  if (/(software|developer|devops|cloud|frontend|backend|full stack|security|informatica|sviluppo\s+software)\b/.test(t)) return 'tech';
  if (/\b(data\s+(?:engineer|scien|analy|warehouse|lake|pipelin|mining|govern)|programm(?:er|ier|ing|ierung))\b/.test(t)) return 'tech';
  if (/(finance|bank|contab|account|audit|tax|wealth|risk|finanz|cred|invest)/.test(t)) return 'finance';
  if (/(engineer|ingegner|mechanic|electrical|automation|industrial|lavori\s+pubblici|edil|costruzion)/.test(t)) return 'engineering';
  if (/(admin|assistant|back office|hr|human resources|segret|amministrativ|servizi\s+generali|operatore\s+socio|collaborat\w+\s+amministrativ)/.test(t)) return 'admin';
  if (/(sales|commercial|business development|account manager|retail|store|vendita|commerciale)/.test(t)) return 'sales';
  return 'other';
}

export function normalizeContract(raw = '', title = '', description = '') {
  const s = String(`${raw} ${title} ${description}`).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const percent = Number((s.match(/\b(\d{1,3})\s*%/)?.[1] || ''));
  if (Number.isFinite(percent) && percent > 0 && percent < 90) return 'part-time';
  for (const [k, v] of Object.entries(CONTRACT_MAP)) {
    if (s.replace(/[\s-]/g, '_').includes(k)) return v;
  }
  if (/(part[- ]?time|tempo parziale)/.test(s)) return 'part-time';
  if (/\b(intern|internship|stage|tirocinio|apprendist)\b/.test(s)) return 'internship';
  if (/\b(temp|temporary|determinato|fixed[- ]term)\b/.test(s)) return 'temporary';
  if (/\b(contractor|freelance|consul)\b/.test(s)) return 'contract';
  return 'full-time';
}

// ─── Job quality scoring ──────────────────────────────────────────────────────

/**
 * Compute a numeric quality score for a job from its structured fields.
 * Title threshold is 5 (not 8) to accommodate short Italian job titles
 * (e.g. "Cuoco"=5, "Gerente"=7, "Autista"=7).
 */
export function qualityScore(job) {
  let score = 0;
  if (job.title && job.title.length >= 5) score += 2;
  if (job.company && job.company.length >= 2) score += 1;
  if (job.location && job.location.length >= 2) score += 1;
  if (job.description && job.description.length >= 120) score += 2;
  if (job.requirements?.length) score += 1;
  if (job.url) score += 1;
  return score;
}

/**
 * Evaluate whether a job meets the minimum quality threshold.
 * Returns { accepted, score, reasons }.
 */
export function evaluateJobQuality(job, { minQualityScore, minDescriptionChars }) {
  const reasons = [];
  const score = qualityScore(job);
  const descLen = (job.description || '').length;
  if (descLen < minDescriptionChars) reasons.push(`thin_description_lt_${minDescriptionChars}`);
  if (score < minQualityScore) reasons.push(`quality_score_lt_${minQualityScore}`);
  return { accepted: reasons.length === 0, score, reasons };
}

// ─── Job/career page classification ──────────────────────────────────────────

const GENERIC_CAREER_TITLES = [
  'your career with us',
  'la vostra carriera con noi',
  'votre parcours professionnel avec nous',
  'sie haben, was es braucht',
  'bereit fur deine berufliche zukunft',
  'bereit für deine berufliche zukunft',
  'careers',
  'career',
  'jobs',
  'stellenangebote',
  'offene stellen',
  'open positions',
  'job opportunities',
  'about us',
  'benefits',
  'equal opportunity employer',
  'applicants with disabilities',
  'professional careers',
  'early careers',
];

/**
 * Returns true if the given title looks like a generic career/listing page
 * rather than a specific job posting.
 */
export function isLikelyGenericCareerTitle(title = '') {
  const lower = String(title || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!lower) return true;
  return GENERIC_CAREER_TITLES.some((t) => lower === t || lower.includes(t));
}

/**
 * Returns true if the URL appears to point to a single job detail page
 * rather than a listing/search/category page.
 */
export function isLikelyJobDetailUrl(rawUrl = '') {
  const url = String(rawUrl || '').toLowerCase();
  if (!url) return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/\/job\b/.test(url) && /[?&]id=\d/.test(url)) return true;
  if (/\/vacanc(?:y|ies)\/?(?:[?#]|$)/.test(url)) return false;
  if (/\/(jobs?|careers?|karriere|offene-stellen|open-positions?)\/?(?:[?#]|$)/.test(url)) return false;
  if (/[?&](q|query|search)=/.test(url) && /vacanc|jobs?|careers?/.test(url)) return false;
  if (/\/application-start\/vacancies\/[^/?#]+\.html(?:[?#]|$)/.test(url)) return false;
  if (/\/vacancies\/[^/?#]+\.html(?:[?#]|$)/.test(url)) return false;
  return (
    ((host.endsWith('recruitee.com') || host.endsWith('jobs.corner.ch')) && /\/o\/[^/?#]+(?:[?#]|$)/.test(url)) ||
    /\/job\//.test(url) ||
    /\/details\//.test(url) ||
    /\/jobs\/view\//.test(url) ||
    /\/jobs\/[^/?#]+/.test(url) ||
    /\/vacanc/.test(url) ||
    /\/offene-stellen\/[^/?#]+/.test(url) ||
    /\/posti-vacanti\/[^/?#]+/.test(url) ||
    /\/open-positions?\/[^/?#]+/.test(url) ||
    /\/offres?-emploi\/[^/?#]+/.test(url) ||
    /\/careers?\/job/.test(url) ||
    /[?&](jobid|jobid=|gh_jid|lever-source|wdjobid|job_id|yid)=/.test(url) ||
    /\/position\//.test(url)
  );
}

// ══════════════════════════════════════════════════════════════
// FRO-231: Slug utilities extracted from shared-jobs-crawler.mjs
// ══════════════════════════════════════════════════════════════

// ── HTML entity decoders ─────────────────────────────────────

export function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export function decodeNumericEntities(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// ── String normalization ─────────────────────────────────────

export function normalizeSpace(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── URL utilities ────────────────────────────────────────────

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeHost(host) {
  return String(host || '').toLowerCase().trim().replace(/^www\d?\./, '');
}

export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const secondLevelSet = new Set(['co', 'com', 'org', 'gov', 'ac', 'edu', 'net']);
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && secondLevelSet.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function canonicalizeJobUrl(rawUrl = '') {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return '';
  }
  const noisyParams = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'trk', 'tracking',
    'source', 'medium', 'campaign',
  ];
  for (const key of noisyParams) u.searchParams.delete(key);
  u.hash = '';
  const pathClean = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${pathClean}${u.search ? `?${u.searchParams.toString()}` : ''}`.toLowerCase();
}

function extractUuidLikeId(raw = '') {
  const text = String(raw || '');
  const uuidMatch = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  return uuidMatch?.[0] ? uuidMatch[0].toLowerCase() : '';
}

export function extractJobIdentityFromUrl(rawUrl = '') {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return '';
  }
  const host = normalizeHost(u.hostname);
  const full = `${host}${u.pathname}${u.search}`.toLowerCase();

  const coopPathMatch = full.match(/\/(?:offene-stellen|posti-vacanti)\/[^/?#]+\/([^/?#]+)/i);
  if (coopPathMatch?.[1]) {
    const coopIdCandidate = normalizeSpace(coopPathMatch[1]);
    const coopUuid = extractUuidLikeId(coopIdCandidate) || extractUuidLikeId(full);
    if (coopUuid) return `${registrableDomain(host)}|${coopUuid}`;
    if (coopIdCandidate) return `${registrableDomain(host)}|${coopIdCandidate.toLowerCase()}`;
  }

  const inPath = [
    /\/jobs\/view\/(\d+)/i,
    /\/job\/(\d+)/i,
    /\/details\/([^/?#]+)/i,
    /\/jobs\/(\d+)/i,
    /\/positions\/(\d+)/i,
    /\/vacanc(?:y|ies)\/(\d+)/i,
    /\/(?:offene-stellen|posti-vacanti)\/[^/?#]+\/([^/?#]+)/i,
    /\/career\/jobs\/([^/?#]+)/i,
    /\/job\/[^/?#]*\/([^/?#]+)/i,
  ];
  for (const re of inPath) {
    const m = full.match(re);
    if (m?.[1]) return `${registrableDomain(host)}|${m[1]}`;
  }
  const queryKeys = ['jobid', 'job_id', 'gh_jid', 'jid', 'wdjobid', 'vacancyid'];
  for (const key of queryKeys) {
    const val = normalizeSpace(u.searchParams.get(key));
    if (val) return `${registrableDomain(host)}|${val.toLowerCase()}`;
  }
  const hashRaw = normalizeSpace(u.hash.replace(/^#/, ''));
  if (hashRaw) {
    const keyedMatch = hashRaw.match(/(?:job[._-]?id|id)=(\w+)/i);
    if (keyedMatch?.[1]) return `${registrableDomain(host)}|${keyedMatch[1].toLowerCase()}`;
    if (hashRaw.length > 3 && /^[\w-]+$/.test(hashRaw)) {
      return `${registrableDomain(host)}|#${hashRaw.toLowerCase()}`;
    }
  }
  return '';
}

// ── Slugify ──────────────────────────────────────────────────

export function slugify(input = '', maxLen = 140) {
  return normalizeSpace(decodeNumericEntities(decodeHtmlEntities(input)))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

// ── Slug quality checks ──────────────────────────────────────

export function isLowQualityLocalizedTitle(value = '') {
  const t = normalizeSpace(value || '');
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^(h|he|her|here|here is|title|job title)\b/i.test(t)) return true;
  if (/^[\W_]+$/.test(t)) return true;
  return false;
}

const SLUG_BOILERPLATE_PATTERNS = [
  /permette-di-combinare-efficacemente/,
  /garantendo-alla-popolaz/,
  /visione-d-insieme-garantendo/,
  /approccio-locale-e-visione/,
];

export function isLowQualityLocalizedSlug(value = '') {
  const s = normalizeSpace(value || '');
  if (!s) return true;
  if (s.length < 12) return true;
  if (/^(h|he|her|here)(-|$)/i.test(s)) return true;
  if (!/^[a-z0-9-]+$/i.test(s)) return true;
  if (SLUG_BOILERPLATE_PATTERNS.some(re => re.test(s))) return true;
  return false;
}

// ── Job fingerprinting & deduplication ───────────────────────

export function fingerprintJob(job) {
  const identity = extractJobIdentityFromUrl(job.url || '');
  if (identity) return `id|${identity}`;

  const canonicalUrl = canonicalizeJobUrl(job.url || '');
  if (canonicalUrl) return `url|${canonicalUrl}`;

  const domain = registrableDomain(hostOf(job.url || '')) || normalizeSpace(job.company).toLowerCase();
  const key = `${normalizeSpace(job.title).toLowerCase()}|${normalizeSpace(job.location).toLowerCase()}|${domain}`;
  return `tl|${key.replace(/\s+/g, ' ')}`;
}

export function dedupHeuristicKey(job) {
  const identity = extractJobIdentityFromUrl(job?.url || '');
  if (identity) return `id|${identity}`;

  const domain = registrableDomain(hostOf(job?.url || '')) || normalizeSpace(job?.company).toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase().replace(/\s+/g, ' ');
  const title = normalizeSpace(job?.title || '').toLowerCase().replace(/\s+/g, ' ');
  const location = normalizeSpace(job?.location || '').toLowerCase().replace(/\s+/g, ' ');
  const canton = normalizeCantonCode(job?.canton || '');
  const contract = normalizeContract(job?.contract || '', job?.title || '', '').toLowerCase();
  const category = normalizeSpace(job?.category || '').toLowerCase();
  const salaryMin = Number.isFinite(Number(job?.salaryMin)) ? Math.round(Number(job.salaryMin)) : '';
  const salaryMax = Number.isFinite(Number(job?.salaryMax)) ? Math.round(Number(job.salaryMax)) : '';

  return `h|${domain}|${company}|${title}|${location}|${canton}|${contract}|${category}|${salaryMin}-${salaryMax}`;
}

// ── Slug registry (persistent slug-to-fingerprint mapping) ───

const SLUG_REGISTRY_PATH = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..', '..', 'data', 'slug-registry.json',
);

export function loadSlugRegistry() {
  try {
    if (fs.existsSync(SLUG_REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(SLUG_REGISTRY_PATH, 'utf-8'));
    }
  } catch { /* ignore malformed file */ }
  return {};
}

export function saveSlugRegistry(registry) {
  fs.writeFileSync(SLUG_REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

export function getRegisteredSlug(job, registry) {
  const fp = fingerprintJob(job);
  if (!fp || !registry[fp]) return null;
  return registry[fp];
}

export function registerJobSlug(job, registry) {
  const fp = fingerprintJob(job);
  if (!fp || fp.startsWith('tl|')) return;
  const slug = String(job.slug || '').trim();
  if (!slug) return;
  if (registry[fp]) return; // Never overwrite — immutable
  registry[fp] = {
    canonicalSlug: slug,
    slugByLocale: job.slugByLocale && typeof job.slugByLocale === 'object'
      ? { ...job.slugByLocale }
      : {},
    createdAt: new Date().toISOString().slice(0, 10),
  };
}

// ── Slug generation ──────────────────────────────────────────

export function ensureJobSlug(job) {
  const titleSlug = slugify(job.title);
  const fullSlug = slugify(`${job.title}-${job.company}-${job.location}`);
  const base = (fullSlug && fullSlug.length <= 140) ? fullSlug : (titleSlug || job.id || 'job');
  return base;
}

export function stableSlugHash(job) {
  const fp = fingerprintJob(job);
  if (!fp || fp.startsWith('tl|')) return null;
  let hash = 0;
  for (const c of fp) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36).padStart(6, '0').slice(-6);
}

export function buildStableId(job) {
  const s = fingerprintJob(job);
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return `company-${Math.abs(hash).toString(36)}`;
}

// ─── FRO-232: Merge/dedup utilities ──────────────────────────────────────────

export const LOCALES = ['it', 'en', 'de', 'fr'];

export function normalizeCompanyKey(input) { return normalizeKey(input).slice(0, 64); }

export function dateOnly(input) {
  const d = new Date(input || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function getJobTargetScope(job = {}) {
  const scope = job?._targetScope;
  return scope && typeof scope === 'object' ? scope : null;
}

export function hasSeedMetaTargetScope(job = {}) {
  const scope = getJobTargetScope(job);
  if (!scope) return false;
  const canton = normalizeCantonCode(scope.canton || job?.canton || '');
  if (canton === 'TI' || canton === 'GR') return true;
  const location = normalizeSpace(scope.location || '');
  if (!location) return false;
  return isTargetSwissLocation(location);
}

export function isJobPortalRelevant(job = {}) {
  const signal = `${job?.title || ''} ${job?.location || ''} ${job?.description || ''}`;
  if (isTargetSwissLocation(signal)) return true;
  return hasSeedMetaTargetScope(job);
}

export function isExplicitlyOutsideTarget(text) {
  const lower = String(text || '').toLowerCase();
  const outsideMarkers = [
    'österreich', 'austria', 'graz', 'wien', 'vienna',
    'deutschland', 'germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt',
    'france', 'paris', 'lyon', 'marseille', 'toulouse', 'strasbourg',
    'spain', 'madrid', 'barcelona', 'sevilla', 'valencia',
    'uk', 'united kingdom', 'london', 'manchester', 'birmingham', 'edinburgh',
    'portugal', 'lisbon', 'lisboa', 'porto',
    'netherlands', 'amsterdam', 'rotterdam', 'den haag',
    'belgium', 'brussels', 'bruxelles', 'antwerp',
    'sweden', 'stockholm', 'göteborg',
    'norway', 'oslo',
    'denmark', 'copenhagen', 'københavn',
    'finland', 'helsinki',
    'poland', 'warsaw', 'kraków', 'wroclaw',
    'czech republic', 'prague', 'praha',
    'hungary', 'budapest',
    'romania', 'bucharest', 'bucuresti',
    'greece', 'athens',
    'italia', 'italy',
    'milano', 'milan', 'roma', 'rome', 'firenze', 'florence', 'napoli', 'naples',
    'torino', 'turin', 'bologna', 'genova', 'palermo', 'catania', 'bari',
    'venezia', 'venice', 'verona', 'padova', 'trieste', 'brescia', 'modena',
    'forte dei marmi', 'toscana', 'lazio', 'lombardia', 'piemonte', 'campania',
    'puglia', 'sicilia', 'sardegna', 'calabria', 'emilia-romagna', 'umbria',
    'usa', 'united states', 'new york', 'los angeles', 'san francisco', 'chicago',
    'canada', 'toronto', 'montreal', 'vancouver',
    'brazil', 'brasile', 'são paulo', 'rio de janeiro',
    'mexico', 'messico',
    'malaysia', 'kuala lumpur',
    'singapore', 'singapour',
    'china', 'cina', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hong kong',
    'japan', 'giappone', 'tokyo',
    'south korea', 'seoul',
    'india', 'mumbai', 'bangalore', 'delhi', 'new delhi',
    'thailand', 'bangkok',
    'indonesia', 'jakarta',
    'vietnam', 'hanoi', 'ho chi minh',
    'philippines', 'manila',
    'taiwan', 'taipei',
    'united arab emirates', 'uae', 'dubai', 'abu dhabi',
    'saudi arabia', 'riyadh',
    'qatar', 'doha',
    'australia', 'sydney', 'melbourne',
    'south africa', 'johannesburg', 'cape town',
  ];
  const hitOutside = outsideMarkers.some((k) => lower.includes(k));
  if (!hitOutside) return false;
  return !/(ticino|lugano|bellinzona|mendrisio|chiasso|svizzera|switzerland|schweiz)/i.test(lower);
}

/**
 * Check if a job's LOCATION field explicitly indicates a non-Swiss location.
 */
export function isLocationExplicitlyForeign(locationField) {
  const lower = String(locationField || '').toLowerCase();
  if (!lower || lower.length < 3) return false;
  if (/(\bch\b|swiss|svizzera|switzerland|schweiz|suisse)/i.test(lower)) return false;
  if (/\b(ticino|tessin|ti)\b/i.test(lower)) return false;
  if (TICINO_CITIES.some((c) => lower.includes(c.toLowerCase()))) return false;
  const foreignCountries = [
    'malaysia', 'italy', 'italia', 'france', 'germany', 'deutschland',
    'austria', 'österreich', 'spain', 'españa', 'portugal',
    'united kingdom', 'uk', 'usa', 'united states', 'canada',
    'china', 'japan', 'india', 'singapore', 'thailand', 'indonesia',
    'vietnam', 'philippines', 'taiwan', 'south korea', 'hong kong',
    'united arab emirates', 'uae', 'saudi arabia', 'qatar',
    'australia', 'brazil', 'mexico', 'south africa',
    'netherlands', 'belgium', 'sweden', 'norway', 'denmark', 'finland',
    'poland', 'czech republic', 'hungary', 'romania', 'greece',
    'russia', 'ukraine', 'turkey',
  ];
  const foreignCities = [
    'kuala lumpur', 'milano', 'milan', 'roma', 'rome', 'firenze', 'florence',
    'napoli', 'naples', 'torino', 'turin', 'bologna', 'genova', 'palermo',
    'venezia', 'venice', 'forte dei marmi', 'toscana', 'lombardia',
    'paris', 'lyon', 'marseille', 'london', 'berlin', 'munich', 'münchen',
    'frankfurt', 'hamburg', 'vienna', 'wien', 'madrid', 'barcelona',
    'amsterdam', 'brussels', 'bruxelles', 'stockholm', 'oslo', 'copenhagen',
    'tokyo', 'beijing', 'shanghai', 'singapore', 'bangkok', 'mumbai',
    'dubai', 'new york', 'los angeles', 'toronto', 'sydney', 'melbourne',
    'zurich', 'zürich', 'bern', 'berne', 'basel', 'lausanne', 'geneva', 'genève',
    'fribourg', 'neuchatel', 'neuchâtel', 'winterthur', 'zug', 'aarau', 'lucerne', 'luzern',
  ];
  return foreignCountries.some((k) => lower.includes(k)) || foreignCities.some((k) => lower.includes(k));
}

export function isExplicitlyOutsideSwissTicino(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  if (/\b(ticino|canton ticino|cantone ticino|ch-ti)\b/i.test(lower)) return false;
  if (/\b(?:ch-?)?\d{4}\s+[a-zà-öø-ÿ'().\-\s]{2,80}\s+(ag|ai|ar|be|bl|bs|fr|ge|gl|gr|ju|lu|ne|nw|ow|sg|sh|so|sz|tg|ur|vd|vs|zg|zh)\b/i.test(lower)) {
    return true;
  }
  const nonTiCantonsCities = [
    'bern', 'berne', 'zuerich', 'zürich', 'basel', 'lausanne', 'geneva', 'genève',
    'fribourg', 'neuchatel', 'luzern', 'lucerne', 'winterthur', 'aarau', 'zug',
    'st. gallen', 'sankt gallen', 'thun', 'biel', 'bienne',
    'gossau', 'dietlikon', 'jegensdorf', 'lenzburg', 'oberbüren', 'oberbueren',
    'pratteln', 'muttenz', 'olten', 'langenthal', 'burgdorf', 'emmen', 'kriens',
    'köniz', 'ostermundigen', 'schaffhausen', 'frauenfeld', 'wil sg', 'rapperswil',
    'uster', 'dübendorf', 'kloten', 'wetzikon', 'volketswil', 'spreitenbach',
  ];
  return nonTiCantonsCities.some((k) => lower.includes(k));
}

export function recencyTs(job) {
  const raw = job?.crawledAt || job?.postedDate || '';
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

export function mergeRequirements(a = [], b = []) {
  const cleanReq = (value = '') =>
    normalizeSpace(String(value || '')
      .replace(/&[A-Za-z]+;/g, ' ')
      .replace(/^[)\]}\-–—:.,\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim());
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    const cleaned = cleanReq(item);
    if (!cleaned) continue;
    if (/\.{2,}\s*$/.test(cleaned)) continue;
    const parts = cleaned.split(/;\s*[-•]\s+/).map((p) => p.replace(/^[-•]\s*/, '').trim()).filter((p) => p.length >= 8);
    const candidates = parts.length > 1 ? parts : [cleaned];
    for (const cand of candidates) {
      const key = cand.toLowerCase();
      if (seen.has(key)) continue;
      if (cand.length < 8 || cand.length > 120) continue;
      if (/\b(streamlined recruitment process|hiring manager|recruiter|business case|how you will make a difference|skills that will make you succeed|skills for success|eligibility requirements)\b/i.test(cand)) continue;
      seen.add(key);
      out.push(cand);
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return out;
}

export function localeTextCoverage(map = {}, minChars = 1) {
  if (!map || typeof map !== 'object') return 0;
  let c = 0;
  for (const locale of LOCALES) {
    const val = normalizeSpace(String(map[locale] || ''));
    if (val.length >= minChars) c += 1;
  }
  return c;
}

export function mergeLocaleTextMap(a = {}, b = {}, minChars = 1) {
  const out = {};
  for (const locale of LOCALES) {
    const av = normalizeSpace(String(a?.[locale] || ''));
    const bv = normalizeSpace(String(b?.[locale] || ''));
    if (av.length < minChars && bv.length < minChars) continue;
    out[locale] = bv.length >= av.length ? bv : av;
  }
  return out;
}

export function mergeLocaleRequirementsMap(a = {}, b = {}) {
  const out = {};
  for (const locale of LOCALES) {
    const merged = mergeRequirements(
      Array.isArray(a?.[locale]) ? a[locale] : [],
      Array.isArray(b?.[locale]) ? b[locale] : [],
    );
    if (merged.length > 0) out[locale] = merged;
  }
  return out;
}

function tokenizeForSimilarity(text = '') {
  return new Set(
    normalizeSpace(String(text || '').toLowerCase())
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3)
  );
}

export function textSimilarityRatio(a = '', b = '') {
  const aa = normalizeSpace(String(a || ''));
  const bb = normalizeSpace(String(b || ''));
  if (!aa && !bb) return 1;
  if (!aa || !bb) return 0;
  if (aa.toLowerCase() === bb.toLowerCase()) return 1;
  const at = tokenizeForSimilarity(aa);
  const bt = tokenizeForSimilarity(bb);
  if (at.size === 0 || bt.size === 0) return 0;
  let intersection = 0;
  for (const t of at) {
    if (bt.has(t)) intersection += 1;
  }
  const union = at.size + bt.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

export function hasCompleteLocalizedCoverage(job = {}) {
  const descCoverage = localeTextCoverage(job?.descriptionByLocale || {}, 120);
  const titleCoverage = localeTextCoverage(job?.titleByLocale || {}, 3);
  const reqCoverage = Object.keys(job?.requirementsByLocale || {}).length;
  return descCoverage >= LOCALES.length && titleCoverage >= LOCALES.length && reqCoverage >= LOCALES.length;
}

export function shouldReusePreviousLocalization(prev = {}, next = {}, cfg = {}) {
  if (!cfg?.enabled) return false;
  if (!hasCompleteLocalizedCoverage(prev)) return false;

  const prevDesc = normalizeSpace(prev?.description || '');
  const nextDesc = normalizeSpace(next?.description || '');
  if (prevDesc.length < cfg.minSourceChars || nextDesc.length < cfg.minSourceChars) return false;

  const similarity = textSimilarityRatio(prevDesc, nextDesc);
  if (similarity < cfg.similarityThreshold) return false;

  const prevLen = Math.max(1, prevDesc.length);
  const nextLen = Math.max(1, nextDesc.length);
  const deltaRatio = Math.abs(nextLen - prevLen) / prevLen;
  if (deltaRatio > cfg.maxLengthDeltaRatio) return false;

  return true;
}

export function preferJob(a, b) {
  const aScore = qualityScore(a) + (a.featured ? 2 : 0) + ((a.source === 'Company Careers Crawler') ? 1 : 0);
  const bScore = qualityScore(b) + (b.featured ? 2 : 0) + ((b.source === 'Company Careers Crawler') ? 1 : 0);
  if (aScore !== bScore) return aScore > bScore ? a : b;
  const aRecency = recencyTs(a);
  const bRecency = recencyTs(b);
  if (aRecency !== bRecency) return aRecency > bRecency ? a : b;
  const aDesc = (a.description || '').length;
  const bDesc = (b.description || '').length;
  if (aDesc !== bDesc) return aDesc > bDesc ? a : b;
  return a;
}

export function getMergeExclusionReasons(job, qualityCfg) {
  const reasons = [];
  if (!(job?.title && job?.company && job?.location && job?.description)) {
    reasons.push('missing_required_fields');
    return reasons;
  }
  if (isLikelyGenericCareerTitle(job.title)) reasons.push('generic_title');
  if (!isLikelyJobDetailUrl(job.url || '') && !hasSeedMetaTargetScope(job)) reasons.push('non_detail_url');
  if (/linkedin\.com/i.test(String(job.url || ''))) reasons.push('linkedin_url');
  if (isLocationExplicitlyForeign(job.location) && !hasSeedMetaTargetScope(job)) reasons.push('location_explicitly_foreign');
  if (!isJobPortalRelevant(job)) reasons.push('not_ticino_relevant');
  {
    const signal = `${job.title} ${job.location} ${job.description}`;
    const hasLocalPrimaryScope = isTargetSwissLocation(job.location || '');
    if (!hasLocalPrimaryScope) {
      if (isExplicitlyOutsideTarget(signal) && !hasSeedMetaTargetScope(job)) reasons.push('explicitly_outside_target');
      if (isExplicitlyOutsideSwissTicino(signal) && !hasSeedMetaTargetScope(job)) reasons.push('outside_swiss_ticino');
    }
  }
  const quality = evaluateJobQuality(job, qualityCfg);
  if (!quality.accepted) {
    reasons.push(...quality.reasons);
  }
  return reasons;
}

export function mergeAndDeduplicate(existingJobs, incomingJobs, qualityCfg, options = {}) {
  const nowIsoDate = dateOnly(Date.now());
  const nowIsoTs = new Date().toISOString();
  const map = new Map();
  const scopeCompanyKeys = new Set(
    (Array.isArray(options.scopeCompanyKeys) ? options.scopeCompanyKeys : [])
      .map((k) => normalizeCompanyKey(k))
      .filter(Boolean)
  );
  const hasScopedCompanyKeys = scopeCompanyKeys.size > 0;
  let duplicateExisting = 0;

  for (const job of existingJobs) {
    if (
      job?.source === 'Company Careers Crawler' &&
      !normalizeSpace(job?.crawledAt || '')
    ) {
      continue;
    }
    const fp = fingerprintJob(job);
    if (!fp) continue;
    const normalized = {
      ...job,
      crawledAt: normalizeSpace(job.crawledAt || ''),
    };
    const prev = map.get(fp);
    if (!prev) {
      map.set(fp, normalized);
      continue;
    }
    duplicateExisting += 1;
    map.set(fp, preferJob(prev, normalized));
  }

  let inserted = 0;
  let refreshed = 0;
  let duplicateIncoming = 0;
  let reusedLocalizationFromPrevious = 0;
  const insertedByCompany = {};
  const refreshedByCompany = {};
  const duplicateByCompany = {};
  const seenIncoming = new Set();

  for (const raw of incomingJobs) {
    const fp = fingerprintJob(raw);
    if (!fp) continue;
    if (seenIncoming.has(fp)) {
      duplicateIncoming += 1;
      duplicateByCompany[raw.company] = (duplicateByCompany[raw.company] || 0) + 1;
      continue;
    }
    seenIncoming.add(fp);
    const next = {
      ...raw,
      id: raw.id || buildStableId(raw),
      crawledAt: nowIsoTs,
    };
    const prev = map.get(fp);
    if (!prev) {
      map.set(fp, next);
      inserted += 1;
      insertedByCompany[next.company] = (insertedByCompany[next.company] || 0) + 1;
      continue;
    }
    const best = {
      ...prev,
      ...next,
      id: prev.id || next.id,
      postedDate: next.postedDate || prev.postedDate || nowIsoDate,
      crawledAt: prev.crawledAt || next.crawledAt || nowIsoTs,
      description: (next.description?.length || 0) >= (prev.description?.length || 0) ? next.description : prev.description,
      requirements: (next.requirements?.length || 0) >= (prev.requirements?.length || 0) ? next.requirements : prev.requirements,
      source: (next.source === 'Company Careers Crawler' || prev.source !== 'Company Careers Crawler')
        ? next.source
        : prev.source,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale || {}, next.titleByLocale || {}, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale || {}, next.descriptionByLocale || {}, 120),
      requirementsByLocale: mergeLocaleRequirementsMap(prev.requirementsByLocale || {}, next.requirementsByLocale || {}),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale || {}, next.slugByLocale || {}, 3),
      previousSlugs: [
        ...new Set([
          ...(Array.isArray(prev.previousSlugs) ? prev.previousSlugs : []),
          ...(Array.isArray(next.previousSlugs) ? next.previousSlugs : []),
        ])
      ].slice(0, 20),
    };
    if (shouldReusePreviousLocalization(prev, next, options.contentReuse || {})) {
      best.titleByLocale = { ...(prev.titleByLocale || {}) };
      best.descriptionByLocale = { ...(prev.descriptionByLocale || {}) };
      best.requirementsByLocale = { ...(prev.requirementsByLocale || {}) };
      best.slugByLocale = { ...(prev.slugByLocale || {}) };
      reusedLocalizationFromPrevious += 1;
    }
    if (localeTextCoverage(best.descriptionByLocale, 120) === 0 && (best.description || '').length >= 120) {
      const fallbackDesc = {};
      const descSourceLang = detectLang(best.description || '', 'en');
      fallbackDesc[descSourceLang] = best.description;
      best.descriptionByLocale = fallbackDesc;
    }
    if (localeTextCoverage(best.titleByLocale, 3) === 0 && best.title) {
      const fallbackTitle = {};
      const titleSourceLang = detectJobTitleLang(best.title, detectLang(best.description || '', 'en'));
      fallbackTitle[titleSourceLang] = best.title;
      best.titleByLocale = fallbackTitle;
    }
    const chosen = preferJob(prev, best);
    if (best._targetScope && !chosen._targetScope) {
      chosen._targetScope = best._targetScope;
    }
    map.set(fp, chosen);
    refreshed += 1;
    refreshedByCompany[best.company] = (refreshedByCompany[best.company] || 0) + 1;
  }

  const allMerged = [...map.values()];
  const inScopeJobs = hasScopedCompanyKeys
    ? allMerged.filter((j) => {
      const key = normalizeCompanyKey(String(j?.companyKey || j?.company || ''));
      return scopeCompanyKeys.has(key);
    })
    : allMerged;
  const outOfScopeJobs = hasScopedCompanyKeys
    ? allMerged.filter((j) => {
      const key = normalizeCompanyKey(String(j?.companyKey || j?.company || ''));
      return !scopeCompanyKeys.has(key);
    })
    : [];

  const mergeExclusionByReason = {};
  const mergeExclusionSamples = [];
  let mergeExcludedJobs = 0;
  const acceptedInScopeJobs = [];
  for (const job of inScopeJobs) {
    const reasons = getMergeExclusionReasons(job, qualityCfg);
    if (reasons.length === 0) {
      acceptedInScopeJobs.push(job);
      continue;
    }
    mergeExcludedJobs += 1;
    for (const reason of new Set(reasons)) {
      mergeExclusionByReason[reason] = (mergeExclusionByReason[reason] || 0) + 1;
    }
    if (mergeExclusionSamples.length < 30) {
      mergeExclusionSamples.push({
        reason: reasons[0],
        title: normalizeSpace(job?.title || ''),
        company: normalizeSpace(job?.company || ''),
        location: normalizeSpace(job?.location || ''),
        url: normalizeSpace(job?.url || ''),
      });
    }
  }

  const merged = acceptedInScopeJobs
    .sort((a, b) => {
      const recencyDiff = recencyTs(b) - recencyTs(a);
      if (recencyDiff !== 0) return recencyDiff;
      return String(b.postedDate).localeCompare(String(a.postedDate));
    });

  let heuristicDupes = 0;
  const seenHeuristic = new Map();
  for (const job of merged) {
    const dedupKey = dedupHeuristicKey(job);
    const prev = seenHeuristic.get(dedupKey);
    if (prev) {
      heuristicDupes += 1;
      seenHeuristic.set(dedupKey, preferJob(prev, job));
    } else {
      seenHeuristic.set(dedupKey, job);
    }
  }
  const deduped = [...seenHeuristic.values()].sort((a, b) => {
    const recencyDiff = recencyTs(b) - recencyTs(a);
    if (recencyDiff !== 0) return recencyDiff;
    return String(b.postedDate).localeCompare(String(a.postedDate));
  });

  const withPreservedOutOfScope = hasScopedCompanyKeys
    ? [...outOfScopeJobs, ...deduped]
    : deduped;
  const dedupedByFp = new Map();
  for (const job of withPreservedOutOfScope) {
    const fp = fingerprintJob(job);
    if (!fp) continue;
    const prev = dedupedByFp.get(fp);
    dedupedByFp.set(fp, prev ? preferJob(prev, job) : job);
  }
  const finalJobs = [...dedupedByFp.values()].sort((a, b) => {
    const recencyDiff = recencyTs(b) - recencyTs(a);
    if (recencyDiff !== 0) return recencyDiff;
    return String(b.postedDate).localeCompare(String(a.postedDate));
  });
  if (heuristicDupes > 0) {
    console.log(`\n🔄 Heuristic dedup: removed ${heuristicDupes} duplicate(s) using identity + multi-field signature`);
  }

  const slugRegistry = loadSlugRegistry();
  let registryHits = 0;
  let registryNewEntries = 0;
  const usedSlugs = new Set();
  for (const job of deduped) {
    const registered = getRegisteredSlug(job, slugRegistry);
    if (registered && registered.canonicalSlug) {
      job.slug = registered.canonicalSlug;
      if (registered.slugByLocale && typeof registered.slugByLocale === 'object') {
        if (!job.slugByLocale || typeof job.slugByLocale !== 'object') job.slugByLocale = {};
        for (const [loc, s] of Object.entries(registered.slugByLocale)) {
          if (s && !job.slugByLocale[loc]) job.slugByLocale[loc] = s;
        }
      }
      usedSlugs.add(job.slug);
      registryHits += 1;
      continue;
    }
    let slug = normalizeSpace(job.slug || ensureJobSlug(job));
    if (!slug) slug = `job-${job.id}`;
    let candidate = slug;
    let suffix = 2;
    while (usedSlugs.has(candidate)) {
      candidate = `${slug}-${suffix}`;
      suffix += 1;
    }
    job.slug = candidate;
    usedSlugs.add(candidate);
    const sizeBefore = Object.keys(slugRegistry).length;
    registerJobSlug(job, slugRegistry);
    if (Object.keys(slugRegistry).length > sizeBefore) registryNewEntries += 1;
  }
  saveSlugRegistry(slugRegistry);
  if (registryHits > 0 || registryNewEntries > 0) {
    console.log(`🔒 Slug registry: ${registryHits} locked from registry, ${registryNewEntries} new entries added (${Object.keys(slugRegistry).length} total)`);
  }

  return {
    merged: finalJobs,
    inserted,
    refreshed,
    duplicateIncoming,
    duplicateExisting,
    insertedByCompany,
    refreshedByCompany,
    duplicateByCompany,
    reusedLocalizationFromPrevious,
    mergeExcludedJobs,
    mergeExclusionByReason,
    mergeExclusionSamples,
  };
}
