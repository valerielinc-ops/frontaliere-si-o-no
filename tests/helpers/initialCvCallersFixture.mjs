import { createMemoryFirestore } from './memoryFirestore.ts';

export const INITIAL_CV_ORDER = 'order_INITIALCV';
export const INITIAL_CV_BASE = `assisted_applications/${INITIAL_CV_ORDER}`;
export const INITIAL_CV_SECRET = 'initial-cv-ingress-fixture-secret';
export const INITIAL_CV_PDF = Buffer.from('%PDF-1.4\nfixture CV\n%%EOF');
export const INITIAL_CV_EMAIL = 'candidate@example.test';

export function initialCvDatabase(order = {}) {
  return createMemoryFirestore({
    [INITIAL_CV_BASE]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload',
      customerEmail: INITIAL_CV_EMAIL, paidAt: Date.now() - 1000, ...order },
  });
}

export function initialCvMessage({ from = INITIAL_CV_EMAIL,
  auth = 'mx.cloudflare.net; dkim=pass header.d=example.test; spf=pass smtp.mailfrom=candidate@example.test',
  extraAuth = '', content = INITIAL_CV_PDF } = {}) {
  return Buffer.from([
    `Authentication-Results: ${auth}`,
    ...(extraAuth ? [`Authentication-Results: ${extraAuth}`] : []),
    `From: ${from}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="cv-fixture"', '',
    '--cv-fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Private candidate notes.',
    '--cv-fixture', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="cv.pdf"',
    'Content-Transfer-Encoding: base64', '', content.toString('base64'), '--cv-fixture--', '',
  ].join('\r\n'));
}

export function initialCvEmailRequest(raw = initialCvMessage(), secret = INITIAL_CV_SECRET) {
  return { method: 'POST', rawBody: raw, get: name => name === 'x-stop-secret' ? secret : undefined };
}

/** Storage model enforces the real create-only and generation-delete conditions. */
export function initialCvBucket() {
  const files = new Map();
  const deleted = [];
  let generation = 0;
  const bucket = {
    files, deleted, beforeSave: null, afterSave: null, beforeMetadata: null,
    file(key) {
      return {
        async save(content, options = {}) {
          if (bucket.beforeSave) await bucket.beforeSave(key, content, options);
          if (options.preconditionOpts?.ifGenerationMatch === 0 && files.has(key)) {
            throw Object.assign(new Error('generation_precondition_failed'), { code: 412 });
          }
          files.set(key, { content: Buffer.from(content), generation: String(++generation), metadata: options.metadata?.metadata || {} });
          if (bucket.afterSave) await bucket.afterSave(key, content, options);
        },
        async getMetadata() {
          if (bucket.beforeMetadata) await bucket.beforeMetadata(key);
          const file = files.get(key);
          if (!file) throw Object.assign(new Error('not_found'), { code: 404 });
          return [{ generation: file.generation, metadata: { ...file.metadata } }];
        },
        async delete(options = {}) {
          const current = files.get(key);
          if (!current) {
            if (options.ignoreNotFound) return;
            throw Object.assign(new Error('not_found'), { code: 404 });
          }
          if (options.ifGenerationMatch != null && String(options.ifGenerationMatch) !== current.generation) {
            throw Object.assign(new Error('generation_precondition_failed'), { code: 412 });
          }
          deleted.push({ key, generation: current.generation });
          files.delete(key);
        },
      };
    },
  };
  return bucket;
}
