/** Pure native-question contract shared by browser and server; no candidate/CV source. */
import { addressContextContract } from './addressContextContract.js';
import { nativeQuestionText } from './nativeQuestionText.js';

export function createNativeContractTools({ addressContextContract, nativeQuestionText }) {
  const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const comparable = value => normalized(value).toLowerCase();
const CONSENT_METADATA = ['ownConsentText', 'ownConsentQuestionLabels', 'ownConsentLinks', 'ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'ownConsentOwnerKey', 'consentOwnershipUnknown'];
function nativeQuestionMetadata(field) {
  return Object.fromEntries(['originalNativeContract', 'addressContext', ...CONSENT_METADATA]
    .filter(key => Object.hasOwn(field || {}, key)).map(key => [key, structuredClone(field[key])]));
}
function ownedAddressContract(field) {
  const value = addressContextContract(field);
  return value == null ? value : { ...value, section: nativeQuestionText(value.section), owners: value.owners.map(nativeQuestionText) };
}

function consentContract(field) {
  const owned = {};
  for (const key of CONSENT_METADATA) {
    if (!Object.hasOwn(field || {}, key)) continue;
    const value = field[key];
    if (['ownConsentText', 'ownConsentQuestionLabels', 'ownConsentLinks'].includes(key)) {
      const links = key === 'ownConsentLinks';
      if (!Array.isArray(value) || value.length > (links ? 16 : 64)
        || value.some(text => typeof text !== 'string' || text.length > (links ? 2048 : 8000))
        || value.reduce((sum, text) => sum + text.length, 0) > (links ? 8192 : 12000)) return null;
      owned[key] = [...value];
    } else if (key === 'ownConsentOwnerKey') {
      if (typeof value !== 'string' || value.length > 4096) return null;
      owned[key] = value;
    } else {
      if (typeof value !== 'boolean') return null;
      owned[key] = value;
    }
  }
  return owned.consentOwnershipUnknown ? null : owned;
}

/** Native contracts remain complete; an extractor cap is not an attestation. */
function nativeFormContract(field) {
  if (!field || field.nativeUncheckedSubmissionUnknown || field.nativeContractUnavailable || typeof field.id !== 'string' || !normalized(field.label)) return null;
  const text = ['label', 'context', 'section', 'autocomplete'];
  if (text.some(key => field[key] != null && typeof field[key] !== 'string')) return null;
  // Full labels and owned descriptions are preserved by the native reader.
  // Older compact projections at a cap cannot certify completeness.
  if (String(field.label).length > 8000 || String(field.context || '').length > 12000
    || String(field.section || '').length > 8000 || String(field.autocomplete || '').length > 100
    || !field.nativeMetadataComplete && (String(field.label).length === 300 || String(field.context || '').length === 240)) return null;
  if (field.options != null && !Array.isArray(field.options)) return null;
  const options = (field.options || []).map(option => typeof option === 'string' ? option : option?.label);
  if (options.some(option => typeof option !== 'string' || option.length > 8000)) return null;
  const optionKeys = options.map(comparable);
  if (new Set(optionKeys).size !== optionKeys.length) return null;
  const addressContext = ownedAddressContract(field);
  if (addressContext === null || addressContext?.unknown) return null;
  const graph = field.nativeOwnedScopes;
  if (graph !== undefined && (!Array.isArray(graph) || graph.length > 32 || graph.some(scope => !scope || !['group', 'form'].includes(scope.kind)
    || Object.keys(scope).some(key => !['kind', 'names', 'unknown'].includes(key)) || scope.unknown !== false || !Array.isArray(scope.names) || scope.names.length > 64 || scope.names.some(name => typeof name !== 'string' || name.length > 8000))
    || graph.flatMap(scope => scope.names).reduce((sum, name) => sum + name.length, 0) > 12000)) return null;
  const consent = consentContract(field);
  if (consent === null) return null;
  return { question: nativeQuestionText(field.label), context: nativeQuestionText(field.context), section: nativeQuestionText(field.section),
    ...consent,
    ...(graph === undefined ? {} : { ownedScopes: structuredClone(graph) }),
    ...(field.nativeUncheckedSubmission ? { uncheckedSubmission: structuredClone(field.nativeUncheckedSubmission) } : {}),
    ...(addressContext === undefined ? {} : { addressContext }),
    controlType: field.inputType || field.kind || '', kind: field.kind || '', name: normalized(field.name), required: Boolean(field.required),
    optionValues: (field.options || []).map(option => typeof option === 'string' ? { label: option } : { label: option.label,
      ...(option.value == null ? {} : { value: String(option.value) }),
      ...(option.placeholder === true ? { placeholder: true } : {}) }),
    autocomplete: normalized(field.autocomplete), options, validation: field.validation || {
      ...(field.inputType ? { type: field.inputType } : {}), ...(field.required != null ? { required: field.required } : {}),
      ...(field.min != null ? { min: field.min } : {}), ...(field.max != null ? { max: field.max } : {}),
      ...(field.pattern ? { pattern: field.pattern } : {}),
    } };
}

/** Decode a complete wire contract through the same bounded native validator. */
function nativeFieldFromContract(native, { id = 'native-contract' } = {}) {
  if (typeof id !== 'string' || !id || id.length > 4096 || !native || typeof native !== 'object'
    || !Array.isArray(native.ownedScopes)) return null;
  const validation = native.validation;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)
    || Object.entries(validation).some(([key, value]) => !['type', 'min', 'max', 'minlength', 'maxlength', 'pattern', 'step', 'required', 'aria-required', 'multiple'].includes(key)
      || !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))) return null;
  const field = { id, label: native.question, context: native.context, section: native.section,
    inputType: native.controlType, kind: native.kind, name: native.name, required: native.required,
    autocomplete: native.autocomplete, options: native.optionValues, validation: native.validation,
    nativeOwnedScopes: native.ownedScopes, nativeUncheckedSubmission: native.uncheckedSubmission,
    nativeMetadataComplete: true, ...Object.fromEntries(Object.entries(native).filter(([key]) => key.startsWith('ownConsent')
      || ['addressContext', 'consentOwnershipUnknown'].includes(key))) };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(nativeFormContract(field))) === JSON.stringify(stable(native)) ? field : null;
}

  const neutralApplicationScope = /^(?:application|application form|create account|account details|registration|login details|basic information|additional data|further information|weitere angaben|zusätzliche angaben|ulteriori dati|informazioni aggiuntive|informations complémentaires|données supplémentaires|benutzerkonto|konto erstellen|registrierung|registrazione|crea account|créer un compte|inscription|application documents|supporting documents|documents|personal (?:data|details|information)|contact (?:data|details|information)|candidate (?:data|details|information)|applicant (?:data|details|information)|your (?:application|details|information)|bewerbung|bewerbungsformular|bewerbungsunterlagen|unterlagen|dokumente|persönliche (?:daten|angaben)|kontaktdaten|kandidatendaten|candidatura|documenti(?: di candidatura)?|dati personali|informazioni personali|dati di contatto|contatti|candidature|formulaire de candidature|documents|documents de candidature|données personnelles|coordonnées|informations personnelles)[:*＊]?$/iu;
const neutralApplicationScopePattern = neutralApplicationScope.source;
/** Only complete, neutral application captions may accompany an exemption. */
function nativeScopeAllows(field, ownPurpose) {

  const address = addressContextContract(field);
  if (address === null || address?.unknown) return false;
  const graph = field.nativeOwnedScopes ?? field.ownedScopes;
  if (!Array.isArray(graph) || graph.some(scope => !scope || Object.keys(scope).some(key => !['kind', 'names', 'unknown'].includes(key)) || scope.unknown !== false || !Array.isArray(scope.names))) return false;
  const contexts = [field.context || '', field.section || '', ...graph.flatMap(scope => scope.names)];
  return contexts.flatMap(text => text.split(' · ')).filter(Boolean).every(text => neutralApplicationScope.test(nativeQuestionText(text)) || ownPurpose(text));
}

function withNativeMetadata(field, native) {
  if (native) {
    const resolveText = value => {
      let text = String(value ?? '');
      for (const fragment of native.counterFragments || []) {
        const counterText = nativeQuestionText(fragment.text, fragment);
        const replacement = counterText !== nativeQuestionText(fragment.text) ? ` ${counterText} ` : String(fragment.text ?? '');
        text = text.replaceAll(fragment.token, replacement);
      }
      return nativeQuestionText(text);
    };
    for (const key of ['label', 'context', 'section']) native[key] = resolveText(native[key]);
    if (native.nativeOwnedScopes) native.nativeOwnedScopes = native.nativeOwnedScopes.map(scope => ({ ...scope, names: scope.names.map(resolveText) }));
    if (native.ownedQuestionContext) native.ownedQuestionContext = native.ownedQuestionContext.map(resolveText);
    delete native.counterFragments;
  }
  const actual = { ...field, ...(native || { nativeContractUnavailable: true }) };
  if (actual.nativeContextUnknown) actual.nativeContractUnavailable = true;
  if (actual.kind === 'checkbox') {
    if (actual.nativeContextUnknown) actual.consentOwnershipUnknown = true;
    if (actual.ownConsentMetadataComplete && actual.ownConsentQuestionOwned) {
      actual.ownConsentText = [...new Set([...(actual.ownConsentText || []), ...(actual.ownedQuestionContext || [])])];
      actual.ownConsentLinks = [...new Set([...(actual.ownConsentLinks || []), ...(actual.ownedQuestionContextLinks || [])])];
    }
  }
  if (actual.nativeUncheckedSubmission && !/^(?:no|nein|non|false|0)$/iu.test(normalized(actual.nativeUncheckedSubmission.value))) actual.nativeUncheckedSubmissionUnknown = true;
  actual.originalNativeContract = nativeFormContract(actual);
  return actual;
}
return { nativeFormContract, nativeFieldFromContract, nativeQuestionMetadata, ownedAddressContract, consentContract, withNativeMetadata, nativeScopeAllows, neutralApplicationScopePattern };

}
export const { nativeFormContract, nativeFieldFromContract, nativeQuestionMetadata, ownedAddressContract, consentContract, withNativeMetadata, nativeScopeAllows, neutralApplicationScopePattern } = createNativeContractTools({ addressContextContract, nativeQuestionText });
