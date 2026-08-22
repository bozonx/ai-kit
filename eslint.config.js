import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import jest from 'eslint-plugin-jest';

export default [
    // Ignore patterns
    {
        ignores: ['dist/', 'node_modules/', 'coverage/', '.eslintrc.cjs'],
    },

    // Base ESLint recommended rules
    eslint.configs.recommended,

    // TypeScript files configuration
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: ['./tsconfig.eslint.json', './tsconfig.json'],
                tsconfigRootDir: import.meta.dirname,
                sourceType: 'module',
                ecmaVersion: 2022,
            },
            globals: {
                // Node.js globals
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                global: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                // ES2022 globals
                Promise: 'readonly',
                Symbol: 'readonly',
                WeakMap: 'readonly',
                WeakSet: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
                Proxy: 'readonly',
                Reflect: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
            prettier,
            jest,
        },
        rules: {
            // Prettier integration
            'prettier/prettier': 'error',

            // TypeScript specific rules
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/prefer-optional-chain': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/prefer-as-const': 'error',
            '@typescript-eslint/no-non-null-assertion': 'warn',
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
            '@typescript-eslint/consistent-type-exports': 'error',
            '@typescript-eslint/no-import-type-side-effects': 'error',

            // NestJS specific rules
            '@typescript-eslint/explicit-member-accessibility': [
                'error',
                {
                    accessibility: 'explicit',
                    overrides: {
                        accessors: 'explicit',
                        constructors: 'no-public',
                        methods: 'explicit',
                        properties: 'explicit',
                        parameterProperties: 'explicit',
                    },
                },
            ],

            // Jest specific rules
            'jest/no-disabled-tests': 'off',
            'jest/no-focused-tests': 'error',
            'jest/no-identical-title': 'error',
            'jest/prefer-to-have-length': 'warn',
            'jest/valid-expect': 'error',
            'jest/expect-expect': 'error',
            'jest/no-done-callback': 'error',
            'jest/valid-describe-callback': 'error',

            // General rules
            'no-unused-vars': 'off', // Disabled in favor of @typescript-eslint/no-unused-vars
            'no-console': 'warn',
            'no-debugger': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },

    // Test files override
    {
        files: ['**/*.spec.ts', '**/*.test.ts', 'test/**/*.ts'],
        languageOptions: {
            globals: {
                // Jest globals
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                afterEach: 'readonly',
            },
        },
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-member-accessibility': 'off',
            'no-console': 'off',
        },
    },

    // Prettier config (must be last to override other configs)
    prettierConfig,
];
