import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The daemon serves the built console under /console — assets must
  // resolve there.
  base: '/console/',
  plugins: [
    // Must come before react(): it generates routeTree.gen.ts from routes/.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // Dev mode: Vite owns /console, the daemon (fake executor is fine) owns
    // the API — same paths the browser uses in production, so no API base
    // knob.
    proxy: {
      '/console/auth': 'http://127.0.0.1:3676',
      '/console/envdToken': 'http://127.0.0.1:3676',
      '/listSandboxes': 'http://127.0.0.1:3676',
      '/releaseSandbox': 'http://127.0.0.1:3676',
      '/acquireSandbox': 'http://127.0.0.1:3676',
      '/rebuildSandbox': 'http://127.0.0.1:3676',
      '/setPolicy': 'http://127.0.0.1:3676',
      '/listTemplates': 'http://127.0.0.1:3676',
      '/registerTemplate': 'http://127.0.0.1:3676',
      '/removeTemplate': 'http://127.0.0.1:3676',
      '/getHostMetrics': 'http://127.0.0.1:3676',
      '/getSandboxMetrics': 'http://127.0.0.1:3676',
      '/listActivity': 'http://127.0.0.1:3676',
      '/getConfig': 'http://127.0.0.1:3676',
      '/getIngress': 'http://127.0.0.1:3676',
      '/setIngress': 'http://127.0.0.1:3676',
      // The terminal speaks the envd surface directly, like the e2b SDK.
      '/e2b': 'http://127.0.0.1:3676',
    },
  },
});
