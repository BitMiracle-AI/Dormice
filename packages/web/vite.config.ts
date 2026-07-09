import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The daemon serves the built console under /ui — assets must resolve there.
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  server: {
    // Dev mode: Vite owns /ui, the daemon (fake executor is fine) owns the
    // API — same paths the browser uses in production, so no API base knob.
    proxy: {
      '/ui/auth': 'http://127.0.0.1:3676',
      '/listSandboxes': 'http://127.0.0.1:3676',
      '/releaseSandbox': 'http://127.0.0.1:3676',
      '/acquireSandbox': 'http://127.0.0.1:3676',
    },
  },
});
