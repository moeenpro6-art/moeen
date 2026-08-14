// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Raw require() calls and TS import-equals (import x = require(...)) are
      // forbidden by default. The only legitimate import-equals usage is in
      // Jest 30 setupFiles that must expose a CommonJS callable; that is
      // allowed via a per-file override below. Do not add a global
      // allowAsImport option here.
      '@typescript-eslint/no-require-imports': 'error',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // Q0-SEC Area 3: narrow the import-equals exception to the exact test files
  // that legitimately reference the CommonJS setup-file callable.
  {
    files: ['src/test-db.guard.spec.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': [
        'error',
        { allowAsImport: true },
      ],
    },
  },
);
