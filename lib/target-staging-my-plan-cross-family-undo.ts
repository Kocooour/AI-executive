/** R3 UI-04b: a definite PRE-COMMIT rejection cannot supersede a previous
 * confirmed Undo in the other mutation family. Called only AFTER dispatch;
 * never during read-only receipt/CAS preflight. */
export function supersedesCrossFamilyUndo(
  resultKind:"committed"|"uncertain"|"rejected",
):boolean{
  return resultKind==="committed"||resultKind==="uncertain";
}
