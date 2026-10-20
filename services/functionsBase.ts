/**
 * Shared Cloud Functions base URL + endpoints used from more than one
 * client module. Extracted (AGENTS.md #6, anti-drift by construction)
 * when the sendCalculatorReport endpoint gained a second caller
 * (CalculatorPaywall + LamalSsnBreakeven).
 */
export const FUNCTIONS_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';

/** PDF report delivery endpoint (calculator paywall + LAMal/SSN breakeven tool). */
export const SEND_CALCULATOR_REPORT_URL = `${FUNCTIONS_BASE}/sendCalculatorReport`;

/** Stripe Checkout Session creation for /consulenza/ one-time session payments. */
export const CREATE_CONSULTING_CHECKOUT_URL = `${FUNCTIONS_BASE}/createConsultingCheckout`;

/** Stripe Checkout Session creation for the €1.99 assisted-application flow. */
export const CREATE_ASSISTED_APPLICATION_CHECKOUT_URL = `${FUNCTIONS_BASE}/createAssistedApplicationCheckout`;

/** Authenticated, candidate-safe list of paid assisted applications and their current status. */
export const MY_ASSISTED_APPLICATIONS_URL = `${FUNCTIONS_BASE}/myAssistedApplications`;

/** Stripe/SumUp Checkout for the €39.99, 30-day application concierge. */
export const CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL = `${FUNCTIONS_BASE}/createApplicationConciergeCheckout`;

/** Candidate portal API for the application concierge parent service. */
export const APPLICATION_CONCIERGE_URL = `${FUNCTIONS_BASE}/applicationConcierge`;

/** Owner proposal queue API for the application concierge. */
export const MANAGE_APPLICATION_CONCIERGE_URL = `${FUNCTIONS_BASE}/manageApplicationConcierge`;

/** Candidate review page of the automated assisted application (signed link, no login). */
export const ASSISTED_APPLICATION_REVIEW_URL = `${FUNCTIONS_BASE}/assistedApplicationReview`;

/** Server-side, idempotent record of the explicit job-application intent click. */
export const RECORD_APPLICATION_INTENT_URL = `${FUNCTIONS_BASE}/recordApplicationIntent`;
