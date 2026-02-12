/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REACT_APP_PAT: string;
  readonly VITE_GEMINI_API_KEY: string;
  readonly VITE_GA_MEASUREMENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}