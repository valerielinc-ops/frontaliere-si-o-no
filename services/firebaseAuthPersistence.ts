const ENCODED_FIREBASE_API_KEY = 'JztKDydNL0lRMwFyR3MKcyFaPABJPEF4I2lwFGxORhwwVgkHPyFT';
const FIREBASE_API_KEY_MASK = 'fr0nt4l13r3-t1c1n0';
const DEFAULT_FIREBASE_APP_NAME = '[DEFAULT]';

function decodeFirebaseApiKey(encoded: string, mask: string): string {
 const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
 let decoded = '';
 for (let i = 0; i < bytes.length; i++) {
 decoded += String.fromCharCode(bytes[i] ^ mask.charCodeAt(i % mask.length));
 }
 return decoded;
}

/** The same public API key used by services/firebase.ts initializeApp(). */
export const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY
 || decodeFirebaseApiKey(ENCODED_FIREBASE_API_KEY, FIREBASE_API_KEY_MASK);

/** Firebase Auth's browser persistence key for the default app. */
export function getFirebaseAuthPersistenceKey(): string {
 return `firebase:authUser:${FIREBASE_API_KEY}:${DEFAULT_FIREBASE_APP_NAME}`;
}
