/// <reference types="vite/client" />

// Build id / commit hash are NOT injected via Vite `define` — that baked a fresh
// value into the bundle every build → new entry content hash → ~100% deploy
// churn. They are emitted as /build-id.txt + /commit-hash.txt and read at runtime.

interface ImportMetaEnv {
 readonly MODE: string;
 readonly DEV: boolean;
 readonly PROD: boolean;

 readonly VITE_FIREBASE_API_KEY?: string;
 readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
 readonly VITE_FIREBASE_PROJECT_ID?: string;
 readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
 readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
 readonly VITE_FIREBASE_APP_ID?: string;
 readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
}

interface ImportMeta {
 readonly env: ImportMetaEnv;
}
