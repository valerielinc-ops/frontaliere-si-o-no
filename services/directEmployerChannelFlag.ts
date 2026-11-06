import { fetchAndActivate, getConfigValue } from './firebase';
import { DIRECT_EMPLOYER_CHANNEL_FLAG } from './directEmployerFeature';

/**
 * Read the public channel flag after attempting activation.
 *
 * Firebase Remote Config can return false when activation found no newer
 * values, while the active cached value is still enabled. The activation
 * result is therefore not the feature flag; only an exception or the value
 * itself can decide the gate.
 */
export async function readDirectEmployerChannelEnabled(): Promise<boolean> {
 try {
  await fetchAndActivate();
  return (await getConfigValue(DIRECT_EMPLOYER_CHANNEL_FLAG)).trim().toLowerCase() === 'true';
 } catch {
  return false;
 }
}
