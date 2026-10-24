// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CsvImportController, MAX_CSV_BYTES } from "./csvImport";

function setup() {
  document.body.innerHTML = `<button id="b"></button><input id="f" type="file" />`;
  const inserted: string[] = [];
  const banners: (string | null)[] = [];
  const controller = new CsvImportController({
    button: document.getElementById("b") as HTMLButtonElement,
    input: document.getElementById("f") as HTMLInputElement,
    insert: (sql) => inserted.push(sql),
    setBanner: (html) => banners.push(html),
  });
  const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => text });
  return { controller, inserted, banners, file };
}

describe("Import CSV", () => {
  it("adds the file's table to the program, and says so", async () => {
    const { controller, inserted, banners, file } = setup();
    await controller.importFile(file("pets.csv", "name,age\nRex,3\n"));
    expect(inserted[0]).toContain("CREATE TABLE pets (");
    expect(banners[0]).toContain("Added the table <strong>pets</strong> from pets.csv: 1 row");
  });

  it("says why a file can't be imported, and adds nothing", async () => {
    const { controller, inserted, banners, file } = setup();
    await controller.importFile(file("bad.csv", "a,b\n1\n"));
    await controller.importFile(file("big.csv", "a\n1", MAX_CSV_BYTES + 1));
    expect(inserted).toEqual([]);
    expect(banners[0]).toContain("bad.csv couldn't be imported.</strong> Every row must have 2 values");
    expect(banners[1]).toContain("big.csv is too big to import");
  });

  it("opens the file picker from the button", () => {
    setup();
    const input = document.getElementById("f") as HTMLInputElement;
    let opened = false;
    input.click = () => {
      opened = true;
    };
    (document.getElementById("b") as HTMLButtonElement).click();
    expect(opened).toBe(true);
  });
});
