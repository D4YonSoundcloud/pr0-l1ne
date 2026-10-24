/**
 * The sample databases a SQL program can start from, with
 * `-- viz: database shop` (see sql/script.ts).
 *
 * Small on purpose (under 15 rows a table), so every row fits on screen at
 * every step, and made for showing what SQL does: NULLs where they change
 * an answer, prices that tie, repeated values for DISTINCT, rows that match
 * nothing in another table (for joins, later).
 *
 * A database's contents are part of every program and share link that
 * names it: change one and those programs show something else. To change
 * one for real, add a new one (`shop2`) rather than editing it, unless the
 * change can't alter any result (a comment, the order of statements that
 * don't depend on each other).
 */

export interface SampleDatabase {
  name: string;
  /** One line, for the docs and the error that lists them. */
  description: string;
  /** Creates and fills its tables. */
  setup: string;
}

const SHOP = `
CREATE TABLE customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  city text,
  joined date NOT NULL
);
INSERT INTO customers VALUES
  (1, 'Ada', 'London', '2021-03-14'),
  (2, 'Grace', 'New York', '2020-11-02'),
  (3, 'Alan', 'London', '2022-06-23'),
  (4, 'Edsger', 'Austin', '2023-01-09'),
  (5, 'Barbara', NULL, '2021-08-30'),
  (6, 'Donald', 'Austin', '2024-02-17'),
  (7, 'Margaret', 'Boston', '2022-10-05'),
  (8, 'Linus', 'Helsinki', '2023-07-21');

CREATE TABLE products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  category text,
  price numeric(6, 2) NOT NULL,
  stock integer NOT NULL
);
INSERT INTO products VALUES
  (1, 'Green tea', 'Tea', 6.50, 40),
  (2, 'Earl Grey', 'Tea', 7.25, 0),
  (3, 'Espresso beans', 'Coffee', 14.00, 12),
  (4, 'Decaf beans', 'Coffee', 13.50, 5),
  (5, 'Mug', 'Kitchen', 9.00, 25),
  (6, 'Teapot', 'Kitchen', 24.00, 3),
  (7, 'Oolong', 'Tea', 9.00, 18),
  (8, 'Cold brew kit', 'Coffee', 32.00, 0),
  (9, 'Honey', NULL, 7.25, 30),
  (10, 'Milk frother', 'Kitchen', 19.99, 7),
  (11, 'Chai', 'Tea', 6.50, 22),
  (12, 'Gift card', NULL, 25.00, 100);

CREATE TABLE orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL,
  ordered_on date NOT NULL
);
INSERT INTO orders VALUES
  (1, 1, 1, 2, '2024-01-05'),
  (2, 2, 3, 1, '2024-01-06'),
  (3, 1, 5, 1, '2024-01-12'),
  (4, 3, 7, 3, '2024-01-15'),
  (5, 2, 6, 1, '2024-02-02'),
  (6, 4, 3, 2, '2024-02-03'),
  (7, 5, 11, 4, '2024-02-14'),
  (8, 1, 9, 1, '2024-02-20'),
  (9, 6, 10, 1, '2024-03-01'),
  (10, 3, 1, 1, '2024-03-08'),
  (11, 2, 4, 2, '2024-03-09'),
  (12, 7, 12, 1, '2024-03-15'),
  (13, 4, 5, 2, '2024-03-22'),
  (14, 1, 7, 1, '2024-03-30');
`;

const SCHOOL = `
CREATE TABLE students (
  id integer PRIMARY KEY,
  name text NOT NULL,
  year integer NOT NULL,
  gpa numeric(3, 2),
  city text NOT NULL
);
INSERT INTO students VALUES
  (1, 'Maya', 2, 3.80, 'Leeds'),
  (2, 'Omar', 1, 3.20, 'York'),
  (3, 'Priya', 3, 3.80, 'Leeds'),
  (4, 'Tom', 1, NULL, 'Hull'),
  (5, 'Zoe', 2, 2.90, 'York'),
  (6, 'Ivan', 4, 3.50, 'Leeds'),
  (7, 'Lena', 3, NULL, 'York'),
  (8, 'Kofi', 2, 3.95, 'Hull'),
  (9, 'Sara', 1, 2.40, 'Leeds'),
  (10, 'Ben', 4, 3.10, 'York'),
  (11, 'Nina', 3, 3.50, 'Hull'),
  (12, 'Raj', 1, 3.65, 'Leeds');

CREATE TABLE courses (
  id integer PRIMARY KEY,
  title text NOT NULL,
  department text NOT NULL,
  credits integer NOT NULL
);
INSERT INTO courses VALUES
  (1, 'Databases', 'Computing', 15),
  (2, 'Algorithms', 'Computing', 15),
  (3, 'Statistics', 'Maths', 10),
  (4, 'Linear Algebra', 'Maths', 15),
  (5, 'Ethics', 'Philosophy', 10),
  (6, 'Logic', 'Philosophy', 10),
  (7, 'Networks', 'Computing', 10);

CREATE TABLE enrollments (
  student_id integer NOT NULL REFERENCES students (id),
  course_id integer NOT NULL REFERENCES courses (id),
  grade text,
  PRIMARY KEY (student_id, course_id)
);
INSERT INTO enrollments VALUES
  (1, 1, 'A'),
  (1, 2, 'B'),
  (2, 1, 'C'),
  (3, 3, 'A'),
  (3, 4, 'A'),
  (4, 5, NULL),
  (5, 2, 'B'),
  (6, 1, 'B'),
  (6, 6, 'A'),
  (8, 2, 'A'),
  (8, 4, 'B'),
  (9, 3, NULL),
  (10, 5, 'C'),
  (11, 6, 'B');
`;

const COMPANY = `
CREATE TABLE departments (
  id integer PRIMARY KEY,
  name text NOT NULL,
  floor integer
);
INSERT INTO departments VALUES
  (1, 'Engineering', 3),
  (2, 'Sales', 1),
  (3, 'Support', 1),
  (4, 'Research', NULL);

CREATE TABLE employees (
  id integer PRIMARY KEY,
  name text NOT NULL,
  department_id integer REFERENCES departments (id),
  manager_id integer REFERENCES employees (id),
  salary integer NOT NULL,
  hired date NOT NULL
);
INSERT INTO employees VALUES
  (1, 'Hana', 1, NULL, 9800, '2016-04-01'),
  (2, 'Luis', 1, 1, 7200, '2019-09-16'),
  (3, 'Mei', 1, 1, 7200, '2021-02-08'),
  (4, 'Sam', 2, 1, 6100, '2018-06-25'),
  (5, 'Aisha', 2, 4, 5400, '2022-03-14'),
  (6, 'Jonas', 3, 1, 4800, '2020-11-30'),
  (7, 'Chloe', 3, 6, 4300, '2023-05-02'),
  (8, 'Victor', 1, 2, 6600, '2023-08-21'),
  (9, 'Ines', 2, 4, 5400, '2024-01-15'),
  (10, 'Tariq', NULL, 1, 5000, '2024-06-03'),
  (11, 'Olga', 3, 6, 4300, '2019-01-07');
`;

const TRANSIT = `
CREATE TABLE stations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  zone integer NOT NULL
);
INSERT INTO stations VALUES
  (1, 'Central', 1),
  (2, 'Harbour', 1),
  (3, 'Market', 1),
  (4, 'Museum', 2),
  (5, 'Park', 2),
  (6, 'University', 2),
  (7, 'Stadium', 3),
  (8, 'Airport', 4),
  (9, 'Riverside', 3),
  (10, 'Old Town', 2);

CREATE TABLE connections (
  from_station integer NOT NULL REFERENCES stations (id),
  to_station integer NOT NULL REFERENCES stations (id),
  minutes integer NOT NULL CHECK (minutes > 0),
  PRIMARY KEY (from_station, to_station)
);
INSERT INTO connections VALUES
  (1, 2, 4),
  (1, 3, 3),
  (2, 4, 5),
  (3, 4, 2),
  (3, 5, 6),
  (4, 6, 4),
  (5, 6, 3),
  (4, 5, 2),
  (6, 7, 5),
  (7, 8, 12),
  (5, 9, 7),
  (2, 9, 8),
  (9, 8, 15);
`;

export const SAMPLE_DATABASES: readonly SampleDatabase[] = [
  {
    name: "shop",
    description: "a small shop: customers, products and orders",
    setup: SHOP,
  },
  {
    name: "school",
    description: "students, courses and who takes which",
    setup: SCHOOL,
  },
  {
    name: "company",
    description: "departments, and employees with their managers",
    setup: COMPANY,
  },
  {
    name: "transit",
    description: "stations and the one-way connections between them",
    setup: TRANSIT,
  },
];

/** A sample database by name (any case), or undefined. */
export function sampleDatabase(name: string): SampleDatabase | undefined {
  const wanted = name.toLowerCase();
  return SAMPLE_DATABASES.find((db) => db.name === wanted);
}
