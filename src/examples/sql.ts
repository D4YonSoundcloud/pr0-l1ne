import type { Example } from "./index";

/**
 * SQL examples: each adds one thing to the one before, from every row of a
 * table to all of one table's clauses together, then joining tables. They use the sample
 * databases (sql/databases.ts), except the last, which makes its own table.
 */
const FIRST = "Querying one table";
const SORTING = "Sorting, DISTINCT and LIMIT";
const JOINS = "Joining tables";
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
  // ------------------------------------------------------------- joins
  {
    group: JOINS,
    name: "JOIN … ON",
    code: `-- viz: database shop
-- Each order names its customer by id. JOIN pairs every order
-- with the customer whose id matches: one line per pair.
SELECT o.id, c.name, o.quantity
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
ORDER BY o.id;
`,
  },
  {
    group: JOINS,
    name: "LEFT JOIN keeps every row",
    code: `-- viz: database shop
-- A plain JOIN drops customers with no orders. LEFT JOIN keeps
-- every row on its left, with NULLs where there's no match.
SELECT c.name, o.id AS order_id, o.ordered_on
FROM customers AS c
LEFT JOIN orders AS o ON o.customer_id = c.id
ORDER BY c.name;
`,
  },
  {
    group: JOINS,
    name: "Rows with no match",
    code: `-- viz: database shop
-- LEFT JOIN, then keep only the rows it filled with NULLs:
-- the products nobody has ordered.
SELECT p.name, p.stock
FROM products AS p
LEFT JOIN orders AS o ON o.product_id = p.id
WHERE o.id IS NULL;
`,
  },
  {
    group: JOINS,
    name: "Three tables",
    code: `-- viz: database shop
-- Joins run one at a time, left to right: orders with their
-- customers, then those rows with their products.
SELECT c.name,
       p.name AS product,
       o.quantity * p.price AS total
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
JOIN products AS p ON p.id = o.product_id
ORDER BY total DESC
LIMIT 5;
`,
  },
  {
    group: JOINS,
    name: "Self join: who reports to whom",
    code: `-- viz: database company
-- A table joined to itself, under two names: e for each
-- employee, m for their manager. Hana has no manager.
SELECT e.name, m.name AS manager
FROM employees AS e
LEFT JOIN employees AS m ON m.id = e.manager_id
ORDER BY e.id;
`,
  },
  {
    group: JOINS,
    name: "FULL JOIN",
    code: `-- viz: database company
-- FULL JOIN keeps the rows with no match on both sides: Tariq,
-- in no department, and Research, with nobody in it.
SELECT e.name, d.name AS department
FROM employees AS e
FULL JOIN departments AS d ON d.id = e.department_id
ORDER BY d.name, e.name;
`,
  },
  {
    group: JOINS,
    name: "A comma in FROM",
    code: `-- viz: database company
-- An older way to join: a comma pairs every row with every
-- row (4 × 11), then WHERE keeps the pairs that belong together.
SELECT d.name AS department, e.name
FROM departments AS d, employees AS e
WHERE e.department_id = d.id
ORDER BY d.name, e.name;
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
