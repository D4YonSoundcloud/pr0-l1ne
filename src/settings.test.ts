import { describe, expect, it } from "vitest";
import { createSettings, type KeyValueStorage, PROGRAMS_KEY, SETTINGS_VERSION } from "./settings";

/** An in-memory stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** Storage that fails like a blocked or full localStorage. */
const brokenStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("full");
  },
  key: () => {
    throw new Error("blocked");
  },
  get length(): number {
    throw new Error("blocked");
  },
};

describe("settings", () => {
  it("have the app's defaults on a first visit", () => {
    const s = createSettings(fakeStorage());
    expect(s.language.get()).toBeNull();
    expect(s.code("python").get()).toBeNull();
    expect(s.memoryMode.get()).toBe("arrows");
    expect(s.showOutput.get()).toBe(true);
    expect(s.dimOutput.get()).toBe(false);
    expect(s.sizes.get()).toBe(false);
    expect(s.complexityLabels.get()).toBe(true);
    expect(s.measureLabels.get()).toBe(true);
    expect(s.measureLimit.get()).toBeNull();
    expect(s.loopMode.get()).toBe("stacked");
    expect(s.loopVertical.get()).toBe(false);
    expect(s.speed.get()).toBeNull();
    expect(s.swapped.get()).toBe(false);
    expect(s.split.get()).toBeNull();
    expect(s.renderer.get()).toBe("svg");
  });

  it("remember values under pr0l1ne: keys", () => {
    const storage = fakeStorage();
    const s = createSettings(storage);
    s.language.set("python");
    s.code("python").set("print(1)");
    s.speed.set(4);
    s.dimOutput.set(true);
    s.swapped.set(true);
    s.loopMode.set("animated");
    s.renderer.set("canvas");
    expect(storage.data.get("pr0l1ne:renderer")).toBe("canvas");
    expect(storage.data.get("pr0l1ne:language")).toBe("python");
    expect(storage.data.get("pr0l1ne:code:python")).toBe("print(1)");
    expect(storage.data.get("pr0l1ne:layout")).toBe("swapped");

    const again = createSettings(storage);
    expect(again.language.get()).toBe("python");
    expect(again.speed.get()).toBe(4);
    expect(again.dimOutput.get()).toBe(true);
    expect(again.swapped.get()).toBe(true);
    expect(again.loopMode.get()).toBe("animated");
    expect(again.renderer.get()).toBe("canvas");
  });

  it("ignore saved values that don't make sense", () => {
    const s = createSettings(
      fakeStorage({
        "pr0l1ne:settings-version": "1",
        "pr0l1ne:language": "cobol",
        "pr0l1ne:memory-mode": "sideways",
        "pr0l1ne:speed": "fast",
        "pr0l1ne:split": "",
        "pr0l1ne:renderer": "webgl",
      }),
    );
    expect(s.renderer.get()).toBe("svg");
    expect(s.language.get()).toBeNull();
    expect(s.memoryMode.get()).toBe("arrows");
    expect(s.speed.get()).toBeNull();
    expect(s.split.get()).toBeNull();
  });

  describe("moving from algoviz: keys", () => {
    const before = {
      "algoviz:language": "python",
      "algoviz:code:python": "x = 1",
      "algoviz:open:python": "p1",
      "algoviz:programs": '[{"id":"p1"}]',
      "algoviz:growth-kept:python": "[]",
      "algoviz:auto-fit:memory": '{"on":true}',
      "algoviz:split": "35",
      "algoviz:speed": "4",
    };

    it("copies every setting and saved program over", () => {
      const storage = fakeStorage(before);
      const s = createSettings(storage);
      expect(s.language.get()).toBe("python");
      expect(s.code("python").get()).toBe("x = 1");
      expect(s.openProgram("python").get()).toBe("p1");
      expect(storage.data.get(PROGRAMS_KEY)).toBe('[{"id":"p1"}]');
      expect(s.growthKept("python").get()).toBe("[]");
      expect(s.autoFit("memory").get()).toBe('{"on":true}');
      expect(s.split.get()).toBe(35);
      expect(s.speed.get()).toBe(4);
      expect(storage.data.get("pr0l1ne:settings-version")).toBe(String(SETTINGS_VERSION));
    });

    it("leaves the old keys in place, so an older build still finds them", () => {
      const storage = fakeStorage(before);
      createSettings(storage);
      expect(storage.data.get("algoviz:programs")).toBe('[{"id":"p1"}]');
    });

    it("runs once: later changes aren't overwritten by the old keys", () => {
      const storage = fakeStorage(before);
      createSettings(storage).speed.set(8);
      expect(createSettings(storage).speed.get()).toBe(8);
    });

    it("never overwrites a pr0l1ne: value that's already there", () => {
      const storage = fakeStorage({ ...before, "pr0l1ne:language": "javascript" });
      expect(createSettings(storage).language.get()).toBe("javascript");
    });

    it("keeps code saved before JavaScript support existed, as Python", () => {
      const storage = fakeStorage({ "algoviz:code": "print('old')" });
      expect(createSettings(storage).code("python").get()).toBe("print('old')");
    });

    it("prefers the newer per-language code over the oldest key", () => {
      const storage = fakeStorage({ "algoviz:code": "old", "algoviz:code:python": "newer" });
      expect(createSettings(storage).code("python").get()).toBe("newer");
    });
  });

  it("last for the visit when storage is unavailable", () => {
    const s = createSettings(brokenStorage);
    expect(s.language.get()).toBeNull();
    s.language.set("typescript");
    s.speed.set(1);
    expect(s.language.get()).toBe("typescript");
    expect(s.speed.get()).toBe(1);
  });

  it("work with no storage at all", () => {
    const s = createSettings(null);
    s.memoryMode.set("nested");
    expect(s.memoryMode.get()).toBe("nested");
    expect(s.programStorage()).toBeNull();
  });
});
