function collectJobPostingRecords(value, records = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectJobPostingRecords(entry, records);
    return records;
  }
  if (!value || typeof value !== 'object') return records;
  const record = value;
  const type = record['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
    records.push(record);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key !== '@type') collectJobPostingRecords(nested, records);
  }
  return records;
}

function replaceScript(fragment, match, script) {
  const start = match.index ?? 0;
  return `${fragment.slice(0, start)}${script}${fragment.slice(start + match[0].length)}`;
}

function rewriteJsonLd(fragment, scriptMatch, updateRecord, serializeJson) {
  let parsed;
  try {
    parsed = JSON.parse(scriptMatch[3] || '');
  } catch {
    throw new Error('malformed JobPosting JSON-LD fragment');
  }
  const records = collectJobPostingRecords(parsed);
  if (records.length !== 1) throw new Error('expected one JobPosting JSON-LD record');
  updateRecord(records[0]);
  return replaceScript(
    fragment,
    scriptMatch,
    `${scriptMatch[1]}${serializeJson(parsed)}${scriptMatch[4]}`,
  );
}

function setValidThrough(record, validThrough) {
  if (Object.prototype.hasOwnProperty.call(record, 'validThrough')) {
    record.validThrough = validThrough;
    return;
  }

  // Match the legacy byte-rewrite path: when an older cached record lacks the
  // field, the full active renderer places it immediately after datePosted.
  // Rebuild insertion order so JSON serialization produces the same bytes.
  const entries = Object.entries(record);
  const datePostedIndex = entries.findIndex(([key]) => key === 'datePosted');
  if (datePostedIndex < 0) throw new Error('missing JobPosting JSON-LD field: datePosted');
  entries.splice(datePostedIndex + 1, 0, ['validThrough', validThrough]);
  for (const key of Object.keys(record)) delete record[key];
  for (const [key, value] of entries) record[key] = value;
}

/**
 * Refresh the date fields of a cached active JobPosting fragment. A null
 * crawledAt means the current source has no heartbeat: remove a cached value
 * if present, matching the full renderer's omitted optional property. A
 * current string still requires a cached replacement target and fails closed
 * when it is absent.
 */
export function replaceActiveJobPostingDates(
  fragment,
  datePosted,
  validThrough,
  crawledAt,
  jobPostingDescription,
  serializeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c'),
) {
  if (!datePosted) throw new Error('active JobPosting datePosted unavailable');
  if (!validThrough || Number.isNaN(new Date(validThrough).getTime())) {
    throw new Error('active JobPosting validThrough unavailable or invalid');
  }
  const scriptMatch = String(fragment).match(
    /(<script\b[^>]*type=(['"])application\/ld\+json\2[^>]*>)([\s\S]*?)(<\/script\s*>)/i,
  );
  if (!scriptMatch) throw new Error('missing JobPosting JSON-LD fragment');

  if (jobPostingDescription !== undefined || crawledAt === null) {
    return rewriteJsonLd(fragment, scriptMatch, (record) => {
      if (!Object.prototype.hasOwnProperty.call(record, 'datePosted')) {
        throw new Error('missing JobPosting JSON-LD field: datePosted');
      }
      record.datePosted = datePosted;
      setValidThrough(record, validThrough);
      if (crawledAt === null) {
        delete record.crawledAt;
      } else if (crawledAt !== undefined) {
        if (!crawledAt) throw new Error('current JobPosting crawledAt unavailable');
        if (!Object.prototype.hasOwnProperty.call(record, 'crawledAt')) {
          throw new Error('missing JobPosting JSON-LD field: crawledAt');
        }
        record.crawledAt = crawledAt;
      }
      if (jobPostingDescription !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(record, 'description') || typeof record.description !== 'string') {
          throw new Error('missing JobPosting JSON-LD field: description');
        }
        record.description = jobPostingDescription;
      }
    }, serializeJson);
  }

  let script = scriptMatch[0];
  const fields = [
    ['datePosted', datePosted],
    ['validThrough', validThrough],
    ...(typeof crawledAt === 'string' ? [['crawledAt', crawledAt]] : []),
  ];
  for (const [field, value] of fields) {
    const fieldPattern = new RegExp(`("${field}"\\s*:\\s*)(?:"[^"]*"|null)`);
    if (fieldPattern.test(script)) {
      script = script.replace(fieldPattern, `$1${JSON.stringify(value)}`);
      continue;
    }
    if (field === 'validThrough') {
      const datePostedPattern = /("datePosted"\s*:\s*)(?:"[^"]*"|null)/;
      if (datePostedPattern.test(script)) {
        script = script.replace(
          datePostedPattern,
          `$1${JSON.stringify(datePosted)},"validThrough":${JSON.stringify(value)}`,
        );
        continue;
      }
    }
    throw new Error(`missing JobPosting JSON-LD field: ${field}`);
  }
  return replaceScript(fragment, scriptMatch, script);
}

const ACTIVE_JOB_SEED_SCRIPT_RE = /(<script\b[^>]*>\s*window\.__JOB_SEED__\s*=\s*)([\s\S]*?)(;\s*<\/script\s*>)/i;

export function activeJobSeedJson(html) {
  const match = String(html).match(ACTIVE_JOB_SEED_SCRIPT_RE);
  if (!match) throw new Error('missing window.__JOB_SEED__ script');
  try {
    JSON.parse(match[2]);
  } catch {
    throw new Error('malformed window.__JOB_SEED__ JSON');
  }
  return match[2];
}

export function replaceActiveJobSeed(html, seedJson) {
  const source = String(html);
  const match = ACTIVE_JOB_SEED_SCRIPT_RE.exec(source);
  if (!match) throw new Error('missing window.__JOB_SEED__ script');
  const currentSeed = match[2];
  try {
    JSON.parse(currentSeed);
    JSON.parse(String(seedJson));
  } catch {
    throw new Error('malformed window.__JOB_SEED__ JSON');
  }
  const start = match.index ?? 0;
  return `${source.slice(0, start)}${match[1]}${seedJson}${match[3]}${source.slice(start + match[0].length)}`;
}
