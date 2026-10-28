/**
 * The scenes for a SQL trace (Trace.sql): what the two windows show at a
 * step of a query, instead of variables and loops.
 *
 *   the memory window   the tables at this stage (SqlTableScene)
 *   the loop window     the statement's stages as a pipeline, this one
 *                       marked (SqlPipelineScene)
 *
 * The renderers draw them with render/sqlView.ts, behind the same contract
 * as every scene (scene/renderer.ts).
 */
import type { SqlRow, SqlStage, SqlStatement, SqlTable, Trace } from "../trace/types";

export interface SqlTableScene {
  kind: "sql-table";
  /** The stage, with group colors carried to the rows the groups became (see groupsCarried). */
  stage: SqlStage;
  /** Each table of the database's color: an index into the palette, the same for the whole run. */
  tableColor(name: string): number | null;
  /** The tables a row was built from (through joins, UNION, WITH and subqueries), with the ones a join found nothing in. */
  sources(row: SqlRow): RowSource[];
  /** Is a drawn table one of the database's own (rather than rows made from them)? */
  isBase(table: SqlTable): boolean;
  /** An aggregate's step: the groups it folds, each into one row (the GROUP BY step's table). */
  fold: SqlTable | null;
}

/** One table a row came from; `missing`: an outer join found no row of it, so its columns are NULL. */
export interface RowSource {
  name: string;
  missing: boolean;
}

export interface SqlPipelineStage {
  stage: SqlStage;
  /** Its step. */
  stepIndex: number;
  /** done: before this step; current: this step; next: still to come. */
  state: "done" | "current" | "next";
}

export interface SqlPipelineScene {
  kind: "sql-pipeline";
  statement: SqlStatement;
  /** Which statement this is, from 1, of how many (the sample database doesn't count). */
  number: number;
  count: number;
  stages: SqlPipelineStage[];
}

export type SqlScene = SqlTableScene | SqlPipelineScene;

/** Is this a SQL scene (rather than a memory or loop scene)? */
export const isSqlScene = (scene: object): scene is SqlScene =>
  "kind" in scene && (scene.kind === "sql-table" || scene.kind === "sql-pipeline");

export function sqlTableScene(trace: Trace, stepIndex: number): SqlTableScene | null {
  const sql = trace.sql;
  const stage = sql?.stages[stepIndex];
  if (!sql || !stage) return null;
  const lineage = lineageOf(trace, stage.statement);
  const colors = tableColors(trace);
  // The aggregate folds the GROUP BY step just before it (in the same part of the statement).
  const before = sql.stages[stepIndex - 1];
  const fold =
    stage.kind === "aggregate" &&
    before?.kind === "group" &&
    before.statement === stage.statement &&
    before.part?.label === stage.part?.label
      ? (before.tables[0] ?? null)
      : null;
  return {
    kind: "sql-table",
    stage: groupsCarried(sql.stages, stepIndex),
    tableColor: (name) => colors.get(lineage.alias.get(name) ?? name) ?? null,
    sources: (row) => lineage.sources(row.id),
    isBase: (table) => lineage.base.has(table.name) && !lineage.derived.has(table.name),
    fold,
  };
}

/** Prefixes of row ids that aren't tables: rows a step made, groups, a recursive query's passes, UNION's sides. */
const NOT_TABLES = /^(result|group|pass\d+|made|first|second)$/;

/** The parts of a row id: "pets:0,3", "p:0,1|o:-" (a join, o's side NULL), "made|first|pets:0,1" (UNION). */
const idParts = (id: string) =>
  id
    .split("|")
    .filter((p) => !NOT_TABLES.test(p))
    .map((p) => {
      const at = p.lastIndexOf(":");
      return at < 0 ? null : { prefix: p.slice(0, at), place: p.slice(at + 1) };
    })
    .filter((p): p is { prefix: string; place: string } => p !== null && !NOT_TABLES.test(p.prefix));

interface Lineage {
  /** Alias -> table name ("p" -> "pets"). */
  alias: Map<string, string>;
  /** Tables made for the statement (WITH, subqueries in FROM) -> the database tables they're made from. */
  derived: Map<string, string[]>;
  /** The database's tables. */
  base: Set<string>;
  sources(id: string): RowSource[];
}

const lineages = new WeakMap<Trace, Map<number, Lineage>>();

/**
 * Where a statement's rows come from. A row's id names the table rows it's
 * made of (select.ts); a table the statement made for itself (WITH name,
 * FROM (...) AS name) stands for the tables its part read, worked out from
 * that part's own rows, in order.
 */
function lineageOf(trace: Trace, statement: number): Lineage {
  let byStatement = lineages.get(trace);
  if (!byStatement) {
    byStatement = new Map();
    lineages.set(trace, byStatement);
  }
  const known = byStatement.get(statement);
  if (known) return known;
  const stages = trace.sql!.stages;
  const alias = new Map<string, string>();
  const base = new Set<string>();
  for (const s of stages)
    for (const table of s.tables) {
      if (table.alias) alias.set(table.alias, table.name);
      if (s.kind === "tables" || s.kind === "statement") base.add(table.name);
    }
  const derived = new Map<string, string[]>();
  const resolve = (prefix: string): string[] => {
    const name = alias.get(prefix) ?? prefix;
    return derived.get(name) ?? [name];
  };
  const sources = (id: string): RowSource[] => {
    const out: RowSource[] = [];
    for (const { prefix, place } of idParts(id))
      for (const name of resolve(prefix)) {
        const missing = place === "-";
        const same = out.find((s) => s.name === name);
        if (same) same.missing &&= missing;
        else out.push({ name, missing });
      }
    return out;
  };
  // Each part that makes a table: the tables its rows came from, before the stages that read it.
  const mine = stages.filter((s) => s.statement === statement);
  const partName = (label: string) =>
    /(?:^|› )(?:WITH(?: RECURSIVE)? |Subquery AS )([^\s:›]+)(?::[^›]*)?$/.exec(label)?.[1] ?? null;
  for (const s of mine) {
    const name = s.part ? partName(s.part.label) : null;
    if (!name) continue;
    const found = derived.get(name) ?? [];
    for (const table of s.tables)
      for (const row of table.rows)
        for (const src of sources(row.id)) if (src.name !== name && !found.includes(src.name)) found.push(src.name);
    derived.set(name, found);
  }
  const lineage = { alias, derived, base, sources };
  byStatement.set(statement, lineage);
  return lineage;
}

/** The database's tables, numbered in the order the run first shows them: their colors. */
const colorOrders = new WeakMap<Trace, Map<string, number>>();
function tableColors(trace: Trace): Map<string, number> {
  let order = colorOrders.get(trace);
  if (order) return order;
  order = new Map();
  for (const stage of trace.sql?.stages ?? []) {
    const lineage = lineageOf(trace, stage.statement);
    for (const table of stage.tables) {
      if (lineage.base.has(table.name) && !order.has(table.name)) order.set(table.name, order.size);
      for (const row of table.rows)
        for (const src of lineage.sources(row.id))
          if (lineage.base.has(src.name) && !order.has(src.name)) order.set(src.name, order.size);
    }
  }
  colorOrders.set(trace, order);
  return order;
}

/**
 * A group keeps its color after GROUP BY: HAVING, SELECT, ORDER BY and
 * LIMIT's rows are the groups (their ids are the groups'), so each takes
 * its group's color, back to the rows it was made from.
 */
function groupsCarried(stages: SqlStage[], stepIndex: number): SqlStage {
  const stage = stages[stepIndex];
  let groupOf: Map<string, number> | null = null;
  for (let i = stepIndex - 1; i >= 0; i--) {
    const s = stages[i];
    if (s.statement !== stage.statement || s.part?.label !== stage.part?.label) break;
    if (s.kind === "aggregate") {
      groupOf = new Map(
        s.tables[0]?.rows.flatMap((r) => (r.group !== undefined ? [[r.id, r.group] as [string, number]] : [])) ?? [],
      );
      break;
    }
  }
  if (!groupOf?.size || stage.kind === "aggregate" || stage.kind === "group") return stage;
  const map = groupOf;
  return {
    ...stage,
    tables: stage.tables.map((table) => ({
      ...table,
      rows: table.rows.map((r) => (r.group === undefined && map.has(r.id) ? { ...r, group: map.get(r.id)! } : r)),
    })),
  };
}

export function sqlPipelineScene(trace: Trace, stepIndex: number): SqlPipelineScene | null {
  const sql = trace.sql;
  const stage = sql?.stages[stepIndex];
  if (!sql || !stage) return null;
  const statement = sql.statements[stage.statement];
  if (!statement) return null;
  const stages = sql.stages
    .map(
      (s, i): SqlPipelineStage => ({
        stage: s,
        stepIndex: i,
        state: i < stepIndex ? "done" : i === stepIndex ? "current" : "next",
      }),
    )
    .filter((s) => s.stage.statement === stage.statement);
  const real = sql.statements.filter((s) => s.kind !== "DATABASE");
  return {
    kind: "sql-pipeline",
    statement,
    number: real.indexOf(statement) + 1,
    count: real.length,
    stages,
  };
}
