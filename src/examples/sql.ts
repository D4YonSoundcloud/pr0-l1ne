import type { Example } from "./index";

/**
 * SQL examples: each adds one thing to the one before, from every row of a
 * table to all of one table's clauses together. They use the sample
 * databases (sql/databases.ts), except the last, which makes its own table.
 */
const FIRST = "Querying one table";
const SORTING = "Sorting, DISTINCT and LIMIT";
const OWN = "Your own tables";

export const SQL_EXAMPLES: Example[] = [
  // ------------------------------------------------------------- one table
  {
    group: FIRST,
    name: "Every row",
    code: `-- viz: database shop
-- The first step shows the shop's tables. Then FROM picks one,
-- and SELECT * keeps every column.
SELECT *
FROM products;
`,
  },
  {
    group: FIRST,
    name: "Choosing columns",
    code: `-- viz: database shop
-- FROM runs first, then SELECT picks the columns: watch the
-- other columns go.
SELECT name, price
FROM products;
`,
  },
  {
    group: FIRST,
    name: "Filtering with WHERE",
    code: `-- viz: database shop
-- WHERE checks every row, before SELECT: a row stays when the
-- condition is true.
SELECT name, price
FROM products
WHERE price < 10;
`,
  },
  {
    group: FIRST,
    name: "AND, OR and NOT",
    code: `-- viz: database shop
-- Each part of the condition gets a column, so you can see
-- which part decided each row.
SELECT name, category, price, stock
FROM products
WHERE category = 'Coffee' AND stock > 0
   OR NOT price < 20;
`,
  },
  {
    group: FIRST,
    name: "NULL is unknown",
    code: `-- viz: database school
-- Two students have no GPA (NULL). NULL > 3.5 isn't false: it's
-- unknown, and WHERE only keeps rows where the condition is true.
SELECT name, gpa
FROM students
WHERE gpa > 3.5;

-- NULL <= 3.5 is unknown too. To keep them, ask with IS NULL.
SELECT name, gpa
FROM students
WHERE gpa <= 3.5 OR gpa IS NULL;
`,
  },
  {
    group: FIRST,
    name: "Computed columns",
    code: `-- viz: database shop
-- SELECT can work things out for each row. AS names the result.
SELECT name,
       price,
       stock,
       price * stock AS stock_value,
       upper(category) AS shelf
FROM products
WHERE stock > 0;
`,
  },
  // ------------------------------------------------------------- sorting
  {
    group: SORTING,
    name: "ORDER BY",
    code: `-- viz: database shop
-- ORDER BY runs after SELECT, so it can sort by a name SELECT made.
-- Rows that sort the same are marked: their order isn't promised.
SELECT name, price
FROM products
ORDER BY price DESC;
`,
  },
  {
    group: SORTING,
    name: "Breaking ties",
    code: `-- viz: database company
-- A second sort key decides between rows the first one ties.
SELECT name, salary, hired
FROM employees
ORDER BY salary DESC, hired;
`,
  },
  {
    group: SORTING,
    name: "DISTINCT",
    code: `-- viz: database school
-- DISTINCT keeps the first of each set of identical rows.
SELECT DISTINCT city
FROM students
ORDER BY city;
`,
  },
  {
    group: SORTING,
    name: "Top three with LIMIT",
    code: `-- viz: database school
-- LIMIT runs last of all: sort first, then cut.
SELECT name, gpa
FROM students
WHERE gpa IS NOT NULL
ORDER BY gpa DESC
LIMIT 3;
`,
  },
  {
    group: SORTING,
    name: "Pages with OFFSET",
    code: `-- viz: database shop
-- OFFSET skips rows before LIMIT counts: page 2, four to a page.
SELECT name, price
FROM products
ORDER BY name
LIMIT 4 OFFSET 4;
`,
  },
  {
    group: SORTING,
    name: "Every clause together",
    code: `-- viz: database company
-- Written SELECT first, but run FROM, WHERE, SELECT, DISTINCT,
-- ORDER BY, LIMIT: step through to see each in turn.
SELECT DISTINCT
       department_id,
       salary * 12 AS yearly
FROM employees
WHERE hired >= '2019-01-01'
  AND department_id IS NOT NULL
ORDER BY yearly DESC
LIMIT 4;
`,
  },
  // ------------------------------------------------------------- your own tables
  {
    group: OWN,
    name: "Create, insert, update, delete",
    code: `-- No sample database: this program makes its own table.
-- Each statement is a step, with the rows it changed marked.
CREATE TABLE pets (
  name text,
  kind text,
  age integer
);

INSERT INTO pets VALUES
  ('Rex', 'dog', 3),
  ('Tom', 'cat', NULL),
  ('Kiwi', 'bird', 1),
  ('Bella', 'dog', 7);

UPDATE pets SET age = age + 1 WHERE kind = 'dog';

DELETE FROM pets WHERE age IS NULL;

SELECT name, age
FROM pets
ORDER BY age DESC;
`,
  },
];
