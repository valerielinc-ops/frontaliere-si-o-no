import { describe, expect, it } from 'vitest';

import {
  businessSuitePageState,
  extractLatestMessage,
  parseBusinessSuiteThreadRef,
} from '../scripts/lib/instagram-community-browser.mjs';

describe('Instagram Business Suite browser adapter', () => {
  it('accepts only a stable visible Inbox thread id', () => {
    const ref = parseBusinessSuiteThreadRef({
      href: '/latest/inbox/instagram_direct?selected_item_id=123456789',
      label: 'Instagram thread',
      surface: 'direct',
    });
    expect(ref).toMatchObject({ id: '123456789', surface: 'direct' });
    expect(parseBusinessSuiteThreadRef({ href: '/latest/inbox/instagram_direct', surface: 'direct' })).toBeNull();
  });

  it('fails closed on login and keeps navigation labels out of a reply candidate', () => {
    expect(businessSuitePageState(
      'https://business.facebook.com/login',
      'Accedi',
    )).toBe('login-required');
    expect(businessSuitePageState(
      'https://business.facebook.com/latest/inbox/instagram',
      'Inbox Instagram comments',
    )).toBe('ready');
    expect(extractLatestMessage(['Inbox', 'Instagram comments', 'Search', 'Mi mandi il link?'])).toBe('Mi mandi il link?');
  });
});
