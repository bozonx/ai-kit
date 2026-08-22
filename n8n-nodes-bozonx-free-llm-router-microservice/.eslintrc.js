module.exports = {
    env: {
        node: true,
        es2022: true,
    },
    globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        exports: 'readonly',
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    extends: ['plugin:n8n-nodes-base/community'],
    ignorePatterns: ['dist/**'],
    rules: {},
};
