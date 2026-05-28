// Flat config (ESLint v9+ standard). See https://eslint.org/docs/latest/use/configure/configuration-files-new
//
// Scope (N-25 first slice):
//   - @eslint/js recommended
//   - typescript-eslint recommended (non-type-checked — fast, lower-noise)
//   - eslint-config-prettier (last; disables stylistic rules that fight Prettier)
//
// Out of scope for this slice (follow-ups):
//   - eslint-plugin-react-hooks (would surface real rules-of-hooks issues in app/*)
//   - eslint-plugin-react full preset (JSX rules, refresh, propTypes)
//   - typescript-eslint recommended-type-checked (needs project parserOptions; slower)
//   - import/no-cycle and import-order rules

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier/flat';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      // Vendored xlsx fork — explicitly do-not-touch (CLAUDE.md / brief).
      'packages/importers/vendor/**',
      // Test fixtures (byte-sensitive engine-output snapshots).
      '**/__fixtures__/**',
      // Bundled JSON data, not source.
      'packages/app/public/**',
      'packages/file-format/src/fx-snapshots/**',
      // Workspace-managed files.
      'pnpm-lock.yaml',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Engines pass time/randomness as parameters; no Date.now/Math.random in
      // computation. TS doesn't catch this — leave to review for now.
      // Add explicit no-restricted-syntax rules in a follow-up if useful.

      // The codebase uses _-prefixed unused vars deliberately in destructure /
      // overload signatures. Mirror the convention in the rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files: looser rules around any/empty types/non-null assertions.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/bench/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Prettier must come last to disable conflicting stylistic rules.
  prettierConfig,
);
