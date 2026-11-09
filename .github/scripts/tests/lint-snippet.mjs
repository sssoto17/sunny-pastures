// Lints a snippet of code with the repo's eslint.config.mjs, as if it were the file at `filePath`
// (#81, #125). The snippets don't exist on disk, so no tsconfig holds them: typed linting is off
// here, which the rules under test don't need (they read syntax, not types). A parse error is
// thrown, never returned as "no findings", so a snippet ESLint can't read can't pass as clean.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

export const root = fileURLToPath(new URL('../../..', import.meta.url));

const eslint = new ESLint({
  cwd: root,
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false } } },
  ],
});

/** The findings of `rules` for `code` linted as the file at `filePath`, as "line rule". */
export const lintSnippet = async (code, filePath, rules) => {
  const [result] = await eslint.lintText(code, { filePath });
  const fatal = result.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`ESLint could not lint ${filePath}: ${fatal.message}`);
  return result.messages.filter((m) => rules.has(m.ruleId)).map((m) => `${m.line} ${m.ruleId}`);
};
