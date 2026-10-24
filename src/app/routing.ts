/**
 * Each language has its own address: pr0l1ne.com/python, /javascript,
 * /typescript and /sql (src/site/pages.ts). The address follows the
 * language in the editor, and the language follows the address:
 *
 *   Open /python             Python, whatever was used last
 *   Open pr0l1ne.com         the language used last (JavaScript the first
 *                            time), and the address becomes its page's
 *   Pick a language          the address becomes its page's (a new entry in
 *                            the history, so Back goes to the one before)
 *   Back / Forward           the language of the page gone back to
 *   Open a share link        its language's page (in place: no new entry)
 *
 * The query and the fragment (a share link: #v1...) are kept as they are.
 * The page's title, description and canonical address change with it, so
 * what a browser tab or a search engine running the page shows matches the
 * page that would be served at that address.
 */
import { isLanguageId, type LanguageId } from "../languages";
import { isHomePath, LANGUAGE_PAGES, languageFromPath, SITE } from "../site/pages";

export { languageFromPath };

export interface RoutingOptions {
  /** The language in the editor now. */
  current(): LanguageId;
  /** Switch the editor to this language (Back or Forward to another language's page). */
  switchTo(language: LanguageId): void;
  /** For tests. */
  location?: Pick<Location, "pathname" | "search" | "hash">;
  history?: Pick<History, "pushState" | "replaceState">;
  win?: Pick<Window, "addEventListener">;
  doc?: Document;
}

export class LanguageRoutes {
  private readonly location: NonNullable<RoutingOptions["location"]>;
  private readonly history: NonNullable<RoutingOptions["history"]>;
  private readonly doc: Document;

  constructor(private readonly options: RoutingOptions) {
    this.location = options.location ?? window.location;
    this.history = options.history ?? window.history;
    this.doc = options.doc ?? document;
    (options.win ?? window).addEventListener("popstate", () => {
      const language = languageFromPath(this.location.pathname);
      if (language && language !== options.current()) options.switchTo(language);
      this.describe(options.current());
    });
  }

  /**
   * At start-up, once the language is chosen: on the home page (or any
   * address that isn't a language's), show the language's own address, in
   * place.
   */
  start(): void {
    this.show(this.options.current(), { replace: true });
  }

  /** The editor now has `language`: show its page's address. */
  show(language: LanguageId, { replace = false } = {}): void {
    const page = LANGUAGE_PAGES[language];
    const { pathname, search, hash } = this.location;
    if (languageFromPath(pathname) !== language || !pathname.startsWith(page.path)) {
      const url = `${page.path}${search}${hash}`;
      // From the home page (or a language's page) to another: replace the
      // home page, since going Back to it would only come forward again.
      if (replace || isHomePath(pathname)) this.history.replaceState(null, "", url);
      else this.history.pushState(null, "", url);
    }
    this.describe(language);
  }

  /** The tab's title, the description and the canonical address, for `language`'s page. */
  private describe(language: LanguageId): void {
    if (!isLanguageId(language)) return;
    const page = LANGUAGE_PAGES[language];
    const { doc } = this;
    doc.title = page.title;
    doc.querySelector('link[rel="canonical"]')?.setAttribute("href", `${SITE}${page.path}`);
    doc.querySelector('meta[name="description"]')?.setAttribute("content", page.description);
    doc.querySelector('meta[property="og:url"]')?.setAttribute("content", `${SITE}${page.path}`);
  }
}
