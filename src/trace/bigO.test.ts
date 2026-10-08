import { describe, expect, it } from "vitest";
import { add, equal, evaluate, expOf, factOf, format, logOf, mul, ONE, power, rename, size, substitute, ZERO } from "./bigO";

const f = (x: Parameters<typeof format>[0]) => format(x);

describe("big-O algebra", () => {
  it("multiplies nested work and keeps the biggest of sequential work", () => {
    const n = size("n");
    expect(f(mul(n, n))).toBe("O(n²)");
    expect(f(add(mul(n, n), n, ONE))).toBe("O(n²)");
    expect(f(mul(n, logOf("n")))).toBe("O(n log n)");
    expect(f(add(mul(n, logOf("n")), n))).toBe("O(n log n)");
    expect(f(ONE)).toBe("O(1)");
    expect(f(ZERO)).toBe("O(1)");
    expect(f(logOf("n"))).toBe("O(log n)");
  });

  it("keeps terms in different sizes", () => {
    expect(f(add(size("V"), size("E")))).toBe("O(V + E)");
    expect(f(mul(size("n"), size("m")))).toBe("O(n·m)");
    expect(f(add(mul(size("n"), size("m")), size("n")))).toBe("O(n·m)");
    expect(f(mul(add(size("V"), size("E")), logOf("V")))).toBe("O(V log V + E log V)");
  });

  it("formats exponentials, factorials and powers", () => {
    expect(f(expOf("n", 2))).toBe("O(2ⁿ)");
    expect(f(add(expOf("n", 2), power("n", 3)))).toBe("O(2ⁿ)");
    expect(f(mul(expOf("n", 2), size("n")))).toBe("O(2ⁿ·n)");
    expect(f(factOf("n"))).toBe("O(n!)");
    expect(f(add(factOf("n"), expOf("n", 2)))).toBe("O(n!)");
    expect(f(power("n", Math.log2(3)))).toBe("O(n^1.58)");
    expect(f(mul(power("n", 2), logOf("n")))).toBe("O(n² log n)");
  });

  it("renames and substitutes sizes", () => {
    const callee = mul(size("items"), logOf("items"));
    expect(f(rename(callee, (s) => (s === "items" ? "nums" : s)))).toBe("O(nums log nums)");
    // a size replaced by a constant drops out
    expect(f(substitute(add(size("V"), mul(size("V"), size("d"))), "d", ONE))).toBe("O(V)");
    expect(equal(add(size("a"), size("b")), add(size("b"), size("a")))).toBe(true);
  });

  it("evaluates with sizes plugged in", () => {
    expect(evaluate(mul(size("n"), size("n")), () => 6)).toBe(36);
    expect(evaluate(expOf("n", 2), () => 5)).toBe(32);
    expect(evaluate(logOf("n"), () => 8)).toBe(3);
  });
});
