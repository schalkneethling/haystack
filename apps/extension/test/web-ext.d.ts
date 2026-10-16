// web-ext ships no types. This describes only what the lint test uses, as web-ext's lib/cmd/lint.js
// and addons-linter's run() define it: with `shouldExitProgram: false` the promise resolves with
// the linter's findings instead of the process exiting, and `output: "none"` keeps them from being
// printed.
declare module "web-ext" {
  interface LintMessage {
    code: string;
    message: string;
    description: string;
    file?: string;
  }

  interface LintResult {
    errors: LintMessage[];
    warnings: LintMessage[];
    notices: LintMessage[];
  }

  interface LintParams {
    sourceDir: string;
    artifactsDir: string;
    output: "none" | "text" | "json";
    ignoreFiles?: string[];
  }

  const webExt: {
    cmd: {
      lint(params: LintParams, options: { shouldExitProgram: boolean }): Promise<LintResult>;
    };
  };

  export default webExt;
}
