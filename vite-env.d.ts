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

 // Public Telegram broadcast channel URL (e.g. https://t.me/frontaliereticino).
 // Empty until the owner creates the channel — consumers gate on it.
 readonly VITE_TELEGRAM_CHANNEL_URL?: string;
}

interface ImportMeta {
 readonly env: ImportMetaEnv;
}

// `blog-<id> → shard ordinal` map, generated at build time by
// build-plugins/seoBlogShardIndexPlugin.ts and dynamically imported by
// services/seoService.ts so one article page fetches one seo-blog shard instead of
// all eight. Under Vitest the build plugins are absent, so vitest.config.ts aliases
// this specifier to tests/stubs/seo-blog-shard-index.ts (an empty map → load-all
// fallback).
declare module 'virtual:seo-blog-shard-index' {
 const shardIndex: Record<string, number>;
 export default shardIndex;
}
