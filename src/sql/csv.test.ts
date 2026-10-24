import { describe, expect, it } from "vitest";
import { csvToSql, MAX_CSV_ROWS, parseCsv, sqlName } from "./csv";

describe("parseCsv", () => {
  it("reads quoted values with commas, quotes and line breaks", () => {
    expect(parseCsv('name,note\r\n"Ada, Countess","said ""hi""\nthen left"\nBob,\n')).toEqual([
      ["name", "note"],
      ["Ada, Countess", 'said "hi"\nthen left'],
      ["Bob", ""],
    ]);
  });

  it("finds semicolon and tab separators, and skips a byte order mark and blank lines", () => {
    expect(parseCsv("﻿a;b\n1;2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("sqlName", () => {
  it("makes a name SQL can use without quotes", () => {
    expect(sqlName("First Name", "x")).toBe("first_name");
    expect(sqlName("2024 sales (€)", "x")).toBe("_2024_sales");
    expect(sqlName("Café", "x")).toBe("cafe");
    expect(sqlName("!!!", "fallback")).toBe("fallback");
  });
});

describe("csvToSql", () => {
  it("makes CREATE TABLE and INSERT, with each column's narrowest type", () => {
    const made = csvToSql(
      "My Pets.csv",
      "Name,Age,Weight,Born,Vaccinated,Order\nRex,3,12.5,2021-04-02,yes,1\nTom's,,4,2019-11-30,no,2\n",
    );
    expect(made).toMatchObject({ table: "my_pets", rows: 2, imported: 2 });
    expect(made.sql).toBe(
      [
        "-- From My Pets.csv",
        "CREATE TABLE my_pets (",
        "  name text,",
        "  age integer,",
        "  weight numeric,",
        "  born date,",
        "  vaccinated boolean,",
        "  order_ integer",
        ");",
        "INSERT INTO my_pets VALUES",
        "  ('Rex', 3, 12.5, '2021-04-02', true, 1),",
        "  ('Tom''s', NULL, 4, '2019-11-30', false, 2);",
        "",
      ].join("\n"),
    );
  });

  it(`imports the first ${MAX_CSV_ROWS} rows, and says how many there were`, () => {
    const made = csvToSql("n.csv", `n\n${Array.from({ length: 250 }, (_, i) => i).join("\n")}`);
    expect([made.rows, made.imported]).toEqual([250, MAX_CSV_ROWS]);
    expect(made.sql.split("\n")[0]).toBe(`-- From n.csv (its first ${MAX_CSV_ROWS} of 250 rows)`);
  });

  it("refuses a file whose rows aren't all as wide as the first", () => {
    expect(() => csvToSql("bad.csv", "a,b\n1\n")).toThrow(
      "Every row must have 2 values, like the first row: one has 1.",
    );
    expect(() => csvToSql("empty.csv", "")).toThrow("The file is empty.");
  });

  it("gives repeated column names their own names", () => {
    expect(csvToSql("t.csv", "x,X,x\n1,2,3").sql).toContain("  x integer,\n  x_2 integer,\n  x_3 integer");
  });
});
