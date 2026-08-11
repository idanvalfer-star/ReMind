import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      /**
       * `injectManifest`, not `generateSW`: our service worker has to open Dexie,
       * look a trigger up by its opaque id and compose the notification text
       * on-device (see PRIVACY.md). That is hand-written TypeScript, so Workbox
       * only gets to inject the precache manifest into it.
       */
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
      // The user decides when to take an update; a silent reload can eat an
      // in-progress capture.
      registerType: 'prompt',
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'ReMind',
        short_name: 'ReMind',
        description: 'A proactive personal memory assistant.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1E1B4B',
        theme_color: '#1E1B4B',
        // `dir` and `lang` are deliberately omitted: both default to `auto` per the
        // manifest spec, which is what we want — pinning either one would mislabel
        // the UI for whichever of English/Hebrew the user did not pick.
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    // Engine and parser only — no UI tests, so no jsdom.
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // The Worker's crypto is deliberately written against plain WebCrypto with no
    // workerd-specific globals, so it runs — and is tested — under node unchanged.
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
