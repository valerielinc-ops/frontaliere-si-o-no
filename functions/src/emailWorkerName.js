/**
 * The Cloudflare Email Worker that receives every address of the domain
 * (infra/cloudflare-email-worker, wrangler `name`). One definition: the
 * routing rules the setup script writes (scripts/lib/bounce-return-path.mjs)
 * and the per-order alias rules the Cloud Functions create
 * (assistedApplicationAlias.js) must point at the same Worker. Lives in
 * functions/src because the deployed functions cannot import scripts/.
 */
export const EMAIL_WORKER_NAME = 'frontaliere-stop-reply-handler';
