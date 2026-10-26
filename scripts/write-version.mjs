import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

if (typeof version !== "string" || !version) {
  throw new Error("package.json is missing a version string");
}

const contents = `/** Generated from package.json by scripts/write-version.mjs — do not edit by hand. */
export const APP_VERSION = ${JSON.stringify(version)};
`;

writeFileSync(join(root, "src", "version.ts"), contents, "utf8");
console.log(`Wrote src/version.ts (APP_VERSION = ${version})`);
