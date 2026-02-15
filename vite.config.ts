import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        VitePWA({
          registerType: 'prompt',
          includeAssets: ['favicon.svg', 'robots.txt', 'icons/icon-192x192.png', 'icons/icon-512x512.png'],
          manifest: {
            name: 'Frontaliere Si o No? — Simulatore Fiscale',
            short_name: 'Frontaliere',
            description: 'Simulatore fiscale per frontalieri Svizzera-Italia. Calcola tasse, pensione, cambio valuta e confronta servizi.',
            theme_color: '#4f46e5',
            background_color: '#f8fafc',
            display: 'standalone',
            scope: '/',
            start_url: '/',
            lang: 'it',
            categories: ['finance', 'utilities'],
            icons: [
              {
                src: '/icons/icon-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              },
              {
                src: '/icons/icon-512x512.png',
                sizes: '512x512',
                type: 'image/png',
              },
              {
                src: '/icons/icon-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
            ],
          },
          workbox: {
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
            clientsClaim: true,
            skipWaiting: false,
            runtimeCaching: [
              {
                urlPattern: /^https:\/\/api\.frankfurter\.app\/.*/i,
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'exchange-rates-cache',
                  expiration: {
                    maxEntries: 50,
                    maxAgeSeconds: 60 * 60, // 1 hour
                  },
                },
              },
              {
                urlPattern: /^https:\/\/cdnjs\.cloudflare\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'cdn-assets',
                  expiration: {
                    maxEntries: 30,
                    maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                  },
                },
              },
              {
                urlPattern: /^https:\/\/unpkg\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'unpkg-assets',
                  expiration: {
                    maxEntries: 30,
                    maxAgeSeconds: 60 * 60 * 24 * 30,
                  },
                },
              },
            ],
          },
        }),
      ],
      define: {
        // No secrets injected at build time — all sensitive keys come from Firebase Remote Config at runtime
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        sourcemap: true,
        modulePreload: {
          // Prevent eager preloading of lazy vendor chunks (charts, pdf, etc.)
          resolveDependencies: (filename, deps, { hostId, hostType }) => {
            // Only preload deps for the entry point, not for lazy chunks
            // Filter out vendor chunks that should only load on demand
            return deps.filter(dep => 
              !dep.includes('vendor-charts') && 
              !dep.includes('vendor-pdf') &&
              !dep.includes('vendor-maps') &&
              !dep.includes('vendor-firebase')
            );
          },
        },
        rollupOptions: {
          output: {
            manualChunks: {
              'vendor-firebase': ['firebase/app', 'firebase/analytics', 'firebase/firestore', 'firebase/remote-config', 'firebase/app-check', 'firebase/auth'],
              'vendor-charts': ['recharts'],
              'vendor-maps': ['leaflet', 'react-leaflet'],
              'vendor-pdf': ['jspdf', 'jspdf-autotable'],
            },
          },
        },
      },
    };
});