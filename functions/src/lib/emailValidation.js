/**
 * emailValidation.js — single source of truth for the pragmatic, server-side
 * email shape check reused across functions/ (adminEmployerInsights.js,
 * journalistRoleCore.js, newsletterSubscriberAuthSync.js,
 * stripePublisherCore.js each declared an identical `EMAIL_RE` literal —
 * consolidated here per AGENTS.md's sibling-pattern rule so the construct
 * can't drift between call sites). Not a full RFC 5322 validator — good
 * enough to catch obviously-malformed input server-side (the client also
 * validates).
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
