/** Pure flag contract shared by Functions and administrative CLIs. */
export const AUTOMATION_FLAG_KEY = 'ASSISTED_APPLICATION_AUTOMATION';

/**
 * The Remote Config flag: "true" automates every order; "false" or empty
 * none; anything else is a list of order ids (commas or spaces) and automates
 * only those — the final trial run, before switching on for everyone.
 */
export function parseAutomationFlag(value) {
  const text = String(value || '').trim();
  if (text.toLowerCase() === 'true') return { all: true, orders: new Set() };
  if (!text || text.toLowerCase() === 'false') return { all: false, orders: new Set() };
  return { all: false, orders: new Set(text.split(/[\s,]+/).filter(Boolean)) };
}

