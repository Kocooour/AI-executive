/** IDs that can be addressed by the isolated read-only project detail HTTP route. */
export function isReadableStagingProjectId(value: unknown): value is string {
  // Dot-only segments are normalized away by HTTP URL parsers, even encoded.
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." &&
    Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
