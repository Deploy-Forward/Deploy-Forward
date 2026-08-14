/**
 * check-readme-version — the stale-pin guard.
 *
 * The README and SECURITY.md deliberately pin exact-version install commands
 * (`npx --yes deploy-forward@X.Y.Z`) because an exact version is what a user can
 * audit and what the provenance attestation signs. The cost of that honesty is a
 * hardcoded string that goes stale on every release — this check makes CI fail
 * the moment any pinned `deploy-forward@X.Y.Z` disagrees with tracker/package.json,
 * so the docs can never quietly recommend an old artifact.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../tracker/package.json", import.meta.url), "utf8"));
const current = pkg.version;

let stale = 0;
for (const doc of ["README.md", "SECURITY.md"]) {
  const text = readFileSync(new URL(`../${doc}`, import.meta.url), "utf8");
  for (const m of text.matchAll(/deploy-forward@(\d+\.\d+\.\d+)/g)) {
    if (m[1] !== current) {
      console.error(`${doc}: pins deploy-forward@${m[1]} but tracker/package.json is ${current}`);
      stale++;
    }
  }
}

if (stale > 0) {
  console.error(`\n${stale} stale pin(s). Update the docs in the same commit as the version bump.`);
  process.exit(1);
}
console.log(`README.md and SECURITY.md pins match tracker/package.json (${current}).`);
