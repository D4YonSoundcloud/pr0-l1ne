/**
 * Which renderer a test's "canvas" means. The chromium-webgl project
 * (playwright.config.ts) runs the tests that draw on the canvas again with
 * WebGL: every "canvas" in them is "webgl" there, so each passes on both
 * backends of the same scene builder.
 */
import { test } from "@playwright/test";

export type Kind = "svg" | "canvas";

/** The renderer setting for a kind, in the project running now. */
export function rendererFor(kind: Kind): string {
  return kind === "canvas" && test.info().project.name.endsWith("-webgl") ? "webgl" : kind;
}
