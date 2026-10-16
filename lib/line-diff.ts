// A simple line diff (longest common subsequence) for comparing two versions of a note. Kept free of
// React so it can be tested.

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

const maxCells = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const head = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same" as const, text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const middle: DiffLine[] = [];
  if ((x.length + 1) * (y.length + 1) > maxCells) {
    // Too large to compare line by line: shown as replaced as a whole.
    for (const text of x) middle.push({ kind: "removed", text });
    for (const text of y) middle.push({ kind: "added", text });
  } else {
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { middle.push({ kind: "same", text: x[i] }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { middle.push({ kind: "removed", text: x[i] }); i += 1; }
      else { middle.push({ kind: "added", text: y[j] }); j += 1; }
    }
    for (; i < x.length; i += 1) middle.push({ kind: "removed", text: x[i] });
    for (; j < y.length; j += 1) middle.push({ kind: "added", text: y[j] });
  }
  return [...head, ...middle, ...tail];
}
