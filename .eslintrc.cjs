/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: false,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    // stdout is reserved for the MCP protocol channel — always log to stderr via pino.
    'no-console': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'templates/', '*.cjs', '*.js'],
  overrides: [
    {
      files: ['tests/**/*.ts', '**/*.test.ts'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // The CLI entry point may emit small startup messages via process.stderr.write,
      // but not via console. Keep `no-console` strict everywhere.
      files: ['src/index.ts'],
      rules: {},
    },
  ],
};
