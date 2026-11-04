import { ACTION_REQUIRED, classifyInstagram, READY } from './social-readiness.mjs';
import { probeInstagramPageLink } from './instagram-page-link-probe.mjs';
import {
  probeInstagramPermissions,
  probeInstagramPublisherToken,
} from './instagram-publisher-readiness-probes.mjs';

function capabilityReadiness({ permissionStatuses, pageTaskStatuses, pageLinkStatus, publisherTokenStatus, publisherTokenSourceStatus }, {
  permissions,
  pageTask,
  label,
  eligibilityNote = null,
} = {}) {
  const blockers = [];
  if (pageLinkStatus !== 'matched') blockers.push('linked Page and Instagram account are not verified');
  if (publisherTokenStatus !== 'matched') blockers.push('publisher token identity is not verified');
  if (publisherTokenSourceStatus !== 'matched') blockers.push('publisher token is not tied to the verified Page');
  for (const permission of permissions) {
    if (permissionStatuses?.[permission] !== 'granted') blockers.push(`${permission} is ${permissionStatuses?.[permission] || 'unavailable'}`);
  }
  if (pageTask && pageTaskStatuses?.[pageTask] !== 'granted') {
    blockers.push(`Page ${pageTask} task is ${pageTaskStatuses?.[pageTask] || 'unavailable'}`);
  }
  return {
    state: blockers.length === 0 ? READY : ACTION_REQUIRED,
    requiredPermissions: permissions,
    ...(pageTask ? { pageTask } : {}),
    reason: blockers.length === 0
      ? `${label} permissions and Page access are verified`
      : `${label} held: ${blockers.join('; ')}`,
    ...(eligibilityNote ? { eligibilityNote } : {}),
  };
}

export function buildInstagramCapabilityReadiness(probe, publishVerdict) {
  const source = {
    permissionStatuses: probe?.permissionStatuses || {},
    pageTaskStatuses: probe?.pageTaskStatuses || {},
    pageLinkStatus: probe?.pageLinkStatus || 'unavailable',
    publisherTokenStatus: probe?.publisherTokenStatus || 'unavailable',
    publisherTokenSourceStatus: probe?.publisherTokenSourceStatus || 'unavailable',
  };
  return {
    feedAndReels: {
      state: publishVerdict?.state || ACTION_REQUIRED,
      reason: publishVerdict?.reason || 'Instagram publishing readiness is unavailable',
      requiredPermissions: ['instagram_basic', 'instagram_content_publish'],
      pageTask: 'createContent',
    },
    insights: capabilityReadiness(source, {
      permissions: ['instagram_basic', 'instagram_manage_insights'],
      pageTask: 'analyze',
      label: 'Instagram Insights',
    }),
    comments: capabilityReadiness(source, {
      permissions: ['instagram_basic', 'instagram_manage_comments'],
      pageTask: 'moderate',
      label: 'Instagram comment management',
    }),
    directMessages: capabilityReadiness(source, {
      permissions: ['instagram_basic', 'instagram_manage_messages', 'pages_manage_metadata'],
      pageTask: 'messaging',
      label: 'Instagram messaging',
    }),
    stories: capabilityReadiness(source, {
      permissions: ['instagram_basic', 'instagram_content_publish'],
      pageTask: 'createContent',
      label: 'Instagram Stories publishing',
      eligibilityNote: 'Meta restricts API Story publishing to Business accounts; verify account eligibility on the first accepted Story publish.',
    }),
  };
}

const OPTIONAL_INSTAGRAM_CAPABILITIES = Object.freeze([
  ['insights', 'insights'],
  ['comments', 'comments'],
  ['directMessages', 'direct_messages'],
]);

/**
 * Watch optional Meta grants only after shared account identity is verified.
 * The general Instagram setup alert owns missing Page/token/basic access; these
 * outputs own the separate Insights, comments, and messaging permissions.
 */
export function buildInstagramCapabilityMonitorOutputs(capabilities, probe) {
  const identityVerified = probe?.pageLinkStatus === 'matched'
    && probe?.publisherTokenStatus === 'matched'
    && probe?.publisherTokenSourceStatus === 'matched'
    && probe?.permissionStatuses?.instagram_basic === 'granted';
  const ready = [];
  const actionRequired = [];
  const reasons = {};

  for (const [key, outputName] of OPTIONAL_INSTAGRAM_CAPABILITIES) {
    const capability = capabilities?.[key];
    if (!capability) continue;
    reasons[outputName] = capability.reason || `${key} readiness is unavailable`;
    if (!identityVerified) continue;
    if (capability.state === READY) ready.push(outputName);
    else actionRequired.push(outputName);
  }

  return { actionRequired, ready, reasons };
}

/** Run the same read-only Meta checks for the monitor and the live publishers. */
export async function checkInstagramPublishReadiness({ env = process.env, fetchImpl = fetch } = {}) {
  const [pageLink, permissions, publisherToken] = await Promise.all([
    probeInstagramPageLink({
      pageId: env.FB_PAGE_ID,
      userAccessToken: env.FB_USER_ACCESS_TOKEN,
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      publisherAccessToken: env.INSTAGRAM_ACCESS_TOKEN,
      fetchImpl,
    }),
    probeInstagramPermissions({ userAccessToken: env.FB_USER_ACCESS_TOKEN, fetchImpl }),
    probeInstagramPublisherToken({
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      fetchImpl,
    }),
  ]);
  const probe = { ...pageLink, ...permissions, ...publisherToken };
  probe.note = [pageLink.note, permissions.note, publisherToken.note].filter(Boolean).join('; ');
  const verdict = classifyInstagram({ env, probe });
  return { verdict, probe, capabilities: buildInstagramCapabilityReadiness(probe, verdict) };
}

/** Fail closed at the publishing boundary; credentials alone do not prove a grant. */
export async function assertInstagramPublishReady(options = {}) {
  const { verdict, probe } = await checkInstagramPublishReadiness(options);
  if (verdict.state !== READY) {
    const error = new Error(`Instagram publishing blocked (${verdict.state}): ${verdict.reason}`);
    error.code = 'SOCIAL_PUBLISH_READINESS_REQUIRED';
    error.readiness = { state: verdict.state, note: probe.note };
    throw error;
  }
  return verdict;
}
