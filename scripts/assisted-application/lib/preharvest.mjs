import { createHash } from 'node:crypto';

const STANDARD_IDENTITY_RE = /^(?:first[\s_-]*name|last[\s_-]*name|full[\s_-]*name|name|e?-?mail|phone|mobile|resume|cv|cover[\s_-]*letter|linkedin|website|portfolio|location|address|city|country)$/i;
const TRACKING_PARAM_RE = /^(?:utm_[^=]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;
export const JOB_QUESTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Canonicalize a job posting URL for stable cross-candidate question caching. */
export function canonicalizeJobPostingUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    const kept = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM_RE.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    return parsed.toString();
  } catch {
    return '';
  }
}

export function canonicalJobQuestionCacheKey(jobUrl) {
  const canonical = canonicalizeJobPostingUrl(jobUrl);
  if (!canonical) return '';
  return createHash('sha256').update(canonical).digest('hex');
}

/** Identify public ATS posting JSON endpoints that expose application questions without login. */
export function parsePublicAtsPosting(jobUrl) {
  let parsed;
  try {
    parsed = new URL(String(jobUrl || '').trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);

  if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') && parts.length >= 3 && parts[1] === 'jobs') {
    const board = parts[0];
    const jobId = parts[2];
    if (board && jobId) {
      return {
        provider: 'greenhouse',
        apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`,
      };
    }
  }

  if (host === 'jobs.lever.co' && parts.length >= 2) {
    const company = parts[0];
    const postingId = parts[1];
    if (company && postingId) {
      return {
        provider: 'lever',
        apiUrl: `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(postingId)}`,
      };
    }
  }

  if (host === 'jobs.smartrecruiters.com' && parts.length >= 2) {
    const company = parts[0];
    const postingId = parts[1];
    if (company && postingId) {
      return {
        provider: 'smartrecruiters',
        apiUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(postingId)}`,
      };
    }
  }

  return null;
}

function normalizeQuestionType(rawType, hasOptions) {
  const t = String(rawType || '').toLowerCase();
  if (hasOptions || ['multi_value_single_select', 'multi_value_multi_select', 'select', 'choice', 'dropdown', 'radio'].includes(t)) {
    return 'choice';
  }
  if (['boolean', 'yes_no'].includes(t)) return 'boolean';
  return 'text';
}

function normalizeQuestionEntry(raw, index, provider) {
  const label = String(raw?.label || raw?.question || raw?.text || '').replace(/\s+/g, ' ').trim();
  if (!label || STANDARD_IDENTITY_RE.test(label) || /captcha/i.test(label)) return null;
  const rawOptions = Array.isArray(raw?.options) ? raw.options : Array.isArray(raw?.values) ? raw.values : [];
  const options = rawOptions
    .map((opt) => (typeof opt === 'string' ? opt : String(opt?.label || opt?.text || opt?.name || '')).trim())
    .filter(Boolean)
    .slice(0, 40);
  const type = normalizeQuestionType(raw?.type, options.length > 0);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `q_${index + 1}`;
  return {
    id: `preharvest_${provider}_${slug}`,
    question: label,
    applicationQuestion: label,
    source: `preharvest:${provider}`,
    type,
    required: raw?.required !== false,
    ...(options.length ? { options, applicationOptions: options } : {}),
    why: 'Domanda rilevata sul modulo pubblico dell’annuncio.',
  };
}

/** Extract custom application questions from public ATS JSON APIs without a browser. Fail-open on any network/format issue. */
export async function preharvestPublicAtsQuestions(jobUrl, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const target = parsePublicAtsPosting(jobUrl);
  if (!target || typeof fetchImpl !== 'function') return [];
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(target.apiUrl, {
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res?.ok) return [];
    const data = await res.json();
    const out = [];
    if (target.provider === 'greenhouse' && Array.isArray(data?.questions)) {
      data.questions.forEach((q, idx) => {
        const fields = Array.isArray(q?.fields) ? q.fields : [q];
        for (const f of fields) {
          const item = normalizeQuestionEntry({
            label: f?.label || q?.label,
            type: f?.type || q?.type,
            required: q?.required,
            options: f?.values || q?.values,
          }, idx, 'greenhouse');
          if (item) out.push(item);
        }
      });
    } else if (target.provider === 'lever' && Array.isArray(data?.customQuestions)) {
      data.customQuestions.forEach((q, idx) => {
        const fields = Array.isArray(q?.fields) ? q.fields : [];
        for (const f of fields) {
          const item = normalizeQuestionEntry({
            label: f?.text || q?.text,
            type: f?.type,
            required: f?.required,
            options: f?.options,
          }, idx, 'lever');
          if (item) out.push(item);
        }
      });
    } else if (target.provider === 'smartrecruiters' && Array.isArray(data?.screeningQuestions)) {
      data.screeningQuestions.forEach((q, idx) => {
        const item = normalizeQuestionEntry({
          label: q?.label || q?.question,
          type: q?.type,
          required: q?.required,
          options: q?.options,
        }, idx, 'smartrecruiters');
        if (item) out.push(item);
      });
    }
    return out.slice(0, 20);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sanitizeQuestionsForCache(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q) => q && typeof q === 'object')
    .filter((q) => {
      const text = `${q.question || ''} ${q.applicationQuestion || ''} ${q.section || ''}`;
      return text.trim().length > 0
        && !/security\s*questions?|domande\s+di\s+sicurezza|password|captcha/i.test(text);
    })
    .slice(0, 25)
    .map((q) => ({
      id: String(q.id || '').slice(0, 120),
      question: String(q.question || q.applicationQuestion || '').slice(0, 300),
      applicationQuestion: String(q.applicationQuestion || q.question || '').slice(0, 300),
      type: String(q.type || 'text').slice(0, 30),
      required: q.required !== false,
      ...(Array.isArray(q.options) && q.options.length ? { options: q.options.slice(0, 40).map((o) => String(o).slice(0, 200)) } : {}),
      ...(Array.isArray(q.applicationOptions) && q.applicationOptions.length ? { applicationOptions: q.applicationOptions.slice(0, 40).map((o) => String(o).slice(0, 200)) } : {}),
      ...(q.section ? { section: String(q.section).slice(0, 120) } : {}),
    }));
}

export async function loadCachedJobQuestions(db, jobUrl, {
  nowMs = Date.now(),
  ttlMs = JOB_QUESTION_CACHE_TTL_MS,
} = {}) {
  if (!db) return [];
  const key = canonicalJobQuestionCacheKey(jobUrl);
  if (!key) return [];
  try {
    const snap = await db.collection('assisted_application_job_questions').doc(key).get();
    const data = snap.exists ? snap.data() : null;
    const updatedAt = typeof data?.updatedAt?.toMillis === 'function'
      ? data.updatedAt.toMillis()
      : Number(data?.updatedAt);
    const ageMs = Number(nowMs) - updatedAt;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(ageMs) || ageMs > ttlMs) return [];
    return Array.isArray(data?.questions) ? data.questions : [];
  } catch {
    return [];
  }
}

export async function saveCachedJobQuestions(db, jobUrl, questions, { source = 'portal_discovery', nowMs = Date.now() } = {}) {
  if (!db) return false;
  const key = canonicalJobQuestionCacheKey(jobUrl);
  const canonicalUrl = canonicalizeJobPostingUrl(jobUrl);
  const sanitized = sanitizeQuestionsForCache(questions);
  if (!key || !canonicalUrl || !sanitized.length) return false;
  try {
    await db.collection('assisted_application_job_questions').doc(key).set({
      canonicalUrl,
      source,
      questions: sanitized,
      updatedAt: nowMs,
    }, { merge: true });
    return true;
  } catch {
    return false;
  }
}

export function mergePreharvestedQuestions(existingQuestions = [], discoveredQuestions = []) {
  const existing = Array.isArray(existingQuestions) ? existingQuestions : [];
  const discovered = Array.isArray(discoveredQuestions) ? discoveredQuestions : [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set(existing.flatMap((q) => [norm(q?.question), norm(q?.applicationQuestion)]).filter(Boolean));
  const merged = [...existing];
  for (const q of discovered) {
    const k1 = norm(q?.question);
    const k2 = norm(q?.applicationQuestion);
    if ((k1 && seen.has(k1)) || (k2 && seen.has(k2))) continue;
    if (k1) seen.add(k1);
    if (k2) seen.add(k2);
    merged.push(q);
  }
  return merged;
}
