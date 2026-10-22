// @vitest-environment jsdom
/**
 * The Share button and opening share links, with a fake address, history
 * and clipboard: a link opens its program without running it or touching
 * the person's own work, and a bad link says why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeShare, MAX_FRAGMENT } from "../share/link";
import { ShareController, type ShareOptions } from "./shareController";
import { makeApp, showJavaScript } from "./testHelpers";

const isLanguage = (id: string) => ["python", "javascript", "typescript"].includes(id);

function setup(hash = "", options: Partial<ShareOptions> = {}) {
  const { app, settings } = makeApp();
  document.body.innerHTML = `<button id="share">Share</button><div id="announce"></div>`;
  const els = {
    share: document.getElementById("share") as HTMLButtonElement,
    announce: document.getElementById("announce")!,
  };
  const location = { hash, href: `https://pr0l1ne.com/${hash}`, pathname: "/", search: "" };
  const history = {
    replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
      location.hash = "";
      location.href = `https://pr0l1ne.com${url}`;
    }),
  };
  const banners: { html: string | null; tone?: string }[] = [];
  const opened: { language: string; code: string }[] = [];
  const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
  let code = "let mine = 1;\n";
  const listeners: Record<string, () => void> = {};
  const controller = new ShareController({
    app,
    els,
    editor: { getCode: () => code },
    setBanner: (html, tone) => banners.push({ html, tone }),
    isLanguage,
    languageLabel: (id) => ({ python: "Python", javascript: "JavaScript", typescript: "TypeScript" })[id] ?? id,
    open(program) {
      opened.push(program);
      app.openShared();
      code = program.code;
    },
    hasUnsavedChanges: () => false,
    location,
    history,
    clipboard,
    win: { addEventListener: (type: string, f: () => void) => (listeners[type] = f) } as unknown as Window,
    ...options,
  });
  return {
    app,
    settings,
    els,
    controller,
    location,
    history,
    banners,
    opened,
    clipboard,
    listeners,
    setCode: (c: string) => (code = c),
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("opening a share link", () => {
  it("puts its program in the editor as a shared program, says whose it is, and runs nothing", async () => {
    const fragment = await encodeShare({ language: "python", code: "a = [3, 1, 2]\n" });
    const s = setup(`#${fragment}`);
    expect(await s.controller.openFromLocation()).toBe(true);
    expect(s.opened).toEqual([{ language: "python", code: "a = [3, 1, 2]\n" }]);
    expect(s.app.get().shared).toBe(true);
    expect(s.banners.at(-1)?.tone).toBe("shared");
    expect(s.banners.at(-1)?.html).toContain("This Python program came from a share link");
    expect(s.banners.at(-1)?.html).toContain('data-action="run"');
    expect(s.banners.at(-1)?.html).toContain('data-action="save-shared"');
    // The editor showing it isn't an edit: nothing to remember or run.
    expect(s.controller.isUnedited("a = [3, 1, 2]\n")).toBe(true);
    expect(s.history.replaceState).not.toHaveBeenCalled();
  });

  it("once edited, it's ordinary unsaved code, and the address no longer holds the link", async () => {
    const s = setup(`#${await encodeShare({ language: "javascript", code: "let a = 1;\n" })}`);
    await s.controller.openFromLocation();
    expect(s.controller.isUnedited("let a = 12;\n")).toBe(false);
    expect(s.app.get().shared).toBe(false);
    expect(s.history.replaceState).toHaveBeenCalledWith(null, "", "/");
    // From then on, edits are just edits.
    expect(s.controller.isUnedited("let a = 1;\n")).toBe(false);
  });

  it("does nothing without a link", async () => {
    const s = setup("#somewhere");
    expect(await s.controller.openFromLocation()).toBe(false);
    expect(s.banners).toEqual([]);
    expect(s.controller.isUnedited("anything")).toBe(false);
  });

  it("says why a link can't be opened, and takes it out of the address", async () => {
    const s = setup("#v1.abc$");
    expect(await s.controller.openFromLocation()).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.banners.at(-1)).toEqual({
      html: expect.stringContaining("Couldn't open the share link"),
      tone: "runtime",
    });
    expect(s.history.replaceState).toHaveBeenCalled();
  });

  it("escapes what it shows from a link", async () => {
    const fragment = await encodeShare({ language: "javascript", code: "x" });
    const s = setup(`#${fragment}`, { languageLabel: () => "<img src=x onerror=alert(1)>" });
    await s.controller.openFromLocation();
    expect(s.banners.at(-1)?.html).not.toContain("<img");
    expect(s.banners.at(-1)?.html).toContain("&lt;img");
  });

  it("opens a link pasted into an open page, asking first if there's unsaved work", async () => {
    const confirm = vi.fn(() => false);
    const s = setup("", { hasUnsavedChanges: () => true, confirm });
    s.location.hash = `#${await encodeShare({ language: "python", code: "b = 2\n" })}`;
    s.listeners.hashchange();
    expect(confirm).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.opened).toEqual([]);
    confirm.mockReturnValue(true);
    s.listeners.hashchange();
    await vi.waitFor(() => expect(s.opened).toHaveLength(1));
    // Other fragments are left alone.
    s.location.hash = "#section";
    s.listeners.hashchange();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("the Share button", () => {
  it("copies a link to the code in the editor, and says so", async () => {
    const s = setup();
    await showJavaScript(s.app, "let a = 1;\n");
    s.setCode("let shared = [1, 2];\n");
    await s.controller.share();
    const url = s.clipboard.writeText.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/pr0l1ne\.com\/#v1\./);
    expect(s.els.share.textContent).toBe("Link copied");
    expect(s.els.announce.textContent).toBe("Link copied");
    // And the link opens as that program.
    const back = setup(new URL(url).hash);
    await back.controller.openFromLocation();
    expect(back.opened).toEqual([{ language: "javascript", code: "let shared = [1, 2];\n" }]);
  });

  it("points at this page, without any link already in its address", async () => {
    const s = setup(`#${await encodeShare({ language: "python", code: "old = 1\n" })}`);
    s.location.href = `https://preview.pr0l1ne.pages.dev/?x=1${s.location.hash}`;
    await s.controller.share();
    expect(s.clipboard.writeText.mock.calls[0][0]).toMatch(/^https:\/\/preview\.pr0l1ne\.pages\.dev\/\?x=1#v1\./);
  });

  it("shows the link to copy by hand when there's no clipboard", async () => {
    const s = setup("", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    await s.controller.share();
    expect(s.banners.at(-1)?.html).toMatch(/<input class="banner-input"[^>]*value="https:\/\/pr0l1ne\.com\/#v1\./);
    const none = setup("", { clipboard: null });
    await none.controller.share();
    expect(none.banners.at(-1)?.html).toContain("banner-input");
  });

  it("says when a program is too long for a link", async () => {
    const s = setup();
    let code = "";
    let seed = 7;
    while (code.length < MAX_FRAGMENT * 1.2) {
      seed = (seed * 16807) % 2147483647;
      code += String.fromCharCode(33 + (seed % 90));
    }
    s.setCode(code);
    await s.controller.share();
    expect(s.clipboard.writeText).not.toHaveBeenCalled();
    expect(s.banners.at(-1)?.html).toContain("too long to share as a link");
  });
});
