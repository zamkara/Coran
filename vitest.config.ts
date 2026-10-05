import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-08-15',
      durableObjects: {
        GUARD: { className: 'Guard', useSQLite: true },
        DESTINATION: { className: 'Destination', useSQLite: true },
      },
      bindings: {
        RELEASE_INGRESS: 'test-secret', INTEGRATION_INGRESS: 'test-secret', DEPLOY_INGRESS: 'test-secret',
        RELEASE_EGRESS: 'https://discord.test/webhook',
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'] },
});
