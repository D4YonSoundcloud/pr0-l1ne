// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Mark, mark, parseSelector, TextMark, toSvg } from "./drawing";

/** The same steps on a DOM element and on a mark, compared by outerHTML. */
function both(
  steps: (el: { setAttribute(n: string, v: string): void; classList: Mark["classList"] | DOMTokenList }) => void,
) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const m = new Mark("g");
  steps(el as never);
  steps(m as never);
  return { dom: el.outerHTML, mark: toSvg(m).outerHTML };
}

describe("Mark", () => {
  it("keeps attributes in the DOM's order: a set attribute keeps its place, a new one goes last", () => {
    const r = both((el) => {
      el.setAttribute("x", "1");
      el.setAttribute("class", "a");
      el.setAttribute("x", "2");
      el.classList.add("b");
      el.setAttribute("y", "3");
    });
    expect(r.mark).toBe(r.dom);
  });

  it("adds a class attribute last when there wasn't one, and normalizes classes as the DOM does", () => {
    const r = both((el) => {
      el.setAttribute("x", "1");
      el.classList.add("is-moved");
      el.classList.add("is-moved");
      el.classList.toggle("on");
      el.classList.toggle("on");
      el.classList.toggle("on", true);
    });
    expect(r.mark).toBe(r.dom);
    const spaced = both((el) => {
      el.setAttribute("class", "  a   b a ");
      el.classList.add("c");
    });
    expect(spaced.mark).toBe(spaced.dom);
    const removed = both((el) => {
      el.classList.remove("x"); // no class attribute: nothing is added
      el.setAttribute("id", "n");
    });
    expect(removed.mark).toBe(removed.dom);
    const m = mark("g", { class: "a b" });
    m.classList.remove("a");
    expect(m.getAttribute("class")).toBe("b");
    expect(m.classList.contains("b")).toBe(true);
  });

  it("puts inline styles where the DOM does, and gives them to toSvg", () => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const m = new Mark("svg");
    for (const target of [el, m] as const) {
      target.setAttribute("class", "memory-svg");
      target.style.setProperty("--font-size", "13px");
      target.setAttribute("width", "10");
      target.style.setProperty("--small-size", "11px");
      target.style.setProperty("--font-size", "14px");
    }
    expect(toSvg(m).outerHTML).toBe(el.outerHTML);
    expect(m.getAttribute("style")).toBe("--font-size: 14px; --small-size: 11px;");
    m.removeAttribute("style");
    expect(m.styleProperties).toEqual([]);
  });

  it("builds trees: text, moving a mark, prepend, before, remove", () => {
    const root = mark("g", {}, mark("rect", { id: "r" }), "text", null, false, undefined);
    expect(root.childNodes).toHaveLength(2);
    expect(root.textContent).toBe("text");
    expect(root.children.map((c) => c.localName)).toEqual(["rect"]);
    const other = mark("g");
    other.append(root.children[0]); // moves, as in the DOM
    expect(root.children).toEqual([]);
    expect(other.children[0].parentElement).toBe(other);
    const first = mark("circle");
    other.prepend(first, "t");
    expect(other.childNodes.map((c) => (c instanceof TextMark ? "#text" : c.localName))).toEqual([
      "circle",
      "#text",
      "rect",
    ]);
    other.children[1].before(mark("line"), null);
    expect(other.children.map((c) => c.localName)).toEqual(["circle", "line", "rect"]);
    first.remove();
    first.remove(); // already out: nothing
    mark("g").before(mark("x")); // no parent: nothing
    expect(other.children.map((c) => c.localName)).toEqual(["line", "rect"]);
    expect(other.children[1].id).toBe("r");
    expect(mark("g").id).toBe("");
    expect(other.attributes).toEqual([]);
    expect(mark("g", { a: 1, b: null, c: false, d: "x" }).attributes).toEqual([
      { name: "a", value: "1" },
      { name: "d", value: "x" },
    ]);
  });

  it("finds marks with simple selectors, as querySelector does", () => {
    const tree = mark(
      "svg",
      {},
      mark(
        "g",
        { class: "boxes" },
        mark("g", { class: "node is-moved", "data-node-key": "obj:o4", "data-flip": "x" }),
        mark("g", { class: "node", "data-node-key": "frame:0:Global" }, mark("rect", { class: "node-hit" })),
      ),
      mark("defs", {}, mark("marker", { id: "arrow-ref" }, mark("path"))),
    );
    const key = (m: Mark | null) => m?.getAttribute("data-node-key");
    expect(key(tree.querySelector(`.node[data-node-key="${CSS.escape("obj:o4")}"]`))).toBe("obj:o4");
    expect(key(tree.querySelector(".node.is-moved"))).toBe("obj:o4");
    expect(tree.querySelectorAll(".node")).toHaveLength(2);
    expect(tree.querySelectorAll("[data-flip], marker[id]")).toHaveLength(2);
    expect(tree.querySelector("marker#arrow-ref")?.localName).toBe("marker");
    expect(tree.querySelectorAll("*")).toHaveLength(7);
    expect(tree.querySelector("[data-node-key='frame:0:Global']")).not.toBeNull();
    expect(tree.querySelector("[data-node-key=nope]")).toBeNull();
    expect(tree.querySelector(".missing")).toBeNull();
    const hit = tree.querySelector(".node-hit")!;
    expect(key(hit.closest(".node"))).toBe("frame:0:Global");
    expect(hit.closest(".nothing")).toBeNull();
    expect(hit.matches("rect.node-hit")).toBe(true);
  });

  it("reads CSS escapes, and rejects what it can't do", () => {
    expect(parseSelector(`[k="a\\:b"]`)[0].attrs[0]).toEqual({ name: "k", value: "a:b" });
    expect(parseSelector(`.\\31 23`)[0].classes).toEqual(["123"]);
    expect(parseSelector(`[k="a,b"], .c`)).toHaveLength(2);
    expect(parseSelector(`[k="a\\"b"]`)[0].attrs[0].value).toBe('a"b');
    for (const bad of ["g rect", "g > rect", ".a,", "g:hover", ".a g"]) {
      expect(() => parseSelector(bad), bad).toThrow(SyntaxError);
    }
  });
});

describe("toSvg", () => {
  it("makes the same elements, attributes and text", () => {
    const m = mark("svg", { class: "s", xmlns: "http://www.w3.org/2000/svg" }, mark("text", { x: 1 }, "a < b"));
    const el = toSvg(m);
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.outerHTML).toBe('<svg class="s" xmlns="http://www.w3.org/2000/svg"><text x="1">a &lt; b</text></svg>');
  });
});
