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
        SRC_MY_GITLAB: 'test-secret', SRC_MY_GITHUB: 'test-secret', SRC_MY_SERVER: 'test-secret',
        DEST_DEPLOYS: 'https://discord.test/webhook',
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'] },
});
