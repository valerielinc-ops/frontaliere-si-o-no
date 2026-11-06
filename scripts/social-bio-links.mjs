#!/usr/bin/env node

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  SOCIAL_BIO_LINK_CHANNELS,
  socialBioUrl,
} from './lib/social-redirect-links.mjs';

export function buildSocialBioLinks(locale = 'it') {
  return Object.fromEntries(
    SOCIAL_BIO_LINK_CHANNELS.map((channel) => [channel, socialBioUrl(channel, locale)]),
  );
}

export function main(argv = process.argv.slice(2)) {
  const locale = argv[0] || 'it';
  if (!['it', 'en', 'de', 'fr'].includes(locale)) {
    throw new Error('Usage: node scripts/social-bio-links.mjs [it|en|de|fr]');
  }
  process.stdout.write(`${JSON.stringify(buildSocialBioLinks(locale), null, 2)}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}
