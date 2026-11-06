// `npm run check`: syntax-checks every script and enforces layer import boundaries.
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceViolations } from "./lib/boundaries.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["api", "server", "src", "scripts", "tests"];
const PAGES = ["public/index.html", "public/admin.html", "public/booking.html"];
const ALLOWED_PAGE_SCRIPTS = new Set(["/assets/guest.js", "/assets/admin.js", "/assets/booking.js"]);

async function listFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => {
      const fullPath = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    }));
  return nested.flat();
}

const problems = [];
const files = (await Promise.all(SOURCE_DIRS.map((directory) => listFiles(join(root, directory))))).flat();
let checked = 0;

for (const file of files) {
  const relativePath = relative(root, file).split(sep).join("/");
  if (/\.m?js$/.test(file)) {
    checked += 1;
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) problems.push(`${relativePath}: syntax error\n${(result.stderr || "").trim()}`);
    problems.push(...sourceViolations(relativePath, await readFile(file, "utf8")));
  } else if (file.endsWith(".sh")) {
    checked += 1;
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    if (result.status !== 0) problems.push(`${relativePath}: shell syntax error\n${(result.stderr || "").trim()}`);
  }
}

for (const page of PAGES) {
  const html = await readFile(join(root, page), "utf8");
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    if (!ALLOWED_PAGE_SCRIPTS.has(match[1])) problems.push(`${page}: script "${match[1]}" must be a bundled /assets/*.js entry`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} scripts and import boundaries`);
}
