Read @PR.md when scoping an issue, planning a task, or starting a new implementation.

# Worker types on Dependabot pull requests

A Wrangler update can change the Workers runtime that `apps/worker/worker-configuration.d.ts` was generated from, and then the Quality workflow fails with "Types at worker-configuration.d.ts are out of date". On Dependabot pull requests, the Dependabot Worker types workflow (`.github/workflows/dependabot-worker-types.yml`) regenerates the file and commits it to the pull request's branch. When the types have not changed, it commits nothing. Its commit starts the pull request's next Quality run in an "approval required" state, so someone with write access has to approve that run once.

If the workflow fails, regenerate the types by hand. Check out the pull request's branch, run `vp install` and `vp run @haystack/worker#types`, and check the result with `vp run @haystack/worker#types:check`. Then commit `apps/worker/worker-configuration.d.ts` to that branch with `[dependabot skip]` in the commit message, so that Dependabot can still rebase the pull request. The "Dependency updates" section of `plans/haystack-v1-implementation-plan.md` explains how the workflow works.

# The @mswjs/interceptors patch on msw updates

Haystack patches @mswjs/interceptors 0.45.9 because an idle connection that MSW passes through to the real network can fail the mocked request sent on it next (#148, upstream in [mswjs/interceptors#881](https://github.com/mswjs/interceptors/issues/881)). msw 3.0.3 accepts `^0.45.6`, and 0.45.9 is the version the lockfile resolves. The patch is in `patches/`, and its `patchedDependencies` entry in `pnpm-workspace.yaml` is keyed to that exact version.

When the lockfile would resolve another version, whether from an msw update or from `vp update`, `vp install` fails, because pnpm's default `allowUnusedPatches: false` rejects a patch that matches no installed package:

```text
Error: ERR_PNPM_UNUSED_PATCH
  × installing dependencies
  ╰─▶ The following patches were not used: @mswjs/interceptors@0.45.9
```

That failure is what makes someone decide about the patch, so don't set `allowUnusedPatches` to `true` to get past it. An msw update that still resolves 0.45.9 needs nothing. A fix released within msw's range, such as a 0.45.10, isn't picked up on its own, because Dependabot doesn't propose updates to dependencies of dependencies, so check #881 now and then, and add a `remove-when` field to the `WORKAROUND(@mswjs/interceptors)` marker once the fixed release is known.

**Dependabot most likely opens no pull request for such an update.** It updates the lockfile with pnpm itself, which fails with the same error, and its pnpm error handling has no case for it (`pnpm_lockfile_updater.rb` in dependabot-core). If msw updates stop arriving, look for the error in the repository's Dependabot logs (Insights, then Dependency graph, then Dependabot). Then make the update on a branch of your own: change msw's version in `apps/worker/package.json`, run `vp install` to see the error above, and follow the steps below. If Dependabot did open a pull request, do the same on its branch, and commit with `[dependabot skip]` in the message, as for the Worker types above.

1. **Check whether the new version fixes the bug.** Read mswjs/interceptors#881 and the [@mswjs/interceptors releases](https://github.com/mswjs/interceptors/releases), then run the standalone reproduction, [schalkneethling/msw-idle-passthrough-repro](https://github.com/schalkneethling/msw-idle-passthrough-repro), against the new versions: change `msw` and the `@mswjs/interceptors` override in its `package.json` to the versions in the update, then run `npm install` and `node repro.mjs`. Without a fix, request 3 fails with `ENOTFOUND`. With one, it gets a 200.
2. **Either way, remove the patch first.** Delete `patches/@mswjs__interceptors@0.45.9.patch` and the whole `patchedDependencies` block in `pnpm-workspace.yaml`, with its comment and marker. Then run `vp install`, which now installs the new version and updates `pnpm-lock.yaml`. If the new version fixes the bug, that's all: run `vp check` and `vp test`.
3. **If it doesn't fix the bug, patch the new version.** The patch can't be moved before the new version is installed: `vp pm patch` reads the installed versions, and `vp pm patch-commit` adds its entry next to any old one and then installs, which fails on the old one.
   1. Run `vp pm patch @mswjs/interceptors@<new version>`, always with the version, because without one pnpm records an entry that applies to every future version. It prints a directory with a clean copy of the package, and a `pnpm patch-commit` command, which is the same as `vp pm patch-commit`.
   2. Make the change from the old patch by hand in that directory. If step 2 isn't committed yet, `git show HEAD:patches/@mswjs__interceptors@0.45.9.patch` prints it; otherwise, use the last commit that still has it. The file it changes is `lib/node/net-<hash>.js`, and the hash changes with each build.
   3. Run `vp pm patch-commit <that directory>`. It writes the patch file, the `patchedDependencies` entry and the lockfile's hash for the patch.
   4. Put the comment and the marker back above the new entry, from `pnpm-workspace.yaml` in the same commit as the old patch, then run `vp check` and `vp test`.
   5. Check that the patch still fixes the failure. The failure needs lookups of `.test` hosts to fail about 100 ms after they start, as they do on GitHub's Ubuntu runners, while macOS takes 30 s. A module preloaded with `NODE_OPTIONS="--import <absolute path to the module>"` can replace `dns.lookup` so that lookups of names ending in `.test` fail with `ENOTFOUND` after a set delay, as `repro.mjs` does. With delays of 105, 115 and 125 ms, `vp test run apps/worker/test/anthropic-provider.test.ts` should pass in every run with the patch, and fail without it. Don't commit the module.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

<!-- calavera-agent-bootstrap:start -->

# Calavera Agent Guidance

- Use Calavera when the user wants to inspect, compose, preview, apply, or update project tooling.
- Verify the Calavera MCP tools are available before composing a recipe.
- Prefer the Calavera MCP server over hand-authoring `calavera.config.json`.
- If the Calavera MCP tools are not available, stop and help the user register the MCP server from `.agents/calavera/mcp.md`, then reload the agent session if the MCP host requires it.
- Do not inspect npm cache internals or import Calavera source files from a package cache as a substitute for MCP setup.
- Inspect existing project tooling before composing a recipe and raise likely config conflicts early.
- If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use `dry_run_apply` to show concrete impact when adoption still looks possible.
- Start with `inspect_project`, `list_profiles`, `list_integrations`, and `list_ai_artifacts`; use `describe_integration` when the user asks for more information or an option needs explanation.
- Compose recipes with `compose_recipe`, validate them with `validate_recipe`, and explain the selected integrations with `explain_recipe`.
- Always present `dry_run_apply` output to the user before changing files.
- Call `apply_recipe` only after the user explicitly approves the dry-run result.
- If the MCP transport closes or reports `-32000` during or immediately after `apply_recipe`, treat the outcome as unknown instead of failed. Inspect `calavera.config.json`, `.calavera/state.json`, generated files, and package metadata before retrying the apply.
- Treat files listed by `dry_run_apply` as Calavera-managed outputs. Do not hand-write or edit them; let `apply_recipe` or `create-project-calavera apply` create them after approval.
- Use AskUserTool or the agent client's equivalent when available for profile choices, conflict decisions, and apply approval.

MCP setup notes live in `.agents/calavera/mcp.md`.
<!-- calavera-agent-bootstrap:end -->
