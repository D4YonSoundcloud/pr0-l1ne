import { describe, expect, it } from "vitest";
import { ProgramStore, StorageFullError, type ProgramStorage } from "./programs";

function fakeStorage(): ProgramStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function clock() {
  let t = 1000;
  return () => (t += 1);
}

describe("ProgramStore", () => {
  it("saves, lists newest first, and keeps languages separate", () => {
    const store = new ProgramStore(fakeStorage(), clock());
    store.save({ name: "Sort", language: "python", code: "a" });
    store.save({ name: "Search", language: "python", code: "b" });
    store.save({ name: "Sort", language: "javascript", code: "c" });
    expect(store.list("python").map((p) => p.name)).toEqual(["Search", "Sort"]);
    expect(store.list("javascript").map((p) => p.code)).toEqual(["c"]);
  });

  it("updates in place when given an id", () => {
    const store = new ProgramStore(fakeStorage(), clock());
    const first = store.save({ name: "Sort", language: "python", code: "v1" });
    const second = store.save({ id: first.id, name: "Sort", language: "python", code: "v2" });
    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(store.list("python")).toHaveLength(1);
    expect(store.get(first.id)?.code).toBe("v2");
  });

  it("finds names case-insensitively within a language", () => {
    const store = new ProgramStore(fakeStorage(), clock());
    store.save({ name: "Bubble Sort ", language: "python", code: "" });
    expect(store.findByName("python", "bubble sort")?.name).toBe("Bubble Sort");
    expect(store.findByName("javascript", "bubble sort")).toBeUndefined();
  });

  it("removes programs", () => {
    const store = new ProgramStore(fakeStorage(), clock());
    const p = store.save({ name: "Temp", language: "python", code: "" });
    store.remove(p.id);
    expect(store.list("python")).toEqual([]);
  });

  it("persists across store instances", () => {
    const storage = fakeStorage();
    new ProgramStore(storage, clock()).save({ name: "Keep", language: "javascript", code: "x" });
    expect(new ProgramStore(storage).list("javascript")[0].name).toBe("Keep");
  });

  it("ignores corrupt or malformed data", () => {
    const storage = fakeStorage();
    storage.data.set("algoviz:programs", "{not json");
    expect(new ProgramStore(storage).list("python")).toEqual([]);
    storage.data.set("algoviz:programs", JSON.stringify([{ id: 1 }, { id: "a", name: "ok", language: "python", code: "", updatedAt: 1 }]));
    expect(new ProgramStore(storage).list("python").map((p) => p.name)).toEqual(["ok"]);
  });

  it("works in memory when storage is unavailable", () => {
    const store = new ProgramStore(null, clock());
    store.save({ name: "Session", language: "python", code: "" });
    expect(store.list("python")).toHaveLength(1);
  });

  it("reports a full storage clearly", () => {
    const store = new ProgramStore({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
    expect(() => store.save({ name: "Big", language: "python", code: "" })).toThrow(StorageFullError);
  });
});
