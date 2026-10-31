/** Pure structural scope view; it never supplies candidate facts or SELF ownership. */
export function createNativeScopeTools() {
const titleText = value => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const boundedText = (value, max) => typeof value === 'string' && value.length <= max;

/** sourceAuthority is a private Stage/Backend argument, never a field or candidate flag. */
function nativeScopeView(field, { sourceAuthority } = {}) {
  let raw;
  try { raw = {
    context: structuredClone(field?.context), section: structuredClone(field?.section),
    ownedScopes: structuredClone(field?.nativeOwnedScopes), scopeIssues: structuredClone(field?.nativeScopeIssues),
    contextIssues: structuredClone(field?.nativeContextIssues), nativeMetadataComplete: field?.nativeMetadataComplete,
    nativeMetadataMissing: field?.nativeMetadataMissing, nativeContextIssuesComplete: field?.nativeContextIssuesComplete,
    nativeContextUnknown: field?.nativeContextUnknown,
  }; } catch { return { status: 'unknown', view: null, raw: null, authorityKey: null }; }
  const unknown = () => ({ status: 'unknown', view: null, raw, authorityKey: null });
  if (raw.nativeMetadataComplete !== true || raw.nativeMetadataMissing !== false || raw.nativeContextIssuesComplete !== true
    || !boundedText(raw.context, 12000) || !boundedText(raw.section, 8000)
    || !Array.isArray(raw.ownedScopes) || raw.ownedScopes.length > 32
    || !Array.isArray(raw.scopeIssues) || raw.scopeIssues.length > 64
    || !Array.isArray(raw.contextIssues) || raw.contextIssues.length > 32) return unknown();
  const scopes = raw.ownedScopes;
  if (scopes.some(scope => !plain(scope) || !onlyKeys(scope, ['kind', 'names', 'unknown'])
    || !['group', 'form'].includes(scope.kind) || typeof scope.unknown !== 'boolean'
    || !Array.isArray(scope.names) || scope.names.length > 64
    || scope.names.some(name => !boundedText(name, 8000) || !titleText(name)))
    || scopes.flatMap(scope => scope.names).reduce((sum, name) => sum + name.length, 0) > 12000) return unknown();
  if (raw.contextIssues.some(issue => !plain(issue) || !onlyKeys(issue, ['reason', 'scopeIndex', 'text'])
    || issue.reason !== 'unowned_shared_prose' || !(issue.scopeIndex === null || Number.isInteger(issue.scopeIndex)
      && issue.scopeIndex >= 0 && issue.scopeIndex < scopes.length) || !boundedText(issue.text, 8000))
    || raw.contextIssues.reduce((sum, issue) => sum + issue.text.length, 0) > 12000
    || raw.contextIssues.length) return unknown();
  const issuesByScope = new Map();
  for (const issue of raw.scopeIssues) {
    if (!plain(issue) || !onlyKeys(issue, ['scopeIndex', 'reason', 'nameIndex', 'refsComplete'])
      || !Number.isInteger(issue.scopeIndex) || issue.scopeIndex < 0 || issue.scopeIndex >= scopes.length
      || !['unrecognized_shared_heading', 'outside_native_form'].includes(issue.reason) || issue.refsComplete !== true
      || !scopes[issue.scopeIndex].unknown
      || issue.reason === 'unrecognized_shared_heading' && (!Number.isInteger(issue.nameIndex)
        || issue.nameIndex < 0 || issue.nameIndex >= scopes[issue.scopeIndex].names.length)
      || issue.reason === 'outside_native_form' && Object.hasOwn(issue, 'nameIndex')) return unknown();
    const entries = issuesByScope.get(issue.scopeIndex) || [];
    entries.push(issue); issuesByScope.set(issue.scopeIndex, entries);
  }
  const uncertain = scopes.flatMap((scope, index) => scope.unknown ? [index] : []);
  if (raw.nativeContextUnknown !== Boolean(uncertain.length)) return unknown();
  const baseView = { context: raw.context, section: raw.section, ownedScopes: structuredClone(scopes),
    structuralScopeIndexes: [], structuralTitle: '' };
  if (!uncertain.length) return { status: 'strict', view: baseView, raw, authorityKey: null };
  // A complete cause list is mandatory. A title cannot explain an empty,
  // foreign, truncated or otherwise unresolved owner or its missing references.
  if (uncertain.some(index => !issuesByScope.has(index))) return unknown();
  if (!plain(sourceAuthority) || !boundedText(sourceAuthority.sourceTitle, 500) || !titleText(sourceAuthority.sourceTitle)
    || !boundedText(sourceAuthority.sourceFingerprint, 131072) || !sourceAuthority.sourceFingerprint.trim()
    || !boundedText(sourceAuthority.urlSignature, 131072) || !sourceAuthority.urlSignature.trim()) return unknown();
  const expected = titleText(sourceAuthority.sourceTitle);
  if (uncertain.some(index => !scopes[index].names.length || scopes[index].names.some(name => titleText(name) !== expected))) return unknown();
  return { status: 'interpreted', view: { ...baseView,
    context: raw.context.split(' · ').filter(fragment => titleText(fragment) !== expected).join(' · '),
    section: titleText(raw.section) === expected && uncertain.some(index => scopes[index].names.some(name => titleText(name) === titleText(raw.section))) ? '' : raw.section,
    structuralScopeIndexes: uncertain, structuralTitle: expected }, raw, authorityKey: sourceAuthority.sourceFingerprint };
}
return { nativeScopeView };
}

export const { nativeScopeView } = createNativeScopeTools();
