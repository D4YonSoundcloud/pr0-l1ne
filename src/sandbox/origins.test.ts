import { describe, expect, it } from "vitest";
import {
  appOriginsFor,
  branchAlias,
  DEPLOYED_APP_ORIGINS,
  LOCAL_APP_ORIGINS,
  originAllowed,
  PREVIEW_RUNNER,
  PRODUCTION_RUNNER,
  runnerHeaders,
  runnerPolicy,
  runnerUrlFor,
} from "./origins";

describe("which runner the app talks to", () => {
  it("is the live one for main, a branch's own preview for a branch, and this machine's elsewhere", () => {
    expect(runnerUrlFor({ CF_PAGES: "1", CF_PAGES_BRANCH: "main" })).toBe(PRODUCTION_RUNNER);
    expect(runnerUrlFor({ CF_PAGES: "1" })).toBe(PRODUCTION_RUNNER);
    expect(runnerUrlFor({ CF_PAGES: "1", CF_PAGES_BRANCH: "Fix/API_v2" })).toBe(
      "https://fix-api-v2.pr0l1ne-run.pages.dev/",
    );
    expect(runnerUrlFor({})).toBe(PREVIEW_RUNNER);
    expect(runnerUrlFor({ CF_PAGES: "1", VITE_RUNNER_URL: "https://elsewhere.example" })).toBe(
      "https://elsewhere.example/",
    );
  });

  it("names branches as Cloudflare does", () => {
    expect(branchAlias("runner")).toBe("runner");
    expect(branchAlias("feature/Share-Links")).toBe("feature-share-links");
  });
});

describe("who may embed the runner", () => {
  it("is the app's sites when built on Cloudflare, this machine otherwise, or what it's told", () => {
    expect(appOriginsFor({ CF_PAGES: "1" })).toEqual(DEPLOYED_APP_ORIGINS);
    expect(appOriginsFor({})).toEqual(LOCAL_APP_ORIGINS);
    expect(appOriginsFor({ RUNNER_APP_ORIGINS: "https://a.example, https://b.example" })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("matches origins as CSP does: exact, any subdomain, any port", () => {
    expect(originAllowed("https://pr0l1ne.com", DEPLOYED_APP_ORIGINS)).toBe(true);
    expect(originAllowed("https://runner.pr0l1ne.pages.dev", DEPLOYED_APP_ORIGINS)).toBe(true);
    expect(originAllowed("https://pr0l1ne.pages.dev", DEPLOYED_APP_ORIGINS)).toBe(true);
    expect(originAllowed("http://localhost:5173", LOCAL_APP_ORIGINS)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4185", LOCAL_APP_ORIGINS)).toBe(true);
  });

  it("refuses look-alikes, other schemes, ports, paths and opaque origins", () => {
    for (const origin of [
      "https://evil.com",
      "https://pr0l1ne.com.evil.com",
      "https://evilpr0l1ne.pages.dev",
      "https://pr0l1ne-run.pages.dev",
      "http://pr0l1ne.com",
      "https://pr0l1ne.com:8443",
      "https://pr0l1ne.com/path",
      "null",
      "",
      "not a url",
    ]) {
      expect(originAllowed(origin, DEPLOYED_APP_ORIGINS), origin).toBe(false);
    }
    expect(originAllowed("https://localhost:5173", LOCAL_APP_ORIGINS)).toBe(false);
    expect(originAllowed("https://pr0l1ne.com", ["nonsense"])).toBe(false);
  });
});

describe("the runner's headers", () => {
  it("allow its own files only, and only the app to embed it", () => {
    const policy = runnerPolicy(DEPLOYED_APP_ORIGINS);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain(`frame-ancestors ${DEPLOYED_APP_ORIGINS.join(" ")}`);
    expect(policy).not.toMatch(/\*(?!\.)|https?:\/\/\*;/); // no bare wildcards
    expect(runnerHeaders(LOCAL_APP_ORIGINS)["Content-Security-Policy"]).toContain("frame-ancestors http://localhost:*");
  });
});
