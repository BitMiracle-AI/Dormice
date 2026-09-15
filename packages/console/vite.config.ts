import { fileURLToPath } from 'node:url';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
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
    // 编译式 i18n:messages/{locale}/*.json → src/paraglide(gitignore)。
    // strategy 链:用户显式切过(localStorage)→ 浏览器语言 → 中文兜底。
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // Dev mode: Vite owns /console, the gateway owns the API — the fleet's
    // one door (2026-09-14: configuration, keys, templates, the console's
    // sessions all answer there, the sandbox verbs are forwarded to the
    // node). Same paths the browser uses in production, so no API base
    // knob. Run a gateway on 3677 and a daemon (fake executor is fine)
    // checking in with it.
    proxy: Object.fromEntries(
      [
        '/console/auth',
        '/envdToken',
        '/listSandboxes',
        '/destroySandbox',
        '/acquireSandbox',
        '/rebuildSandbox',
        '/updatePolicy',
        '/updateMetadata',
        '/listTemplates',
        '/registerTemplate',
        '/removeTemplate',
        '/listApiKeys',
        '/createApiKey',
        '/revokeApiKey',
        '/updateApiKey',
        '/execCommand',
        '/writeFile',
        '/writeFiles',
        '/readFile',
        '/readFiles',
        '/getHostMetrics',
        '/getSandboxMetrics',
        '/getSandboxMetricsHistory',
        '/listSandboxMetrics',
        '/listSandboxImages',
        '/getFleetStateHistory',
        '/getFleetMetrics',
        '/getConfig',
        '/checkUpgrade',
        '/applyUpgrade',
        '/getUpgradeStatus',
        '/updateSettings',
        '/getIngress',
        '/setIngress',
        '/healthz',
        '/listNodes',
        '/removeNode',
        '/updateNodeSettings',
        // The terminal speaks the envd surface directly, like the e2b SDK.
        '/e2b',
      ].map((path) => [path, 'http://127.0.0.1:3677']),
    ),
  },
});
