/**
 * Every way a JavaScript program can change an object, one small program
 * each: what marks (js/marks.ts) must notice. Each program reads the object
 * at a recorded step first (so the tracer has it as it was), then changes
 * it, then records a step where it shows; the tests (marks.test.ts) trace
 * each with marks and without, and the two must be the same at every step.
 *
 * A way of writing JavaScript gains (new syntax, a new built-in that
 * changes what it's given) belongs here: this is the list a reviewer
 * checks it against.
 */
export interface WriteForm {
  name: string;
  code: string;
}

/** `o` (fields), `a` (a short list), `m` (a Map), `s` (a Set), read at the step before `WRITE`. */
const around = (write: string, extra = "") => `${extra}const o = { a: 1, b: { c: 2 }, n: 0, k: "x" };
const a = [3, 1, 2];
const m = new Map([["x", 1]]);
const s = new Set([1]);
let seen = 0;
${write}
seen = 1;
seen = 2;
`;

export const WRITE_FORMS: WriteForm[] = [
  // Assignment, every operator.
  { name: "o.a = v", code: around("o.a = 5;") },
  { name: "o[key] = v", code: around('o["a"] = 5;') },
  { name: "a[i] = v", code: around("a[1] = 9;") },
  { name: "nested o.b.c = v", code: around("o.b.c = 7;") },
  { name: "+= -= *= /=", code: around("o.a += 2; o.n -= 1; a[0] *= 3; o.a /= 2;") },
  {
    name: "**= %= <<= >>= >>>= &= |= ^=",
    code: around("o.a **= 2; o.a %= 3; o.n <<= 1; o.n >>= 1; o.n >>>= 0; o.n &= 1; o.n |= 6; o.n ^= 3;"),
  },
  { name: "&&= ||= ??=", code: around("o.a &&= 4; o.n ||= 8; o.z ??= 3;") },
  { name: "chained a.x = b.y = v", code: around("o.a = o.b.c = 11;") },
  { name: "a new field", code: around("o.extra = [1, 2];") },
  { name: "o.__proto__ = p", code: around("o.__proto__ = { inherited: true };") },
  // Updates and deletes.
  { name: "o.a++ ++o.a o.a-- --o.a", code: around("o.a++; ++o.a; o.n--; --o.n;") },
  { name: "a[i]++", code: around("a[2]++;") },
  { name: "delete o.k", code: around("delete o.k;") },
  { name: "delete a[i]", code: around("delete a[0];") },
  // Destructuring into fields.
  { name: "[a[i], a[j]] = [a[j], a[i]]", code: around("[a[0], a[2]] = [a[2], a[0]];") },
  { name: "({ x: o.a, y: o.b.c } = src)", code: around("({ x: o.a, y: o.b.c } = { x: 40, y: 41 });") },
  { name: "[...o.rest] = xs", code: around("[o.first, ...o.rest] = [7, 8, 9];") },
  { name: "destructuring with a default that writes", code: around("[o.a = (o.n = 99)] = [];") },
  // The right-hand side records steps before the write lands.
  {
    name: "o.a = f() where f records steps",
    code: around(
      "o.a = slow(4);",
      `function slow(x) {
  let t = 0;
  t += x;
  return t * 2;
}
`,
    ),
  },
  {
    name: "a[i] = a.indexOf(...) and o.a = o.a + g(o)",
    code: around(
      "a[a.indexOf(1)] = 50; o.a = o.a + bump(o);",
      `function bump(x) {
  x.n = x.n + 1;
  return x.n;
}
`,
    ),
  },
  // Built-ins that change what they're called on.
  { name: "push pop shift unshift", code: around("a.push(4); a.pop(); a.shift(); a.unshift(0);") },
  { name: "splice", code: around("a.splice(1, 1, 7, 8);") },
  { name: "sort and reverse", code: around("a.sort(); a.reverse();") },
  {
    name: "sort with a comparator that records steps",
    code: around(
      `a.sort((x, y) => {
  const d = x - y;
  return d;
});`,
    ),
  },
  { name: "fill and copyWithin", code: around("a.fill(0, 1); a.copyWithin(0, 2);") },
  { name: "a.length = 0", code: around("a.length = 1;") },
  {
    name: "Map set, delete, clear",
    code: around('m.set("y", 2); m.delete("x"); m.set("z", 3); m.clear(); m.set("w", 4);'),
  },
  { name: "Set add, delete", code: around("s.add(2); s.delete(1); s.add(3);") },
  // Built-ins that change what they're given.
  { name: "Object.assign(target, src)", code: around("Object.assign(o, { a: 100, q: 1 });") },
  { name: "Object.defineProperty", code: around('Object.defineProperty(o, "a", { value: 77, enumerable: true });') },
  {
    name: "Reflect.set and Reflect.deleteProperty",
    code: around('Reflect.set(o, "a", 61); Reflect.deleteProperty(o, "k");'),
  },
  { name: "Array.prototype.push.call(o, ...)", code: around("Array.prototype.push.call(a, 5, 6);") },
  { name: "Object.setPrototypeOf", code: around("Object.setPrototypeOf(o, { from: 1 });") },
  { name: "a spread argument: Array.prototype.push.apply", code: around("Array.prototype.push.apply(a, [10, 11]);") },
  { name: "a method borrowed into a variable", code: around("const push = a.push.bind(a); push(12);") },
  { name: "forEach with a callback that writes", code: around("a.forEach((x, i) => { a[i] = x * 10; });") },
  {
    name: "map and reduce whose callbacks write elsewhere",
    code: around("a.map((x) => { o.n += x; return x; }); a.reduce((t, x) => { o.a = t + x; return o.a; }, 0);"),
  },
  // Optional chains and calls.
  { name: "o?.b.c = v (through an optional read)", code: around("const b = o?.b; b.c = 3;") },
  { name: "m.get(k)?.push(v)", code: around('m.set("l", [1]); m.get("l")?.push(2);') },
  { name: "optional call that doesn't happen", code: around("const none = null; none?.push(1); a.push(13);") },
  // Classes: setters, getters, fields, super, private fields.
  {
    name: "a setter that writes another field",
    code: around(
      "box.v = 5;",
      `class Box {
  constructor() { this._v = 0; this.writes = 0; }
  set v(x) { this._v = x; this.writes++; }
  get v() { return this._v; }
}
const box = new Box();
`,
    ),
  },
  {
    name: "a getter that caches into a field",
    code: around(
      "const got = lazy.value;",
      `class Lazy {
  constructor() { this.cache = null; }
  get value() { if (this.cache === null) { this.cache = 42; } return this.cache; }
}
const lazy = new Lazy();
`,
    ),
  },
  {
    name: "super.x = v and a super method that writes",
    code: around(
      "kid.grow();",
      `class Base { constructor() { this.size = 1; } bump() { this.size++; } }
class Kid extends Base {
  constructor() { super(); this.age = 0; }
  grow() { super.bump(); super.age = 3; }
}
const kid = new Kid();
`,
    ),
  },
  {
    name: "a private field's method writing a public field",
    code: around(
      "acct.deposit(5);",
      `class Account {
  #balance = 0;
  constructor() { this.history = []; }
  deposit(x) { this.#balance += x; this.history.push(this.#balance); }
}
const acct = new Account();
`,
    ),
  },
  {
    name: "a static field",
    code: around(
      "Counter.count += 1; Counter.bump();",
      "class Counter { static count = 0; static bump() { Counter.count++; } }\n",
    ),
  },
  // Aliases and objects that come back.
  { name: "a write through another name", code: around("const alias = o; alias.a = 21;") },
  {
    name: "a write through a list of objects",
    code: around("const rows = [o, { a: 0 }]; rows[0].b.c = 30; rows[1].a = 1;"),
  },
  {
    name: "written while unreachable, then back",
    code: around(
      `let hold = o.b;
o.b = null;
seen = 3;
hold.c = 500;
seen = 4;
o.b = hold;`,
    ),
  },
  // Errors part-way.
  {
    name: "a write whose right-hand side throws",
    code: around(
      `try { o.a = boom(); } catch (e) { o.n = 1; }`,
      `function boom() {
  throw new Error("no");
}
`,
    ),
  },
  {
    name: "a call that throws after changing its argument",
    code: around(`try { [3, 2, 1].sort(() => { a.push(100); throw new Error("stop"); }); } catch (e) { o.n = 2; }`),
  },
  // Generators, async, timers.
  {
    name: "a write across a yield",
    code: around(
      `const g = gen();
g.next();
seen = 5;
g.next(77);`,
      `function* gen() {
  o.a = yield 1;
  o.n = 2;
}
`,
    ),
  },
  {
    name: "a write across an await",
    code: around(
      "fill();",
      `async function fill() {
  a[0] = await Promise.resolve(64);
  o.a = await later();
}
async function later() {
  return 65;
}
`,
    ),
  },
  { name: "a timer's callback writes", code: around("setTimeout(() => { o.a = 1234; }, 0);") },
  // Typed arrays and other built-in objects.
  {
    name: "typed array element",
    code: around("const bytes = new Uint8Array(4); seen = 9; bytes[2] = 7; bytes.set([1], 0);"),
  },
  { name: "Date setter", code: around("const d = new Date(0); seen = 9; d.setFullYear(2001);") },
  // Code marks can't follow: the whole run reads every object instead.
  { name: "eval", code: around('eval("o.a = 3");') },
  { name: "new Function", code: around('new Function("o", "o.a = 4")(o);') },
  { name: "a field as a for-of target", code: around("for (o.a of [1, 2, 3]) { seen = 6; }") },
  { name: "with", code: around("with (o) { a = 5; n = 6; }") },
];

/**
 * A write marks can't see: a bound function kept on an object and called as
 * its method. The call shows only the object it's called on, not the one
 * the function was bound to, and the function is code the program made
 * with the Function constructor, reached without naming it, so it isn't
 * rewritten either. Only the in-run check can catch this one (marks.test.ts).
 */
export const HIDDEN_WRITE = around(
  `const make = Object.getPrototypeOf(function () {}).constructor;
const holder = { f: null };
holder.f = make("x", "x.a = 314").bind(null, o);
seen = 7;
holder.f();`,
);
