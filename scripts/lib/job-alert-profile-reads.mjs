/** Build the per-run Firestore profile references used by send-job-alerts. */
export function buildJobAlertProfileRefs(db, emails, { includeAuxiliary = false } = {}) {
  const uniqueEmails = [...new Set((emails || [])
    .map((email) => String(email || '').toLowerCase())
    .filter(Boolean))];
  return uniqueEmails.flatMap((email) => {
    if (includeAuxiliary) {
      return [
        db.collection('newsletter_subscribers').doc(email).collection('private').doc('personalization'),
        db.collection('job_alert_subscribers').doc(email).collection('delivery_state').doc('first_discovery'),
      ];
    }
    return [
      db.collection('newsletter_subscribers').doc(email),
      db.collection('job_alert_subscribers').doc(email),
    ];
  });
}
