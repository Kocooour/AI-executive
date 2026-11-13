import path from "node:path";

/**
 * Return true when child is the same path as parent or is below it.
 * path.relative handles filesystem roots: startsWith(parent + sep) fails for
 * '/' because the constructed prefix is '//'. Callers canonicalize existing
 * paths with realpathSync before checking aliases.
 */
export function isWithinPath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
