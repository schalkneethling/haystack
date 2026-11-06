// readText reads the start of a body up to a limit, and says whether that was all of it.

import { describe, expect, it } from "vite-plus/test";
import { readText } from "../src/enrichment/bounded-read.ts";

/** A body that delivers each of the given strings as one chunk. */
function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("readText", () => {
  it("reads a body shorter than the limit whole", async () => {
    expect(await readText(bodyOf("abc"), 10)).toEqual({ ok: true, text: "abc", complete: true });
  });

  it("reads a body of exactly the limit whole, in one chunk or in several", async () => {
    expect(await readText(bodyOf("abcde"), 5)).toEqual({ ok: true, text: "abcde", complete: true });
    expect(await readText(bodyOf("abc", "de"), 5)).toEqual({
      ok: true,
      text: "abcde",
      complete: true,
    });
  });

  it("cuts a body that goes past the limit, in one chunk or in several", async () => {
    expect(await readText(bodyOf("abcdef"), 5)).toEqual({
      ok: true,
      text: "abcde",
      complete: false,
    });
    expect(await readText(bodyOf("abc", "def"), 5)).toEqual({
      ok: true,
      text: "abcde",
      complete: false,
    });
    expect(await readText(bodyOf("abcde", "f"), 5)).toEqual({
      ok: true,
      text: "abcde",
      complete: false,
    });
  });
});
