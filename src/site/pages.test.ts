import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_PAGES, HOME_PAGE, isHomePath, LANGUAGE_PAGES, languageFromPath, pageHtml, sitemap } from "./pages";

const index = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

describe("the site's pages", () => {
  it("has one for every language", () => {
    expect(Object.keys(LANGUAGE_PAGES).sort()).toEqual(["javascript", "python", "sql", "typescript"]);
  });

  it("finds the language in an address", () => {
    expect(languageFromPath("/python")).toBe("python");
    expect(languageFromPath("/SQL/")).toBe("sql");
    expect(languageFromPath("/")).toBe(null);
    expect(languageFromPath("/docs/user-guide.html")).toBe(null);
    expect(isHomePath("/")).toBe(true);
    expect(isHomePath("/python")).toBe(false);
  });

  it("says each page is free, needs no sign-up and runs in the browser, in a search result's length", () => {
    for (const page of ALL_PAGES) {
      expect(page.description).toContain("Free, no sign-up, runs in your own browser.");
      expect(page.description.length).toBeLessThanOrEqual(160);
      expect(page.title.length).toBeLessThanOrEqual(90);
    }
  });

  it("makes each page's HTML from index.html, with its own head and introduction", () => {
    const html = pageHtml(index, LANGUAGE_PAGES.sql);
    expect(html).toContain("<title>SQL Visualizer: See Your Query Run, Clause by Clause | PR0L1NE</title>");
    expect(html).toContain('<link rel="canonical" href="https://pr0l1ne.com/sql" />');
    expect(html).toContain('<meta property="og:url" content="https://pr0l1ne.com/sql" />');
    expect(html).toContain('<h2 id="intro-heading">SQL visualizer: see your query run, clause by clause</h2>');
    const json = /<script type="application\/ld\+json" id="structured-data">([^<]*)<\/script>/.exec(html)![1];
    const data = JSON.parse(json);
    expect(data).toMatchObject({
      "@type": "WebApplication",
      isAccessibleForFree: true,
      url: "https://pr0l1ne.com/sql",
    });
    expect(data.offers.price).toBe("0");
    // Who made it: D4Y, tied to the name and the LinkedIn profile.
    expect(data.author).toMatchObject({
      "@type": "Person",
      name: "Matthew Day",
      alternateName: "D4Y",
      url: "https://www.linkedin.com/in/matthew-day-developer/",
    });
    expect(html).toContain(
      'Created by <a href="https://www.linkedin.com/in/matthew-day-developer/" rel="author">D4Y</a>',
    );
    expect(html).toContain('<meta name="author" content="D4Y (Matthew Day)" />');
    // Everything else is index.html's.
    expect(html.split("\n").length).toBe(index.split("\n").length);
    expect(pageHtml(index, HOME_PAGE)).toContain('<link rel="canonical" href="https://pr0l1ne.com/" />');
  });

  it("lists every page in the sitemap", () => {
    const xml = sitemap();
    for (const page of ALL_PAGES) expect(xml).toContain(`<loc>https://pr0l1ne.com${page.path}</loc>`);
  });

  it("links to every language's page from index.html", () => {
    for (const page of Object.values(LANGUAGE_PAGES)) expect(index).toContain(`href="${page.path}"`);
  });
});

describe("llms.txt", () => {
  const text = readFileSync(new URL("../../public/llms.txt", import.meta.url), "utf8");
  it("says who made PR0L1NE, when it was written, and links every language's page", () => {
    expect(text).toMatch(/^# PR0L1NE\n/);
    expect(text).toContain("Created by D4Y (Matthew Day): https://www.linkedin.com/in/matthew-day-developer/");
    expect(text).toContain("As of October 2026");
    for (const page of Object.values(LANGUAGE_PAGES)) expect(text).toContain(`(https://pr0l1ne.com${page.path})`);
  });
});
