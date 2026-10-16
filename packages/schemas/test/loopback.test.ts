import { describe, expect, it } from "vite-plus/test";
import { isHttpsOrLoopbackUrl } from "../src/loopback.ts";

describe("isHttpsOrLoopbackUrl", () => {
  for (const url of [
    "https://haystack.example/",
    "https://localhost/",
    "http://localhost:5173/",
    "http://127.0.0.1:8787/",
    "http://[::1]:5173/",
  ]) {
    it(`accepts ${url}`, () => {
      expect(isHttpsOrLoopbackUrl(new URL(url))).toBe(true);
    });
  }

  for (const url of [
    "http://haystack.example/",
    // A name that merely contains a loopback host is somewhere else.
    "http://localhost.haystack.example/",
    "http://127.0.0.1.haystack.example/",
    "ftp://localhost/",
    "ws://localhost/",
  ]) {
    it(`refuses ${url}`, () => {
      expect(isHttpsOrLoopbackUrl(new URL(url))).toBe(false);
    });
  }
});
