import test from "node:test";
import assert from "node:assert/strict";
import { extractImports, importViolation, sourceViolations } from "../scripts/lib/boundaries.mjs";

test("extracts static, re-export, side-effect, and dynamic imports", () => {
  const source = `import a from "./a.js";\nimport {\n  b,\n  c\n} from "../b.js";\nexport { d } from "./d.js";\nimport "./side.js";\nconst e = await import("./e.js");\n// Must not import server/, api/, or secrets.\n`;
  assert.deepEqual(extractImports(source), ["./a.js", "../b.js", "./d.js", "./side.js", "./e.js"]);
});

test("browser code cannot reach server code, Node built-ins, or server-only packages", () => {
  assert.ok(importViolation("src/guest/index.js", "../../server/http.js"));
  assert.ok(importViolation("src/guest/index.js", "../../api/config.js"));
  assert.ok(importViolation("src/admin/index.js", "node:fs"));
  assert.ok(importViolation("src/admin/index.js", "fs"));
  assert.ok(importViolation("src/admin/index.js", "stripe"));
  assert.ok(importViolation("src/admin/index.js", "pg"));
  assert.equal(importViolation("src/admin/index.js", "@supabase/supabase-js"), null);
  assert.equal(importViolation("src/guest/index.js", "./format.js"), null);
  assert.equal(importViolation("src/guest/index.js", "../shared/dates.js"), null);
});

test("server and API layers keep their direction", () => {
  assert.equal(importViolation("server/integrations/supabase.js", "../http.js"), null);
  assert.ok(importViolation("server/http.js", "../api/config.js"));
  assert.ok(importViolation("server/http.js", "../src/guest/index.js"));
  assert.equal(importViolation("api/config.js", "../server/config.js"), null);
  assert.ok(importViolation("api/config.js", "../src/guest/index.js"));
  assert.ok(importViolation("api/admin/blocks.js", "../bookings.js"));
  assert.ok(importViolation("api/config.js", "../../outside.js"));
});

test("flags process.env in browser code and helpers under api/_*", () => {
  assert.equal(sourceViolations("src/guest/index.js", "const key = process.env.SECRET;").length, 1);
  assert.equal(sourceViolations("api/_lib/http.js", "export const x = 1;").length, 1);
  assert.deepEqual(sourceViolations("server/config.js", "export const v = process.env.X;"), []);
});
