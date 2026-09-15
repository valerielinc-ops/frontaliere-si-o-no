export const ONETAP_PROMPTED_KEY = 'onetap_prompted';
export const ONETAP_PENDING_KEY = 'onetap_pending';

export interface OneTapPromptStorage {
 getItem: (key: string) => string | null;
 setItem: (key: string, value: string) => void;
 removeItem: (key: string) => void;
}

/** Claim a One Tap prompt once, including when deferred callbacks race. */
export function claimOneTapPrompt(storage: OneTapPromptStorage): boolean {
 try {
 if (storage.getItem(ONETAP_PROMPTED_KEY)) return false;
 storage.setItem(ONETAP_PROMPTED_KEY, '1');
 storage.removeItem(ONETAP_PENDING_KEY);
 return true;
 } catch {
 // A blocked sessionStorage should not break the app or repeatedly prompt.
 return false;
 }
}
