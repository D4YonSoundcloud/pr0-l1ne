/**
 * The docs site, pr0l1ne.com/docs: VitePress over this folder's Markdown,
 * as it is (the same files GitHub shows). `npm run build` builds it into
 * dist/docs after the app, so it deploys with the app; `npm run docs:dev`
 * serves it on its own while writing.
 *
 * The Markdown links to the code with relative paths (../src/...), which
 * work on GitHub but aren't pages here: they become links to the file on
 * GitHub. Links to the folder's README (GitHub's index of these docs)
 * become links to the site's home page.
 */
import { defineConfig } from "vitepress";

const REPO = "https://github.com/D4YonSoundcloud/pr0-l1ne";

export default defineConfig({
  title: "PR0L1NE docs",
  description: "How to use PR0L1NE, see your code run: Python, JavaScript and TypeScript, step by step.",
  lang: "en",
  base: "/docs/",
  outDir: "../dist/docs",
  // GitHub's index of this folder; the site has its own home page (index.md).
  srcExclude: ["README.md"],
  cleanUrls: false,
  lastUpdated: false,
  // The development guide's http://localhost links are for your own machine.
  ignoreDeadLinks: "localhostLinks",
  sitemap: { hostname: "https://pr0l1ne.com/docs/" },
  head: [
    // The site's icon (public/ of the app, served at the site's root).
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
      },
    ],
    ["meta", { property: "og:image", content: "https://pr0l1ne.com/og-image.png" }],
  ],
  markdown: {
    config(md) {
      // Links out of this folder go to GitHub; links to the README go home.
      const open = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token.attrGet("href");
        if (href?.startsWith("../")) {
          const path = href.slice(3);
          const kind = path.endsWith("/") ? "tree" : "blob";
          token.attrSet("href", `${REPO}/${kind}/main/${path}`);
          token.attrSet("target", "_blank");
          token.attrSet("rel", "noopener");
        } else if (href === "README.md" || href?.startsWith("README.md#")) {
          token.attrSet("href", `./${href.slice("README.md".length)}`);
        }
        return open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      };
    },
  },
  themeConfig: {
    nav: [
      { text: "User guide", link: "/user-guide" },
      { text: "Hints", link: "/hints" },
      { text: "How it works", link: "/how-it-works" },
      { text: "Open PR0L1NE", link: "https://pr0l1ne.com/", target: "_self" },
    ],
    sidebar: [
      {
        text: "Using PR0L1NE",
        items: [
          { text: "User guide", link: "/user-guide" },
          { text: "SQL", link: "/sql" },
          { text: "Hints: viz: comments", link: "/hints" },
          { text: "Limitations and troubleshooting", link: "/limitations" },
        ],
      },
      {
        text: "Under the hood",
        items: [
          { text: "How it works", link: "/how-it-works" },
          { text: "Development", link: "/development" },
          { text: "Roadmap ideas", link: "/roadmap" },
        ],
      },
    ],
    outline: { level: [2, 3], label: "On this page" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: { message: "PR0L1NE is open source (AGPL-3.0).", copyright: "" },
  },
});
