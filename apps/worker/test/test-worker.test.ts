// How test-worker.ts reads the secrets to empty from wrangler.jsonc (#132's review). A secret it
// missed would be bound from the shell that runs the tests, so the reader must not be misled by
// a comment in the config.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { requiredSecretNames, withoutJsoncComments } from "./test-worker.ts";

describe("requiredSecretNames", () => {
  it("reads every secret in wrangler.jsonc's secrets.required", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(requiredSecretNames(config)).toEqual([
      "GOOGLE_CLIENT_SECRET",
      "TYPESAFE_API_KEY",
      "GITHUB_TOKEN",
      "ANTHROPIC_API_KEY",
      "AI_GATEWAY_TOKEN",
    ]);
  });

  // A `]` in a comment would end the list early, and let the names after it through, and a
  // quoted name in a comment would add one that isn't a secret.
  it("ignores comments inside the list, whatever they hold", () => {
    const config = `{
      // The keys [for "NOT_A_SECRET"] below.
      "secrets": {
        "required": [
          "FIRST_SECRET", // ends the list? ] "LINE_COMMENT_NAME"
          /* "BLOCK_COMMENT_NAME" ] */ "SECOND_SECRET",
          /*
            "MULTI_LINE_NAME" ]
          */
          "THIRD_SECRET",
        ],
      },
    }`;
    expect(requiredSecretNames(config)).toEqual(["FIRST_SECRET", "SECOND_SECRET", "THIRD_SECRET"]);
  });

  it.each([
    ["no secrets", `{ "vars": { "A": "b" } }`],
    ["an empty list", `{ "secrets": { "required": [] } }`],
    ["a list that is only comments", `{ "secrets": { "required": [ // "COMMENTED_OUT"\n ] } }`],
  ])("throws for a config with %s", (_, config) => {
    expect(() => requiredSecretNames(config)).toThrow("No secrets.required found");
  });
});

describe("withoutJsoncComments", () => {
  it("keeps strings as they are, with a // or /* inside them and escaped quotes", () => {
    const jsonc = `{"url": "https://api.typesafe.ai", "glob": "a/*b", "quote": "say \\"hi\\" // not a comment"} // gone`;
    expect(withoutJsoncComments(jsonc)).toBe(
      `{"url": "https://api.typesafe.ai", "glob": "a/*b", "quote": "say \\"hi\\" // not a comment"} `,
    );
  });

  it("keeps the line break that ends a line comment", () => {
    expect(withoutJsoncComments(`{ // one\n"a": 1 /* two */ }`)).toBe(`{ \n"a": 1  }`);
  });
});
