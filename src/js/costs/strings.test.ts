import { describe } from "vitest";
import { STRING_METHODS } from "./strings";
import { checkTable } from "./tableTests";

describe("string methods cost what the table says", () => {
  checkTable(STRING_METHODS, "s", "", { name: "s", len: true });
});
