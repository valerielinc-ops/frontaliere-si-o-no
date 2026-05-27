/// <reference types="vite/client" />

/** Build timestamp injected by Vite define — used to detect stale caches. */
declare const __BUILD_ID__: string;
/** Full commit hash injected by Vite define — used for versioning and debugging. */
declare const __COMMIT_HASH__: string;
/** Short commit hash injected by Vite define — used for version badge in UI. */
declare const __SHORT_COMMIT_HASH__: string;

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
