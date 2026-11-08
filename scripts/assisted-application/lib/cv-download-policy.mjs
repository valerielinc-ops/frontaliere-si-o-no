import { cvToSend } from '../../../functions/src/assistedApplicationDocxInPlace.js';

/** The runner needs the original bytes for drafting or when they will be sent. */
export function shouldDownloadOriginalCv({ mode, draft, flow, order } = {}) {
  return mode === 'draft' || cvToSend(draft, flow, order).cv === 'original';
}
