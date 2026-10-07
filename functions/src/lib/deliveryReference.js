/**
 * Shared post-delivery reference seam for senders that use the confirmation
 * cascade directly.
 *
 * The persistence implementation remains behind its provider-specific module;
 * callers use this neutral entry point so the Cloud Function and the follow-up
 * runner cannot drift apart.
 */

export { makeMailerooRefOnSent as makeDeliveryRefOnSent } from './mailerooRef.js';
