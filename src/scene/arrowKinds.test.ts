import { describe, expect, it } from "vitest";
import type { HeapObject, Step, Value } from "../trace/types";
import { linkKinds, trackLinkKind } from "./arrowKinds";

const ref = (id: string): Value => ({ kind: "ref", id });
const none: Value = { kind: "prim", type: "none", repr: "None" };
const node = (id: string, fields: [string, Value][], typeName = "Node"): HeapObject => ({
  kind: "object",
  id,
  typeName,
  fields,
});
const step = (locals: [string, Value][], objects: HeapObject[]): Step => ({
  event: "line",
  line: 1,
  stack: [{ id: "f1", func: "Global", line: 1, locals }],
  heap: Object.fromEntries(objects.map((o) => [o.id, o])),
  stdoutLength: 0,
  loops: [],
});

describe("linkKinds", () => {
  it("calls a link to another of the same class next, and anything else a reference", () => {
    const kind = linkKinds(
      step(
        [["head", ref("a")]],
        [
          node("a", [["next", ref("b")]]),
          node("b", [
            ["next", none],
            ["data", ref("l")],
          ]),
          { kind: "list", id: "l", typeName: "list", items: [], length: 0 },
        ],
      ),
    );
    expect(kind("a", "b")).toBe("next");
    expect(kind("b", "l")).toBe("ref");
  });

  it("calls the way back of a two-way link back, by its field's name", () => {
    // Reached from the tail first, but prev is still the way back.
    const kind = linkKinds(
      step(
        [
          ["tail", ref("b")],
          ["head", ref("a")],
        ],
        [
          node("a", [
            ["next", ref("b")],
            ["prev", none],
          ]),
          node("b", [
            ["next", none],
            ["prev", ref("a")],
          ]),
        ],
      ),
    );
    expect(kind("a", "b")).toBe("next");
    expect(kind("b", "a")).toBe("back");
  });

  it("calls a link back into the links it came along a cycle", () => {
    const kind = linkKinds(
      step(
        [["head", ref("a")]],
        [node("a", [["next", ref("b")]]), node("b", [["next", ref("c")]]), node("c", [["next", ref("b")]])],
      ),
    );
    expect(kind("a", "b")).toBe("next");
    expect(kind("b", "c")).toBe("next");
    expect(kind("c", "b")).toBe("cycle");
  });

  it("names links in a loop row's list or tree by field", () => {
    expect(trackLinkKind("next", "list", false)).toBe("next");
    expect(trackLinkKind("next", "list", true)).toBe("cycle");
    expect(trackLinkKind("prev", "list", true)).toBe("back");
    expect(trackLinkKind("left", "tree", false)).toBe("tree");
    expect(trackLinkKind("parent", "tree", false)).toBe("back");
  });
});
