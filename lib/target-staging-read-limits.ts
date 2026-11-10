/** Hard staging bound for Areas contributing to one scoped snapshot read. */
export const MAX_SCOPED_READ_AREAS = 1000;

/** A single, bounded private Area catalogue may include up to 1000 titles of
 * 4096 UTF-8 bytes each. JSON escaping can double quoted/backslash bytes;
 * the child also includes an internal linearization witness. Allow only
 * this script a 12MiB cap; all other staging children remain capped at 1MiB. */
export const MAX_PRIVATE_NOTE_AREA_CATALOG_BYTES = 12 * 1024 * 1024;
