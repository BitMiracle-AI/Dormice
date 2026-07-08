import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/setup/daemon.ts',
    // e2e runs on real wall-clock time (second-scale lifecycle policies),
    // so tests legitimately take a few seconds each.
    testTimeout: 15_000,
  },
});
