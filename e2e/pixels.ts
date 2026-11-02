/** Comparing screenshots in the browser, without image libraries: decoded on a 2D canvas in the page. */
import type { Page } from "@playwright/test";

/** How many pixels differ between two PNG screenshots of the same size (a channel more than `channel` off), of how many. */
export function pixelDifference(
  page: Page,
  a: Buffer,
  b: Buffer,
  channel: number,
): Promise<{ differ: number; total: number }> {
  return page.evaluate(
    async ([one, two, most]) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [x, y] = await Promise.all([load(one as string), load(two as string)]);
      const total = x.width * x.height;
      if (x.width !== y.width || x.height !== y.height) return { differ: total, total };
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const p = pixels(x);
      const q = pixels(y);
      let differ = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.max(
          Math.abs(p[i] - q[i]),
          Math.abs(p[i + 1] - q[i + 1]),
          Math.abs(p[i + 2] - q[i + 2]),
          Math.abs(p[i + 3] - q[i + 3]),
        );
        if (d > (most as number)) differ++;
      }
      return { differ, total };
    },
    [a.toString("base64"), b.toString("base64"), channel] as const,
  );
}

/**
 * How many pixels a window's canvas draws on: its screenshot against the
 * same with the canvas hidden. The same for Canvas 2D and WebGL (whose
 * drawing can't be read back once shown).
 */
export async function inked(page: Page, window: string): Promise<number> {
  const canvas = page.locator(`${window} canvas.viewport-canvas`);
  const area = page.locator(window);
  const drawn = await area.screenshot();
  await canvas.evaluate((c) => {
    (c as HTMLElement).style.visibility = "hidden";
  });
  const bare = await area.screenshot();
  await canvas.evaluate((c) => {
    (c as HTMLElement).style.visibility = "";
  });
  return (await pixelDifference(page, drawn, bare, 0)).differ;
}
