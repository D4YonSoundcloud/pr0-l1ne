// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LanguageId } from "../languages";
import { LanguageRoutes } from "./routing";

function setup(path: string, start: LanguageId = "javascript") {
  document.head.innerHTML = `<link rel="canonical" href="https://pr0l1ne.com/" /><meta name="description" content="" /><meta property="og:url" content="" />`;
  const loc = { pathname: path, search: "", hash: "" };
  const at = (url: string) => {
    const u = new URL(url, "https://pr0l1ne.com");
    Object.assign(loc, { pathname: u.pathname, search: u.search, hash: u.hash });
  };
  const calls: string[] = [];
  let pop = () => {};
  let language = start;
  const routes = new LanguageRoutes({
    current: () => language,
    switchTo: (l) => {
      language = l;
      calls.push(`switch ${l}`);
    },
    location: loc,
    history: {
      pushState: (_s, _t, url) => {
        calls.push(`push ${url}`);
        at(String(url));
      },
      replaceState: (_s, _t, url) => {
        calls.push(`replace ${url}`);
        at(String(url));
      },
    },
    win: { addEventListener: ((_type: string, f: () => void) => (pop = f)) as unknown as Window["addEventListener"] },
  });
  return {
    routes,
    calls,
    loc,
    at,
    back: (url: string) => {
      at(url);
      pop();
    },
    setLanguage: (l: LanguageId) => (language = l),
  };
}

describe("LanguageRoutes", () => {
  it("shows the language's address on the home page, keeping a share link", () => {
    const { routes, calls, loc } = setup("/", "sql");
    loc.hash = "#v1.abc";
    routes.start();
    expect(calls).toEqual(["replace /sql#v1.abc"]);
    expect(document.title).toMatch(/^SQL Visualizer/);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://pr0l1ne.com/sql");
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toContain("no sign-up");
  });

  it("leaves a language's own address alone", () => {
    const { routes, calls } = setup("/python", "python");
    routes.start();
    expect(calls).toEqual([]);
    expect(document.title).toMatch(/^Python Visualizer/);
  });

  it("adds a history entry when the language is picked, and Back switches back", () => {
    const { routes, calls, back, setLanguage } = setup("/python", "python");
    setLanguage("typescript");
    routes.show("typescript");
    expect(calls).toEqual(["push /typescript"]);
    back("/python");
    expect(calls.at(-1)).toBe("switch python");
    expect(document.title).toMatch(/^Python/);
    back("/python"); // already there: nothing to switch
    expect(calls).toHaveLength(2);
  });

  it("replaces the address for a share link's language", () => {
    const { routes, calls } = setup("/javascript");
    routes.show("python", { replace: true });
    expect(calls).toEqual(["replace /python"]);
  });
});
