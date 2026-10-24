/**
 * The site's pages: one for each language (pr0l1ne.com/python, /javascript,
 * /typescript, /sql), and the home page (pr0l1ne.com), which opens the
 * language last used (or JavaScript, the first time) and shows its address.
 *
 * Every page is the same app (index.html). What differs is what a search
 * engine or a link preview reads before the app runs: the title, the
 * description, the canonical address, the structured data (JSON-LD), and a
 * short introduction with links to the other pages. vite.config.ts writes
 * a copy of the built index.html for each language (`python.html`, served
 * at /python), with its own; the app reads the language from the address
 * (languageFromPath).
 *
 * No DOM here: the build (Node) uses it as well as the app.
 */
/**
 * The languages with a page. Kept apart from languages.ts, which brings the
 * runners with it, so the build can use this file; app/routing.ts indexes
 * LANGUAGE_PAGES by the app's LanguageId, so a language added there without
 * a page here doesn't compile.
 */
export type LanguageId = "javascript" | "python" | "typescript" | "sql";

export const SITE = "https://pr0l1ne.com";

/** What every page says about the price, accounts and privacy, in a few words. */
export const FREE = "Free, no sign-up, and it runs in your own browser.";

export interface SitePage {
  /** The address's path: "/python", or "/" for home. */
  path: string;
  language: LanguageId | null;
  title: string;
  /** For search results (under 160 characters, ideally). */
  description: string;
  /** For link previews: shorter. */
  socialTitle: string;
  /** The page's heading and introduction (shown to screen readers and search engines). */
  heading: string;
  intro: string;
}

export const LANGUAGE_PAGES: Record<LanguageId, SitePage> = {
  javascript: {
    path: "/javascript",
    language: "javascript",
    title: "JavaScript Visualizer: See Your Code Run, Step by Step | PR0L1NE",
    description:
      "Step through JavaScript line by line and watch variables, arrays, objects, closures and loops change. Free, no sign-up, runs in your own browser.",
    socialTitle: "PR0L1NE: see your JavaScript run",
    heading: "JavaScript visualizer: see your code run, step by step",
    intro:
      "Write JavaScript and step through it line by line. PR0L1NE draws every variable, array, object, closure and call as it changes, stacks each pass of a loop to compare, draws graphs and trees, and estimates time and space complexity.",
  },
  python: {
    path: "/python",
    language: "python",
    title: "Python Visualizer: See Your Code Run, Step by Step | PR0L1NE",
    description:
      "Step through Python line by line and watch variables, lists, dicts, objects and loops change, in real CPython. Free, no sign-up, runs in your own browser.",
    socialTitle: "PR0L1NE: see your Python run",
    heading: "Python visualizer: see your code run, step by step",
    intro:
      "Write Python and step through it line by line, in a real CPython running in your browser. PR0L1NE draws every variable, list, dict, object and call frame as it changes, stacks each pass of a loop to compare, draws graphs and trees, and estimates time and space complexity.",
  },
  typescript: {
    path: "/typescript",
    language: "typescript",
    title: "TypeScript Visualizer: See Your Code Run, Step by Step | PR0L1NE",
    description:
      "Step through TypeScript line by line and watch variables, arrays, objects, classes and loops change. Free, no sign-up, runs in your own browser.",
    socialTitle: "PR0L1NE: see your TypeScript run",
    heading: "TypeScript visualizer: see your code run, step by step",
    intro:
      "Write TypeScript and step through it line by line. PR0L1NE draws every variable, array, object, class instance and call as it changes, stacks each pass of a loop to compare, draws graphs and trees, and estimates time and space complexity.",
  },
  sql: {
    path: "/sql",
    language: "sql",
    title: "SQL Visualizer: See Your Query Run, Clause by Clause | PR0L1NE",
    description:
      "Run SQL on a real PostgreSQL in your browser and watch each clause work: FROM, JOIN, WHERE, GROUP BY, ORDER BY. Free, no sign-up, runs in your own browser.",
    socialTitle: "PR0L1NE: see your SQL query run",
    heading: "SQL visualizer: see your query run, clause by clause",
    intro:
      "Write SQL and watch it run on a real PostgreSQL in your browser, one clause at a time, in the order Postgres runs them: the table at each step, every row kept or dropped and why, joins drawn as lines between rows, groups folding into rows, subqueries, window functions and recursive queries. Sample databases to start from, or your own tables.",
  },
};

export const HOME_PAGE: SitePage = {
  path: "/",
  language: null,
  title: "PR0L1NE: See Your Code Run | Python, JavaScript, TypeScript and SQL Visualizer",
  description:
    "Step through Python, JavaScript, TypeScript and SQL and watch memory, loops and queries change, step by step. Free, no sign-up, runs in your own browser.",
  socialTitle: "PR0L1NE: see your code run",
  heading: "See your code run",
  intro:
    "PR0L1NE steps through Python, JavaScript and TypeScript programs and draws every variable, list, object and loop as it changes, and steps through SQL queries one clause at a time on a real PostgreSQL.",
};

/** The language a path is the page of ("/python", "/python/", "/PYTHON"), or null. */
export function languageFromPath(path: string): LanguageId | null {
  const name = path.replace(/\/+$/, "").replace(/^\//, "").toLowerCase();
  const page = Object.values(LANGUAGE_PAGES).find((p) => p.path === `/${name}`);
  return page?.language ?? null;
}

/** Is this the home page's path? */
export const isHomePath = (path: string) => path === "/" || path === "" || path === "/index.html";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The structured data a search engine reads: the page is a free web app. */
export function structuredData(page: SitePage): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    // "PR0L1NE SQL Visualizer", from the title.
    name: page.language ? `PR0L1NE ${page.title.split(":")[0]}` : "PR0L1NE",
    url: `${SITE}${page.path}`,
    description: page.description,
    applicationCategory: "EducationalApplication",
    applicationSubCategory: "Code visualizer",
    operatingSystem: "Any: runs in a web browser",
    browserRequirements: "Requires JavaScript and WebAssembly",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: [
      "Free to use",
      "No sign-up or account",
      "Runs entirely in your own browser: your code never leaves it",
      "Step through code line by line, or SQL clause by clause",
    ],
  };
  // In a <script> element: "</" can't appear in it.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** Every page, for the sitemap and the links between them. */
export const ALL_PAGES: SitePage[] = [HOME_PAGE, ...Object.values(LANGUAGE_PAGES)];

/**
 * index.html as `page`: its head (title, description, canonical address,
 * link previews, structured data) and its introduction. The markers it
 * replaces are index.html's own, written for the home page.
 */
export function pageHtml(index: string, page: SitePage): string {
  const url = `${SITE}${page.path}`;
  const swaps: [RegExp, string][] = [
    [/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`],
    [/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`],
    [
      /<meta name="description" content="[^"]*" \/>/,
      `<meta name="description" content="${escapeHtml(page.description)}" />`,
    ],
    [
      /<meta property="og:title" content="[^"]*" \/>/,
      `<meta property="og:title" content="${escapeHtml(page.socialTitle)}" />`,
    ],
    [
      /<meta property="og:description" content="[^"]*" \/>/,
      `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    ],
    [/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`],
    [
      /<meta name="twitter:title" content="[^"]*" \/>/,
      `<meta name="twitter:title" content="${escapeHtml(page.socialTitle)}" />`,
    ],
    [
      /<meta name="twitter:description" content="[^"]*" \/>/,
      `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
    ],
    [
      /<script type="application\/ld\+json" id="structured-data">[^<]*<\/script>/,
      `<script type="application/ld+json" id="structured-data">${structuredData(page)}</script>`,
    ],
    [/<h2 id="intro-heading">[^<]*<\/h2>/, `<h2 id="intro-heading">${escapeHtml(page.heading)}</h2>`],
    [/<p id="intro-text">[^<]*<\/p>/, `<p id="intro-text">${escapeHtml(page.intro)} ${escapeHtml(FREE)}</p>`],
  ];
  let html = index;
  for (const [find, replace] of swaps) {
    if (!find.test(html))
      throw new Error(`index.html has no ${find.source.slice(0, 40)}…: pages.ts can't make ${page.path}`);
    html = html.replace(find, replace);
  }
  return html;
}

/** The sitemap: every page of the app (the docs have their own, /docs/sitemap.xml). */
export function sitemap(): string {
  const urls = ALL_PAGES.map((p) => `  <url><loc>${SITE}${p.path}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
