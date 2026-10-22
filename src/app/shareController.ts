/**
 * Share links (share/link.ts): the Share button, and opening a link.
 *
 * Sharing copies a link holding the code in the editor and its language.
 * Opening one (the page loaded with `#v1.` in its address, or a link pasted
 * into the address bar of an open page) puts that program in the editor as
 * a "Shared program", and runs nothing: it's someone else's code, so the
 * banner says so, with Run and Save buttons. Nothing of the person's own is
 * touched until they act: their saved programs, and the unsaved code they
 * had in that language, stay as they were until they edit the shared one
 * (then it's their unsaved code, as if they'd typed it).
 */
import { decodeShare, encodeShare, isShareFragment, ShareLinkError, shareUrl, TooLongToShare } from "../share/link";
import type { BannerTone } from "./banner";
import { escapeHtml } from "./html";
import type { AppStore } from "./state";

export interface ShareElements {
  share: HTMLButtonElement;
  /** A live region for screen readers ("Link copied"). */
  announce: HTMLElement;
}

export interface ShareOptions {
  app: AppStore;
  els: ShareElements;
  editor: { getCode(): string };
  setBanner(html: string | null, tone?: BannerTone): void;
  /** Is this a language the app has? */
  isLanguage(id: string): boolean;
  /** Its name, for the banner ("Python"). */
  languageLabel(id: string): string;
  /**
   * Put a shared program in the editor, switching language if it's in
   * another one, and mark it shared (app.openShared). Don't run it.
   */
  open(program: { language: string; code: string }): void;
  /** Would opening something else lose work? (Asked before a link pasted into an open page replaces it.) */
  hasUnsavedChanges(): boolean;
  confirm?(message: string): boolean;
  /** For tests: where the page is, its history, and the clipboard. */
  location?: Pick<Location, "hash" | "href" | "pathname" | "search">;
  history?: Pick<History, "replaceState">;
  clipboard?: Pick<Clipboard, "writeText"> | null;
  win?: Pick<Window, "addEventListener">;
}

const FEEDBACK_MS = 1500;

export class ShareController {
  /** The code of the shared program in the editor, as it came: until it's edited. */
  private pristine: string | null = null;
  private feedbackTimer = 0;
  private readonly location: NonNullable<ShareOptions["location"]>;
  private readonly history: NonNullable<ShareOptions["history"]>;

  constructor(private readonly options: ShareOptions) {
    this.location = options.location ?? window.location;
    this.history = options.history ?? window.history;
    options.els.share.addEventListener("click", () => void this.share());
    // A link pasted into the address bar of an open page changes only the
    // part after `#`: the page doesn't reload, so open it here.
    (options.win ?? window).addEventListener("hashchange", () => {
      if (!isShareFragment(this.location.hash)) return;
      if (options.hasUnsavedChanges()) {
        const confirm = options.confirm ?? ((m: string) => window.confirm(m));
        if (!confirm("Open the shared program? What's in the editor now isn't saved.")) return;
      }
      void this.openFromLocation();
    });
  }

  /**
   * The editor changed to `code`. True while it's the shared program as it
   * came (just put there): nothing to remember or run. Otherwise, if it was
   * the shared program, it's been edited: it's ordinary unsaved code now,
   * and the address no longer says it's the link's.
   */
  isUnedited(code: string): boolean {
    if (this.pristine === null) return false;
    if (code === this.pristine && this.options.app.get().shared) return true;
    this.pristine = null;
    this.options.app.keepShared();
    this.clearAddress();
    return false;
  }

  /** The program left the editor some other way (opened another, switched language, saved it). */
  forget(): void {
    this.pristine = null;
  }

  /**
   * Open the share link in the page's address, if there is one. Resolves
   * true if a program was opened (so the app doesn't run what was there
   * before), false if there's no link, or it couldn't be opened (the
   * banner says why).
   */
  async openFromLocation(): Promise<boolean> {
    const { hash } = this.location;
    if (!isShareFragment(hash)) return false;
    const { setBanner, isLanguage, languageLabel, open } = this.options;
    try {
      const program = await decodeShare(hash, isLanguage);
      this.pristine = program.code;
      open(program);
      setBanner(
        `<strong>This ${escapeHtml(languageLabel(program.language))} program came from a share link.</strong> ` +
          "It's someone else's code: read it before you run it. " +
          '<button type="button" class="banner-link" data-action="run">Run it</button> · ' +
          '<button type="button" class="banner-link" data-action="save-shared">Save to my programs</button>',
        "shared",
      );
      return true;
    } catch (error) {
      const message =
        error instanceof ShareLinkError
          ? error.message
          : "This link couldn't be opened: copy the whole link and try again.";
      setBanner(`<strong>Couldn't open the share link.</strong> ${escapeHtml(message)}`, "runtime");
      this.clearAddress();
      return false;
    }
  }

  /** The Share button: copy a link to the code in the editor. */
  async share(): Promise<void> {
    const { app, editor, setBanner, els } = this.options;
    let url: string;
    try {
      const fragment = await encodeShare({ language: app.get().language, code: editor.getCode() });
      url = shareUrl(this.page(), fragment);
    } catch (error) {
      const message = error instanceof TooLongToShare ? error.message : "This browser can't make share links.";
      setBanner(escapeHtml(message), "hint");
      return;
    }
    const clipboard = this.options.clipboard === undefined ? navigator.clipboard : this.options.clipboard;
    try {
      if (!clipboard) throw new Error("no clipboard");
      await clipboard.writeText(url);
    } catch {
      // No clipboard here (or it was refused): show the link to copy by hand.
      setBanner(
        `Copy this link to share the program: <input class="banner-input" type="text" readonly aria-label="Share link" value="${escapeHtml(url)}">`,
        "hint",
      );
      return;
    }
    els.announce.textContent = "Link copied";
    els.share.textContent = "Link copied";
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = window.setTimeout(() => {
      els.share.textContent = "Share";
    }, FEEDBACK_MS);
  }

  /** This page's address without any fragment, for links to point at. */
  private page(): string {
    const url = new URL(this.location.href);
    url.hash = "";
    return url.href;
  }

  /** Take the link out of the address bar (the editor no longer shows its program). */
  private clearAddress(): void {
    if (!isShareFragment(this.location.hash)) return;
    this.history.replaceState(null, "", `${this.location.pathname}${this.location.search}`);
  }
}
