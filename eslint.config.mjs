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

// Sim purity (MUST-10.1, CONSTRAINTS.md purity row, #81). The sim's tsconfig already rejects
// fetch, timers, performance, crypto and node:* types; these rules catch what tsc can't. Fallow
// boundaries (#41, M3) add the import-escape and call checks.
const SIM_FILES = ['packages/sim/**'];
const SIM_TEST_FILES = ['packages/sim/**/*.test.ts'];

// Every import that isn't relative: bare packages, scoped packages and node:*.
const nonRelativeImport = (allowed, message) => ({
  patterns: [{ regex: `^(?!\\.\\.?(/|$)${allowed.map((name) => `|${name}$`).join('')})`, message }],
});

// D16 (ADR-0003, section 10): 32-bit operators truncate times above 2^31 ms (about 24.9 days).
// Lint sees a time only by its name: `time`, `at`, `to`, or a name ending in `Time` or `At`.
const TIME_NAME = '/^(time|at|to)$|(Time|At)$/';
const BITWISE = `:matches(BinaryExpression[operator=/^(\\||&|\\^|<<|>>>?)$/], AssignmentExpression[operator=/^(\\||&|\\^|<<|>>>?)=$/], UnaryExpression[operator='~'])`;

const SIM_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'new Date() reads the clock; time arrives as an argument (MUST-10.1).',
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: 'Date() reads the clock; time arrives as an argument (MUST-10.1).',
  },
  {
    selector: 'ImportExpression',
    message: 'No dynamic import: the sim imports only its own files, statically (MUST-10.1).',
  },
  {
    selector: `${BITWISE} > :matches(Identifier[name=${TIME_NAME}], MemberExpression[property.name=${TIME_NAME}])`,
    message: 'No 32-bit operators on times: they truncate above 2^31 ms (ADR-0003, section 10).',
  },
];

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
  {
    files: SIM_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        nonRelativeImport([], 'The sim imports only its own files (MUST-10.1): no packages, no node:*.'),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Time arrives as an argument (MUST-10.1).' },
        { object: 'Math', property: 'random', message: 'Randomness comes from a stream in the state (ADR-0003, section 7).' },
      ],
      'no-restricted-syntax': ['error', ...SIM_SYNTAX],
    },
  },
  {
    // Sim tests may import their test tools and nothing else outside the sim (admin, 9 Nov, #81).
    // Every other purity rule above still applies to them.
    files: SIM_TEST_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        nonRelativeImport(['vitest', 'fast-check'], 'Sim tests import only vitest, fast-check and sim files (#81).'),
      ],
      // A later block's options replace an earlier block's, so the sim selectors are repeated here.
      'no-restricted-syntax': [
        'error',
        ...SIM_SYNTAX,
        {
          // Without the settings, fast-check picks a random seed and its own run count (D10).
          selector: "CallExpression[callee.object.name='fc'][callee.property.name=/^(assert|check)$/][arguments.length<2]",
          message: "Pass the shared settings: fc.assert(property, inject('fastCheck')) (D10, ADR-0003 section 9).",
        },
      ],
    },
  },
);
