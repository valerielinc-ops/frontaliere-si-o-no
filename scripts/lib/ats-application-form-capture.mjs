import { JSDOM, VirtualConsole } from 'jsdom';
import { parseNcoreApplicationForm } from './sintetica-job-parser.mjs';

const USER_AGENT = 'Frontaliereticino-AtsFormBot/1.0 (+https://frontaliereticino.ch)';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_FIELDS = 50;
const MAX_LABEL_LENGTH = 240;
const MAX_OPTIONS = 40;

export const ATS_FORM_PROVIDERS = Object.freeze([
  'ncoreplat', 'greenhouse', 'ashby', 'workable', 'lever', 'dover', 'recruitee', 'teamtailor',
]);

const GREENHOUSE_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);
const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);
const TEAMTAILOR_CUSTOM_HOSTS = new Set(['careers.mkspamp.com']);

const TYPE_MAP = new Map([
  ['input_text', 'text'], ['string', 'text'], ['email', 'email'], ['phone', 'tel'], ['tel', 'tel'],
  ['text', 'text'], ['textarea', 'textarea'], ['paragraph', 'textarea'], ['longtext', 'textarea'],
  ['number', 'number'], ['date', 'date'], ['file', 'file'], ['input_file', 'file'], ['file_upload', 'file'],
  ['select', 'select'], ['dropdown', 'select'], ['value_select', 'select'], ['single_choice', 'select'],
  ['multiselect', 'multiselect'], ['multiple', 'multiselect'], ['multi_choice', 'multiselect'],
  ['multi_value_multi_select', 'multiselect'], ['multi_value_single_select', 'select'],
  ['boolean', 'checkbox'], ['checkbox', 'checkbox'], ['radio', 'radio'], ['legal', 'checkbox'],
]);

export class ATSFormCaptureError extends Error {
  constructor(message, { status = 0, provider = '', retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ATSFormCaptureError';
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

function safeHttpsUrl(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null;
  try {
    const url = new URL(rawValue.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hostname = url.hostname.toLowerCase();
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function providerForUrl(rawUrl) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return '';
  const host = url.hostname;
  if (host === 'app.ncoreplat.com') return 'ncoreplat';
  if (GREENHOUSE_HOSTS.has(host)) return 'greenhouse';
  if (LEVER_HOSTS.has(host)) return 'lever';
  if (host === 'apply.workable.com') return 'workable';
  if (host === 'jobs.ashbyhq.com') return 'ashby';
  if (host === 'app.dover.com' || host === 'jobs.dover.com') return 'dover';
  if (host.endsWith('.recruitee.com')) return 'recruitee';
  if (host === 'teamtailor.com' || host.endsWith('.teamtailor.com') || TEAMTAILOR_CUSTOM_HOSTS.has(host)) return 'teamtailor';
  return '';
}

function providerForJob(job) {
  for (const rawUrl of [job?.applyUrl, job?.url]) {
    const provider = providerForUrl(rawUrl);
    if (provider) return { provider, jobUrl: rawUrl };
  }
  return null;
}

export function identifyATSProvider(job) {
  return providerForJob(job)?.provider || '';
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripMarkup(value = '') {
  const source = String(value || '');
  if (!/[<&]/.test(source)) return normalizeSpace(source);
  const { document } = new JSDOM(`<body>${source}</body>`, { virtualConsole: new VirtualConsole() }).window;
  for (const hidden of document.querySelectorAll('script,style')) hidden.remove();
  return normalizeSpace(document.body.textContent || '');
}

function cleanLabel(value = '') {
  return stripMarkup(value)
    .replace(/^required[.:]?\s*/i, '')
    .replace(/\s*(?:\*|✱)?\s*(?:required|required field)\s*$/i, '')
    .replace(/[\s*✱]+$/, '')
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
}

function normalizeType(rawType = '') {
  const type = String(rawType || '').trim();
  const mapped = TYPE_MAP.get(type.toLowerCase());
  return mapped || (type ? type.toLowerCase().slice(0, 32) : 'other');
}

function isConsentLabel(label = '') {
  return /privacy|consent|agree|agreement|terms and conditions|data protection|informativa|trattamento dei dati|contact me|future job|sms|recruiting-related communication|marketing|newsletter/i.test(label);
}

function makeField({ label, type, required = false, kind = '', section = '', options = [] }) {
  const clean = cleanLabel(label);
  if (!clean) return null;
  const normalizedOptions = [...new Set((Array.isArray(options) ? options : [])
    .map((option) => cleanLabel(typeof option === 'string' ? option : option?.label || option?.name || option?.value || ''))
    .filter(Boolean))].slice(0, MAX_OPTIONS);
  const normalizedType = normalizeType(type);
  return {
    label: clean,
    type: normalizedType,
    required: Boolean(required),
    kind: kind === 'consent' || (normalizedType === 'checkbox' && isConsentLabel(clean)) ? 'consent' : 'question',
    ...(normalizeSpace(section) ? { section: normalizeSpace(section).slice(0, 120) } : {}),
    ...(normalizedOptions.length ? { options: normalizedOptions } : {}),
  };
}

function normalizeFields(fields) {
  const out = [];
  const seen = new Set();
  for (const raw of fields || []) {
    const field = makeField(raw);
    if (!field) continue;
    const key = `${field.type}:${field.label.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

function snapshot(provider, jobUrl, sourceUrl, fields, checkedAt = new Date().toISOString(), stage = '') {
  const safeJobUrl = safeHttpsUrl(jobUrl);
  const safeSourceUrl = safeHttpsUrl(sourceUrl);
  const normalizedFields = normalizeFields(fields);
  if (!safeJobUrl || !safeSourceUrl || normalizedFields.length === 0) return null;
  return {
    provider,
    sourceUrl: safeSourceUrl.toString(),
    jobUrl: safeJobUrl.toString(),
    checkedAt: new Date(checkedAt).toISOString(),
    stage: cleanLabel(stage).slice(0, 120),
    fields: normalizedFields,
  };
}

async function request(url, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, json = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const originHost = new URL(url).hostname.toLowerCase();
    let requestUrl = url;
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetch(requestUrl, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || redirects === 3) {
        throw new ATSFormCaptureError('ATS form endpoint returned an unusable redirect', { status: response.status });
      }
      const next = new URL(location, requestUrl);
      if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== originHost || next.username || next.password || next.port) {
        throw new ATSFormCaptureError('ATS form endpoint redirected outside its verified host', { status: response.status });
      }
      requestUrl = next.toString();
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    if (!response.ok) {
      throw new ATSFormCaptureError(`ATS form endpoint returned HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 6 * 60 * 60 * 1000) : 0,
      });
    }
    if (json) {
      try {
        return await response.json();
      } catch {
        throw new ATSFormCaptureError('ATS form endpoint returned invalid JSON', { status: response.status });
      }
    }
    return await response.text();
  } catch (error) {
    if (error instanceof ATSFormCaptureError) throw error;
    throw new ATSFormCaptureError(error?.name === 'AbortError' ? 'ATS form request timed out' : 'ATS form request failed');
  } finally {
    clearTimeout(timer);
  }
}

function pageTitle(html) {
  const { document } = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window;
  return cleanLabel(document.querySelector('h1, h2')?.textContent || document.title || '');
}

function labelsForControls(form, controls) {
  const options = [];
  for (const control of controls) {
    const id = control.getAttribute('id') || '';
    const label = id
      ? [...form.querySelectorAll('label[for]')].find((entry) => entry.getAttribute('for') === id)
      : control.closest('label');
    const text = cleanLabel(visibleElementText(label) || control.getAttribute('aria-label') || '');
    if (text && !options.includes(text)) options.push(text);
  }
  return options;
}

function visibleElementText(element) {
  if (!element) return '';
  const clone = element.cloneNode(true);
  for (const hidden of clone.querySelectorAll('script,style,sup,.sr-only,[aria-hidden="true"],[hidden]')) hidden.remove();
  return normalizeSpace(clone.textContent || '');
}

function inputType(control) {
  if (control.tagName.toLowerCase() === 'textarea') return 'textarea';
  if (control.tagName.toLowerCase() === 'select') return control.multiple ? 'multiselect' : 'select';
  return String(control.getAttribute('type') || 'text').toLowerCase();
}

function extractTeamtailor(html, jobUrl, sourceUrl, checkedAt) {
  const virtualConsole = new VirtualConsole();
  const { document } = new JSDOM(html, { virtualConsole }).window;
  const form = document.querySelector('#job-application-form')
    || [...document.querySelectorAll('form')].find((candidate) => candidate.querySelector('[data-question-mandatory]'));
  if (!form) throw new ATSFormCaptureError('Teamtailor application form was not present in the response');

  const fields = [];
  const questionControls = new Set();
  for (const block of form.querySelectorAll('[data-question-mandatory]')) {
    if (block.closest('[hidden],[aria-hidden="true"]')) continue;
    const controls = [...block.querySelectorAll('input,select,textarea')]
      .filter((control) => !['hidden', 'submit', 'button', 'reset', 'password'].includes(inputType(control)));
    controls.forEach((control) => questionControls.add(control));
    if (controls.length === 0) continue;

    const title = block.querySelector('fieldset legend')
      || [...block.querySelectorAll('label')].find((label) => !label.classList.contains('choice-input-wrapper__label'));
    const label = cleanLabel(visibleElementText(title));
    if (!label) continue;
    const types = controls.map(inputType);
    const firstType = types[0];
    const type = firstType === 'radio' ? 'radio' : firstType;
    const required = block.getAttribute('data-question-mandatory') === 'true'
      || controls.some((control) => control.hasAttribute('required') || control.getAttribute('aria-required') === 'true');
    const options = firstType === 'radio'
      ? [...block.querySelectorAll('label.choice-input-wrapper__label')].map(visibleElementText)
      : controls.flatMap((control) => control.tagName.toLowerCase() === 'select'
        ? [...control.options].map((option) => option.textContent || '') : []);
    fields.push({ label, type, required, options, kind: firstType === 'checkbox' && isConsentLabel(label) ? 'consent' : 'question' });
  }

  // Teamtailor keeps the employer's custom prompts in data-question-mandatory blocks;
  // candidate identity and upload fields sit outside those blocks and are gathered here.
  const ordinaryControls = [...form.querySelectorAll('input,select,textarea')]
    .filter((control) => !questionControls.has(control) && !['hidden', 'submit', 'button', 'reset', 'password'].includes(inputType(control)));
  const grouped = new Map();
  for (const control of ordinaryControls) {
    const key = control.getAttribute('name') || control.getAttribute('id') || `control-${grouped.size}`;
    const group = grouped.get(key) || [];
    group.push(control);
    grouped.set(key, group);
  }
  for (const controls of grouped.values()) {
    const control = controls[0];
    const id = control.getAttribute('id') || '';
    const labelElement = (id && [...form.querySelectorAll('label[for]')].find((label) => label.getAttribute('for') === id))
      || control.closest('label');
    const rawLabel = visibleElementText(labelElement) || control.getAttribute('aria-label') || control.getAttribute('placeholder') || '';
    const label = cleanLabel(rawLabel);
    if (!label) continue;
    const markedRequired = Boolean(labelElement?.querySelector('sup')
      || [...(labelElement?.querySelectorAll('.sr-only') || [])].some((node) => /required/i.test(node.textContent || '')));
    const type = inputType(control);
    const options = type === 'radio'
      ? labelsForControls(form, controls)
      : controls.flatMap((item) => item.tagName.toLowerCase() === 'select'
        ? [...item.options].map((option) => option.textContent || '') : []);
    fields.push({
      label,
      type,
      required: controls.some((item) => item.hasAttribute('required') || item.getAttribute('aria-required') === 'true')
        || markedRequired
        || /(?:\*|✱)\s*(?:required)?\s*$/i.test(rawLabel),
      options,
      kind: type === 'checkbox' && isConsentLabel(label) ? 'consent' : 'question',
    });
  }
  return snapshot('teamtailor', jobUrl, sourceUrl, fields, checkedAt, pageTitle(html));
}

function extractLever(html, jobUrl, sourceUrl, checkedAt) {
  const { document } = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window;
  const fields = [];
  for (const block of document.querySelectorAll('li.application-question')) {
    const controls = [...block.querySelectorAll('input,select,textarea')]
      .filter((control) => !['hidden', 'submit', 'button', 'reset', 'password'].includes(inputType(control)));
    if (controls.length === 0) continue;
    const labelElement = block.querySelector('.application-label')
      || block.querySelector('label:not(.application-answer-alternative)');
    const label = cleanLabel(visibleElementText(labelElement));
    if (!label) continue;
    const firstType = inputType(controls[0]);
    const options = firstType === 'radio'
      ? [...block.querySelectorAll('.application-answer-alternative')].map(visibleElementText)
      : controls.flatMap((control) => control.tagName.toLowerCase() === 'select'
        ? [...control.options].map((option) => option.textContent || '') : []);
    fields.push({
      label,
      type: firstType === 'radio' ? 'radio' : firstType,
      required: controls.some((control) => control.hasAttribute('required')) || /[✱*]\s*$/.test(labelElement?.textContent || ''),
      options,
      kind: firstType === 'checkbox' && isConsentLabel(label) ? 'consent' : 'question',
    });
  }
  if (fields.length === 0) throw new ATSFormCaptureError('Lever application form had no parseable question blocks');
  return snapshot('lever', jobUrl, sourceUrl, fields, checkedAt, pageTitle(html));
}

function greenhouseFields(job) {
  const fields = [];
  const appendQuestions = (questions, section = '', kind = 'question') => {
    for (const question of questions || []) {
      const controls = Array.isArray(question.fields) ? question.fields : [];
      for (const control of controls) {
        if (String(control.type || '').toLowerCase() === 'input_hidden') continue;
        fields.push({
          label: question.label,
          type: control.type,
          required: question.required,
          section,
          options: (control.values || []).map((option) => option.label),
          kind,
        });
      }
    }
  };
  appendQuestions(job.questions);
  for (const block of job.compliance || []) appendQuestions(block.questions, block.type || 'Compliance', 'consent');
  return fields;
}

function workableFields(sections) {
  const fields = [];
  for (const section of sections || []) {
    for (const field of section.fields || []) {
      // Workable marks repeatable groups structurally; the parent label is the question.
      fields.push({
        label: field.label,
        type: field.type,
        required: field.required,
        section: section.name,
        options: (field.options || []).map((option) => (
          typeof option === 'string' ? option : option?.label || option?.name || option?.value
        )),
        kind: field.type === 'legal' ? 'consent' : 'question',
      });
    }
  }
  return fields;
}

function ashbyFields(form) {
  const fields = [];
  for (const section of form?.sections || []) {
    if (section.isHidden) continue;
    for (const entry of section.fieldEntries || []) {
      if (entry.isHidden || String(entry.field?.type || '').toLowerCase() === 'info') continue;
      fields.push({
        label: entry.field?.title,
        type: entry.field?.type,
        required: entry.isRequired,
        section: section.title,
        options: (entry.field?.selectableValues || []).map((option) => option.label),
      });
    }
  }
  return fields;
}

function doverFields(questions) {
  return (questions || []).filter((question) => !question.hidden).map((question) => ({
    label: question.question,
    type: question.input_type,
    required: question.required,
    options: question.multiple_choice_options || [],
  }));
}

function recruiteeFields(offer) {
  const fields = [
    { label: 'Full name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
  ];
  for (const [key, label, type] of [
    ['options_cv', 'CV', 'file'], ['options_cover_letter', 'Cover letter', 'file'],
    ['options_phone', 'Phone', 'tel'], ['options_photo', 'Photo', 'file'],
    ['options_salutation', 'Salutation', 'text'], ['options_title', 'Title', 'text'],
  ]) {
    if (offer[key] === 'required' || offer[key] === 'optional') {
      fields.push({ label, type, required: offer[key] === 'required' });
    }
  }
  const questions = [...(offer.open_questions || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  for (const question of questions) {
    if (question.kind === 'infobox') continue;
    fields.push({
      label: question.body,
      type: question.kind,
      required: question.required,
      options: (question.open_question_options || []).map((option) => option.body),
      kind: question.kind === 'legal' ? 'consent' : 'question',
    });
  }
  return fields;
}

function canonicalMatchUrl(rawUrl) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function matchRecruiteeOffer(offers, job) {
  const candidates = new Set([job?.url, job?.applyUrl].map(canonicalMatchUrl).filter(Boolean));
  const candidatePaths = new Set([...candidates].map((value) => new URL(value).pathname));
  for (const offer of offers || []) {
    const offerUrl = canonicalMatchUrl(offer.careers_url || offer.url || '');
    if (offerUrl && candidates.has(offerUrl)) return offer;
    if (offerUrl && candidatePaths.has(new URL(offerUrl).pathname)) return offer;
  }
  return null;
}

async function fetchRecruiteeOffer(job, jobUrl, { timeoutMs, cache }) {
  const parsed = safeHttpsUrl(jobUrl);
  const board = parsed?.hostname.replace(/\.recruitee\.com$/, '');
  if (!board) throw new ATSFormCaptureError('Recruitee board could not be resolved');
  const cacheKey = `${board}.recruitee.com`;
  let pending = cache?.get(cacheKey);
  if (!pending) {
    pending = request(`https://${cacheKey}/api/offers/`, { timeoutMs, json: true });
    cache?.set(cacheKey, pending);
  }
  const response = await pending;
  const offer = matchRecruiteeOffer(response?.offers, job);
  if (!offer) throw new ATSFormCaptureError('Recruitee offer was not present in the public board response', { status: 404 });
  return offer;
}

function greenhouseRequestParts(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const jobsAt = parts.indexOf('jobs');
  if (jobsAt < 1 || !parts[jobsAt + 1]) return null;
  return { board: parts[jobsAt - 1], postingId: parts[jobsAt + 1] };
}

function workableShortcode(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  const jAt = parts.indexOf('j');
  return jAt >= 0 ? parts[jAt + 1] || '' : '';
}

function ashbyRequestParts(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? { board: decodeURIComponent(parts[0]), postingId: parts.at(-1) } : null;
}

function doverPostingId(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return '';
  const segments = url.pathname.split('/').filter(Boolean);
  const id = segments.at(-1) || '';
  return /^[a-z0-9-]{8,}$/i.test(id) ? id : '';
}

function teamtailorFormUrls(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return null;
  const match = url.pathname.match(/^(\/jobs\/[^/]+)(?:\/applications\/new)?\/?$/i);
  if (!match) return null;
  const canonicalJob = new URL(url);
  canonicalJob.pathname = match[1];
  const form = new URL(url);
  form.pathname = `${match[1]}/applications/new`;
  return { jobUrl: canonicalJob.toString(), sourceUrl: form.toString() };
}

function leverFormUrl(jobUrl) {
  const url = safeHttpsUrl(jobUrl);
  if (!url) return '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/apply$/i.test(path) ? path : `${path}/apply`;
  return url.toString();
}

const ASHBY_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    applicationForm {
      sections {
        title
        isHidden
        fieldEntries {
          id
          isRequired
          isHidden
          field {
            title
            type
            selectableValues { label }
          }
        }
      }
    }
  }
}`;

export async function captureATSApplicationForm(job, {
  checkedAt = new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recruiteeCache = new Map(),
} = {}) {
  const detected = providerForJob(job);
  if (!detected) return null;
  const { provider, jobUrl: rawJobUrl } = detected;
  const jobUrl = safeHttpsUrl(rawJobUrl)?.toString();
  if (!jobUrl) return null;

  if (provider === 'ncoreplat') {
    const html = await request(jobUrl, { timeoutMs });
    const parsed = parseNcoreApplicationForm(html, { sourceUrl: jobUrl, checkedAt });
    return parsed ? { ...parsed, jobUrl } : null;
  }

  if (provider === 'teamtailor') {
    const urls = teamtailorFormUrls(jobUrl);
    if (!urls) return null;
    const html = await request(urls.sourceUrl, { timeoutMs });
    return extractTeamtailor(html, urls.jobUrl, urls.sourceUrl, checkedAt);
  }

  if (provider === 'greenhouse') {
    const ids = greenhouseRequestParts(jobUrl);
    if (!ids) return null;
    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ids.board)}/jobs/${encodeURIComponent(ids.postingId)}?questions=true`;
    const body = await request(endpoint, { timeoutMs, json: true });
    const fields = greenhouseFields(body);
    return snapshot(provider, jobUrl, jobUrl, fields, checkedAt, body.title || '');
  }

  if (provider === 'lever') {
    const sourceUrl = leverFormUrl(jobUrl);
    if (!sourceUrl) return null;
    const html = await request(sourceUrl, { timeoutMs });
    return extractLever(html, jobUrl, sourceUrl, checkedAt);
  }

  if (provider === 'workable') {
    const code = workableShortcode(jobUrl);
    if (!code) return null;
    const body = await request(`https://apply.workable.com/api/v1/jobs/${encodeURIComponent(code)}/form`, { timeoutMs, json: true });
    const sections = Array.isArray(body) ? body : body?.sections || body?.data || [];
    return snapshot(provider, jobUrl, jobUrl, workableFields(sections), checkedAt, '');
  }

  if (provider === 'ashby') {
    const ids = ashbyRequestParts(jobUrl);
    if (!ids) return null;
    const body = await request('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
      method: 'POST',
      timeoutMs,
      json: true,
      body: {
        operationName: 'ApiJobPosting',
        variables: { organizationHostedJobsPageName: ids.board, jobPostingId: ids.postingId },
        query: ASHBY_QUERY,
      },
    });
    const form = body?.data?.jobPosting?.applicationForm;
    if (!form) throw new ATSFormCaptureError('Ashby posting was absent from its public form API', { status: 404 });
    return snapshot(provider, jobUrl, jobUrl, ashbyFields(form), checkedAt, '');
  }

  if (provider === 'dover') {
    const postingId = doverPostingId(jobUrl);
    if (!postingId) return null;
    const body = await request(`https://app.dover.com/api/v1/inbound/application-portal-job/${encodeURIComponent(postingId)}`, { timeoutMs, json: true });
    const questions = body?.application_questions || body?.applicationQuestions || [];
    return snapshot(provider, jobUrl, jobUrl, doverFields(questions), checkedAt, '');
  }

  if (provider === 'recruitee') {
    const offer = await fetchRecruiteeOffer(job, jobUrl, { timeoutMs, cache: recruiteeCache });
    return snapshot(provider, jobUrl, jobUrl, recruiteeFields(offer), checkedAt, '');
  }

  return null;
}
