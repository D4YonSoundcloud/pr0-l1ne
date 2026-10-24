import type { Example } from "./index";

/**
 * SQL examples: each adds one thing to the one before, from every row of a
 * table to all of one table's clauses together, then joining tables. They use the sample
 * databases (sql/databases.ts), except the last, which makes its own table.
 */
const FIRST = "Querying one table";
const SORTING = "Sorting, DISTINCT and LIMIT";
const JOINS = "Joining tables";
const GROUPS = "Grouping and aggregates";
const COMPOSE = "Subqueries, WITH and UNION";
const WINDOWS = "Window functions";
const RECURSION = "WITH RECURSIVE";
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
  // ------------------------------------------------------------- grouping
  {
    group: GROUPS,
    name: "COUNT and SUM over every row",
    code: `-- viz: database shop
-- An aggregate with no GROUP BY makes every row one group, and
-- the group one row. Each aggregate shows the values it was given.
SELECT count(*) AS products,
       sum(stock) AS in_stock,
       max(price) AS dearest
FROM products;
`,
  },
  {
    group: GROUPS,
    name: "GROUP BY",
    code: `-- viz: database shop
-- GROUP BY gathers the rows into groups, one per category (the
-- two with no category group together), and each group becomes
-- one row.
SELECT category, count(*) AS products, sum(stock) AS in_stock
FROM products
GROUP BY category
ORDER BY category;
`,
  },
  {
    group: GROUPS,
    name: "COUNT(*) or COUNT(column)",
    code: `-- viz: database school
-- COUNT(*) counts rows. COUNT(gpa) counts the rows whose gpa isn't
-- NULL, and AVG(gpa) leaves the NULLs out too.
SELECT year,
       count(*) AS students,
       count(gpa) AS with_gpa,
       round(avg(gpa), 2) AS average
FROM students
GROUP BY year
ORDER BY year;
`,
  },
  {
    group: GROUPS,
    name: "HAVING",
    code: `-- viz: database company
-- HAVING is WHERE for groups: it runs after the aggregates, so it
-- can use them, and drops whole groups.
SELECT department_id,
       count(*) AS people,
       max(salary) AS top_salary
FROM employees
GROUP BY department_id
HAVING count(*) >= 3;
`,
  },
  {
    group: GROUPS,
    name: "WHERE, then GROUP BY, then HAVING",
    code: `-- viz: database shop
-- WHERE drops rows before they're grouped; HAVING drops groups
-- after. Products over 8, then categories with two or more.
SELECT category, count(*) AS products, min(price) AS cheapest
FROM products
WHERE price > 8
GROUP BY category
HAVING count(*) >= 2
ORDER BY cheapest;
`,
  },
  {
    group: GROUPS,
    name: "Grouping a join",
    code: `-- viz: database shop
-- Join the orders to their customers and products, then group
-- the joined rows by customer: what each one has spent.
SELECT c.name, count(*) AS orders, sum(o.quantity * p.price) AS spent
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
JOIN products AS p ON p.id = o.product_id
GROUP BY c.name
ORDER BY spent DESC
LIMIT 3;
`,
  },
  // ------------------------------------------------------------- composing queries
  {
    group: COMPOSE,
    name: "CASE",
    code: `-- viz: database shop
-- CASE picks a value for each row: the first WHEN that's true
-- wins. A column beside it shows which branch each row took.
SELECT name,
       price,
       CASE WHEN price < 8 THEN 'cheap'
            WHEN price < 20 THEN 'middle'
            ELSE 'dear'
       END AS band
FROM products
ORDER BY price;
`,
  },
  {
    group: COMPOSE,
    name: "A subquery that stands alone",
    code: `-- viz: database shop
-- The subquery doesn't depend on the outer query, so it runs
-- once, first: its steps come before the outer query's.
SELECT name, price
FROM products
WHERE price > (SELECT avg(price) FROM products)
ORDER BY price DESC;
`,
  },
  {
    group: COMPOSE,
    name: "IN (subquery)",
    code: `-- viz: database shop
-- The customers who ordered tea: the subquery finds their ids,
-- and IN checks each customer against that list.
SELECT name
FROM customers
WHERE id IN (
  SELECT o.customer_id
  FROM orders AS o
  JOIN products AS p ON p.id = o.product_id
  WHERE p.category = 'Tea'
)
ORDER BY name;
`,
  },
  {
    group: COMPOSE,
    name: "EXISTS, once for each row",
    code: `-- viz: database shop
-- This subquery uses c.id from the outer row, so it can't run
-- on its own: Postgres runs it again for each customer.
SELECT c.name
FROM customers AS c
WHERE EXISTS (
  SELECT 1 FROM orders AS o
  WHERE o.customer_id = c.id AND o.quantity > 1
)
ORDER BY c.name;
`,
  },
  {
    group: COMPOSE,
    name: "A count for each row",
    code: `-- viz: database company
-- A subquery in SELECT, once per employee: how many people
-- report to them.
SELECT e.name,
       (SELECT count(*) FROM employees AS r WHERE r.manager_id = e.id) AS reports
FROM employees AS e
ORDER BY reports DESC, e.name
LIMIT 4;
`,
  },
  {
    group: COMPOSE,
    name: "The NOT IN trap",
    code: `-- viz: database company
-- Which departments have nobody in them? Tariq's department is
-- NULL, and x NOT IN (..., NULL) is never true: no rows at all.
SELECT name
FROM departments
WHERE id NOT IN (SELECT department_id FROM employees);

-- NOT EXISTS asks the question the way it was meant.
SELECT d.name
FROM departments AS d
WHERE NOT EXISTS (
  SELECT 1 FROM employees AS e WHERE e.department_id = d.id
);
`,
  },
  {
    group: COMPOSE,
    name: "WITH",
    code: `-- viz: database shop
-- WITH names a query, which then reads like a table. Its steps
-- come first; then the main query's.
WITH spent AS (
  SELECT o.customer_id, sum(o.quantity * p.price) AS total
  FROM orders AS o
  JOIN products AS p ON p.id = o.product_id
  GROUP BY o.customer_id
)
SELECT c.name, s.total
FROM spent AS s
JOIN customers AS c ON c.id = s.customer_id
WHERE s.total > 40
ORDER BY s.total DESC;
`,
  },
  {
    group: COMPOSE,
    name: "A subquery in FROM",
    code: `-- viz: database company
-- A subquery in FROM makes a table for the outer query: here,
-- each department's head count, then the bigger departments.
SELECT d.name, sizes.people
FROM (
  SELECT department_id, count(*) AS people
  FROM employees
  GROUP BY department_id
) AS sizes
JOIN departments AS d ON d.id = sizes.department_id
WHERE sizes.people >= 3;
`,
  },
  {
    group: COMPOSE,
    name: "UNION",
    code: `-- viz: database company
-- Two queries, one list: UNION keeps each different row once,
-- so Hana, Luis and Mei, in both, appear once (UNION ALL keeps both).
SELECT name FROM employees WHERE salary >= 7000
UNION
SELECT e.name
FROM employees AS e
JOIN departments AS d ON d.id = e.department_id
WHERE d.name = 'Engineering'
ORDER BY name;
`,
  },
  {
    group: COMPOSE,
    name: "INTERSECT and EXCEPT",
    code: `-- viz: database shop
-- INTERSECT: the rows both queries give. EXCEPT: the first
-- query's rows that the second doesn't give.
SELECT name FROM products WHERE price < 10
INTERSECT
SELECT name FROM products WHERE stock > 20;

SELECT name FROM products WHERE price < 10
EXCEPT
SELECT name FROM products WHERE stock > 20;
`,
  },
  // ------------------------------------------------------------- window functions
  {
    group: WINDOWS,
    name: "A running total",
    code: `-- viz: database company
-- A window function works out a value for each row from other
-- rows, without folding them into one. With ORDER BY, each row's
-- frame is the rows up to it: a running total.
SELECT name, hired, salary,
       sum(salary) OVER (ORDER BY hired) AS payroll_so_far
FROM employees
ORDER BY hired;
`,
  },
  {
    group: WINDOWS,
    name: "PARTITION BY",
    code: `-- viz: database company
-- PARTITION BY splits the rows like GROUP BY, but keeps every row:
-- each is worked out from its own department's rows.
SELECT name, department_id, salary,
       avg(salary) OVER (PARTITION BY department_id) AS dept_average,
       rank() OVER (PARTITION BY department_id ORDER BY salary DESC) AS place
FROM employees
WHERE department_id IS NOT NULL
ORDER BY department_id, place;
`,
  },
  {
    group: WINDOWS,
    name: "A moving window",
    code: `-- viz: database shop
-- ROWS BETWEEN sets the frame by hand: each order and the two
-- before it.
SELECT id, ordered_on, quantity,
       sum(quantity) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS last_three
FROM orders
ORDER BY id;
`,
  },
  {
    group: WINDOWS,
    name: "LAG: the row before",
    code: `-- viz: database shop
-- lag() reads a value from the row before, in the window's order:
-- how many days since the order before.
SELECT id, ordered_on,
       ordered_on - lag(ordered_on) OVER (ORDER BY ordered_on) AS days_since
FROM orders
ORDER BY ordered_on;
`,
  },
  // ------------------------------------------------------------- recursion
  {
    group: RECURSION,
    name: "Counting to five",
    code: `-- A recursive query runs again and again on the rows it made
-- last, until it makes none: each pass is a step.
WITH RECURSIVE n (i) AS (
  SELECT 1
  UNION ALL
  SELECT i + 1 FROM n WHERE i < 5
)
SELECT i FROM n;
`,
  },
  {
    group: RECURSION,
    name: "Chain of command",
    code: `-- viz: database company
-- Start at Chloe, then find each manager's manager, pass by pass,
-- up to the top.
WITH RECURSIVE chain AS (
  SELECT id, name, manager_id, 1 AS level
  FROM employees
  WHERE name = 'Chloe'
  UNION ALL
  SELECT m.id, m.name, m.manager_id, chain.level + 1
  FROM employees AS m
  JOIN chain ON m.id = chain.manager_id
)
SELECT level, name FROM chain ORDER BY level;
`,
  },
  {
    group: RECURSION,
    name: "Every station you can reach",
    code: `-- viz: database transit
-- From Central, follow the connections out, one stop a pass.
-- UNION (not ALL) skips stations already found, so it ends.
WITH RECURSIVE reach (station, stops) AS (
  SELECT 1, 0
  UNION
  SELECT c.to_station, reach.stops + 1
  FROM connections AS c
  JOIN reach ON c.from_station = reach.station
  WHERE reach.stops < 4
)
SELECT s.name, min(r.stops) AS fewest_stops
FROM reach AS r
JOIN stations AS s ON s.id = r.station
GROUP BY s.name
ORDER BY fewest_stops, s.name;
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

-- UPDATE and DELETE step through their WHERE first, then show
-- the table before and after.
UPDATE pets SET age = age + 1 WHERE kind = 'dog';

DELETE FROM pets WHERE age IS NULL;

SELECT name, age
FROM pets
ORDER BY age DESC;
`,
  },
];
