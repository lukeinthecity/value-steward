import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(repoRoot, "scripts");

// CLAUDE.md: runnable scripts must guard their entrypoint so importing them
// (from tests or other modules) never executes real work against the live
// data tree. A script counts as runnable if it invokes main() at top level.
test("every runnable script guards its main() invocation", () => {
  const offenders = [];
  for (const file of fs.readdirSync(scriptsDir)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(scriptsDir, file), "utf8");
    const invokesMain = /^\s*main\(\)/m.test(src);
    if (!invokesMain) continue;
    const guarded =
      src.includes("import.meta.url") && src.includes("process.argv[1]");
    if (!guarded) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `scripts missing the isDirectExecution guard: ${offenders.join(", ")}`
  );
});
