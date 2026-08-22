import type { Config } from 'jest';

// Common module file extensions
const moduleFileExtensions = ['ts', 'js', 'json'];

// Common transform configuration
const transform = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: 'tsconfig.spec.json',
      useESM: true,
    },
  ],
};

const config: Config = {
  extensionsToTreatAsEsm: ['.ts'],

  // Parallel test execution - use 50% of CPU cores locally, limit to 2 in CI
  maxWorkers: process.env.CI ? 2 : '50%',
  // Stop test execution on first failure in CI for faster feedback
  bail: process.env.CI ? 1 : 0,
  // Verbose output in CI for better debugging
  verbose: process.env.CI === 'true',

  projects: [
    // Unit tests configuration
    {
      displayName: 'unit',
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'node',
      moduleFileExtensions,
      rootDir: '.',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      testPathIgnorePatterns: ['<rootDir>/test/e2e/', '<rootDir>/dist/'],
      setupFilesAfterEnv: ['<rootDir>/test/setup/unit.setup.ts'],
      collectCoverageFrom: ['src/**/*.(t|j)s'],
      coverageDirectory: 'coverage',
      coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/test/', '.module.ts$', 'main.ts$'],
      transform,
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
      // Global timeout for unit tests (default: 5 seconds)
      testTimeout: 5000,
    },
    // E2E tests configuration
    {
      displayName: 'e2e',
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'node',
      moduleFileExtensions,
      rootDir: '.',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/setup/e2e.setup.ts'],
      collectCoverageFrom: ['src/**/*.(t|j)s'],
      coverageDirectory: 'coverage',
      coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/test/', '.module.ts$', 'main.ts$'],
      transform,
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
      setupFiles: ['<rootDir>/test/setup/env.setup.ts'],
      // Global timeout for e2e tests (default: 30 seconds)
      testTimeout: 30000,
    },
  ],
};

export default config;
