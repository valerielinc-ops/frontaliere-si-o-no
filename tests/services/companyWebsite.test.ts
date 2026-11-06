import { describe, expect, it } from 'vitest';
import { companyWebsiteDomain } from '@/services/companyWebsite';

describe('companyWebsiteDomain', () => {
 it('normalizes valid company URLs and fails safe for malformed values', () => {
  expect(companyWebsiteDomain('https://www.example.com/jobs')).toBe('example.com');
  expect(companyWebsiteDomain('https://careers.example.com')).toBe('careers.example.com');
  expect(companyWebsiteDomain('not a URL')).toBe('');
  expect(companyWebsiteDomain('')).toBe('');
  expect(companyWebsiteDomain(undefined)).toBe('');
 });
});
