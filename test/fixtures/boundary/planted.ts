// synthetic: a module the boundary test's import parser must see through (never imported by pr-rla).
import * as files from "../../../src/api/write/files.js";
export { initAudit } from "../../../src/api/write/init.js";
export * from "../../../src/core/canonical.js";
export const planted = files;
