// Pure POSIX ownership guard shared by the provision verifier and its
// regression tests. A privileged operator must not accept 0700/0600 objects
// controlled by another UID: that owner can still change them during preflight.
// Fail closed when the process UID is unavailable.
export function isOwnedByOperator(stat, operatorUid) {
  return Number.isSafeInteger(operatorUid) && operatorUid >= 0 &&
    stat?.uid === operatorUid;
}
