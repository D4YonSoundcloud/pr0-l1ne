/** The instrumenter: how it names functions, finds loops and reports what it can't parse. */

import * as t from "@babel/types";
import { describe, expect, it } from "vitest";
import { InstrumentError, instrument, instrumentAst, parseProgram } from "./instrument";
import { traceJavaScript } from "./trace";

/** The name each frame had while the program ran. */
async function frameNames(source: string): Promise<string[]> {
  const trace = await traceJavaScript(source);
  expect(trace.error).toBeNull();
  const names = new Set<string>();
  for (const step of trace.steps) for (const frame of step.stack) names.add(frame.func);
  names.delete("Global");
  return [...names];
}

describe("function names", () => {
  it("come from declarations, variables, assignments and properties", async () => {
    const names = await frameNames(`function declared() {}
const expr = function () {};
let later;
later = () => {};
const obj = {};
obj.method = function () {};
obj["computed"] = () => {};
const o = { arrow: () => {}, short() {}, "quoted"() {}, 7() {}, ["dyn" + 1]() {} };
declared(); expr(); later(); obj.method(); obj.computed();
o.arrow(); o.short(); o.quoted(); o[7](); o.dyn1();
`);
    expect(names).toEqual([
      "declared",
      "expr",
      "later",
      "method",
      "anonymous",
      "arrow",
      "short",
      "quoted",
      "7",
      "[computed]",
    ]);
  });

  it("put a class's name in front of its methods", async () => {
    const names = await frameNames(`class A {
  field = () => 1;
  #secret() { return 1; }
  static make() { return new A(); }
  run() { return this.#secret() + this.field(); }
}
const B = class { go() {} };
const anon = [class { hi() {} }][0];
A.make().run(); new B().go(); new anon().hi();
`);
    expect(names).toEqual(["A.make", "A.run", "A.#secret", "A.field", "B.go", "hi"]);
  });
});

describe("loops", () => {
  it("are numbered by line, with the column when two share one", () => {
    const { loops } = instrument("for (let i = 0; i < 2; i++) {} for (const x of []) {}\nwhile (false) {}\n");
    expect(loops.map((l) => l.id)).toEqual(["L1", "L1_31", "L2"]);
  });

  it("are described by their header", () => {
    const { loops } = instrument("let i = 0;\ndo {\n  i++;\n} while (i < 3);\nfor (const x of [1]) {\n}\n");
    expect(loops.map((l) => l.header)).toEqual(["do … while (i < 3)", "for (const x of [1])"]);
  });

  it("continue to a label on a label still runs", async () => {
    const trace = await traceJavaScript(`let n = 0;
a: b: for (let i = 0; i < 3; i++) {
  if (i === 1) continue a;
  n += i;
}
console.log(n);
`);
    expect(trace.stdout).toBe("2\n");
  });

  it("record which names index which lists, and every grid[row][col]", () => {
    const { indexNames, gridAccesses } = instrument(`const xs = [1, 2], grid = [[1]], o = { a: [1] };
let i = 0, j = 0;
xs[i + j]; grid[i + 1][j]; o.a[i]; xs[0];
`);
    expect(indexNames).toEqual({ xs: ["i", "j"], grid: ["i"], "grid[]": ["j"] });
    expect(gridAccesses).toEqual([{ name: "grid", line: 3, row: "i + 1", col: "j" }]);
  });
});

describe("parse errors", () => {
  const error = (source: string, plugins: "typescript"[] = []) => {
    try {
      parseProgram(source, plugins);
    } catch (e) {
      return e as InstrumentError;
    }
    throw new Error("parsed");
  };

  it("say which line, and are SyntaxErrors", () => {
    const e = error("let a = 1;\nlet = ;");
    expect(e).toBeInstanceOf(InstrumentError);
    expect(e.name).toBe("SyntaxError");
    expect(e.line).toBe(2);
    expect(e.message).not.toMatch(/\(\d+:\d+\)$/);
  });

  it("explain what isn't supported", () => {
    expect(error("@dec class A {}").message).toBe("Decorators aren't supported.");
    expect(error("const a = <div>hi</div>;").message).toBe("JSX isn't supported.");
    expect(error("const a = <b>hi</b>;", ["typescript"]).message).toMatch(/\(JSX isn't supported\.\)$/);
    expect(error("import x from 'y';").message).toMatch(/import and export aren't supported/);
    expect(error("export const a = 1;").line).toBe(1);
  });
});

describe("hints", () => {
  it("are every viz: comment, with its line", () => {
    const { hints } = instrument("// viz: hide i\nlet i = 0; /* viz: pointers lo, hi */\n// not a hint\n");
    expect(hints).toEqual([
      { line: 1, text: "hide i" },
      { line: 2, text: "pointers lo, hi" },
    ]);
  });
});

describe("generated code", () => {
  it("runs a program built by hand, with no source locations or comments, untraced", () => {
    const ast = t.file(
      t.program([t.variableDeclaration("let", [t.variableDeclarator(t.identifier("x"), t.numericLiteral(1))])]),
    );
    const out = instrumentAst(ast, "");
    expect(out.hints).toEqual([]);
    expect(out.loops).toEqual([]);
    expect(out.code).toContain("let x = 1;");
  });
});
