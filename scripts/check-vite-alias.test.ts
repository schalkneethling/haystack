import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import { annotation, evaluateWorkspace, expectedAlias, main } from "./check-vite-alias.ts";

/** A pnpm-workspace.yaml laid out like the real one, with the catalog entries under test. */
const workspace = (vitePlus?: string, vite?: string) =>
  [
    "packages:",
    "  - apps/*",
    "catalog:",
    '  "@playwright/test": ^1.64.1',
    ...(vite === undefined ? [] : [`  vite: ${vite}`]),
    ...(vitePlus === undefined ? [] : [`  vite-plus: ${vitePlus}`]),
    "overrides:",
    '  vite@*: "catalog:"',
    "",
  ].join("\n");

const OLD = expectedAlias("1.1.0");
const NEW = expectedAlias("1.4.0");

describe("evaluateWorkspace", () => {
  it("passes when the vite alias names the vite-plus version", () => {
    expect(evaluateWorkspace(workspace("1.4.0", NEW))).toEqual({
      ok: true,
      message: "The vite alias matches vite-plus 1.4.0.",
    });
  });

  it("passes on this repository's own pnpm-workspace.yaml", () => {
    const text = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
    expect(evaluateWorkspace(text)).toMatchObject({ ok: true });
  });

  it("fails as on 2026-10-30, where Dependabot bumped vite-plus only, and says what to set", () => {
    const outcome = evaluateWorkspace(workspace("1.4.0", OLD));
    expect(outcome).toMatchObject({ ok: false, line: 6 });
    expect(outcome.message).toContain(`the vite alias is "${OLD}"`);
    expect(outcome.message).toContain(`Set \`vite: ${NEW}\` in the catalog`);
    expect(outcome.message).toContain("run `vp install`");
  });

  it("accepts a prerelease version", () => {
    const beta = expectedAlias("1.5.0-beta.1");
    expect(evaluateWorkspace(workspace("1.5.0-beta.1", beta))).toMatchObject({ ok: true });
  });

  it("accepts quoted values", () => {
    expect(evaluateWorkspace(workspace('"1.4.0"', `"${NEW}"`))).toMatchObject({ ok: true });
  });

  it("rejects a range in vite-plus, because the alias must name one version", () => {
    const outcome = evaluateWorkspace(workspace("^1.4.0", NEW));
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toContain('"^1.4.0", which is not an exact version');
  });

  it("reports a missing vite alias", () => {
    const outcome = evaluateWorkspace(workspace("1.4.0"));
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toContain("has no `vite` entry");
    expect(outcome.message).toContain(`vite: ${NEW}`);
  });

  it("reports a missing vite-plus entry", () => {
    const outcome = evaluateWorkspace(workspace(undefined, NEW));
    expect(outcome.message).toBe("pnpm-workspace.yaml has no `vite-plus` entry in its catalog.");
  });

  it("reports a file with no catalog", () => {
    expect(evaluateWorkspace("packages:\n  - apps/*\n").message).toBe(
      "pnpm-workspace.yaml has no `vite-plus` entry in its catalog.",
    );
  });
});

describe("annotation", () => {
  it("points at pnpm-workspace.yaml and the given line", () => {
    expect(annotation("Fix it.", 6)).toBe(
      "::error file=pnpm-workspace.yaml,line=6,title=vite alias out of step::Fix it.",
    );
  });

  it("leaves out the line when there is none", () => {
    expect(annotation("Fix it.")).toBe(
      "::error file=pnpm-workspace.yaml,title=vite alias out of step::Fix it.",
    );
  });

  it("escapes percent signs and line breaks in the message", () => {
    expect(annotation("50%\r\nmore")).toMatch(/::50%25%0D%0Amore$/);
  });
});

describe("main", () => {
  it("returns 0 and prints to stdout when the alias matches", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(workspace("1.4.0", NEW), {})).toBe(0);
    expect(log).toHaveBeenCalledWith("The vite alias matches vite-plus 1.4.0.");
    log.mockRestore();
  });

  it("returns 1 and prints the plain message outside GitHub Actions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(workspace("1.4.0", OLD), {})).toBe(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^pnpm-workspace\.yaml pins vite-plus 1\.4\.0/);
    error.mockRestore();
  });

  it("prints an annotation inside GitHub Actions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(workspace("1.4.0", OLD), { GITHUB_ACTIONS: "true" })).toBe(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^::error file=pnpm-workspace\.yaml,line=6,/);
    error.mockRestore();
  });
});
