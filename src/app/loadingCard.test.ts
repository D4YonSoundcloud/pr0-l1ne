// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LoadingCard } from "./loadingCard";

function card() {
  document.body.innerHTML = `<div id="card" hidden><span class="loading-what"></span><span class="loading-size"></span></div>`;
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

  it("stays hidden for a language that's ready at once, and after a failure", () => {
    const { card: loading } = card();
    loading.show({ kind: "loading" }, null);
    expect(loading.visible).toBe(false);
    loading.show({ kind: "failed", message: "offline" }, { name: "Python", size: "6 MB" });
    expect(loading.visible).toBe(false);
  });
});
