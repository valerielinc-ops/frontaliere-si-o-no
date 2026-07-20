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
