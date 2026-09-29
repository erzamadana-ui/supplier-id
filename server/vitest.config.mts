import { defineConfig } from 'vitest/config';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/supplier_id_test';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    include: ['tests/**/*.test.ts'],
    // seluruh test memakai database uji terpisah — TIDAK menyentuh database dev/produksi
    env: { DATABASE_URL: TEST_DB, TEST_DATABASE_URL: TEST_DB, UPLOAD_DIR: '/tmp/supplier-id-test-uploads', JWT_SECRET: 'test-secret' },
  },
});
