import { getAuth } from 'firebase-admin/auth';
import { pdfRendererMode, renderCvPdf } from './assistedApplicationPdfRenderer.js';

const MAX_LINES = 12;
const MAX_LINE_LENGTH = 240;

function text(value, maxLength = MAX_LINE_LENGTH) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function textList(value, maxItems = MAX_LINES) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => text(item)).filter(Boolean);
}

function verifyCaller(req) {
  const header = req.get?.('Authorization') || req.get?.('authorization') || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return getAuth().verifyIdToken(match[1]).catch(() => null);
}

/** Build a CV only from the authenticated owner's extracted CV projection. */
export function bilingualCvDocumentFromProfileRecord(record) {
  if (record?.status !== 'ready') return null;
  const profile = record.profile && typeof record.profile === 'object' ? record.profile : {};
  const name = text(profile.fullName, 200);
  if (!name) return null;

  const experience = textList(profile.experienceSummary).map((line) => ({ text: line }));
  const skills = textList(profile.skills, 40);
  const languages = textList(profile.languages);
  if (!experience.length && !skills.length && !languages.length) return null;

  const sections = [];
  if (experience.length) {
    sections.push({ kind: 'experience', title: 'Esperienza professionale / Berufserfahrung', items: experience });
  }
  if (skills.length) {
    sections.push({ kind: 'skills', title: 'Competenze & Tecnologie / Kenntnisse & IT-Skills', text: skills.join(', ') });
  }
  if (languages.length) {
    sections.push({ kind: 'languages', title: 'Lingue / Sprachen', list: languages });
  }

  return {
    language: 'it',
    name,
    headline: text(profile.headline, 200),
    contact: [text(profile.phone, 80), text(profile.email, 320)].filter(Boolean),
    personalTitle: 'Dati personali / Persönliche Angaben',
    personal: [],
    sections,
  };
}

export async function handleBilingualCvDownload(req, {
  db,
  verify = verifyCaller,
  render = renderCvPdf,
  mode = pdfRendererMode,
} = {}) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const caller = await verify(req);
  if (!caller || caller.firebase?.sign_in_provider === 'anonymous') {
    return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  }

  const snapshot = await db.collection('user_cv_profiles').doc(String(caller.uid || '')).get();
  if (!snapshot.exists) return { status: 409, body: { ok: false, error: 'cv_profile_unavailable' } };

  const document = bilingualCvDocumentFromProfileRecord(snapshot.data());
  if (!document) return { status: 409, body: { ok: false, error: 'cv_profile_unavailable' } };

  const rendered = await render(document, { mode: await mode(), bilingual: true });
  return { status: 200, body: rendered.pdf };
}
