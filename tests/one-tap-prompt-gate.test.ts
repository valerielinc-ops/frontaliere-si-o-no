import { describe, expect, it } from 'vitest';
import {
 claimOneTapPrompt,
 ONETAP_PENDING_KEY,
 ONETAP_PROMPTED_KEY,
} from '@/services/oneTapPromptGate';

function makeStorage() {
 const values = new Map<string, string>();
 return {
 getItem: (key: string) => values.get(key) ?? null,
 setItem: (key: string, value: string) => { values.set(key, value); },
 removeItem: (key: string) => { values.delete(key); },
 };
}

describe('One Tap deferred replay gate', () => {
 it('claims a pending replay only once when callbacks race', () => {
 const storage = makeStorage();
 storage.setItem(ONETAP_PENDING_KEY, '1');

 const promptCalls = [claimOneTapPrompt(storage), claimOneTapPrompt(storage)]
 .filter(Boolean);

 expect(promptCalls).toHaveLength(1);
 expect(storage.getItem(ONETAP_PROMPTED_KEY)).toBe('1');
 expect(storage.getItem(ONETAP_PENDING_KEY)).toBeNull();
 });

 it('fails closed when sessionStorage is unavailable', () => {
 const storage = {
 getItem: () => { throw new Error('blocked'); },
 setItem: () => { throw new Error('blocked'); },
 removeItem: () => { throw new Error('blocked'); },
 };

 expect(claimOneTapPrompt(storage)).toBe(false);
 });
});
