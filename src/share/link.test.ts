/**
 * The share link format: programs come back exactly as they went, and
 * anything else (damaged, cut off, too big, another version, the wrong
 * shape) is turned down, saying why.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES } from "../examples/index";
import {
  decodeShare,
  encodeShare,
  isShareFragment,
  MAX_FRAGMENT,
  ShareLinkError,
  shareUrl,
  TooLongToShare,
} from "./link";

const isLanguage = (id: string) => ["python", "javascript", "typescript"].includes(id);
const pack = (value: unknown) =>
  `v1.${deflateRawSync(Buffer.from(typeof value === "string" ? value : JSON.stringify(value))).toString("base64url")}`;
const fails = async (fragment: string, message: RegExp) => {
  const error = await decodeShare(fragment, isLanguage).catch((e: unknown) => e);
  expect(error, fragment.slice(0, 40)).toBeInstanceOf(ShareLinkError);
  expect((error as Error).message).toMatch(message);
};

describe("share links", () => {
  it("bring a program back exactly as it went, whatever's in it", async () => {
    for (const code of [
      "a = [3, 1, 2]\na.sort()\n",
      "",
      "const s = 'héllo wörld 👋 日本語';\r\nconsole.log(s);\t// tabs, CRLF\n",
      "x".repeat(5000),
      PYTHON_EXAMPLES[0].code,
    ]) {
      const fragment = await encodeShare({ language: "python", code });
      expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(await decodeShare(fragment, isLanguage)).toEqual({ language: "python", code });
      expect(await decodeShare(`#${fragment}`, isLanguage)).toEqual({ language: "python", code });
    }
  });

  it("are short: every example's link is under 1,500 characters, and repetitive code packs small", async () => {
    for (const example of [...JAVASCRIPT_EXAMPLES, ...PYTHON_EXAMPLES]) {
      const fragment = await encodeShare({ language: "javascript", code: example.code });
      expect(fragment.length, example.name).toBeLessThan(1500);
    }
    const long = PYTHON_EXAMPLES.map((e) => e.code).join("\n");
    expect((await encodeShare({ language: "python", code: long })).length).toBeLessThan(long.length / 2);
  });

  it("put the program after the page's address", () => {
    expect(shareUrl("https://pr0l1ne.com/", "v1.abc")).toBe("https://pr0l1ne.com/#v1.abc");
    expect(shareUrl("https://pr0l1ne.com/?x=1#old", "v1.abc")).toBe("https://pr0l1ne.com/?x=1#v1.abc");
  });

  it("know a share link when they see one", () => {
    expect(isShareFragment("#v1.abc")).toBe(true);
    expect(isShareFragment("v2.abc")).toBe(true);
    expect(isShareFragment("#section")).toBe(false);
    expect(isShareFragment("")).toBe(false);
  });

  it("won't make a link too long to paste whole", async () => {
    // Random text barely compresses.
    let code = "";
    let seed = 1;
    while (code.length < MAX_FRAGMENT * 1.2) {
      seed = (seed * 16807) % 2147483647;
      code += String.fromCharCode(33 + (seed % 90));
    }
    await expect(encodeShare({ language: "python", code })).rejects.toBeInstanceOf(TooLongToShare);
    await expect(encodeShare({ language: "python", code })).rejects.toThrow(/too long to share as a link/);
  });

  it("turn down what isn't a whole, well-formed link", async () => {
    await fails("#section", /isn't a PR0L1NE share link/);
    await fails("v2.abc", /newer version/);
    await fails("v1.abc$%", /characters/);
    await fails(`v1.${"A".repeat(MAX_FRAGMENT + 1)}`, /too long/);
    const good = await encodeShare({ language: "python", code: "a = 1\n".repeat(50) });
    await fails(good.slice(0, Math.floor(good.length / 2)), /damaged or cut off/);
    await fails(pack([1, 2]), /isn't a program/);
    await fails(pack("not json"), /isn't a program/);
    await fails(pack({ language: "cobol", code: "x" }), /language/);
    await fails(pack({ language: "toString", code: "x" }), /language/);
    await fails(pack({ language: "python", code: 42 }), /no code/);
    await fails(pack({ language: "python" }), /no code/);
    // Not UTF-8.
    await fails(`v1.${deflateRawSync(Buffer.from([0xff, 0xfe, 0x00])).toString("base64url")}`, /damaged/);
  });

  it("won't unpack a small link into something huge", async () => {
    const bomb = pack({ language: "python", code: "a".repeat(5_000_000) });
    expect(bomb.length).toBeLessThan(MAX_FRAGMENT);
    await fails(bomb, /more than a program could/);
  });

  it("ignore fields a later v1 might add", async () => {
    expect(await decodeShare(pack({ language: "javascript", code: "let a;", title: "x" }), isLanguage)).toEqual({
      language: "javascript",
      code: "let a;",
    });
  });
});
