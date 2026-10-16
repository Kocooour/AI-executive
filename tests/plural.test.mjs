import assert from "node:assert/strict";
import test from "node:test";

const { pluralText } = await import("../lib/plural.ts");
const { copy } = await import("../app/ui/copy.ts");

test("Czech forms: 1, 2-4, 5 and more, 0", () => {
  const forms = "záznam|záznamy|záznamů";
  assert.deepEqual([0, 1, 2, 3, 4, 5, 11, 22, 100].map((count) => pluralText("cs", count, forms)),
    ["0 záznamů", "1 záznam", "2 záznamy", "3 záznamy", "4 záznamy", "5 záznamů", "11 záznamů", "22 záznamů", "100 záznamů"]);
});

test("English forms: 1 and the rest", () => {
  assert.deepEqual([0, 1, 2].map((count) => pluralText("en", count, "claim|claims")), ["0 claims", "1 claim", "2 claims"]);
});

test("every counted noun of the backup list has forms in both languages", () => {
  for (const key of ["pluRecords", "pluClaims", "pluSources", "pluNoteVersions", "pluWorkBlocks", "pluItems", "pluRelations"]) {
    assert.equal(copy.cs[key].split("|").length, 3, key);
    assert.equal(copy.en[key].split("|").length, 2, key);
  }
  assert.equal(pluralText("cs", 1, copy.cs.pluNoteVersions), "1 verze poznámky");
  assert.equal(pluralText("cs", 3, copy.cs.pluNoteVersions), "3 verze poznámek");
  assert.equal(pluralText("cs", 5, copy.cs.pluNoteVersions), "5 verzí poznámek");
  assert.equal(pluralText("cs", 2, copy.cs.pluWorkBlocks), "2 pracovní bloky");
  assert.equal(pluralText("cs", 7, copy.cs.pluRelations), "7 vztahů");
  assert.equal(pluralText("cs", 1, copy.cs.pluItems), "1 položka");
  assert.equal(pluralText("cs", 4, copy.cs.pluSources), "4 zdroje");
  assert.equal(pluralText("en", 1, copy.en.pluNoteVersions), "1 note version");
});
