/**
 * Private, deterministic CV profile projection.
 *
 * The browser never receives the CV bytes or the extracted text. This module
 * creates the owner-only `user_cv_profiles/{uid}` projection used by the
 * profile page and by the concierge matcher. Parsing is deliberately
 * conservative: a missing or scanned-document text layer produces
 * `needs_review` instead of invented candidate data.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { extractCvText } from './assistedApplicationAiDocuments.js';
import { detectCvFileType, ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { CV_PROFILE_PARSER_VERSION } from './candidateCvProfileContract.js';

export { CV_PROFILE_PARSER_VERSION } from './candidateCvProfileContract.js';

const MAX_SEARCH_TEXT = 18_000;
const MAX_SKILLS = 40;
const MAX_EXPERIENCE_LINES = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SKILL_HEADING_RE = /^(?:skills?|core skills?|key skills?|technical skills?|technical competencies|core competencies|key competencies|professional competencies|competencies|skills and expertise|areas of expertise|expertise|competenze(?: tecniche| chiave| professionali)?|compétences?(?: techniques| clés| cles| informatiques)?|competences(?: techniques| cles| informatiques)?|kenntnisse|fachkenntnisse|informatikkenntnisse|fähigkeiten|fahigkeiten|kompetenzen)\s*:?$/i;
const EXPERIENCE_HEADING_RE = /^(?:esperienza(?: professionale)?|esperienze(?: professionali)?|experience|work experience|professional experience|employment history|work history|professional background|career history|expérience professionnelle|berufserfahrung)\s*:?$/i;
const PROFILE_SECTION_HEADING_RE = /^(?:informazioni personali|dati personali|personal information|personal details|personal data|persönliche daten|donnees personnelles|données personnelles|résidence|residenza|domicilio|wohnort|wohnsitz|family members|family composition|familiari|composizione familiare|familienmitglieder|membres de la famille)\s*:?$/i;
const FAMILY_MEMBER_SECTION_RE = /^(?:family members|family composition|familiari|composizione familiare|familienmitglieder|membres de la famille)\s*:?$/i;
const PROFILE_FIELD_LABEL_RE = /^(?:age|età|âge|alter|date of birth|birth date|dob|data di nascita|nato il|nata il|date de naissance|geburtsdatum|gender|sex|sesso|genere|geschlecht|marital status|family situation|civil status|stato civile|situazione familiare|familienstand|état civil|situation familiale|frontaliere type|border worker permit|work permit|residence permit|permit type|permesso di lavoro|tipo di permesso|bewilligung|permis de travail|permit expiry|permit expiration|expiry date|valid until|scadenza permesso|scadenza del permesso|permesso valido fino al|gültig bis|date d’expiration du permis|expiration du permis|current residence|residential municipality|residence municipality|municipality of residence|comune di residenza|indirizzo di residenza|residential address|home address|residence|residenza|domicilio|wohnort|wohnsitz|adresse|address|number of children|number of kids|children count|children|kids|figli|numero di figli|enfants|kinder|household size|number of household members|number of family members|family members count|componenti del nucleo familiare|numero componenti nucleo familiare|membri della famiglia|household members|annual gross salary|gross annual salary|annual salary|salary per year|salary per annum|gross salary|salary|retribuzione annua lorda|retribuzione annuale lorda|stipendio lordo annuo|stipendio annuo|salario annuo|ral|bruttojahresgehalt|jahresgehalt|preferred language|preferred language for communication|lingua preferita|langue préférée|langue de préférence|bevorzugte sprache|preferred border crossing|preferred customs crossing|preferred frontier crossing|dogana preferita|passaggio di frontiera preferito|grenzübergang bevorzugt|poste-frontière préféré|workplace|work location|office location|luogo di lavoro|sede di lavoro|standort|lieu de travail)\s*[:：=]?\s*$/i;
const SECTION_HEADING_RE = /^(?:curriculum vitae|cv|profilo|profile|summary|professional summary|esperienza|esperienze|experience|work experience|professional experience|employment history|work history|professional background|career history|expérience professionnelle|berufserfahrung|competenze|skills|core skills|key skills|technical competencies|core competencies|key competencies|professional competencies|competencies|skills and expertise|areas of expertise|expertise|competenze tecniche|competenze chiave|competenze professionali|compétences|compétences techniques|compétences clés|compétences cles|compétences informatiques|competences techniques|competences cles|competences informatiques|kenntnisse|fachkenntnisse|informatikkenntnisse|fähigkeiten|fahigkeiten|kompetenzen|lingue|languages|langues|sprachen|formazione|education|éducation|ausbildung|istruzione|references|referenze)\s*:?$/i;
const CONTACT_RE = /(?:@|\+?\d[\d\s()./-]{6,})/;
const YEAR_RE = /(?:19|20)\d{2}/;
const STOP_LINE_RE = /^(?:curriculum vitae|cv|profilo|profile|esperienza|esperienze|experience|work experience|employment history|work history|competenze|skills|lingue|languages|langues|sprachen|formazione|education|éducation|ausbildung|istruzione|references|referenze)\s*:?[\s]*$/i;

function clean(value, max = 400) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function linesOf(text) {
  return String(text || '')
    .split(/\r?\n|•|·|\|/)
    .map((line) => clean(line, 500))
    .filter(Boolean);
}
function unique(values, max = MAX_SKILLS) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const item = clean(value, 100);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

function sectionLines(lines, headingPattern) {
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return [];
  const result = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (STOP_LINE_RE.test(lines[index]) || SECTION_HEADING_RE.test(lines[index]) || PROFILE_SECTION_HEADING_RE.test(lines[index]) || SKILL_HEADING_RE.test(lines[index])) break;
    result.push(lines[index]);
  }
  return result;
}

function emailFromText(text) {
  return String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
}

function phoneFromText(text) {
  const candidate = String(text || '').match(/(?:\+|00)?\d[\d\s()./-]{7,}\d/);
  return clean(candidate?.[0] || '', 80);
}

function likelyName(lines) {
  for (const line of lines.slice(0, 8)) {
    if (CONTACT_RE.test(line) || STOP_LINE_RE.test(line) || SECTION_HEADING_RE.test(line) || SKILL_HEADING_RE.test(line)) continue;
    if (line.length < 3 || line.length > 90 || /\d/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 5) return line;
  }
  return '';
}

function likelyHeadline(lines, name) {
  const rolePattern = /\b(?:developer|engineer|manager|analyst|designer|nurse|infermiere|infermiera|medico|accountant|contabile|technician|tecnico|operator|operaio|sales|marketing|recruiter|project|chef|cuoco|cameriere|driver|autista|warehouse|magazzin|architect|architetto|lawyer|avvoc|teacher|insegn|consultant|consulente|specialist|responsabile|assistant|assistente)\b/i;
  return lines.find((line) => line !== name && rolePattern.test(line) && line.length <= 140) || '';
}

function languageValues(lines) {
  const languageText = sectionLines(lines, /^(?:lingue|languages|langues|sprachen)\s*:?$/i).join(' ');
  const candidates = [
    [/\bdeutschkenntnis(?:se|sen)?\b/gi, 'deutsch'],
    [/\benglischkenntnis(?:se|sen)?\b/gi, 'englisch'],
    [/\bfranzösischkenntnis(?:se|sen)?\b/gi, 'französisch'],
    [/\bitalienischkenntnis(?:se|sen)?\b/gi, 'italienisch'],
    ...[
      'italiano', 'italian', 'italien', 'italienisch',
      'inglese', 'english', 'englisch', 'anglais',
      'tedesco', 'german', 'deutsch', 'allemand',
      'francese', 'french', 'français', 'französisch',
      'spagnolo', 'spanish', 'español', 'spanisch', 'espagnol',
      'portoghese', 'portuguese', 'português', 'portugiesisch',
    ].map((value) => [new RegExp('\\b' + value + '\\b', 'gi'), value]),
  ];
  const found = [];
  for (const [pattern, language] of candidates) {
    for (const match of languageText.matchAll(pattern)) found.push({ index: match.index ?? 0, language });
  }
  found.sort((left, right) => left.index - right.index);
  return unique(found.map((item) => item.language), 12);
}

/** Read a value only when the CV labels it as that specific fact. */
function labelledValue(lines, labels) {
  const inline = new RegExp('^\\s*(?:' + labels + ')\\s*[:：=]\\s*(.+?)\\s*$', 'i');
  const spaced = new RegExp('^\\s*(?:' + labels + ')\\s+(.+?)\\s*$', 'i');
  const labelOnly = new RegExp('^\\s*(?:' + labels + ')\\s*[:：=]?\\s*$', 'i');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(inline) || line.match(spaced);
    if (match?.[1]) return clean(match[1], 240);
    if (!labelOnly.test(line)) continue;
    const next = lines[index + 1] || '';
    if (!next || PROFILE_FIELD_LABEL_RE.test(next) || SECTION_HEADING_RE.test(next) || PROFILE_SECTION_HEADING_RE.test(next)) continue;
    return clean(next, 240);
  }
  return '';
}

function localeForLanguage(value) {
  const text = clean(value, 120).toLocaleLowerCase();
  if (/italian|italiano|italien|italienisch/.test(text)) return 'it';
  if (/english|inglese|englisch|anglais/.test(text)) return 'en';
  if (/german|tedesco|deutsch|allemand|tedesca/.test(text)) return 'de';
  if (/french|francese|français|französisch|francais/.test(text)) return 'fr';
  return '';
}

function preferredLanguageValue(lines) {
  const explicit = labelledValue(lines, 'preferred language|preferred language for communication|lingua preferita|langue préférée|langue de préférence|bevorzugte sprache');
  return explicit ? localeForLanguage(explicit) : '';
}

function utcDateFromParts(year, month, day) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return parsed;
}

function birthDateFromValue(value) {
  const text = clean(value, 120);
  const iso = text.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return utcDateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const european = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b/);
  if (european) return utcDateFromParts(Number(european[3]), Number(european[2]), Number(european[1]));
  return null;
}

function ageBracket(age) {
  if (!Number.isInteger(age) || age < 18 || age > 120) return '';
  if (age <= 25) return '18-25';
  if (age <= 35) return '26-35';
  if (age <= 45) return '36-45';
  if (age <= 55) return '46-55';
  if (age <= 65) return '56-65';
  return '65+';
}

function ageValue(lines, nowMs) {
  const explicitAge = labelledValue(lines, 'age|età|âge|alter');
  const explicitNumber = explicitAge.match(/^\s*(\d{1,3})(?:\s*(?:years?|yrs?|anni|ans|jahre)(?:\s+old)?)?\s*$/i);
  if (explicitNumber) return ageBracket(Number(explicitNumber[1]));

  const birthValue = explicitAge || labelledValue(lines, 'date of birth|birth date|dob|data di nascita|nato il|nata il|date de naissance|geburtsdatum');
  const birthDate = birthDateFromValue(birthValue);
  if (!birthDate || Number.isNaN(birthDate.getTime())) return '';
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birthDate.getUTCMonth()
    || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return ageBracket(age);
}

function genderValue(lines) {
  const value = labelledValue(lines, 'gender|sex|sesso|genere|geschlecht');
  const text = clean(value, 120).toLocaleLowerCase();
  if (/^(?:male|man|masculine|maschile|uomo|männlich|masculin|m)$/.test(text)) return 'male';
  if (/^(?:female|woman|feminine|femminile|donna|weiblich|féminin|f)$/.test(text)) return 'female';
  if (/^(?:other|altro|altra|non[- ]?binary|nonbinary|diverse|divers|non-binaire)$/.test(text)) return 'other';
  return '';
}

function familySituationValue(lines) {
  const value = labelledValue(lines, 'marital status|family situation|civil status|stato civile|situazione familiare|familienstand|état civil|situation familiale');
  const text = clean(value, 160).toLocaleLowerCase();
  if (/\b(?:not|never) (?:legally )?(?:married|divorced)\b|\bnot legally married\b|\bnon (?:sposat[oa]|coniugat[oa])\b/.test(text)) return '';
  if (/\b(?:single|unmarried|celibe|nubile|ledig|célibataire)\b/.test(text)) return 'single';
  if (/\b(?:married|sposat[oa]|coniugat[oa]|verheiratet|marié[ea])\b/.test(text)) return 'married';
  if (/\b(?:divorced|divorziat[oa]|geschieden|divorcé[ea])\b/.test(text)) return 'divorced';
  if (/\b(?:cohabiting|cohabitant|convivent[ei]|convivente|partenariat|eingetragene partnerschaft|union libre)\b/.test(text)) return 'cohabiting';
  return '';
}

function frontaliereTypeValue(lines) {
  const value = labelledValue(lines, 'frontaliere type|border worker permit|work permit|residence permit|permit type|permesso di lavoro|tipo di permesso|bewilligung|permis de travail');
  const text = clean(value, 160).toLocaleLowerCase();
  if (/\b(?:permit|permesso|bewilligung|permis)?\s*(?:type\s*)?g\b|grenzgängerbewilligung|permesso g/.test(text)) return 'permit-g';
  if (/\b(?:permit|permesso|bewilligung|permis)?\s*(?:type\s*)?b\b|permesso b/.test(text)) return 'permit-b';
  if (/\b(?:considering|in valutazione|sto valutando|à l'étude|noch unentschieden)\b/.test(text)) return 'considering';
  return '';
}

function isoDateValue(value) {
  const parsed = birthDateFromValue(value);
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function permitExpiryValue(lines) {
  const value = labelledValue(lines, 'permit expiry|permit expiration|expiry date|valid until|scadenza permesso|scadenza del permesso|permesso valido fino al|gültig bis|date d’expiration du permis|expiration du permis');
  return isoDateValue(value);
}

function municipalityValue(lines) {
  const address = labelledValue(lines, 'current residence|residential municipality|residence municipality|municipality of residence|comune di residenza|indirizzo di residenza|residential address|home address|residence|residenza|domicilio|wohnort|wohnsitz');
  if (!address) return '';
  const postal = address.match(/\b\d{4,5}\s+([^,;]+)/);
  if (postal?.[1]) return clean(postal[1].replace(/\s*\([A-Z]{1,3}\)\s*$/, ''), 120);
  const country = /^(?:italy|italia|switzerland|schweiz|suisse|svizzera|germany|deutschland|france|francia|austria)$/i;
  const parts = address.split(/[;,]/).map((part) => clean(part, 120)).filter(Boolean).reverse();
  for (const part of parts) {
    if (country.test(part)) continue;
    const candidate = part.replace(/\s*\([A-Z]{1,3}\)\s*$/, '').trim();
    if (!candidate || /\d/.test(candidate) || /\b(?:via|viale|piazza|strasse|straße|rue|route|street|road)\b/i.test(candidate)) continue;
    if (candidate.split(/\s+/).length <= 4) return candidate;
  }
  return '';
}

function countValue(lines, labels, maximum) {
  const value = labelledValue(lines, labels).toLocaleLowerCase();
  if (!value) return '';
  const numberWords = {
    one: 1, uno: 1, una: 1, ein: 1, eine: 1, un: 1, une: 1,
    two: 2, due: 2, zwei: 2, deux: 2,
    three: 3, tre: 3, drei: 3, trois: 3,
    four: 4, quattro: 4, vier: 4, quatre: 4,
    five: 5, cinque: 5, fünf: 5, cinq: 5,
    six: 6, sei: 6, sechs: 6, sixième: 6,
  };
  const nouns = '(?:children|child|kids|kid|figli|figlio|figlia|enfants|enfant|kinder|members|people|persons|household members|family members|componenti|membri|familiari|membres)';
  const noCount = new RegExp('^(?:none|no|zero|0|nessuno|nessuna|kein(?:e|en)?|aucun|aucune)(?:\\s+' + nouns + ')?$', 'i');
  if (noCount.test(value.trim())) return '0';
  const numeric = value.trim().match(new RegExp('^(\\d{1,2})(?:\\s+' + nouns + ')?$', 'i'));
  const word = value.trim().match(new RegExp('^(' + Object.keys(numberWords).join('|') + ')(?:\\s+' + nouns + ')?$', 'i'));
  const amount = numeric ? Number(numeric[1]) : (word ? numberWords[word[1].toLocaleLowerCase()] : NaN);
  if (!Number.isInteger(amount) || amount < 0) return '';
  return amount >= maximum ? maximum + '+' : String(amount);
}

function salaryValue(lines) {
  const annualLabels = 'annual gross salary|gross annual salary|annual salary|salary per year|salary per annum|retribuzione annua lorda|retribuzione annuale lorda|stipendio lordo annuo|stipendio annuo|salario annuo|ral|bruttojahresgehalt|jahresgehalt';
  const annualValue = labelledValue(lines, annualLabels);
  const value = annualValue || labelledValue(lines, 'gross salary|salary|retribuzione|stipendio|salario');
  if (!value || !/\b(?:chf|sfr\.?|franchi svizzeri|swiss francs)\b/i.test(value)) return '';
  if (!annualValue && !/\b(?:annual|annually|yearly|per year|per annum|p\.?a\.?|annua|annuo|annuale|all'anno|l'anno|jahr|pro jahr|ral)\b/i.test(value)) return '';
  const groupedAmount = "(?:\\d{1,3}(?:[\\s'’.,]\\d{3})+|\\d{4,})";
  if (new RegExp(groupedAmount + '\\s*(?:-|–|—|to|bis|a)\\s*' + groupedAmount, 'i').test(value)) return '';
  const currency = '(?:chf|sfr\\.?|franchi svizzeri|swiss francs)';
  const amount = '(' + groupedAmount + ')';
  const amounts = [...value.matchAll(new RegExp('(?:' + currency + ')\\s*' + amount + '(?!\\d)|' + amount + '\\s*(?:' + currency + ')(?!\\w)', 'gi'))];
  if (amounts.length !== 1) return '';
  const amountText = amounts[0][1] || amounts[0][2] || '';
  if (!amountText || /[kKmM]\b/.test(value.slice(amounts[0].index + amounts[0][0].length))) return '';
  const digits = amountText.replace(/\D/g, '');
  const parsedAmount = Number(digits);
  return Number.isSafeInteger(parsedAmount) && parsedAmount > 0 ? String(parsedAmount) : '';
}

function preferredDoganaValue(lines) {
  return labelledValue(lines, 'preferred border crossing|preferred customs crossing|preferred frontier crossing|dogana preferita|passaggio di frontiera preferito|grenzübergang bevorzugt|poste-frontière préféré');
}

function yesNoValue(value) {
  const text = clean(value, 80).toLocaleLowerCase();
  if (/^(?:yes|y|true|si|sì|ja|oui)$/.test(text)) return true;
  if (/^(?:no|n|false|nein|non)$/.test(text)) return false;
  return null;
}

function familyMemberValues(lines) {
  const section = sectionLines(lines, FAMILY_MEMBER_SECTION_RE);
  const members = [];
  for (const line of section) {
    const relationshipMatch = line.match(/^(spouse|wife|husband|partner|coniuge|moglie|marito|partner|child|son|daughter|figlio|figlia|parent|mother|father|genitore|madre|padre|sibling|brother|sister|fratello|sorella|other|altro|altra)\b/i);
    if (!relationshipMatch) continue;
    const word = relationshipMatch[1].toLocaleLowerCase();
    const relationship = /^(?:spouse|wife|husband|partner|coniuge|moglie|marito)$/.test(word) ? 'spouse'
      : /^(?:child|son|daughter|figlio|figlia)$/.test(word) ? 'child'
        : /^(?:parent|mother|father|genitore|madre|padre)$/.test(word) ? 'parent'
          : /^(?:sibling|brother|sister|fratello|sorella)$/.test(word) ? 'sibling' : 'other';
    const dependentMatch = line.match(/\b(?:dependent|dependant|a carico|à charge)\s*[:=]\s*(yes|no|y|n|true|false|sì|si|ja|oui|nein|non)\b/i);
    const liveTogetherMatch = line.match(/\b(?:lives? with me|living together|live together|convive con me|vive con me|same household|coabitazione)\s*[:=]\s*(yes|no|y|n|true|false|sì|si|ja|oui|nein|non)\b/i);
    const dependent = dependentMatch ? yesNoValue(dependentMatch[1]) : null;
    const liveTogether = liveTogetherMatch ? yesNoValue(liveTogetherMatch[1]) : null;
    if (dependent === null || liveTogether === null) continue;
    const birthYear = line.match(/\b(?:birth year|born|nato nel|nata nel|geburtsjahr|année de naissance)\s*[:=]?\s*((?:19|20)\d{2})\b/i)?.[1] || undefined;
    members.push({ id: 'cv-family-' + members.length, relationship, ...(birthYear ? { birthYear } : {}), liveTogether, dependent });
  }
  return members;
}

function skillValues(lines) {
  const skillLines = sectionLines(lines, SKILL_HEADING_RE);
  const values = skillLines.flatMap((line) => line.split(/[,;:]\s*|\s+\/\s+/));
  return unique(values.filter((value) => value.length >= 2 && value.length <= 80));
}

function experienceValues(lines) {
  const isDated = (line) => YEAR_RE.test(line) || /\b(?:oggi|present|current|actuel|heute)\b/i.test(line);
  const section = sectionLines(lines, EXPERIENCE_HEADING_RE);
  if (!section.length) return lines.filter(isDated).slice(0, MAX_EXPERIENCE_LINES);

  const datedLines = section.filter(isDated).slice(0, Math.floor(MAX_EXPERIENCE_LINES / 2));
  const segments = [];
  let currentSegment = [];
  for (const line of section) {
    if (isDated(line) && currentSegment.length) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(line);
  }
  if (currentSegment.length) segments.push(currentSegment);

  const descriptionGroups = segments.map((segment) => segment.filter((line) => !isDated(line)
    && line.length >= 36
    && !CONTACT_RE.test(line)
    && !SECTION_HEADING_RE.test(line)
    && !SKILL_HEADING_RE.test(line)));
  const descriptionSlots = Math.max(0, MAX_EXPERIENCE_LINES - datedLines.length);
  const descriptions = [];
  for (let depth = 0; descriptions.length < descriptionSlots; depth += 1) {
    let foundAtDepth = false;
    for (const group of descriptionGroups) {
      if (!group[depth]) continue;
      descriptions.push(group[depth]);
      foundAtDepth = true;
      if (descriptions.length >= descriptionSlots) break;
    }
    if (!foundAtDepth) break;
  }

  const result = [];
  const seen = new Set();
  for (const value of [...datedLines, ...descriptions]) {
    const item = clean(value, 240);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_EXPERIENCE_LINES) break;
  }
  return result;
}

function normalizedSearchText(profile) {
  return clean([
    profile.headline,
    profile.workPosition,
    ...(profile.skills || []),
    ...(profile.languages || []),
    ...(profile.experienceSummary || []),
  ].filter(Boolean).join(' '), MAX_SEARCH_TEXT);
}

/** Parse only facts that can be traced to an explicit CV statement. */
export function parseCandidateCvText(text, { nowMs = Date.now() } = {}) {
  const normalizedText = clean(text, MAX_SEARCH_TEXT);
  const lines = linesOf(text);
  const email = emailFromText(text);
  const phone = phoneFromText(text);
  const fullName = likelyName(lines);
  const headline = likelyHeadline(lines, fullName);
  const skills = skillValues(lines);
  const languages = languageValues(lines);
  const familyMembersList = familyMemberValues(lines);
  const experienceSummary = experienceValues(lines);
  const workPosition = headline;
  const workplace = labelledValue(lines, 'workplace|work location|office location|luogo di lavoro|sede di lavoro|standort|lieu de travail');
  const profile = {
    fullName: clean(fullName, 200),
    email: EMAIL_RE.test(email) ? email : '',
    phone,
    headline: clean(headline, 200),
    workPosition: clean(workPosition, 200),
    workplace: clean(workplace, 160),
    age: ageValue(lines, nowMs),
    gender: genderValue(lines),
    familySituation: familySituationValue(lines),
    frontaliereType: frontaliereTypeValue(lines),
    municipality: municipalityValue(lines),
    children: countValue(lines, 'number of children|children count|children|figli|numero di figli|enfants|kinder', 4),
    familyMembers: countValue(lines, 'household size|number of household members|number of family members|family members count|componenti del nucleo familiare|numero componenti nucleo familiare|membri della famiglia|household members', 6),
    familyMembersList,
    preferredDogana: preferredDoganaValue(lines),
    preferredLanguage: preferredLanguageValue(lines),
    grossSalary: salaryValue(lines),
    permitExpiry: permitExpiryValue(lines),
    skills,
    languages,
    experienceSummary,
    extractedTextAvailable: Boolean(normalizedText),
  };
  return { ...profile, searchText: normalizedSearchText(profile) };
}

function sourceFileName(storageKey) {
  return clean(String(storageKey || '').split('/').pop() || 'CV', 160);
}

function safeSourceType(value) {
  return ['application_concierge', 'assisted_application'].includes(value) ? value : 'unknown';
}

function sourceRefFor(db, sourceType, sourceId) {
  if (!db || !sourceId) return null;
  if (sourceType === 'application_concierge') return db.collection('application_concierge_services').doc(sourceId);
  if (sourceType === 'assisted_application') return db.collection('assisted_applications').doc(sourceId);
  return null;
}

/**
 * Read, parse and persist a candidate CV. The caller owns trigger idempotency;
 * this function is safe to retry because the profile document is merged.
 */
export async function enrichCandidateProfileFromCv({
  db = getAdminDb(),
  bucket = null,
  userId,
  sourceId,
  sourceType,
  cvStorageKey,
  uploadedAt = null,
  updateSource = true,
} = {}) {
  if (!userId || !sourceId || !cvStorageKey) return { status: 'skipped', reason: 'missing_input' };
  const profileRef = db.collection('user_cv_profiles').doc(String(userId));
  const sourceRef = updateSource ? sourceRefFor(db, safeSourceType(sourceType), sourceId) : null;
  const fileName = sourceFileName(cvStorageKey);
  const source = safeSourceType(sourceType);
  const now = Timestamp.now();
  await profileRef.set({
    userId: String(userId),
    status: 'processing',
    cvDocument: { fileName, sourceType: source, sourceId: String(sourceId), uploadedAt: uploadedAt || now },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (sourceRef) await sourceRef.set({ cvFileName: fileName, cvProfileStatus: 'processing', cvProfileUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });

  try {
    const storageBucket = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
    const file = storageBucket.file(cvStorageKey);
    const [buffer] = await file.download();
    const detectedType = detectCvFileType(buffer.subarray(0, 8));
    const text = detectedType ? await extractCvText(buffer, detectedType) : '';
    const parsed = parseCandidateCvText(text);
    const status = parsed.extractedTextAvailable ? 'ready' : 'needs_review';
    await profileRef.set({
      userId: String(userId),
      status,
      parserVersion: CV_PROFILE_PARSER_VERSION,
      sourceType: source,
      sourceId: String(sourceId),
      cvDocument: {
        fileName,
        sourceType: source,
        sourceId: String(sourceId),
        uploadedAt: uploadedAt || now,
        detectedType: detectedType || null,
        extractedTextAvailable: parsed.extractedTextAvailable,
      },
      profile: parsed,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (sourceRef) await sourceRef.set({
      cvFileName: fileName,
      cvProfileStatus: status,
      cvProfileUpdatedAt: FieldValue.serverTimestamp(),
      ...(source === 'application_concierge' ? { matchingStatus: status === 'ready' ? 'queued' : 'needs_review' } : {}),
    }, { merge: true });
    return { status, parserVersion: CV_PROFILE_PARSER_VERSION, detectedType, profile: parsed };
  } catch (error) {
    await profileRef.set({ status: 'needs_review', cvProcessingError: 'cv_processing_failed', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (sourceRef) await sourceRef.set({ cvProfileStatus: 'needs_review', cvProfileUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'needs_review', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Rebuild an older CV projection for its authenticated owner without touching
 * concierge matching or the application order's state.
 */
export async function refreshCandidateCvProfile({ db = getAdminDb(), userId } = {}) {
  if (!db || !userId) return { status: 'unavailable' };
  const profileSnapshot = await db.collection('user_cv_profiles').doc(String(userId)).get();
  if (!profileSnapshot.exists) return { status: 'unavailable' };
  const profileRecord = profileSnapshot.data() || {};
  if (Number(profileRecord.parserVersion) >= CV_PROFILE_PARSER_VERSION) {
    return { status: 'current', parserVersion: Number(profileRecord.parserVersion) };
  }
  if (profileRecord.status === 'processing') {
    return { status: 'processing', parserVersion: Number(profileRecord.parserVersion) || null };
  }

  const cvDocument = profileRecord.cvDocument || {};
  const sourceType = safeSourceType(cvDocument.sourceType || profileRecord.sourceType);
  const sourceId = String(cvDocument.sourceId || profileRecord.sourceId || '');
  const sourceCollection = sourceType === 'application_concierge'
    ? 'application_concierge_services'
    : sourceType === 'assisted_application' ? 'assisted_applications' : '';
  if (!sourceCollection || !sourceId) return { status: 'unavailable' };

  const sourceSnapshot = await db.collection(sourceCollection).doc(sourceId).get();
  if (!sourceSnapshot.exists) return { status: 'unavailable' };
  const source = sourceSnapshot.data() || {};
  if (String(source.userId || '') !== String(userId) || !source.cvStorageKey) return { status: 'unavailable' };

  const result = await enrichCandidateProfileFromCv({
    db,
    userId,
    sourceId,
    sourceType,
    cvStorageKey: source.cvStorageKey,
    uploadedAt: source.cvUploadedAt || cvDocument.uploadedAt || null,
    updateSource: false,
  });
  return { status: result.status, parserVersion: result.parserVersion || null };
}
// End of the private CV profile projection module.
