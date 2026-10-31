/** A current paid service mandate is policy authority, never a candidate qualification or Q/A. */
import { ASSISTED_APPLICATION_CONSENT_VERSIONS } from '../assistedApplicationConstants.js';
import { assistedApplicationRetained, timestampMillis } from './assistedApplicationRetentionPolicy.js';
const SCOPES = Object.freeze(['application_consent', 'optional_consent_refusal', 'individual_application_origin', 'operational_preference']);
export function applicationPolicyAuthority({ orderId, order = {}, flow = {}, nowMs = Date.now() } = {}) {
  if (!order || typeof order !== 'object' || !flow || typeof flow !== 'object') return null;
  const round = Number(flow.round); const consentedAt = timestampMillis(order.consentedAt);
  if (typeof orderId !== 'string' || !orderId || orderId.length > 200 || !Number.isInteger(round) || round < 1
    || order.paymentStatus !== 'paid' || ['pending', 'completed', 'succeeded', 'refunded'].includes(order.refundStatus) || order.refundedAt != null || order.withdrawnAt != null || flow.state === 'withdrawn'
    || !ASSISTED_APPLICATION_CONSENT_VERSIONS.includes(order.consentVersion)
    || !Number.isFinite(consentedAt) || consentedAt <= 0 || consentedAt > nowMs || !assistedApplicationRetained(order, nowMs)) return null;
  return Object.freeze({ version: 'server-application-policy-authority-v1', orderId, round,
    consentVersion: order.consentVersion, consentedAt, paid: true, scopes: SCOPES,
    operationalPreferencesVersion: 'operational-preferences-v1' });
}
