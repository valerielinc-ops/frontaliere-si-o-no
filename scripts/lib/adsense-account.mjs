import { AD_CLIENT } from '../../services/adsenseSlots.ts';

const PUBLISHER_CLIENT_PATTERN = /^ca-(pub-\d+)$/;

/**
 * Resolve this site's AdSense publisher client to its API account resource.
 * @param {unknown} client
 */
export function resolveAdSenseAccount(client = AD_CLIENT) {
  const publisherId = typeof client === 'string' ? PUBLISHER_CLIENT_PATTERN.exec(client)?.[1] : null;
  if (!publisherId) throw new Error('AD_CLIENT does not identify an AdSense publisher account');
  return `accounts/${publisherId}`;
}
