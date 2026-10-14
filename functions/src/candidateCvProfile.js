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

const MAX_SEARCH_TEXT = 18_000;
const MAX_SKILLS = 40;
const MAX_EXPERIENCE_LINES = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SECTION_HEADINGS = /^(?:curriculum vitae|cv|profilo|profile|esperienza|esperienze|experience|work experience|competenze|skills|compétences|kenntnisse|lingue|languages|langues|sprachen|formazione|education|éducation|ausbildung)\s*:?$/i;
const CONTACT_RE = /(?:@|\+?\d[\d\s()./-]{6,})/;
const YEAR_RE = /(?:19|20)\d{2}/;
const STOP_LINE_RE = /^(?:curriculum vitae|cv|profilo|profile|esperienza|esperienze|experience|work experience|competenze|skills|lingue|languages|formazione|education|istruzione|references|referenze)\s*:?[\s]*$/i;

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
    if (STOP_LINE_RE.test(lines[index])) break;
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
    if (CONTACT_RE.test(line) || STOP_LINE_RE.test(line)) continue;
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
  const found = [];
  for (const value of ['italiano', 'italian', 'inglese', 'english', 'tedesco', 'german', 'francese', 'french', 'spagnolo', 'spanish', 'portoghese', 'portuguese']) {
    if (new RegExp(`\\b${value}\\b`, 'i').test(languageText)) found.push(value);
  }
  return unique(found, 12);
}

function skillValues(lines) {
  const skillLines = sectionLines(lines, /^(?:competenze|skills|compétences|kenntnisse)\s*:?$/i);
  const values = skillLines.flatMap((line) => line.split(/[,;:/]/));
  return unique(values.filter((value) => value.length >= 2 && value.length <= 80));
}

function experienceValues(lines) {
  return lines.filter((line) => YEAR_RE.test(line) || /\b(?:oggi|present|current|actuel|heute)\b/i.test(line))
    .slice(0, MAX_EXPERIENCE_LINES);
}

function normalizedSearchText(profile) {
  return clean([
    profile.fullName,
    profile.headline,
    profile.workPosition,
    profile.workplace,
    ...(profile.skills || []),
    ...(profile.languages || []),
    ...(profile.experienceSummary || []),
  ].filter(Boolean).join(' '), MAX_SEARCH_TEXT);
}

/** Parse only facts that can be traced to the extracted CV text. */
export function parseCandidateCvText(text) {
  const normalizedText = clean(text, MAX_SEARCH_TEXT);
  const lines = linesOf(text);
  const email = emailFromText(text);
  const phone = phoneFromText(text);
  const fullName = likelyName(lines);
  const headline = likelyHeadline(lines, fullName);
  const skills = skillValues(lines);
  const languages = languageValues(lines);
  const experienceSummary = experienceValues(lines);
  const workPosition = headline || skills[0] || '';
  const workplace = lines.find((line) => /\b(?:Lugano|Mendrisio|Bellinzona|Locarno|Zurigo|Zürich|Milano|Como|Varese|Ticino|Zug|Genf|Genève|Basel|Basilea)\b/i.test(line)) || '';
  const profile = {
    fullName: clean(fullName, 200),
    email: EMAIL_RE.test(email) ? email : '',
    phone,
    headline: clean(headline, 200),
    workPosition: clean(workPosition, 200),
    workplace: clean(workplace, 160),
    preferredLanguage: languages[0] || '',
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

async function mergeSafeProfileFields(db, email, parsed) {
  const normalizedEmail = clean(email, 320).toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) return false;
  const ref = db.collection('newsletter_subscribers').doc(normalizedEmail);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  const existing = snapshot.data() || {};
  const projection = {
    ...(existing.workPosition ? {} : parsed.workPosition ? { workPosition: parsed.workPosition } : {}),
    ...(existing.workplace ? {} : parsed.workplace ? { workplace: parsed.workplace } : {}),
    ...(existing.preferredLanguage ? {} : parsed.preferredLanguage ? { preferredLanguage: parsed.preferredLanguage } : {}),
    cv_profile_available: true,
    cv_profile_updated_at: new Date().toISOString(),
  };
  await ref.set(projection, { merge: true });
  return true;
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
  applicantEmail = '',
  uploadedAt = null,
} = {}) {
  if (!userId || !sourceId || !cvStorageKey) return { status: 'skipped', reason: 'missing_input' };
  const profileRef = db.collection('user_cv_profiles').doc(String(userId));
  const sourceRef = sourceRefFor(db, safeSourceType(sourceType), sourceId);
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
    await mergeSafeProfileFields(db, applicantEmail || parsed.email, parsed).catch(() => false);
    return { status, detectedType, profile: parsed };
  } catch (error) {
    await profileRef.set({ status: 'needs_review', cvProcessingError: 'cv_processing_failed', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (sourceRef) await sourceRef.set({ cvProfileStatus: 'needs_review', cvProfileUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'needs_review', error: error instanceof Error ? error.message : String(error) };
  }
}
// End of the private CV profile projection module.
