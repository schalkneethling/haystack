// The browser test fixtures (a Worker per process, `signIn`, `query`) plus a running VoiceOver
// (`voiceOver`), for the `*.voiceover.ts` tests.
import { voiceOverTest } from "@guidepup/playwright";
import { mergeTests } from "@playwright/test";
import { test as haystackTest } from "./fixtures.ts";

export const test = mergeTests(haystackTest, voiceOverTest);

export { expect } from "@playwright/test";
