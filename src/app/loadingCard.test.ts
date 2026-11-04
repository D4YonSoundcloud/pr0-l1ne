// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LoadingCard } from "./loadingCard";

function card() {
  document.body.innerHTML = `<div id="card" hidden>
    <p><span class="loading-verb">Downloading</span> <span class="loading-what"></span><span class="loading-percent"></span></p>
    <div class="loading-bar"><span></span></div>
    <span class="loading-size"></span>
  </div>`;
  const el = document.getElementById("card")!;
  return { el, card: new LoadingCard(el) };
}

describe("LoadingCard", () => {
  it("shows what's downloading, and how big it is, while it loads", () => {
    const { el, card: loading } = card();
    loading.show({ kind: "loading" }, { name: "PostgreSQL", size: "8 MB" });
    expect(loading.visible).toBe(true);
    expect(el.querySelector(".loading-what")?.textContent).toBe("PostgreSQL");
    expect(el.querySelector(".loading-size")?.textContent).toBe("8 MB");
    loading.show({ kind: "ready", label: "Ready" }, { name: "PostgreSQL", size: "8 MB" });
    expect(loading.visible).toBe(false);
  });

  it("fills its bar as the bytes are counted, then says it's starting up", () => {
    const { el, card: loading } = card();
    const python = { name: "Python", size: "6 MB" };
    const bar = el.querySelector<HTMLElement>(".loading-bar")!;
    loading.show({ kind: "loading" }, python);
    expect(bar.classList.contains("is-counted")).toBe(false); // not counted yet: it moves to and fro
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    loading.show({ kind: "loading", download: { loaded: 3_000_000, total: 12_000_000 } }, python);
    expect(el.querySelector(".loading-verb")?.textContent).toBe("Downloading");
    expect(el.querySelector(".loading-percent")?.textContent).toBe(" · 25%");
    expect(bar.classList.contains("is-counted")).toBe(true);
    expect(bar.querySelector("span")!.style.width).toBe("25%");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    loading.show({ kind: "loading", download: { loaded: 12_000_000, total: 12_000_000 } }, python);
    expect(el.querySelector(".loading-verb")?.textContent).toBe("Starting");
    expect(el.querySelector(".loading-percent")?.textContent).toBe("");
    expect(bar.classList.contains("is-counted")).toBe(false); // starting up can't be counted
    expect(bar.querySelector("span")!.style.width).toBe("");
  });

  it("stays hidden for a language that's ready at once, and after a failure", () => {
    const { card: loading } = card();
    loading.show({ kind: "loading" }, null);
    expect(loading.visible).toBe(false);
    loading.show({ kind: "failed", message: "offline" }, { name: "Python", size: "6 MB" });
    expect(loading.visible).toBe(false);
  });
});
