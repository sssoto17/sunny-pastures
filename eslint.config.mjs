// The project's lint standard (CONSTRAINTS.md, "Lint"): 0 errors. Turning a rule off, or adding
// a path to `ignores`, is a moved threshold that the floor guard reports.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
};

export default defineConfig(
  {
    ignores: ['**/node_modules/', '**/coverage/', '**/dist/', '**/.next/', '.claude/', '.agents/'],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: nodeGlobals },
  },
);
