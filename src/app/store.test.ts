import { describe, expect, it } from "vitest";
import { Store } from "./store";

describe("Store", () => {
  it("replaces the state on each action and tells listeners what changed", () => {
    const store = new Store({ count: 0, name: "a" });
    const seen: string[] = [];
    store.subscribe((state, previous, action) => seen.push(`${action}: ${previous.count} -> ${state.count}`));
    const before = store.get();
    store.update("increment", { count: 1 });
    expect(store.get()).toEqual({ count: 1, name: "a" });
    expect(before).toEqual({ count: 0, name: "a" }); // the old state is untouched
    expect(seen).toEqual(["increment: 0 -> 1"]);
  });

  it("tells no one when nothing changed", () => {
    const store = new Store({ count: 0 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.update("same", { count: 0 });
    expect(calls).toBe(0);
  });

  it("watches one part of the state", () => {
    const store = new Store({ count: 0, name: "a" });
    const names: string[] = [];
    store.watch(
      (s) => s.name,
      (name, previous) => names.push(`${previous}->${name}`),
    );
    store.update("count", { count: 5 });
    store.update("rename", { name: "b" });
    expect(names).toEqual(["a->b"]);
  });

  it("stops listening when asked", () => {
    const store = new Store({ count: 0 });
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.update("one", { count: 1 });
    stop();
    store.update("two", { count: 2 });
    expect(calls).toBe(1);
  });
});
