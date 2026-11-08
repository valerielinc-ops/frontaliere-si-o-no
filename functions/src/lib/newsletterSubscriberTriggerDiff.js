const WELCOME_TRIGGER_FIELDS = Object.freeze([
 'confirmed_at',
 'confirmedAt',
 'welcome_sent_at',
]);

const NEWSLETTER_AUTH_TRIGGER_FIELDS = Object.freeze([
 'account_deleted_at',
 'status',
]);

const JOB_ALERT_BACKFILL_TRIGGER_FIELDS = Object.freeze([
 // Newsletter-record eligibility and saved-jobs-digest-anchor exclusion.
 'status',
 'isActive',
 'active',
 'confirmed',
 'preferences',
 'consent_given',
 'consentGiven',
 'consent_text',
 'consentText',
 'registration_terms_accepted',
 'registrationTermsAccepted',
 'unsubscribed_at',
 'unsubscribedAt',
 'resubscribed_at',
 'resubscribedAt',
 'all_email_opted_out',
 'all_emails_opted_out',
 'global_email_opt_out',
 'global_email_opted_out',
 'saved_jobs_digest_anchor',
 'created_at',
 'createdAt',
 'subscribed_at',
 'subscribedAt',
 'source_channel',
 'sourceChannel',
 'consent_basis',
 'consentBasis',
 'confirmed_at',
 'confirmedAt',
 // Flat signal tier, URL fallback, and account-deletion lifecycle.
 'job_category',
 'job_location',
 'sector_interest',
 'location_interest',
 'geo_city',
 'consent_source_url',
 'source_page',
 'account_deleted_at',
]);

function timestampMillis(value) {
 if (value instanceof Date) return value.getTime();
 if (typeof value?.toMillis === 'function') return value.toMillis();
 if (typeof value?.toDate === 'function') return value.toDate().getTime();
 return null;
}

function sameValue(left, right) {
 if (Object.is(left, right)) return true;
 if (left == null || right == null) return false;

 const leftTimestamp = timestampMillis(left);
 const rightTimestamp = timestampMillis(right);
 if (leftTimestamp !== null || rightTimestamp !== null) {
  return leftTimestamp !== null && leftTimestamp === rightTimestamp;
 }

 if (Array.isArray(left) || Array.isArray(right)) {
  return Array.isArray(left)
   && Array.isArray(right)
   && left.length === right.length
   && left.every((value, index) => sameValue(value, right[index]));
 }

 if (typeof left !== 'object' || typeof right !== 'object') return false;
 const leftKeys = Object.keys(left).sort();
 const rightKeys = Object.keys(right).sort();
 return leftKeys.length === rightKeys.length
  && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

/**
 * Compare only the fields used by a newsletter document trigger's eligibility
 * logic. Firestore snapshots deserialize maps separately, so nested values
 * (such as `preferences`) are compared by value rather than object identity.
 *
 * @param {object|null|undefined} before
 * @param {object|null|undefined} after
 * @param {string[]} fields
 * @returns {boolean}
 */
export function hasRelevantNewsletterSubscriberFieldChange(before, after, fields) {
 if (before == null || after == null) return before !== after;
 return fields.some((field) => !sameValue(before[field], after[field]));
}

export {
 WELCOME_TRIGGER_FIELDS,
 NEWSLETTER_AUTH_TRIGGER_FIELDS,
 JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
};
