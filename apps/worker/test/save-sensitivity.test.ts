// The save form's sensitivity check (#132): GET /save asks Jev whether the link looks private and
// warns above SENSITIVE_WARN_THRESHOLD, and POST /save asks again, rejects an unacknowledged
// submission above it, and stores the noul, when it was checked and the acknowledgment. A Jev
// outage never blocks saving. Every request to Jev is answered by the Jev fixture
// (jev-fixture.ts), which fails a test that makes a request it did not plan for. See "On the save
// form" and "Calibration" under "Probabilistic check with Jev" in
// plans/haystack-v1-implementation-plan.md.
//
// Every test Worker starts with its secrets empty and Jev at the fixture's `.test` address
// (test-worker.ts), so the other save tests (save-form.test.ts, save-post.test.ts), which give no
// TypeSafe key, find the configuration error before they send anything, whatever key the shell
// holds, and their forms have no warning. This file gives a test key. The tests at its end show
// that a configuration error never blocks saving.
import {
  describeUrlForJudgment,
  normalizeUrl,
  SENSITIVE_CANONICAL_DROPPED,
} from "@haystack/schemas";
import { delay } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { JevTiming } from "../src/enrichment/jev-client.ts";
import { SENSITIVITY_QUESTION } from "../src/enrichment/jev-questions.ts";
import { checkSaveSensitivity } from "../src/save-sensitivity.ts";
import { noul } from "./jev-answers.ts";
import {
  answer,
  JEV_ORIGIN,
  type JevFixture,
  type JevResolver,
  networkError,
  startJevFixture,
  status,
} from "./jev-fixture.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { createTestWorker, type TestWorker } from "./test-worker.ts";
import { expectValidHtml } from "./validate-html.ts";

// Not a real key: a string that appears nowhere else.
const KEY = "ts-test-key-3d9a61c4";

let fixture: JevFixture;
let server: TestWorker;
let origin: string;

// The fixture starts first, because the harness sends the Worker's requests through this
// process's `fetch`, which it patches (page-fixture.ts).
beforeAll(async () => {
  fixture = startJevFixture();
  server = createTestWorker({
    vars: { ALLOWED_EMAILS: "owner@example.com" },
    secrets: { TYPESAFE_API_KEY: KEY },
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
  fixture.close();
});

async function db() {
  return (await server.getWorker().getEnv()).DB;
}

let owner: SeededUser;

beforeEach(async () => {
  const DB = await db();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
  fixture.reset();
  server.clearLogs();
});

afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
});

// A share link whose address carries no telltale parameter, which only Jev can warn about. The
// tracking parameter is removed before the address is shown, checked and saved.
const SHARED = {
  url: "https://docs.example/s/k9Xq2Lm7?utm_source=mail",
  title: "Q3 planning (draft)",
  description: "The plan for the quarter",
  og_title: "Shared document",
};
const SAVED_URL = "https://docs.example/s/k9Xq2Lm7";

// What the form submits for SHARED, with the title the user confirmed.
const SUBMISSION = {
  url: SAVED_URL,
  title: SHARED.title,
  description: SHARED.description,
  og_title: SHARED.og_title,
  confirmed_title: "My planning doc",
  confirmed_description: "Notes",
};

// The parts of SHARED that no log may hold: its host, its path, and its titles.
const PRIVATE_PARTS = ["docs.example", "k9Xq2Lm7", "Q3 planning", "Shared document"];

function getSave(fields: Record<string, string>, cookie: string | null = owner.cookie) {
  return server.fetch(`/save?${new URLSearchParams(fields).toString()}`, {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

function postSave(fields: Record<string, string>, cookie: string | null = owner.cookie) {
  return server.fetch("/save", {
    method: "POST",
    headers: { accept: "text/html", origin, ...(cookie === null ? {} : { cookie }) },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function bookmarks(): Promise<Record<string, unknown>[]> {
  const { results } = await (
    await db()
  )
    .prepare(
      "SELECT url, title, sensitivity_noul, sensitivity_checked_at, sensitivity_acknowledged_at FROM bookmarks",
    )
    .all();
  return results;
}

function logs(): { level: string; message: string }[] {
  return server.getLogs().map(({ level, message }) => ({ level, message }));
}

function warningLogs(): string[] {
  return logs()
    .filter((log) => log.message.startsWith("Sensitivity warning shown:"))
    .map((log) => log.message);
}

function expectNoPrivatePartsLogged(): void {
  const everything = JSON.stringify(server.getLogs());
  for (const part of PRIVATE_PARTS) {
    expect(everything).not.toContain(part);
  }
}

// The checkbox as the form renders it, unticked and not rejected.
const CHECKBOX =
  '<input type="checkbox" id="not-private" name="not_private" value="yes" required aria-describedby="sensitivity-warning">';
const LABEL = '<label for="not-private">This link does not give access to anything private</label>';
const WARNING = "This link looks as if it might be private.";
const UNTICKED_ERROR =
  "Tick “This link does not give access to anything private” to save this link.";

function expectNoWarning(markup: string): void {
  expect(markup).not.toContain("sensitivity-warning");
  expect(markup).not.toContain('name="not_private"');
  expect(markup).not.toContain(WARNING);
}

// Every way Jev can fail to answer, with the code the Worker logs for it. A request that fails
// without a response reaches the Worker as a 500 under the harness (page-fixture.ts says why), so
// the `network` code isn't tested here.
const OUTAGES: [string, JevResolver, string][] = [
  ["a 503", status(503), "status:503"],
  ["a 429", status(429), "status:429"],
  ["a rejected key", status(401), "status:401"],
  ["a request that fails without a response", networkError, "status:500"],
  [
    "an answer that isn't a noul",
    answer({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1 } }),
    "invalid-response",
  ],
];

describe("GET /save", () => {
  it("warns and asks for the checkbox above the threshold, and logs the noul only", async () => {
    fixture.respond(noul(0.82));
    const response = await getSave(SHARED);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Save a link - Haystack</title>");
    expect(markup).toContain(`<p id="sensitivity-warning" class="warning">`);
    expect(markup).toContain(WARNING);
    expect(markup).toContain(CHECKBOX);
    expect(markup).toContain(LABEL);
    // The warning comes after the notice and before the checkbox, which comes before the fields.
    const order = [
      'id="sensitive-notice"',
      'id="sensitivity-warning"',
      'id="not-private"',
      'id="confirmed-title"',
    ].map((marker) => markup.indexOf(marker));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
    // Nothing is in an alert: the warning is the form's content, not an error.
    expect(markup).not.toContain('role="alert"');
    await expectValidHtml(markup);

    expect(warningLogs()).toEqual([expect.stringContaining("0.82")]);
    expect(logs()).toContainEqual({ level: "info", message: warningLogs()[0] });
    expectNoPrivatePartsLogged();
  });

  it("warns at the threshold too", async () => {
    fixture.respond(noul(0.5));
    expect(await (await getSave(SHARED)).text()).toContain(CHECKBOX);
  });

  it("shows neither the warning nor the checkbox below the threshold, and logs nothing", async () => {
    fixture.respond(noul(0.49));
    const response = await getSave(SHARED);
    expect(response.status).toBe(200);
    expectNoWarning(await response.text());
    expect(logs()).toEqual([]);
  });

  it("sends Jev the description of the address it saves, with the page's own title, never the URL", async () => {
    fixture.respond(noul(0.1));
    await getSave(SHARED);
    expect(fixture.requests).toHaveLength(1);
    const [request] = fixture.requests;
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request?.body ?? "")).toEqual({
      model: "jev-1.13.0",
      // Without the tracking parameter, as the gate describes the stored address, and with the
      // payload's `title`, which `captured_title` stores, not the sharing title or the user's.
      state: { link: describeUrlForJudgment(new URL(SAVED_URL), SHARED.title, false) },
      questions: { private_access: SENSITIVITY_QUESTION },
    });
    // The random part of the path is masked, and the tracking parameter is gone.
    expect(request?.body).not.toContain("k9Xq2Lm7");
    expect(request?.body).not.toContain("utm_source");
    // A page that declared no flagged canonical URL is checked without the statement.
    expect(JSON.parse(request?.body ?? "").state.link).not.toHaveProperty(
      "declares_sensitive_canonical",
    );
  });

  it.each(OUTAGES)(
    "shows the form without a warning after %s, with one attempt",
    async (_, resolver, code) => {
      fixture.respond(resolver);
      const response = await getSave(SHARED);
      expect(response.status).toBe(200);
      const markup = await response.text();
      expect(markup).toContain('id="confirmed-title"');
      expectNoWarning(markup);
      expect(fixture.requests).toHaveLength(1);
      expect(logs()).toEqual([{ level: "warn", message: `Sensitivity check skipped: ${code}` }]);
    },
  );

  it("makes no Jev request for a link that is saved already", async () => {
    await seedBookmark(await db(), owner.userId, SAVED_URL, normalizeUrl(SAVED_URL));
    const response = await getSave(SHARED);
    expect(await response.text()).toContain("You already saved this link");
    expect(fixture.requests).toEqual([]);
  });

  it("makes no Jev request for the address form", async () => {
    expect((await getSave({})).status).toBe(200);
    expect(fixture.requests).toEqual([]);
  });
});

// The flag that the page declared a canonical URL that detectSensitiveUrl flags (#131) is evidence
// for Jev, as `declares_sensitive_canonical`, and the canonical URL itself is never sent, in raw
// or redacted form. The flag reaches the check in three ways: the save link carries it, as the
// popup and the address form build it; GET /save drops a flagged canonical URL itself; or the
// form's hidden input carries it to POST /save.
describe("the flag that the page declared a flagged canonical URL", () => {
  // On another host than the page, with a token, so every part of it can be searched for.
  const CANONICAL = "https://files.share.test/d/Kq7Lr2Zx?access_token=canonical-token-6b1e9d";
  const CANONICAL_PARTS = [
    "files.share.test",
    "Kq7Lr2Zx",
    "access_token",
    "canonical-token-6b1e9d",
    encodeURIComponent(CANONICAL),
  ];
  const FLAGGED_STATE = {
    link: describeUrlForJudgment(new URL(SAVED_URL), SHARED.title, true),
  };

  function sentState(index = 0): unknown {
    return JSON.parse(fixture.requests[index]?.body ?? "").state;
  }

  function expectNoCanonicalUrlSent(): void {
    for (const request of fixture.requests) {
      for (const part of CANONICAL_PARTS) {
        expect(request.body).not.toContain(part);
      }
    }
  }

  it.each([
    ["a save link that carries the flag", { [SENSITIVE_CANONICAL_DROPPED]: "1" }],
    ["a save link whose canonical URL GET /save drops", { canonical_url: CANONICAL }],
  ])("is in the state Jev gets for %s", async (_, fields) => {
    fixture.respond(noul(0.1));
    const markup = await (await getSave({ ...SHARED, ...fields })).text();
    expect(sentState()).toEqual(FLAGGED_STATE);
    expect(FLAGGED_STATE.link).toHaveProperty("declares_sensitive_canonical", true);
    expectNoCanonicalUrlSent();
    // The form carries the flag on, and never the canonical URL.
    expect(markup).toContain(`name="${SENSITIVE_CANONICAL_DROPPED}" value="1"`);
    expect(markup).not.toContain("canonical-token-6b1e9d");
  });

  it.each([
    ["the form's hidden input", { [SENSITIVE_CANONICAL_DROPPED]: "1" }],
    ["a canonical URL POST /save drops", { canonical_url: CANONICAL }],
  ])("is in the state Jev gets on POST /save from %s, and is stored", async (_, fields) => {
    fixture.respond(noul(0.1));
    expect((await postSave({ ...SUBMISSION, ...fields })).status).toBe(200);
    expect(sentState()).toEqual(FLAGGED_STATE);
    expectNoCanonicalUrlSent();
    const { results } = await (
      await db()
    )
      .prepare("SELECT canonical_url, sensitive_canonical_dropped FROM bookmarks")
      .all();
    expect(results).toEqual([{ canonical_url: null, sensitive_canonical_dropped: 1 }]);
  });

  it("is left out of the state for a bookmark saved without it, which stores 0", async () => {
    fixture.respond(noul(0.1));
    expect((await postSave(SUBMISSION)).status).toBe(200);
    expect(sentState()).toEqual({
      link: describeUrlForJudgment(new URL(SAVED_URL), SHARED.title, false),
    });
    expect(JSON.stringify(sentState())).not.toContain("declares_sensitive_canonical");
    const { results } = await (
      await db()
    )
      .prepare("SELECT sensitive_canonical_dropped FROM bookmarks")
      .all();
    expect(results).toEqual([{ sensitive_canonical_dropped: 0 }]);
  });
});

describe("POST /save", () => {
  it("checks again, and rejects a submission without the box above the threshold", async () => {
    // GET's check found nothing, so the form had no checkbox. POST asks again rather than
    // trusting what the form showed.
    fixture.respond(noul(0.1));
    expectNoWarning(await (await getSave(SHARED)).text());
    fixture.respond(noul(0.82));
    const response = await postSave(SUBMISSION);
    expect(fixture.requests).toHaveLength(2);

    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<title>Check the form - Haystack</title>");
    // The error comes right after the heading, as a rejected title's does.
    expect(markup).toContain(
      `<h1>Save a link</h1><div class="alert" role="alert"><p id="save-error">${UNTICKED_ERROR}</p></div>`,
    );
    // The box reads the error first, then the warning, and nothing takes focus.
    expect(markup).toContain(
      '<input type="checkbox" id="not-private" name="not_private" value="yes" required aria-invalid="true" aria-describedby="save-error sensitivity-warning">',
    );
    expect(markup).toContain(WARNING);
    expect(markup).not.toContain("autofocus");
    expect(markup).not.toContain("tabindex");
    // What the user entered stays in the form.
    expect(markup).toContain('value="My planning doc"');
    expect(markup).toContain(">Notes</textarea>");
    await expectValidHtml(markup);
    expect(await bookmarks()).toEqual([]);

    // A warning shown without a save logs the noul, and nothing from the link.
    expect(warningLogs()).toEqual([expect.stringContaining("0.82")]);
    expectNoPrivatePartsLogged();
  });

  it("saves a ticked submission above the threshold with the noul, the check and the acknowledgment", async () => {
    fixture.respond(noul(0.82));
    const before = Date.now();
    const response = await postSave({ ...SUBMISSION, not_private: "yes" });
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Saved</h1>");
    const [bookmark] = await bookmarks();
    expect(bookmark).toMatchObject({
      url: SAVED_URL,
      title: "My planning doc",
      sensitivity_noul: 0.82,
    });
    for (const column of ["sensitivity_checked_at", "sensitivity_acknowledged_at"]) {
      expect(bookmark?.[column]).toBeGreaterThanOrEqual(before);
      expect(bookmark?.[column]).toBeLessThanOrEqual(after);
    }
    // The warning wasn't shown again, so nothing is logged for it.
    expect(warningLogs()).toEqual([]);
  });

  it.each([
    ["without the box", {}],
    // A form built by hand can tick a box the form never showed. Jev didn't warn, so the tick
    // acknowledges nothing, and the gate can still hold the link if a later check warns.
    ["with the box", { not_private: "yes" }],
  ])(
    "saves a submission %s below the threshold with the noul and no acknowledgment",
    async (_, box) => {
      fixture.respond(noul(0.2));
      const response = await postSave({ ...SUBMISSION, ...box });
      expect(response.status).toBe(200);
      const [bookmark] = await bookmarks();
      expect(bookmark).toMatchObject({ sensitivity_noul: 0.2, sensitivity_acknowledged_at: null });
      expect(bookmark?.sensitivity_checked_at).toEqual(expect.any(Number));
    },
  );

  it("doesn't take another value in the box as a tick", async () => {
    fixture.respond(noul(0.82));
    const response = await postSave({ ...SUBMISSION, not_private: "on" });
    expect(response.status).toBe(400);
    expect(await bookmarks()).toEqual([]);
  });

  it.each(OUTAGES)("saves after %s, with the noul left empty", async (_, resolver, code) => {
    fixture.respond(resolver);
    // The box was ticked on a form whose GET warned. Without an answer now, it isn't stored.
    const response = await postSave({ ...SUBMISSION, not_private: "yes" });
    expect(response.status).toBe(200);
    expect(await bookmarks()).toEqual([
      {
        url: SAVED_URL,
        title: "My planning doc",
        sensitivity_noul: null,
        sensitivity_checked_at: null,
        sensitivity_acknowledged_at: null,
      },
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(logs()).toEqual([{ level: "warn", message: `Sensitivity check skipped: ${code}` }]);
  });

  it("shows a rejected title with the warning, and keeps the box ticked", async () => {
    fixture.respond(noul(0.82));
    const response = await postSave({ ...SUBMISSION, confirmed_title: "   ", not_private: "yes" });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain('<p id="save-error">Enter a title of up to 200 characters.</p>');
    expect(markup).toContain(
      '<input type="checkbox" id="not-private" name="not_private" value="yes" checked required aria-describedby="sensitivity-warning">',
    );
    await expectValidHtml(markup);
    expect(await bookmarks()).toEqual([]);
  });

  it("makes no Jev request for a link that is saved already", async () => {
    await seedBookmark(await db(), owner.userId, SAVED_URL, normalizeUrl(SAVED_URL));
    const response = await postSave(SUBMISSION);
    expect(await response.text()).toContain("You already saved this link");
    expect(fixture.requests).toEqual([]);
  });

  // The fields are checked before the link is looked up, as before #132, so a rejected title
  // gets its error even for a link that is saved already. The form it comes back with asks Jev,
  // so it can show the warning.
  it("rejects a blank title on a link that is saved already", async () => {
    await seedBookmark(await db(), owner.userId, SAVED_URL, normalizeUrl(SAVED_URL));
    fixture.respond(noul(0.1));
    const response = await postSave({ ...SUBMISSION, confirmed_title: "   " });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<title>Check the form - Haystack</title>");
    expect(markup).toContain('<p id="save-error">Enter a title of up to 200 characters.</p>');
    expect(markup).not.toContain("You already saved this link");
    expect(fixture.requests).toHaveLength(1);
  });
});

// The check's time limit, in this process, with a short limit in place of SAVE_CHECK_TIMING's
// 2 seconds, so the test doesn't wait for it. The routes' tests above show what the form and the
// save do when the check gives no answer, which a timeout is.
describe("checkSaveSensitivity", () => {
  const config = {
    JEV_BASE_URL: JEV_ORIGIN,
    JEV_MODEL: "jev-1.13.0",
    TYPESAFE_API_KEY: KEY,
    SENSITIVE_WARN_THRESHOLD: "0.5",
  };
  // Short enough to keep the test fast, long enough for a delayed answer to miss it.
  const timing: JevTiming = { attemptTimeoutMs: 100, backoffInitialMs: 1, attemptLimit: 1 };

  it("treats an answer after the time limit as no answer, and logs the timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.respond(async (request) => {
        await delay(timing.attemptTimeoutMs * 5);
        return noul(0.9)(request);
      });
      const check = await checkSaveSensitivity(config, SAVED_URL, SHARED.title, false, timing);
      expect(check).toEqual({ answered: false });
      expect(fixture.requests).toHaveLength(1);
      expect(warn.mock.calls).toEqual([["Sensitivity check skipped:", "timeout"]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers with the noul, when it was checked, and whether it warns", async () => {
    fixture.respond(noul(0.5));
    const before = Date.now();
    const check = await checkSaveSensitivity(config, SAVED_URL, SHARED.title, false, timing);
    expect(check).toEqual({
      answered: true,
      noul: 0.5,
      checkedAt: expect.any(Number),
      warns: true,
    });
    expect(check.answered && check.checkedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("without a session", () => {
  // The check runs after sign-in, so a request that hasn't signed in spends nothing on Jev.
  it("makes no Jev request for GET /save", async () => {
    const response = await getSave(SHARED, null);
    expect(response.status).toBe(302);
    expect(fixture.requests).toEqual([]);
  });

  it("makes no Jev request for POST /save", async () => {
    const response = await postSave(SUBMISSION, null);
    expect(response.status).toBe(303);
    expect(fixture.requests).toEqual([]);
  });

  // The save link that sign-in returns to carries the values the user entered (#34), but not the
  // box, because the form it opens asks Jev again, and the box is an answer to that warning.
  it("returns to a form that asks for the box again", async () => {
    const response = await postSave({ ...SUBMISSION, not_private: "yes" }, null);
    const location = new URL(response.headers.get("location") ?? "", origin);
    const returnTo = location.searchParams.get("return_to") ?? "";
    expect(returnTo).toMatch(/^\/save\?/);
    expect(returnTo).not.toContain("not_private");

    fixture.respond(noul(0.82));
    const form = await server.fetch(returnTo, {
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    const markup = await form.text();
    expect(markup).toContain("<title>Not saved yet - Haystack</title>");
    expect(markup).toContain('value="My planning doc"');
    expect(markup).toContain(CHECKBOX);
    expect(await bookmarks()).toEqual([]);
  });
});

// A configuration the check can't use is the deployment's problem, which the sweep stops for.
// Saving goes on without the check, and the log names the error by its code.
describe.each([
  ["no TypeSafe key", {}, {}, "TYPESAFE_API_KEY_EMPTY"],
  [
    "a threshold that can't be read",
    { SENSITIVE_WARN_THRESHOLD: "high" },
    { TYPESAFE_API_KEY: KEY },
    "SENSITIVE_WARN_THRESHOLD_INVALID",
  ],
])("with %s", (_, vars, secrets, code) => {
  let misconfigured: TestWorker;
  let misconfiguredOrigin: string;
  let cookie: string;

  beforeAll(async () => {
    misconfigured = createTestWorker({
      vars: { ALLOWED_EMAILS: "owner@example.com", ...vars },
      secrets,
    });
    misconfiguredOrigin = (await misconfigured.listen()).url.origin;
    await misconfigured.getWorker().applyD1Migrations("DB");
    const DB = (await misconfigured.getWorker().getEnv()).DB;
    ({ cookie } = await seedSignedInUser(DB, "owner@example.com"));
  });

  afterAll(async () => {
    await misconfigured.close();
  });

  it("shows the form without a warning, saves with the noul left empty, and logs the code", async () => {
    const form = await misconfigured.fetch(`/save?${new URLSearchParams(SHARED).toString()}`, {
      headers: { accept: "text/html", cookie },
    });
    expect(form.status).toBe(200);
    expectNoWarning(await form.text());
    const saved = await misconfigured.fetch("/save", {
      method: "POST",
      headers: { accept: "text/html", origin: misconfiguredOrigin, cookie },
      body: new URLSearchParams(SUBMISSION),
    });
    expect(saved.status).toBe(200);
    const DB = (await misconfigured.getWorker().getEnv()).DB;
    const { results } = await DB.prepare("SELECT sensitivity_noul FROM bookmarks").all();
    expect(results).toEqual([{ sensitivity_noul: null }]);
    expect(fixture.requests).toEqual([]);
    expect(misconfigured.getLogs().map(({ level, message }) => ({ level, message }))).toEqual([
      { level: "warn", message: `Sensitivity check skipped: ${code}` },
      { level: "warn", message: `Sensitivity check skipped: ${code}` },
    ]);
  });
});
