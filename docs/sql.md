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

Without the hint, the database starts empty. Make your own tables with `CREATE TABLE` and fill them with `INSERT`.

Every run starts from a fresh copy of the database. Nothing a program does is kept, not even a `DROP TABLE`, so you can't break anything.

## Each clause, step by step

| Step | What it shows |
| --- | --- |
| **FROM** | The table, every row, numbered in the order Postgres keeps them (`#1`, `#2`...). The numbers stay with the rows through every step after this one. |
| **JOIN** | One step for each table joined: see [Joins](#joins), below. |
| **WHERE** | Every row, with the condition worked out for it in a **kept?** column. Rows where it isn't true are struck through. A condition joined with AND, OR or NOT also gets a column for each of its parts (up to four), so you can see which part decided each row. |
| **SELECT** | The columns the query asks for, for the rows WHERE kept. Columns it works out (`price * stock AS stock_value`) are tinted, and hovering over the heading shows the expression. |
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

### NULL

NULL is SQL's "no value", and any comparison with it is neither true nor false but **unknown**: `NULL > 3.5` and `NULL = NULL` are both unknown. WHERE keeps only the rows where the condition is true, so an unknown leaves the row out, just as false does. PR0L1NE shows unknown as **NULL** (in orange), and the row says "NULL: unknown, so not kept". To ask for missing values, use `IS NULL`. The "NULL is unknown" example shows both.

### No ORDER BY

Without ORDER BY, Postgres may return rows in any order, and the last step says so. PR0L1NE draws them in the order the table keeps them.

## Statements that change tables

`CREATE TABLE`, `INSERT`, `UPDATE` and `DELETE` are a step each. Each one shows the table it changed:

- **INSERT** shows the new rows highlighted.
- **UPDATE** shows the changed rows highlighted.
- **DELETE** shows the table before the delete, with the deleted rows struck through.

`BEGIN`, `COMMIT` and `ROLLBACK` aren't needed here and aren't allowed: every run is thrown away at the end. `COPY` can't read files here either.

## Errors

The first error stops the run. It's shown on its line with Postgres's own message, followed by what usually causes it. For example:

> **Error** on line 4: column "prise" does not exist. products has "id", "name", "category", "price", "stock". Perhaps you meant to reference the column "products.price".

Using a name from SELECT in WHERE is explained the same way: WHERE runs first, so the name doesn't exist there yet. Asking for a table that isn't there lists the tables there are. If there aren't any, the message suggests a sample database.

## Not stepped through yet

A query that uses any of these is still run, and its result is shown as a single step, saying what isn't stepped through yet:

- joins in parentheses (`a JOIN (b JOIN c ON ...) ON ...`), a join with a name of its own (`AS` after it), and a mix of commas and JOIN in one FROM
- GROUP BY, HAVING, and aggregate functions like COUNT and SUM
- subqueries, WITH (common table expressions), UNION, INTERSECT and EXCEPT
- window functions, DISTINCT ON, and `FETCH … WITH TIES`
- functions in FROM, like `generate_series`
- functions like `random()`, which give a new answer each time they're called

GROUP BY and aggregates are next: see the [roadmap](roadmap.md).

## Examples

The **Open…** menu has SQL examples in four groups. Each one adds one thing to the one before:

| Group | Examples |
| --- | --- |
| Querying one table | Every row, choosing columns, filtering with WHERE, AND, OR and NOT, NULL is unknown, computed columns |
| Sorting, DISTINCT and LIMIT | ORDER BY, breaking ties, DISTINCT, top three with LIMIT, pages with OFFSET, every clause together |
| Joining tables | JOIN … ON, LEFT JOIN keeps every row, rows with no match, three tables, a self join (who reports to whom), FULL JOIN, a comma in FROM |
| Your own tables | Create, insert, update, delete |

## The download

Postgres runs in your browser (as [PGlite](https://pglite.dev), Postgres compiled to WebAssembly), so nothing you write leaves the page. It's downloaded the first time you pick SQL, which takes a few seconds; the toolbar shows "Downloading PostgreSQL" until it's ready. After that, your browser keeps a copy, and a run takes a fraction of a second.
