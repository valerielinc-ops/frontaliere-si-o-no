import { describe, it, expect } from 'vitest';
import { subscriberFromFirestoreRow } from '../scripts/lib/subscriberFromFirestoreRow.mjs';

describe('subscriberFromFirestoreRow — acquisition-surface projection (#4299)', () => {
  it('projects source_route_family / source_component onto camelCase fields', () => {
    const row = {
      email: 'user@example.com',
      source_route_family: 'jobs_search',
      source_component: 'JobBoard',
    };
    const subscriber = subscriberFromFirestoreRow(row);
    expect(subscriber.sourceRouteFamily).toBe('jobs_search');
    expect(subscriber.sourceComponent).toBe('JobBoard');
  });

  it('defaults both fields to null when absent from the row', () => {
    const subscriber = subscriberFromFirestoreRow({ email: 'user@example.com' });
    expect(subscriber.sourceRouteFamily).toBeNull();
    expect(subscriber.sourceComponent).toBeNull();
  });

  it('returns null for a row with no usable email', () => {
    expect(subscriberFromFirestoreRow({ source_route_family: 'jobs_search' })).toBeNull();
  });
});
