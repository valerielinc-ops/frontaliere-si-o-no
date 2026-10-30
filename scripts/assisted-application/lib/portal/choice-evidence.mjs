/** Structural facts only: never copy DOM text, values, identifiers or URLs. */
export async function choiceControlState(locator) {
  if (typeof locator?.evaluate !== 'function') return null;
  try { return await locator.evaluate(element => {
    const doc = element.ownerDocument;
    const id = element.id;
    const aaId = element.getAttribute('data-aa-id');
    const labels = id ? [...doc.querySelectorAll('label[for]')].filter(label => label.htmlFor === id) : [];
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type')?.toLowerCase();
    const style = doc.defaultView.getComputedStyle(element);
    return {
      tag: ['input', 'label', 'button', 'select', 'textarea', 'div', 'span', 'a', 'i'].includes(tag) ? tag : 'other',
      inputType: ['checkbox', 'radio', 'text', 'email', 'tel', 'password', 'hidden', 'file'].includes(type) ? type : null,
      checked: typeof element.checked === 'boolean' ? element.checked : null,
      disabled: typeof element.disabled === 'boolean' ? element.disabled : null,
      connected: element.isConnected,
      hidden: style.display === 'none' || style.visibility === 'hidden',
      aaIdCount: aaId ? [...doc.querySelectorAll('[data-aa-id]')].filter(node => node.getAttribute('data-aa-id') === aaId).length : 0,
      nativeIdCount: id ? [...doc.querySelectorAll('[id]')].filter(node => node.id === id).length : 0,
      labelCount: element.labels?.length ?? 0,
      directLabelCount: labels.length,
      directLabelControlsTarget: labels.length === 1 ? labels[0].control === element : null,
    };
  }, null, { timeout: 2000 }); } catch { return null; }
}

export async function beginChoiceObservation(locator, requestedChecked, frame, frameIndexBefore) {
  let original = null;
  try { original = typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: 2000 }) : null; } catch { /* Observation cannot prevent the action. */ }
  return { original, frame, frameIndexBefore, requestedChecked, before: await choiceControlState(locator), method: 'native', attempts: [] };
}

/** Returned only on a failed action, into the existing encrypted evidence. */
export async function choiceFailureEvidence({ page, fields, field, locator, observation }) {
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const frameMatches = await Promise.all(frames.map(async (frame, index) => {
    let count = null;
    try { count = await frame.locator(`[data-aa-id="${field.id}"]`).count(); } catch { /* A frame may have closed. */ }
    return { index, count };
  }));
  const identity = observation.original && typeof locator.evaluate === 'function'
    ? await locator.evaluate((element, original) => ({
      sameNode: element === original,
      sameNativeId: element.id && original.id ? element.id === original.id : null,
      sameName: element.getAttribute('name') && original.getAttribute('name')
        ? element.getAttribute('name') === original.getAttribute('name') : null,
    }), observation.original, { timeout: 2000 }).catch(() => null) : null;
  return {
    requestedChecked: observation.requestedChecked,
    registeredChecked: observation.registeredChecked ?? null,
    method: observation.method, attempts: observation.attempts,
    labelClickTag: observation.labelClickTag || null,
    before: observation.before, after: await choiceControlState(locator), identity,
    logicalFieldCount: fields.filter(candidate => candidate.id === field.id).length,
    logicalFrameIndices: fields.filter(candidate => candidate.id === field.id).map(candidate => candidate.frame || 0),
    selectedFrameIndexBefore: observation.frameIndexBefore,
    selectedFrameIndex: frames.indexOf(observation.frame), frameMatches,
  };
}
