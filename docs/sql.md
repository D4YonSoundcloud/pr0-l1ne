[← Docs index](README.md)

# SQL

Pick **SQL** in the language menu, and PR0L1NE runs your queries on a real PostgreSQL database in your browser. Each query is drawn one step per clause: the table at each step, with every row kept or dropped and the reason why.

```sql
-- viz: database shop
SELECT name, price
FROM products
WHERE price < 10
ORDER BY price DESC
LIMIT 3;
```

This query is written starting with SELECT, but Postgres doesn't run it in that order. It starts with FROM, then filters with WHERE, picks columns with SELECT, sorts with ORDER BY and stops at LIMIT. PR0L1NE steps through the clauses in that order, so a lot of SQL's surprises stop being surprising. For example, the name a column gets with `AS` doesn't exist yet in WHERE, because WHERE runs before SELECT.

## The two windows

With SQL, the two windows show a query rather than a program's variables and loops:

- **Tables** (where memory usually is) shows the table at the current step. Above it are the clause and what it did, such as "kept 6 of 12 rows".
- **Query steps** (where the loop history usually is) lists the steps of the current statement, from top to bottom, with how many rows each one leaves. The current step is marked.

In the editor, the clause that the current step shows is highlighted. Step through as usual, or press **Play**. Each row keeps its place from step to step, so when ORDER BY moves it, it slides there.

The Output pane shows what each statement printed, the way `psql` (Postgres's own command line) shows it.

Measure, Complexity and the memory window's options (arrows or nested, sizes, output) are about lines, loops and variables, which queries don't have, so they're hidden while SQL is selected.

## Sample databases

Start a program with a hint that names a sample database, and it starts from that database's tables:

```sql
-- viz: database shop
```

Its first step shows every table in the database. The sample databases are small on purpose: under 15 rows a table, so every row fits on screen. They include NULLs, prices that tie and repeated values, which are the things that make queries interesting.

| Database | Tables |
| --- | --- |
| `shop` | `customers` (id, name, city, joined), `products` (id, name, category, price, stock), `orders` (id, customer_id, product_id, quantity, ordered_on) |
| `school` | `students` (id, name, year, gpa, city), `courses` (id, title, department, credits), `enrollments` (student_id, course_id, grade) |
| `company` | `departments` (id, name, floor), `employees` (id, name, department_id, manager_id, salary, hired) |
| `transit` | `stations` (id, name, zone), `connections` (from_station, to_station, minutes): one-way, for following routes with WITH RECURSIVE |

Without the hint, the database starts empty. Make your own tables with `CREATE TABLE` and fill them with `INSERT`.

Every run starts from a fresh copy of the database. Nothing a program does is kept, not even a `DROP TABLE`, so you can't break anything.

## Each clause, step by step

| Step | What it shows |
| --- | --- |
| **FROM** | The table, every row, numbered in the order Postgres keeps them (`#1`, `#2`...). The numbers stay with the rows through every step after this one. |
| **JOIN** | One step for each table joined: see [Joins](#joins), below. |
| **WHERE** | Every row, with the condition worked out for it in a **kept?** column. Rows where it isn't true are struck through. A condition joined with AND, OR or NOT also gets a column for each of its parts (up to four), so you can see which part decided each row. |
| **GROUP BY** | The rows gathered into groups, then each group made into one row, then **HAVING** for each group: see [Groups and aggregates](#groups-and-aggregates), below. |
| **SELECT** | The columns the query asks for, for the rows WHERE kept (or for each group). Columns it works out (`price * stock AS stock_value`) are tinted, and hovering over the heading shows the expression. |
| **DISTINCT** | Repeated rows struck through, each marked with the row it repeats: "same as #1". |
| **ORDER BY** | The rows in their new order. The sort keys are marked in the headings (▲ ascending, ▼ descending, numbered when there are several). A key that isn't one of the result's columns gets a column of its own. Rows that sort the same as the row above are marked `=`, because Postgres may give tied rows in either order. |
| **LIMIT / OFFSET** | Red lines across the table where OFFSET starts and LIMIT stops, with the rows outside them struck through. |

### Joins

A join is a step of its own, right after FROM, for each table it joins. The step shows three tables, left to right (or the third one below the other two, if that fits the window better):

1. **The rows so far.** For the first join, these are the FROM table's rows. For a second join, they're the rows the first join made.
2. **The table being joined.**
3. **The rows the join makes.** Each row is a pair, labeled with the numbers of its two rows (`#1·#3`). Its columns are named by their table (`c.name`, `o.id`).

A line runs from each row of the first table to each row it pairs with in the second. Every pair is a row of the result: a customer with four orders has four lines, and four rows in the result. The rows that match nothing depend on the kind of join:

| Join | Rows that match nothing |
| --- | --- |
| `JOIN` (inner) | Struck through: they're left out. |
| `LEFT JOIN` | The left table's are kept, tinted orange, with NULLs in the other table's columns (labeled `#8·–`). The right table's are left out. |
| `RIGHT JOIN` | The right table's are kept with NULLs; the left table's are left out. |
| `FULL JOIN` | Both tables' are kept with NULLs. |
| `CROSS JOIN` | There are none: every row pairs with every row (8 × 14 = 112 rows), so no lines are drawn. |

A comma between tables in FROM (`FROM customers c, orders o`) is a CROSS JOIN, usually followed by a WHERE that keeps the pairs that belong together. `ON`, `USING (...)` and `NATURAL` are all stepped through. With three or more tables, the joins happen one at a time, left to right, as Postgres reads them.

In a self join (a table joined to itself, like employees and their managers), the two copies have different names (`e` and `m`), and their rows are kept apart by those names.

### Groups and aggregates

A query with GROUP BY, or with an aggregate like `count(*)` or `sum(price)`, takes three steps after WHERE:

1. **GROUP BY.** The rows slide together into their groups. Each group has its own color down the left edge, a line above it, and a label beside it saying what its rows share: "G2 · category = Coffee · 3 rows". What GROUP BY groups on is worked out for each row in a column of its own. Rows with NULL there make one group together.
2. **The aggregates.** Each group becomes one row (`G1`, `G2`...). Each aggregate gets a column, and beside it a column with the values it was given, so `sum(stock)` shows `40, 0, 18, 22` next to its 80. `count(*)` lists the group's rows (`#1, #2, #7`). `count(gpa)` and `avg(gpa)` show the NULLs they leave out.
3. **HAVING**, if there is one. It's WHERE for groups: the condition is worked out for each group, and the groups where it isn't true are struck through. It runs after the aggregates, so it can use them, which WHERE can't.

An aggregate with no GROUP BY (`SELECT count(*) FROM products`) makes every row one group, and the group one row. SELECT, ORDER BY and LIMIT then work on the groups' rows. Each group's row starts from the group's first row, so it slides there from the GROUP BY step.

GROUP BY can name a column, an expression, or a name or number from SELECT (`GROUP BY 1`, `GROUP BY shelf`), as in Postgres.

### Subqueries, WITH and UNION

A query can hold other queries. Each inner query is stepped through as a **part** of the statement, before the steps that use it. In the Query steps window, a part's steps are indented under its name (for example "WITH spent", "Subquery 1" or "UNION: the first query"). The same name is shown above the clause in the Tables window. A part inside another part is named with both, like "UNION: the first query › Subquery 1".

- **WITH name AS (...)**: the WITH query's steps come first. In the main query's steps, `name` is a table of its rows, like any other.
- **A subquery in FROM** (`FROM (SELECT ...) AS sizes`) works the same way: its steps come first, then the outer query reads it as a table called `sizes`.
- **A subquery that stands alone**, in WHERE, SELECT or HAVING (`WHERE price > (SELECT avg(price) FROM products)`), doesn't depend on the outer query. It runs once, first, and its steps come before the outer query's. In the outer query's clauses it's called `(subquery 1)`, so its text doesn't crowd them.
- **A subquery that uses the outer row** (a *correlated* subquery, like `EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)`) can't run on its own: Postgres runs it again for every row. It gets a step of its own, just before the clause it's in, showing each row, the outer values the subquery uses (`c.id`), and what it gave for that row.
- **UNION, INTERSECT and EXCEPT**: each query's steps, then a step showing both queries' rows and the rows they make together. Rows that are left out are struck through, with the reason: "same as #1" (a repeat UNION drops), "not in the second query" (INTERSECT), "in the second query" (EXCEPT). The `ALL` kinds keep repeats, counting copies. An ORDER BY or LIMIT after them sorts and cuts the combined rows, in steps of their own.

**The NOT IN trap.** If a `NOT IN (subquery)` subquery gives a NULL, `x NOT IN (...)` is never true, so the query returns no rows. That's because comparing x with NULL is unknown. The WHERE step says so when it happens, and suggests NOT EXISTS. The "The NOT IN trap" example shows both.

**CASE** in SELECT gets a column beside it showing which branch each row took: `WHEN price < 8`, `WHEN price < 20` or `ELSE`.

### Window functions

A window function (`sum(salary) OVER (...)`, `rank() OVER (...)`, `lag(x) OVER (...)`) works out a value for each row from other rows, without folding them into one the way GROUP BY does. Each window (each different `OVER (...)`) gets a step of its own, just before SELECT:

- **Partitions.** The rows are shown in their partitions (`PARTITION BY department_id`), each with a color and a label beside it: "P1 · department_id = 1 · 4 rows". Within a partition, rows are in the window's ORDER BY.
- **The value.** Each window function gets a column, worked out for each row.
- **The frame.** An aggregate (`sum`, `avg`, `count`...) and `first_value`, `last_value` and `nth_value` work from a row's *frame*: some of its partition's rows. A **frame** column lists them for every row (`#1, #2, #3`), and a column beside it lists the values the function was given. With ORDER BY in the window, a row's frame is its partition's rows up to it, so `sum` makes a running total. Without ORDER BY, the frame is the whole partition. `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` sets a frame by hand. A note under the clause says which applies.
- `row_number`, `rank` and `dense_rank` count along the partition, and `lag` and `lead` read the row before or after: they don't use a frame.

### WITH RECURSIVE

A recursive WITH query has a starting query, then `UNION` or `UNION ALL`, then a query that reads the WITH query itself. Postgres runs it in passes, like a loop. The steps follow it: the starting query's steps, then one step per pass. Each pass shows two tables: the rows the pass before made (the starting rows, the first time), and the rows this pass makes from them. That's all the recursive query sees each time: not every row so far, only the last pass's. It stops when a pass makes no new rows. With `UNION` (not ALL), a row found already isn't new, and is struck through ("found already"), which is what lets a search through a graph with a cycle finish. A last step shows every pass's rows together, which is what the main query reads.

The Query steps window lists the passes (`PASS 1`, `PASS 2`...) like loop passes. A recursive query that runs for more than 50 passes is shown as its result instead.

### NULL

NULL is SQL's "no value", and any comparison with it is neither true nor false but **unknown**: `NULL > 3.5` and `NULL = NULL` are both unknown. WHERE keeps only the rows where the condition is true, so an unknown leaves the row out, just as false does. PR0L1NE shows unknown as **NULL** (in orange), and the row says "NULL: unknown, so not kept". To ask for missing values, use `IS NULL`. The "NULL is unknown" example shows both.

### No ORDER BY

Without ORDER BY, Postgres may return rows in any order, and the last step says so. PR0L1NE draws them in the order the table keeps them.

## Statements that change tables

`CREATE TABLE`, `INSERT`, `UPDATE` and `DELETE` are a step each, showing the table before and after:

- **INSERT:** the new rows are highlighted in the table after.
- **UPDATE:** first, a step through its WHERE. It shows which rows it picks to change, with a **picked?** column, the same way a query's WHERE works. Then the table before, with those rows marked, beside the table after. Each changed row there says what changed: "was #1: age 3 → 4". Postgres writes an updated row anew, so it has a new number.
- **DELETE:** first, the same step through its WHERE. Then the table before, with the deleted rows struck through, beside the table after.

### Refused statements

When Postgres refuses a statement for one of a table's rules, the error is shown as usual, and a last step shows the rows involved. Nothing has changed at that point.

- **A unique key** (`PRIMARY KEY`, `UNIQUE`): the row that already has the key is marked. For example, "customers already has a row with id = 3", with Alan's row marked.
- **A foreign key:** for a key that doesn't exist, the step shows the other table ("stations has no row with to_station = 99"). For a row that other rows still point at, the step marks those rows ("rows of orders still point at id = 2").
- **NOT NULL and CHECK:** the table, and the rule it breaks, like `CHECK ((minutes > 0))`.

The rule itself, as Postgres keeps it, is in a note under the step.

`BEGIN`, `COMMIT` and `ROLLBACK` aren't needed here and aren't allowed: every run is thrown away at the end. `COPY` can't read files here either.

## Importing a CSV file

With SQL selected, **Import CSV** in the toolbar makes a table from a CSV file. It adds `CREATE TABLE` and `INSERT` statements to your program, at the cursor, so the table is part of the program: it's saved with it and travels in its share link. The file is read in your browser and goes nowhere else.

- **Column names:** the first row names the columns, made into names SQL can use without quotes (`First Name` becomes `first_name`).
- **Types:** each column gets the narrowest type every value fits: integer, numeric, date (`2024-01-31`), boolean, or text. An empty value is NULL.
- **Separators:** commas, semicolons or tabs, and quoted values with commas or line breaks in them.
- **Limits:** up to the first 200 rows are imported, from a file of up to 1 MB. A program is for reading, and its share link has to hold it.

## Errors

The first error stops the run. It's shown on its line with Postgres's own message, followed by what usually causes it. For example:

> **Error** on line 4: column "prise" does not exist. products has "id", "name", "category", "price", "stock". Perhaps you meant to reference the column "products.price".

Using a name from SELECT in WHERE is explained the same way: WHERE runs first, so the name doesn't exist there yet.

The most common GROUP BY error, "column must appear in the GROUP BY clause or be used in an aggregate function", is stepped through as far as GROUP BY. The step shows the groups with the refused column beside them (in red), and points at a group where it has more than one value: "In G1 (category = Tea), products.name has 4 different values: Green tea, Earl Grey, Oolong, Chai." A group becomes one row, which can't show four names. The fix is to put the column in GROUP BY, or inside an aggregate like `max(name)`. Asking for a table that isn't there lists the tables there are. If there aren't any, the message suggests a sample database.

## Not stepped through yet

A query that uses any of these is still run, and its result is shown as a single step, saying what isn't stepped through yet:

- joins in parentheses (`a JOIN (b JOIN c ON ...) ON ...`), a join with a name of its own (`AS` after it), and a mix of commas and JOIN in one FROM
- GROUPING SETS, ROLLUP and CUBE, and ordered-set aggregates (`WITHIN GROUP`)
- WITH queries that change tables, a WITH RECURSIVE query that isn't a starting query, UNION, then the recursive one, LATERAL, and ARRAY(...) subqueries
- named windows (`WINDOW w AS (...)`), window functions with GROUP BY, DISTINCT ON, and `FETCH … WITH TIES`
- functions in FROM, like `generate_series`
- functions like `random()`, which give a new answer each time they're called



## Examples

The **Open…** menu has SQL examples in eight groups. Each one adds one thing to the one before:

| Group | Examples |
| --- | --- |
| Querying one table | Every row, choosing columns, filtering with WHERE, AND, OR and NOT, NULL is unknown, computed columns |
| Sorting, DISTINCT and LIMIT | ORDER BY, breaking ties, DISTINCT, top three with LIMIT, pages with OFFSET, every clause together |
| Joining tables | JOIN … ON, LEFT JOIN keeps every row, rows with no match, three tables, a self join (who reports to whom), FULL JOIN, a comma in FROM |
| Grouping and aggregates | COUNT and SUM over every row, GROUP BY, COUNT(*) or COUNT(column), HAVING, WHERE then GROUP BY then HAVING, grouping a join |
| Subqueries, WITH and UNION | CASE, a subquery that stands alone, IN (subquery), EXISTS once for each row, a count for each row, the NOT IN trap, WITH, a subquery in FROM, UNION, INTERSECT and EXCEPT |
| Window functions | A running total, PARTITION BY, a moving window, LAG: the row before |
| WITH RECURSIVE | Counting to five, chain of command, every station you can reach |
| Your own tables | Create, insert, update, delete |

## The download

Postgres runs in your browser (as [PGlite](https://pglite.dev), Postgres compiled to WebAssembly), so nothing you write leaves the page. It's downloaded the first time you pick SQL, which takes a few seconds; the toolbar shows "Downloading PostgreSQL" until it's ready. After that, your browser keeps a copy, and a run takes a fraction of a second.
