import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** The generated file is intentionally listed in `.prettierignore`; compare
 * Supabase's exact deterministic output rather than creating formatting-only
 * churn in generated code. */
const generated = execFileSync(
  process.execPath,
  [
    path.join("node_modules", "supabase", "dist", "supabase.js"),
    "gen",
    "types",
    "--local",
    "--schema",
    "public",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const actual = await readFile("src/types/database.ts", "utf8");
assert.equal(
  actual,
  generated,
  "src/types/database.ts is stale; run npm run db:types",
);
process.stdout.write(
  "Generated public database types match the local schema.\n",
);
