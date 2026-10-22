/**
 * Share links: a program packed into the part of a link after `#`.
 *
 *   https://pr0l1ne.com/#v1.bVJLbsIwEN1zitkAkvA...
 *                       └─┘ └──── the program, packed ────┘
 *                       version
 *
 * Packing: {"language": "python", "code": "..."} as JSON, compressed with
 * the browser's own deflate (CompressionStream), then written in base64url
 * (letters, digits, `-` and `_`: safe in a link as is).
 *
 * The part after `#` (the fragment) never leaves the browser: it isn't sent
 * to the server with the page request, so a shared program goes from the
 * person who shared it straight to whoever opens the link. Nothing is
 * stored anywhere, and the links work as long as the site does.
 *
 * A link comes from someone else, so unpacking checks everything (see
 * decodeShare): the version, the characters, the size before and after
 * decompressing (a tiny link can't unpack into gigabytes), the JSON, the
 * language and the code. The code is only ever put in the editor as text,
 * and isn't run until the person presses Run (see app/shareController.ts).
 *
 * The version is part of the format's promise: links say `v1.` forever.
 * A later format would be `v2.`, and the app keeps opening `v1.` links.
 *
 * No DOM and nothing of the app's here: the browser tests make links with it.
 */

/** This format's version: the start of every link it makes. */
export const SHARE_VERSION = "v1";

/** The longest link fragment made or opened: what chat apps and forms keep whole, with room to spare. */
export const MAX_FRAGMENT = 32_000;

/** The most text a link may unpack to (a program, as JSON). */
export const MAX_UNPACKED = 1_000_000;

/** A program in a link. */
export interface SharedProgram {
  language: string;
  code: string;
}

/** Why a link couldn't be opened, in words for the person. */
export class ShareLinkError extends Error {}

/** Why a program couldn't be made into a link. */
export class TooLongToShare extends Error {
  constructor(readonly length: number) {
    super(
      `This program is too long to share as a link: packed, it's ${Math.ceil(length / 1000)} KB, and a link can hold ${MAX_FRAGMENT / 1000} KB.`,
    );
  }
}

// ---------------------------------------------------------------- base64url

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------- compression

/**
 * Bytes through a (de)compression stream, read back as they come, giving
 * up as soon as there are more than `limit` of them.
 */
async function through(transform: TransformStream<Uint8Array, Uint8Array>, bytes: Uint8Array, limit: number) {
  const writer = transform.writable.getWriter();
  // Not awaited: the stream takes the bytes as they're read below. A bad
  // input fails the read, which the caller sees; these would only repeat it.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ShareLinkError("This link holds more than a program could: it wasn't opened.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const deflate = (bytes: Uint8Array) =>
  through(
    new CompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>,
    bytes,
    Number.POSITIVE_INFINITY,
  );

const inflate = (bytes: Uint8Array, limit: number) =>
  through(new DecompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>, bytes, limit);

// ---------------------------------------------------------------- making and opening links

/** Can this browser make and open links? (CompressionStream: every current browser.) */
export const canShare = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** A program as a link fragment (without the `#`): `v1.` and the program, packed. */
export async function encodeShare(program: SharedProgram): Promise<string> {
  const json = JSON.stringify({ language: program.language, code: program.code });
  const fragment = `${SHARE_VERSION}.${toBase64Url(await deflate(new TextEncoder().encode(json)))}`;
  if (fragment.length > MAX_FRAGMENT) throw new TooLongToShare(fragment.length);
  return fragment;
}

/** The whole link: the page's address, then `#` and the fragment. */
export function shareUrl(page: string, fragment: string): string {
  const url = new URL(page);
  url.hash = fragment;
  return url.href;
}

/** Is this fragment (with or without its `#`) a share link of any version? */
export function isShareFragment(fragment: string): boolean {
  return /^#?v\d+\./.test(fragment);
}

/**
 * Open a link fragment (with or without its `#`). Throws a ShareLinkError,
 * saying why in the person's words, for anything that isn't a whole,
 * well-formed program in a language `isLanguage` knows.
 */
export async function decodeShare(fragment: string, isLanguage: (id: string) => boolean): Promise<SharedProgram> {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const version = /^(v\d+)\./.exec(text)?.[1];
  if (!version) throw new ShareLinkError("This isn't a PR0L1NE share link.");
  if (version !== SHARE_VERSION) {
    throw new ShareLinkError("This link was made by a newer version of PR0L1NE: reload the page, then open it again.");
  }
  const packed = text.slice(version.length + 1);
  if (packed.length > MAX_FRAGMENT) throw new ShareLinkError("This link is too long to be a PR0L1NE link.");
  if (!/^[A-Za-z0-9_-]+$/.test(packed))
    throw new ShareLinkError("This link is damaged: it has characters a PR0L1NE link never has.");
  if (!canShare())
    throw new ShareLinkError("This browser can't open share links: try a current Chrome, Edge, Firefox or Safari.");

  let json: string;
  try {
    const bytes = await inflate(fromBase64Url(packed), MAX_UNPACKED);
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ShareLinkError) throw error;
    throw new ShareLinkError("This link is damaged or cut off: copy the whole link and try again.");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ShareLinkError("This link is damaged: what's in it isn't a program.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShareLinkError("This link is damaged: what's in it isn't a program.");
  }
  // Fields a later v1 might add are ignored; these two must be right.
  const { language, code } = value as Record<string, unknown>;
  if (typeof language !== "string" || !isLanguage(language)) {
    throw new ShareLinkError("This link's program is in a language PR0L1NE doesn't know.");
  }
  if (typeof code !== "string") throw new ShareLinkError("This link is damaged: it has no code in it.");
  return { language, code };
}
