import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { nativeControlEvidenceInPage, snapshotWithNativeControlEvidence, observeNativeControlContractInPage, installNativeGroupIdentityInPage, hasNativeApplicantIdentity } from '../scripts/assisted-application/lib/portal/native-control-contract.mjs';
import { revalidatedPortalQuestions } from '../scripts/assisted-application/lib/portal/question-contract-reconciliation.mjs';
const label = 'How did you hear about this job?';
const field = { id: 'proxy', frame: 0, form: -1, label, name: '', kind: 'combobox', inputType: 'span', widget: 'jquery-selectmenu', nativeSelectId: 'source', required: false, options: [] };
const markup = (aria = 'aria-required="false"') => `<form id="apply"><fieldset id="own"><label for="source" id="question">${label}</label><select id="source" name="source" ${aria} aria-labelledby="question"><option value="">Prompt</option><option value="site">Website</option></select><span data-aa-id="proxy" id="source-button" class="ui-selectmenu-button" role="combobox" aria-owns="source-menu"></span></fieldset></form>`;
function evidence(html: string, descriptor = field) {
  const dom = new JSDOM(html, { url: 'https://jobs.example.com/apply/', runScripts: 'outside-only' });
  try {
    dom.window.eval(`(${installNativeGroupIdentityInPage.toString()})`)();
    const read = dom.window.eval(`(${nativeControlEvidenceInPage.toString()})`);
    return JSON.parse(JSON.stringify(read([descriptor])));
  } finally { dom.window.close(); }
}
describe('native select contract behind a visible selectmenu proxy', () => {
  it('reads form, required state, native identity and catalogue from the unique native owner', () => {
    const observed = evidence(markup());
    expect(observed).toMatchObject([{ id: 'proxy', nativeControlOwned: true, nativeControlId: 'source', nativeSelectId: 'source', form: 0,
      nativeRequired: false, explicitlyOptional: true, required: false, kind: 'select', inputType: 'select-one', label,
      options: [{ value: '', label: 'Prompt' }, { value: 'site', label: 'Website' }] }]);
    expect(snapshotWithNativeControlEvidence({ fields: [field] }, observed).fields[0]).toMatchObject({ form: 0, kind: 'select', options: observed[0].options });
  });
  it('revalidates a legacy question only after the original select supplies its form and explicit optional marker', () => {
    const url = 'https://jobs.example.com/apply/';
    const native = snapshotWithNativeControlEvidence({ fields: [field] }, evidence(markup())).fields[0];
    const question = { id: 'portal_source', source: 'portal', required: true, type: 'text', question: label, applicationQuestion: label, options: [] };
    const draft = { round: 1, status: 'ready', channel: { applyUrl: url }, questions: [question] };
    const context = { order: {}, flow: { state: 'needs_candidate_action', round: 1, heldBy: ['question:portal_source'], answers: {} }, draft };
    const proof = { complete: true, stable: true, readOnly: true, sourceUrl: url, url, observedAt: Date.now(), fields: [
      { ...native, explicitlyOptional: true }, { nativeControlOwned: true, nativeLabelOwned: true, nativeReferencesComplete: true, id: 'cv', frame: 0, form: 0, kind: 'file', label: 'CV' },
      { nativeControlOwned: true, nativeLabelOwned: true, nativeReferencesComplete: true, id: 'email', frame: 0, form: 0, kind: 'text', inputType: 'email', label: 'Email' },
    ] };
    const result = revalidatedPortalQuestions(context, proof, Date.now());
    expect(result.changed).toBe(true);
    expect(result.questions[0]).toMatchObject({ id: question.id, required: false, type: 'choice', options: ['Prompt', 'Website'],
      portalNativeContract: { form: 0, nativeSelectId: 'source', nativeControlId: 'source', requiredEvidence: 'aria-required:false' } });
    expect(draft.questions).toEqual([question]);
    for (const id of ['proxy', 'cv', 'email']) {
      expect(revalidatedPortalQuestions(context, { ...proof, fields: proof.fields.map(item => item.id === id ? { ...item, nativeReferencesComplete: undefined } : item) }, Date.now()).changed).toBe(false);
    }
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [...proof.fields, { id: 'extra', frame: 0, form: 0, kind: 'file', label: 'Additional attachment', nativeReferencesComplete: false }] }, Date.now()).changed).toBe(true);
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [{ ...native, nativeReferencesComplete: false }, ...proof.fields.slice(1)] }, Date.now()).changed).toBe(false);
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [native, { ...proof.fields[1], nativeReferencesComplete: false }, proof.fields[2]] }, Date.now()).changed).toBe(false);
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [native, proof.fields[1], { ...proof.fields[2], nativeReferencesComplete: false }] }, Date.now()).changed).toBe(false);
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [{ ...field, explicitlyOptional: false }, ...proof.fields.slice(1)] }, Date.now()).changed).toBe(false);
    const skipped = snapshotWithNativeControlEvidence({ fields: [{ ...field, kind: 'select', form: 0, required: true }] }, []).fields[0];
    expect(revalidatedPortalQuestions(context, { ...proof, fields: [skipped, ...proof.fields.slice(1)] }, Date.now()).changed).toBe(false);
  });

  it.each(['missing_marker', 'aria_required', 'native_required'])('never invents optional evidence for %s', kind => {
    const attrs = kind === 'missing_marker' ? '' : kind === 'aria_required' ? 'aria-required="true"' : 'aria-required="false" required';
    const result = evidence(markup(attrs))[0];
    expect(result.explicitlyOptional).toBe(false);
    expect(result.required).toBe(kind !== 'missing_marker');
    if (kind === 'native_required') expect(result.options[0].placeholder).toBe(true);
  });
  it.each(['duplicate_native', 'duplicate_proxy', 'wrong_owner', 'other_form', 'other_group', 'label_mismatch', 'missing_native_label_ref', 'other_frame', 'unavailable'])('keeps ownership unknown for %s', kind => {
    let html = markup(); let descriptor = field;
    if (kind === 'duplicate_native') html += '<div id="source"></div>';
    if (kind === 'duplicate_proxy') html += '<span id="source-button" data-aa-id="proxy"></span>';
    if (kind === 'wrong_owner') html = html.replace('source-menu', 'other-menu');
    if (kind === 'other_form') html = html.replace('<span ', '</fieldset></form><form id="other"><fieldset><span ');
    if (kind === 'other_group') html = html.replace('<span ', '</fieldset><fieldset><span ');
    if (kind === 'missing_native_label_ref') html = html.replace('aria-labelledby="question"', 'aria-labelledby="missing"');
    if (kind === 'label_mismatch') descriptor = { ...field, label: 'Other question' };
    if (kind === 'other_frame') descriptor = { ...field, frame: 1 };
    if (kind === 'unavailable') descriptor = { ...field, nativeContractUnavailable: true } as any;
    expect(evidence(html, descriptor)).toEqual([]);
    if (descriptor.frame === 0) expect(snapshotWithNativeControlEvidence({ fields: [descriptor] }, evidence(html, descriptor)).fields[0]).toMatchObject({ nativeControlOwned: false, nativeLabelOwned: false, nativeReferencesComplete: false });
  });
  it('retains a missing auxiliary reference as an unknown component without inventing native metadata', () => {
    const html = '<form><label for="extra">Additional attachment</label><input type="file" id="extra" data-aa-id="extra" aria-labelledby="missing-caption"></form>';
    const observed = evidence(html, { id: 'extra', frame: 0, form: 0, label: 'Additional attachment', kind: 'file' } as any);
    expect(observed[0]).toMatchObject({ nativeReferencesComplete: false, nativeLabelOwned: false });
  });

  it('reads the native display label without treating internal text as a visible choice', () => {
    const html = markup().replace('<option value="site">Website</option>', '<option value="site" label="Company website">internal-code</option>');
    expect(evidence(html)[0].options[1]).toEqual({ value: 'site', label: 'Company website' });
  });

  it('preserves every real native option beyond the old planner catalogue', () => {
    const options = Array.from({ length: 37 }, (_, i) => `<option value="v${i}">Source ${i}</option>`).join('');
    const result = evidence(markup().replace('<option value="">Prompt</option><option value="site">Website</option>', options))[0];
    expect(result.options).toHaveLength(37);
    expect(result.options[36]).toEqual({ value: 'v36', label: 'Source 36' });
  });
});

describe('late native contract mutations after the third snapshot', () => {
  it.each(['external_label', 'external_form_label', 'aria_retarget', 'option_value', 'multiple', 'proxy_class', 'duplicate_id', 'external_remove', 'external_rebind', 'missing_ref', 'duplicate_ref', 'missing_ref_appears', 'late_style', 'late_hidden', 'late_aria_hidden', 'ancestor_class_visibility', 'cmp_cosmetic', 'cmp_overflow'])('keeps native ownership fresh for %s', async kind => {
    let html = markup().replace('aria-labelledby="question"', 'aria-labelledby="external"') + `<style>#late { display: none; }.expanded #late { display: block; }</style><span id="external">${label}</span><span id="other-caption">Other question</span><form id="other"></form>`;
    if (kind.startsWith('external_') && kind !== 'external_label') {
      const match = html.match(/<select[\s\S]*?<\/select>/)![0];
      html = html.replace(match, '').replace(/<\/?fieldset[^>]*>/g, '') + match.replace('<select ', '<select form="apply" hidden ');
    }
    if (kind === 'external_form_label') html = html.replace('<form id="apply">', '<form id="apply" aria-labelledby="form-caption">') + '<span id="form-caption">Personal information</span>';
    const dom = new JSDOM(html, { url: 'https://jobs.example.com/apply/', runScripts: 'outside-only' });
    try {
      const doc = dom.window.document;
      const late = doc.createElement('input'); late.id = 'late'; late.required = true; late.style.display = 'none';
      if (kind === 'ancestor_class_visibility') late.style.display = '';
      if (kind === 'late_hidden') { late.style.display = 'block'; late.hidden = true; }
      if (kind === 'late_aria_hidden') { late.style.display = 'block'; late.setAttribute('aria-hidden', 'true'); }
      doc.getElementById('apply')!.append(late);
      dom.window.eval(`(${installNativeGroupIdentityInPage.toString()})`)();
    const read = dom.window.eval(`(${nativeControlEvidenceInPage.toString()})`);
      if (kind !== 'external_form_label') expect(read([field])[0].nativeControlOwned).toBe(true);
      if (kind === 'missing_ref' || kind === 'missing_ref_appears') doc.getElementById('external')!.remove();
      if (kind === 'duplicate_ref') { const duplicate = doc.createElement('span'); duplicate.id = 'external'; doc.body.append(duplicate); }
      (dom.window as any).__portalContractProbeNativeChanged = async () => {};
      const observe = dom.window.eval(`(${observeNativeControlContractInPage.toString()})`);
      observe([{ id: field.id, nativeSelectId: 'source', nativeControlOwned: true }]);
      const select = doc.getElementById('source') as HTMLSelectElement;
      if (kind === 'missing_ref_appears') { const restored = doc.createElement('span'); restored.id = 'external'; restored.textContent = label; doc.body.append(restored); }
      if (kind === 'external_label') doc.getElementById('external')!.firstChild!.textContent = 'Other question';
      if (kind === 'external_form_label') doc.getElementById('form-caption')!.firstChild!.textContent = 'Reference contact';
      if (kind === 'aria_retarget') select.setAttribute('aria-labelledby', 'other-caption');
      if (kind === 'option_value') select.options[1].value = 'different';
      if (kind === 'multiple') select.multiple = true;
      if (kind === 'proxy_class') doc.getElementById('source-button')!.className = 'different';
      if (kind === 'duplicate_id') { const duplicate = doc.createElement('div'); duplicate.id = 'source'; doc.body.append(duplicate); }
      if (kind === 'external_remove') select.remove();
      if (kind === 'external_rebind') select.setAttribute('form', 'other');
      if (kind === 'late_style') late.style.display = 'block';
      if (kind === 'late_hidden') late.hidden = false;
      if (kind === 'late_aria_hidden') late.setAttribute('aria-hidden', 'false');
      if (kind === 'ancestor_class_visibility') doc.body.className = 'expanded';
      if (kind === 'cmp_overflow') doc.body.style.overflow = 'hidden';
      if (kind === 'cmp_cosmetic') { doc.body.className = 'consent-banner-open'; const banner = doc.createElement('div'); banner.textContent = 'Cookie settings'; doc.body.append(banner); }
      await new Promise(resolve => setTimeout(resolve, 0));
      const stableBaseline = kind.startsWith('cmp_') || ['missing_ref', 'duplicate_ref'].includes(kind);
      expect((dom.window as any).__portalNativeContractChanged).toBe(!stableBaseline);
      if (['missing_ref', 'duplicate_ref'].includes(kind)) expect(read([field])).toEqual([]);
      if (!stableBaseline) expect(['attribute', 'child_list', 'character_data', 'visibility', 'reference_unknown']).toContain((dom.window as any).__portalNativeContractChange.kind);
      if (kind === 'option_value') expect((dom.window as any).__portalNativeContractChange).toEqual({ kind: 'attribute', attribute: 'value' });
      if (kind === 'ancestor_class_visibility') expect((dom.window as any).__portalNativeContractChange).toEqual({ kind: 'visibility', attribute: null });
    } finally { dom.window.close(); }
  });
});

function identityEvidence(purpose: string, labels: string[], names: string[], variation = '') {
  const inputs = labels.map((label, i) => `<label for="i${i}">${label} *</label><input data-aa-id="i${i}" id="i${i}" type="text" autocomplete="off" name="application[${names[i]}]" aria-required="true">`);
  let html = `<form id="apply"><fieldset><legend>${purpose}</legend>${inputs.join('\n')}</fieldset></form>`;
  if (variation === 'foreign_form') html = html.replace(inputs[2], '') + `<form><fieldset><legend>${purpose}</legend>${inputs[2]}</fieldset></form>`;
  if (variation === 'foreign_group') html = `<form><fieldset><legend>${purpose}</legend>${inputs.slice(0, 2).join('\n')}</fieldset><fieldset><legend>${purpose}</legend>${inputs[2]}</fieldset></form>`;
  if (variation === 'duplicate_leaf') html = html.replace('</fieldset>', `${inputs[2].replaceAll('i2', 'i3')}</fieldset>`);
  if (variation === 'conflicting_owner') html = html.replace('<legend>', '<p>Reference contact details</p><legend>');
  if (variation === 'foreign_name_scope') html = html.replace(`application[${names[2]}]`, `application[reference][${names[2]}]`);
  if (variation === 'unknown_label') html = html.replace(`${labels[2]} *`, 'Company contact *');
  if (variation === 'not_required') html = html.replace('aria-required="true"', 'aria-required="false"');
  if (variation === 'named_form') html = html.replace('<form id="apply">', '<form id="apply" aria-label="Reference contact">');
  if (variation === 'named_ancestor') html = html.replace('<fieldset>', '<div aria-label="Reference contact"><fieldset>').replace('</fieldset>', '</fieldset></div>');
  if (variation === 'heading_ancestor') html = html.replace('<fieldset>', '<div><h2>Reference contact</h2><fieldset>').replace('</fieldset>', '</fieldset></div>');
  if (variation === 'field_ancestor') html = html.replace('<fieldset>', '<div class="field"><label>Reference contact</label><fieldset>').replace('</fieldset>', '</fieldset></div>');
  if (variation === 'missing_owner_ref') html = html.replace('<form id="apply">', '<form id="apply" aria-labelledby="missing-owner">');
  if (variation === 'duplicate_owner_ref') html = '<span id="owner">Personal information</span><span id="owner">Reference contact</span>' + html.replace('<form id="apply">', '<form id="apply" aria-labelledby="owner">');
  if (variation === 'conflicting_form_markers') html = html.replace('<form id="apply">', '<form id="apply" aria-label="Reference contact"><h2>Personal information</h2>');
  if (variation === 'external_personal_form' || variation === 'external_foreign_form') {
    html = `<form id="apply" aria-label="${variation === 'external_personal_form' ? purpose : 'Reference contact'}"></form><section><h2>${purpose}</h2><fieldset><legend>${purpose}</legend>${inputs.map(input => input.replace('<input ', '<input form="apply" ')).join('\n')}</fieldset></section>`;
  }
  if (variation.startsWith('job_')) {
    html = html.replace('<fieldset>', '<div><h2>Sales consultant (m/f) - 100%</h2><fieldset>').replace('</fieldset>', '</fieldset></div>');
    if (variation === 'job_conflicting_heading') html = html.replace('<div><h2>', '<div aria-label="Reference contact"><h2>');
    if (variation === 'job_reference_ancestor') html = html.replace('<form id="apply">', '<form id="apply" aria-label="Reference contact">');
    if (variation === 'job_missing_personal') html = html.replace(`<legend>${purpose}</legend>`, '<legend>Sales consultant (m/f) - 100%</legend>');
  }
  const dom = new JSDOM(html, { url: 'https://jobs.example.com/apply/', runScripts: 'outside-only' });
  try {
    const doc = dom.window.document;
    const fields = [...doc.querySelectorAll('input')].map(input => {
      const group = input.closest('fieldset')!;
      return { id: input.id, frame: 0, kind: 'text', inputType: 'text', autocomplete: 'off', form: -1,
        name: input.name, label: input.labels![0].textContent!.trim(), section: group.querySelector('legend')!.textContent!.trim(),
        context: [...group.querySelectorAll('legend,p,label')].map(node => node.textContent!.trim()).join(' · '), required: true };
    });
    dom.window.eval(`(${installNativeGroupIdentityInPage.toString()})`)();
    const read = dom.window.eval(`(${nativeControlEvidenceInPage.toString()})`);
    const markers = JSON.parse(JSON.stringify(read(fields)));
    return snapshotWithNativeControlEvidence({ fields }, markers).fields;
  } finally { dom.window.close(); }
}

describe('native applicant identity observation without assuming email input semantics', () => {
  it.each<[string, string[], string[]]>([
    ['Dati personali', ['Nome', 'Cognome', 'E-Mail'], ['vorname', 'nachname', 'mail']],
    ['Personal information', ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email']],
    ['Persönliche Angaben', ['Vorname', 'Nachname', 'E-Mail'], ['vorname', 'nachname', 'mail']],
    ['Informations personnelles', ['Prénom', 'Nom', 'Courriel'], ['prenom', 'nom', 'courriel']],
  ])('accepts only the complete owned text-input identity group in %s', (purpose, labels, names) => {
    const fields = identityEvidence(purpose, labels, names);
    expect(fields.every(field => field.inputType === 'text' && field.autocomplete === 'off')).toBe(true);
    expect(hasNativeApplicantIdentity(fields, 0)).toBe(true);
    expect(hasNativeApplicantIdentity(fields.slice(0, 2), 0)).toBe(false);
    expect(hasNativeApplicantIdentity(fields.map(field => ({ ...field, nativeControlOwned: false })), 0)).toBe(false);
  });
  it.each(['foreign_form', 'foreign_group', 'duplicate_leaf', 'conflicting_owner', 'foreign_name_scope', 'unknown_label', 'not_required', 'named_form', 'named_ancestor', 'heading_ancestor', 'field_ancestor', 'missing_owner_ref', 'duplicate_owner_ref', 'conflicting_form_markers', 'external_foreign_form'])('does not infer candidate ownership for %s', variation => {
    expect(hasNativeApplicantIdentity(identityEvidence('Personal information', ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email'], variation), 0)).toBe(false);
  });
  it('checks the named actual form even when it is not an ancestor', () => {
    expect(hasNativeApplicantIdentity(identityEvidence('Personal information', ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email'], 'external_personal_form'), 0)).toBe(true);
  });
  it('allows only the exact source-bound application title above the personal owner', () => {
    const fields = identityEvidence('Personal information', ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email'], 'job_heading');
    expect(hasNativeApplicantIdentity(fields, 0, 'Sales consultant (m/f) - 100%')).toBe(true);
    for (const title of ['', 'Sales consultant', 'Sales consultant (m/f) - 80%', 'Another job']) expect(hasNativeApplicantIdentity(fields, 0, title)).toBe(false);
    for (const variation of ['job_conflicting_heading', 'job_reference_ancestor', 'job_missing_personal']) {
      expect(hasNativeApplicantIdentity(identityEvidence('Personal information', ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email'], variation), 0, 'Sales consultant (m/f) - 100%')).toBe(false);
    }
  });
  it.each(['Email address', 'E-mail address'])('accepts the complete English email label %s', email => {
    expect(hasNativeApplicantIdentity(identityEvidence('Personal information', ['First name', 'Last name', email], ['first_name', 'last_name', 'email']), 0)).toBe(true);
  });
  it.each(['Reference contact', 'Newsletter', 'Company details', 'Personal information for another person'])('keeps unproven group purpose unknown: %s', purpose => {
    expect(hasNativeApplicantIdentity(identityEvidence(purpose, ['First name', 'Last name', 'Email'], ['first_name', 'last_name', 'email']), 0)).toBe(false);
  });
});
