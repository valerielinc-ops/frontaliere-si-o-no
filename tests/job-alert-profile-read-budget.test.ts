import { describe, expect, it } from 'vitest';
import { buildJobAlertProfileRefs } from '../scripts/lib/job-alert-profile-reads.mjs';

function fixtureDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`;
          return {
            path,
            collection(subcollection: string) {
              return {
                doc(child: string) {
                  return { path: `${path}/${subcollection}/${child}` };
                },
              };
            },
          };
        },
      };
    },
  } as any;
}

describe('job-alert per-run profile read budget', () => {
  it('reads two common profiles per candidate and two auxiliary profiles only per due recipient', () => {
    const db = fixtureDb();
    const candidateEmails = ['A@example.com', 'b@example.com', 'a@example.com', 'c@example.com', 'd@example.com'];
    const dueEmails = ['a@example.com', 'a@example.com', 'c@example.com'];

    const commonRefs = buildJobAlertProfileRefs(db, candidateEmails);
    const auxiliaryRefs = buildJobAlertProfileRefs(db, dueEmails, { includeAuxiliary: true });

    expect(commonRefs).toHaveLength(8);
    expect(auxiliaryRefs).toHaveLength(4);
    expect(commonRefs.length + auxiliaryRefs.length).toBe(12);
    expect(commonRefs.length + auxiliaryRefs.length).toBeLessThan(candidateEmails.length * 4);
    expect(auxiliaryRefs.map((ref: { path: string }) => ref.path)).toEqual([
      'newsletter_subscribers/a@example.com/private/personalization',
      'job_alert_subscribers/a@example.com/delivery_state/first_discovery',
      'newsletter_subscribers/c@example.com/private/personalization',
      'job_alert_subscribers/c@example.com/delivery_state/first_discovery',
    ]);
  });
});
