/**
 * dataControllerIdentity.js — SINGLE SOURCE of the data-controller identity
 * (name + contact) that art. 19 nLPD requires to be identifiable wherever
 * personal data is collected: the privacy policy AND the footer of every
 * lifecycle email (#5675).
 *
 * Measured on production 2026-08-12: frontaliereticino.ch/privacy/ named no
 * controller at all ("A cura di Redazione Frontaliere Ticino" was the only
 * attribution), and neither did any email footer. A recipient's LPD art.
 * 25/32 request had nowhere to land except the automated `alerts@` mailbox,
 * and from there to the IFPDT instead of to us.
 *
 * Canonical home is functions/src/lib/ (not services/) for the same
 * deploy-boundary reason as newsletterUrlPaths.js in this same directory:
 * firebase.json's `source: "functions"` means functions/src/** can only
 * import from within functions/ — no reach into the repo-root services/
 * tree. The welcome email and the two Cloud-Function-hosted transactional
 * emails (functions/src/newsletterConfirmationEmail.js,
 * functions/src/sendCalculatorReport.js) import this directly; every
 * services/*.mjs and scripts/*.mjs template (weekly newsletter, daily
 * brief, job alerts, winback ×2, onboarding drip, saved-jobs digest,
 * company-follow alert, publisher blast) reaches it with a relative path
 * into functions/src/lib/, exactly like they already do for
 * newsletterUrlPaths.js.
 *
 * DATA, per issue #5675 (owner's comment, 2026-08-12): name + email only —
 * deliberately NO postal address. That is an explicit owner choice, not a
 * gap to fill in here or at any call site: inventing or placeholder-ing a
 * sede would misstate what the owner decided. See that issue for the
 * assessment that name+email is a real improvement over the prior absence
 * but not a complete art. 19 nLPD recap (which expects a postal address
 * too) — recorded there on purpose so nobody "fixes" this file to add one.
 *
 * The contact is deliberately NOT `alerts@` — that is the automated-send
 * mailbox, and it receiving LPD requests instead of a monitored address is
 * exactly the defect this file exists to close.
 */

export const DATA_CONTROLLER_NAME = 'Valerie Linc';
export const DATA_CONTROLLER_EMAIL = 'valerie@frontaliereticino.ch';

/**
 * Short one-line identification for an email footer, one per site locale
 * (it/en/de/fr — the four this codebase ships everywhere else). Plain text
 * on purpose: every footer that consumes this runs its own HTML-escaping
 * function over arbitrary strings already, and a bare string is safe to
 * pass through any of them without needing to know which one.
 */
export const DATA_CONTROLLER_FOOTER_LINE = Object.freeze({
  it: `Titolare del trattamento: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  en: `Data controller: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  de: `Verantwortliche Person: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  fr: `Responsable du traitement : ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
});

/** `DATA_CONTROLLER_FOOTER_LINE[locale]`, falling back to Italian like every other email i18n table in this codebase. */
export function dataControllerFooterLine(locale) {
  const key = String(locale || 'it').slice(0, 2).toLowerCase();
  return DATA_CONTROLLER_FOOTER_LINE[key] || DATA_CONTROLLER_FOOTER_LINE.it;
}
