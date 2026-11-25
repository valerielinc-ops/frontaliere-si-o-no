/**
 * Canonical vocabulary for portal stops.
 *
 * The runner, public stop report, recovery reconciler and replay observer need
 * the same names, but they consume different projections of the contract.
 * Keep the code declaration here and derive those projections below so a new
 * stop cannot be emitted by one surface while being unknown to another.
 */

export const PORTAL_STOP_CODES = Object.freeze({
  next_disabled: {
    hint: 'The deterministic filler filled the form controls it understood, but the button to the next step is missing or disabled: a question on this page is still unanswered (often a custom widget).',
  },
  refused: {
    hint: 'The page did not move on after Next: the form refused a value or a required answer is missing. Look for error messages and fix them.',
  },
  no_form_controls: {
    hint: 'No standard form controls were found on this page: its questions are custom widgets.',
  },
  unclear_fields: {
    hint: 'Some required fields have no readable label (generated ids such as "select-input-_r_p_"): find their real question on the page and answer it.',
  },
  registration_incomplete: {
    hint: 'This is the portal\'s account registration page, before the application itself. The deterministic filler could not complete it (a field did not keep its value, or the form kept redrawing). Fill or choose every field you can answer from the candidate data (e-mail and its repetition, names, country of residence, other personal fields); type into a field that rejects a pasted value. Leave password fields, privacy consent, and account creation or sign-in clicks to the runner. Do not invent facts: use NEEDS_CANDIDATE only for required information that is genuinely unavailable. When the other fields are ready, return ACCOUNT_STEP.',
  },
  sign_in_incomplete: {
    hint: 'This is the portal\'s sign-in page for the candidate\'s existing account. The values the runner typed did not stay in the form: something on the page (a notice or dialog over the form, a widget around the e-mail field) undoes them. Make the form usable and type the candidate\'s e-mail where a pasted value does not stay. Never type a password or one-time code and never press the sign-in button: the runner does that through the existing account flow. When the page is ready for that flow, return ACCOUNT_STEP.',
  },
  cookie_preferences_unresolved: {
    hint: 'A cookie consent banner or cookie preference panel is still open on this page (it may sit inside an iframe or a shadow root) and the runner could not close it. Close it allowing only the necessary cookies: press the control that rejects the optional cookies or allows only the necessary ones; if only a preference panel is open, leave every optional category switched off and press the control that saves the choice; accept all cookies only when no other control closes it. Act only on the cookie banner or panel: do not press application, sign-in, registration, navigation, or submit controls and do not fill fields. Return REACHED_FORM once the banner is gone, or PARKED with a concrete reason if it cannot be closed.',
  },
  required_fields_unfilled: {
    hint: 'The portal still has required fields unfilled. Inspect the current page and repair every required field you can answer from the candidate profile, CV/documents, or previously saved portal answers. This includes custom controls and CV/document uploads when the matching file is available. Do not ask again for known answers and do not invent facts; use NEEDS_CANDIDATE only for required information that is genuinely unavailable.',
  },
  posting_mismatch: {
    hint: 'This page or route is not recognized as the selected job. Return to its posting or search this employer site by the exact requirement ID or job title. Continue only when the current application is linked to that selected job.',
    reason: 'modulo non riconosciuto come quello dell’annuncio',
    recoverable: true,
  },
  application_stage_unknown: {
    hint: 'The runner cannot classify this portal page. Inspect it and continue toward the selected job application, using visible links, buttons, tabs, or the same-site job search as needed.',
  },
  posting_unbound: {
    hint: 'The final form is not yet proven to belong to the paid job. Return to the selected posting once and reopen its application. Never submit from a talent pool, spontaneous application, or job alert.',
  },
  portal_needs_candidate: {
    reason: 'pagina non superata',
    recoverable: true,
  },
  account: {
    reason: 'account del portale',
    recoverable: true,
  },
  rejected: {
    reason: 'invio rifiutato dal portale',
  },
  account_create_unanswered: { recoverable: true },
  privacy_not_accepted: { recoverable: true },
  question_label_unreadable: { recoverable: true, rediscover: true },
  portal_choice_not_registered: { recoverable: true },
  upload_failed: { recoverable: true },
  cv_upload_failed: { recoverable: true },
});

function projection(property) {
  return Object.freeze(Object.fromEntries(
    Object.entries(PORTAL_STOP_CODES)
      .filter(([, definition]) => typeof definition[property] === 'string')
      .map(([code, definition]) => [code, definition[property]]),
  ));
}

export const PORTAL_STOP_HINTS = projection('hint');
export const PORTAL_STOP_REASONS = projection('reason');

function holdCodes(property) {
  return new Set(Object.entries(PORTAL_STOP_CODES)
    .filter(([, definition]) => definition[property] === true)
    .map(([code]) => `portal:${code}`));
}

export const PORTAL_STOP_RECOVERY_HOLDS = holdCodes('recoverable');
export const PORTAL_STOP_REDISCOVERY_HOLDS = holdCodes('rediscover');

// Every canonical stop is safe to expose as a sanitized replay outcome code.
export const PORTAL_STOP_REPLAY_CODES = new Set(Object.keys(PORTAL_STOP_CODES));

/**
 * Recovery behavior for a persisted portal hold.
 *
 * The public stop vocabulary above describes what the runner may report. This
 * contract describes what the state machine may do with a persisted hold. It
 * belongs here so the retry policy, source-version reconciler and notifications
 * cannot disagree about a spelling variant of the same namespaced stop.
 */
export const PORTAL_STOP_CLASSES = Object.freeze({
  SOURCE_RECOVERABLE: 'source_recoverable',
  TRANSPORT: 'transport',
  PORTAL_RETRY: 'portal_retry',
  CAPTCHA: 'captcha',
  AMBIGUOUS: 'ambiguous',
  TERMINAL: 'terminal',
  UNKNOWN: 'unknown',
});

const SOURCE_RECOVERABLE_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.SOURCE_RECOVERABLE,
  sourceRecovery: true,
  retryLane: 'none',
  automaticRetry: false,
});
const TRANSPORT_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.TRANSPORT,
  sourceRecovery: false,
  retryLane: 'transport',
  automaticRetry: true,
});
const PORTAL_RETRY_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.PORTAL_RETRY,
  sourceRecovery: true,
  retryLane: 'portal',
  automaticRetry: true,
});
const CAPTCHA_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.CAPTCHA,
  sourceRecovery: false,
  retryLane: 'none',
  automaticRetry: false,
});
const AMBIGUOUS_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.AMBIGUOUS,
  sourceRecovery: false,
  retryLane: 'none',
  automaticRetry: false,
});
const TERMINAL_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.TERMINAL,
  sourceRecovery: false,
  retryLane: 'none',
  automaticRetry: false,
});
const UNKNOWN_STOP = Object.freeze({
  category: PORTAL_STOP_CLASSES.UNKNOWN,
  sourceRecovery: false,
  retryLane: 'none',
  automaticRetry: false,
});

const SOURCE_RECOVERABLE_CODES = new Set([
  ...[...PORTAL_STOP_RECOVERY_HOLDS].map(hold => hold.replace(/^portal:/u, '')),
  // These runner handoffs are source-repairable but do not yet have public
  // hint/reason projections in PORTAL_STOP_CODES.
  'profile_section_row_incomplete',
  'previous_file_not_removable',
  'previous_file_removal_failed',
  'previous_file_removal_unconfirmed',
  'previous_file_replacement_unavailable',
  'portal_required_fields_unfilled',
  'portal_final_form_unbound',
  'posting_unbound',
  'portal_reader_failed',
]);

const PORTAL_STOP_RECOVERY_CONTRACT = Object.freeze({
  ...Object.fromEntries([...SOURCE_RECOVERABLE_CODES].map(code => [`portal:${code}`, SOURCE_RECOVERABLE_STOP])),

  // This lane has candidate-answer checks in the reconciler and the extra
  // send fence in portalRecoveryDefinitelyUnsent.
  'portal:portal_needs_candidate': PORTAL_RETRY_STOP,

  // Stops caused by where/how the runner connects, not by the candidate.
  'portal:navigation_unavailable': TRANSPORT_STOP,
  'transport:email_provider_unavailable': TRANSPORT_STOP,
  'transport:codex_quota_unavailable': TRANSPORT_STOP,
  'portal:question_localization_unavailable': TRANSPORT_STOP,
  'portal:application_region_unsupported': TRANSPORT_STOP,
  'portal:swiss_runner_offline': TRANSPORT_STOP,

  'portal:captcha': CAPTCHA_STOP,
  'portal:captcha_provider_unavailable': CAPTCHA_STOP,
  'portal:cookie_preferences_unresolved': AMBIGUOUS_STOP,
  'portal:portal_control_click_unresolved': AMBIGUOUS_STOP,
  'portal:application_stage_unknown': AMBIGUOUS_STOP,
  'portal:account_application_already_applied': AMBIGUOUS_STOP,
  'portal:account_application_history_uncertain': AMBIGUOUS_STOP,
  'portal:account_recovery_rejected': AMBIGUOUS_STOP,
  'portal:portal_ambiguous': AMBIGUOUS_STOP,
  'portal:portal_antibot_ambiguous': AMBIGUOUS_STOP,
  'portal:account_verification': AMBIGUOUS_STOP,

  'portal:portal_refused': TERMINAL_STOP,
  'portal:portal_validation': TERMINAL_STOP,
  'portal:portal_replay_final_click_blocked': TERMINAL_STOP,
  'portal:posting_closed': TERMINAL_STOP,
});

export function normalizePortalStopReason(reason) {
  return String(reason ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/gu, ':');
}

export function portalStopCode(reason) {
  return normalizePortalStopReason(reason).replace(/^(?:portal|transport):/u, '');
}

/** Resolve only a known, namespaced hold; unknown reasons fail closed. */
export function portalStopContract(reason) {
  const normalized = normalizePortalStopReason(reason);
  const code = portalStopCode(normalized);
  const contract = PORTAL_STOP_RECOVERY_CONTRACT[normalized];
  return Object.freeze({
    normalized,
    code,
    known: Boolean(contract),
    rediscovery: PORTAL_STOP_REDISCOVERY_HOLDS.has(normalized),
    ...(contract || UNKNOWN_STOP),
  });
}

export function isPortalNeedsCandidateHold(reason) {
  return portalStopContract(reason).normalized === 'portal:portal_needs_candidate';
}
