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
import type { SqlStage, SqlStatement, Trace } from "../trace/types";

export interface SqlTableScene {
  kind: "sql-table";
  stage: SqlStage;
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
  const stage = trace.sql?.stages[stepIndex];
  return stage ? { kind: "sql-table", stage } : null;
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
