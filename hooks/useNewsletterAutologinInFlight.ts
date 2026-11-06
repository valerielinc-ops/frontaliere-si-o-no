import { useEffect, useState } from 'react';
import { isNewsletterAutologinInFlight, subscribeNewsletterAutologin } from '@/services/newsletterAutologinSignal';

/**
 * Reactive view of the newsletter autologin in-flight signal.
 *
 * Returns `true` while a newsletter autologin code is being exchanged for a
 * Firebase session, then flips to `false` once it settles (success or failure).
 * Components use this to suppress sign-in affordances (Google One Tap, the
 * job/chatbot auth gate) during the brief window so a newsletter visitor sees
 * the linked content immediately instead of a redundant sign-in prompt.
 */
export function useNewsletterAutologinInFlight(): boolean {
 const [inFlight, setInFlight] = useState(isNewsletterAutologinInFlight);
 useEffect(() => {
 if (!isNewsletterAutologinInFlight()) {
 setInFlight(false);
 return;
 }
 return subscribeNewsletterAutologin(() => setInFlight(false));
 }, []);
 return inFlight;
}
