import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../../lib/is-invoked-directly.mjs';
import {
  APPLICATION_CONSENT_FACT_SOURCES,
  createApplicationConsentGuard,
  readOwnConsentMetadata,
} from '../../../functions/src/lib/applicationConsent.js';

const controlsPath = fileURLToPath(new URL('./apply-control.js', import.meta.url));
const fieldsPath = fileURLToPath(new URL('../lib/portal/fields.mjs', import.meta.url));
const start = '// BEGIN GENERATED APPLICATION CONSENT';
const end = '// END GENERATED APPLICATION CONSENT';

function region(source, body, anchor) {
  const rendered = `  ${start}\n${body}\n  ${end}`;
  const from = source.indexOf(`  ${start}`), to = source.indexOf(`  ${end}`);
  if (from >= 0 && to >= from) return source.slice(0, from) + rendered + source.slice(to + `  ${end}`.length);
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error('application_consent_generation_anchor_missing');
  return source.slice(0, at) + rendered + '\n' + source.slice(at);
}

export function renderConsentControls(current) {
  const body = `  const pureApplicationConsent = (${createApplicationConsentGuard.toString()})(${JSON.stringify(APPLICATION_CONSENT_FACT_SOURCES)});\n  const readOwnConsentMetadata = ${readOwnConsentMetadata.toString()};`;
  const rendered = region(current, body, '  root.AssistedApplyControls = Object.freeze(');
  const exports = rendered.match(/root\.AssistedApplyControls = Object\.freeze\(\{([^{}]*)\}\);/);
  if (!exports) throw new Error('application_consent_exports_anchor_missing');
  const properties = exports[1].split(',').map(value => value.trim()).filter(Boolean);
  for (const property of ['pureApplicationConsent', 'isConsentOnly: pureApplicationConsent.isConsentOnly', 'isConsentRefusal: pureApplicationConsent.isConsentRefusal', 'readOwnConsentMetadata']) {
    const key = property.split(':')[0];
    if (!properties.some(value => value.split(':')[0].trim() === key)) properties.push(property);
  }
  return rendered.replace(exports[0], `root.AssistedApplyControls = Object.freeze({ ${properties.join(', ')} });`);
}

export function renderConsentMetadataInFields(current) {
  const header = current.match(/^export function extractFieldsInPage\([^\n]+\{\n/m)?.[0];
  if (!header) throw new Error('application_consent_extractor_header_missing');
  if (current.includes(start)) return region(current, `  const readOwnConsentMetadata = ${readOwnConsentMetadata.toString()};`, '');
  const at = current.indexOf(header) + header.length;
  return current.slice(0, at) + region('', `  const readOwnConsentMetadata = ${readOwnConsentMetadata.toString()};`, '') + '\n' + current.slice(at);
}

export async function buildConsentControls({ check = false } = {}) {
  for (const [path, render] of [[controlsPath, renderConsentControls], [fieldsPath, renderConsentMetadataInFields]]) {
    const current = await readFile(path, 'utf8'), expected = render(current);
    if (check && current !== expected) throw new Error('application_consent_generated_code_out_of_date');
    if (!check && current !== expected) await writeFile(path, expected);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  await buildConsentControls({ check: process.argv.includes('--check') });
  console.log('application consent policy and native reader are aligned');
}
