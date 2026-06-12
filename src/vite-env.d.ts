/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  // Fixed public production base for the phone/QR URL (e.g.
  // "https://steer-it.vercel.app"). Optional — falls back to the current
  // origin when unset so local dev still works.
  readonly VITE_PUBLIC_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
