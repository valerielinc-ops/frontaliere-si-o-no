/**
 * Shared Firebase Remote Config admin-write plumbing for the scripts/set-*-rc.mjs
 * one-shot family (+ seo-serp-autopilot.mjs). Centralizes admin init, template
 * fetch, per-key stage-if-changed, and publish so a fix to any of those lands
 * everywhere at once instead of drifting across copy-pasted siblings.
 */

export async function getRemoteConfig() {
  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin.remoteConfig();
}

export async function fetchRcTemplate(rc) {
  const template = await rc.getTemplate();
  template.parameters = template.parameters || {};
  return template;
}

/**
 * Stages `key` = `value` in `template` if it differs from the current
 * defaultValue. Returns true if staged (change pending publish), false if
 * already up-to-date.
 */
export function stageRcParam(template, key, value, description) {
  const existing = template.parameters[key]?.defaultValue?.value;
  if (existing === value) return false;
  template.parameters[key] = {
    defaultValue: { value },
    valueType: 'STRING',
    description,
  };
  return true;
}

export async function publishRcTemplate(rc, template, changedCount) {
  if (changedCount === 0) return false;
  await rc.publishTemplate(template, { force: true });
  return true;
}
