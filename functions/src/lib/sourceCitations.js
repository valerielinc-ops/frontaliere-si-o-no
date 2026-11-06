/** Source IDs let a model select evidence without rewriting it. Resolution is server-owned. */
export const SOURCE_CITATIONS_VERSION = 'source-citations-v2';

const LANGUAGE_LABELS = new Map([
  ['de', 'German'], ['en', 'English'], ['fr', 'French'], ['it', 'Italian'], ['es', 'Spanish'],
  ['pt', 'Portuguese'], ['rm', 'Romansh'], ['sq', 'Albanian'], ['ar', 'Arabic'], ['bs', 'Bosnian'],
  ['hr', 'Croatian'], ['sr', 'Serbian'], ['ru', 'Russian'], ['ro', 'Romanian'], ['tr', 'Turkish'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['nl', 'Dutch'], ['el', 'Greek'], ['pl', 'Polish'],
  ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['hu', 'Hungarian'],
  ['cs', 'Czech'], ['sk', 'Slovak'], ['uk', 'Ukrainian'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['fa', 'Persian'], ['ur', 'Urdu'], ['vi', 'Vietnamese'], ['ko', 'Korean'], ['th', 'Thai'],
  ['id', 'Indonesian'], ['sw', 'Swahili'],
]);

/** Build citation text only from server-owned, typed candidate declarations. */
export function candidateConfirmedEvidenceSources({ languageFacts = null, answers = null } = {}) {
  const sources = {};
  if (languageFacts?.provenance === 'candidate_confirmed'
    && typeof languageFacts.schemaVersion === 'string'
    && languageFacts.confirmedAt) {
    const languages = Array.isArray(languageFacts.languages) ? languageFacts.languages : [];
    const rows = languages.map(item => {
      const code = String(item?.languageCode || '').toLowerCase();
      const label = LANGUAGE_LABELS.get(code);
      const level = String(item?.level || 'unknown');
      return label ? `${label}: ${level === 'native' ? 'native' : level === 'unknown' ? 'level not specified' : level}` : '';
    }).filter(Boolean);
    const completeness = languageFacts.listComplete === true ? 'complete' : 'incomplete';
    sources.candidate_confirmed_languages = `Candidate-confirmed ${completeness} spoken-language list: ${rows.length ? rows.join('; ') : 'no languages listed'}.`;
  }
  if (answers?.provenance === 'candidate_confirmed'
    && typeof answers.schemaVersion === 'string'
    && answers.confirmedAt) {
    sources.candidate_confirmed_answers = (Array.isArray(answers.answers) ? answers.answers : [])
      .map(item => `Question: ${String(item?.question || '').trim()} Candidate response: ${String(item?.answer || '').trim()}`)
      .filter(item => !/^Question:\s*Candidate response:\s*$/.test(item))
      .join('\n');
  }
  return sources;
}

export function sourceCitations(sources) {
  const excerpts = [];
  for (const [source, value] of Object.entries(sources)) {
    for (const line of String(value || '').split(/\r?\n/)) {
      let rest = line.replace(/\s+/gu, ' ').trim();
      while (rest) {
        let end = Math.min(rest.length, 360);
        if (end < rest.length) {
          const space = rest.lastIndexOf(' ', end);
          if (space >= 180) end = space;
          if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
        }
        excerpts.push({ id: `[[${source}:${excerpts.length}]]`, text: rest.slice(0, end) });
        rest = rest.slice(end).trim();
      }
    }
  }
  const lookup = new Map(excerpts.map(({ id, text }) => [id, text]));
  return { excerpts, resolve: value => {
    const id = String(value ?? '');
    if (lookup.has(id)) return lookup.get(id);
    // Even a token printed in the CV is not a valid citation unless this
    // request issued it. Keep that failure distinct from absent evidence.
    return /^\s*\[\[[\s\S]*\]\]\s*$/u.test(id) ? null : value;
  } };
}

/** Keep the public stored schema unchanged; only the provider response uses IDs. */
export function citationSchema(schema, collection, field, citations) {
  const copy = structuredClone(schema);
  copy.properties[collection].items.properties[field] = {
    type: 'string', enum: ['', ...citations.excerpts.map(item => item.id)],
    description: 'One source excerpt ID; empty only when no evidence exists. Never translate or paraphrase.',
  };
  return copy;
}

export function resolveCitations(raw, collection, field, citations) {
  return { ...raw, [collection]: Array.isArray(raw?.[collection])
    ? raw[collection].map(item => {
      const resolved = citations.resolve(item?.[field]);
      return { ...item, [field]: resolved ?? '', ...(resolved === null ? { [`${field}Unverified`]: true } : {}) };
    }) : raw?.[collection] };
}
