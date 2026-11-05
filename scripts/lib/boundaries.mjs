// Import-boundary rules shared by `npm run check` and the esbuild browser build.
// Layers: src/ (browser), api/ (Vercel handlers), server/ (server-only modules).
import { builtinModules } from "node:module";
import { posix } from "node:path";

const BUILTINS = new Set(builtinModules);
export const SERVER_ONLY_PACKAGES = new Set(["stripe", "resend", "pg"]);
const IMPORT_PATTERN = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

export function extractImports(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] || match[2]);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function layerOf(file) {
  return file.split("/")[0];
}

// file: repository-relative POSIX path of the importing module.
export function importViolation(file, specifier) {
  const layer = layerOf(file);
  if (specifier.startsWith("/")) return `${file}: absolute import "${specifier}" is not allowed`;
  const relativeImport = specifier.startsWith(".");
  const target = relativeImport ? posix.normalize(posix.join(posix.dirname(file), specifier)) : null;
  if (target && (target === ".." || target.startsWith("../"))) return `${file}: import "${specifier}" escapes the repository`;
  const targetLayer = target ? layerOf(target) : null;

  if (layer === "src") {
    if (specifier.startsWith("node:") || (!relativeImport && BUILTINS.has(packageName(specifier)))) {
      return `${file}: browser code cannot import Node built-in "${specifier}"`;
    }
    if (!relativeImport && SERVER_ONLY_PACKAGES.has(packageName(specifier))) {
      return `${file}: browser code cannot import server-only package "${specifier}"`;
    }
    if (target && targetLayer !== "src") return `${file}: browser code cannot import "${specifier}" outside src/`;
  }
  if (layer === "server" && target && targetLayer !== "server") {
    return `${file}: server modules may only import other server/ modules (got "${specifier}")`;
  }
  if (layer === "api" && target && targetLayer !== "server") {
    return `${file}: API routes may only import from server/ (got "${specifier}")`;
  }
  return null;
}

export function sourceViolations(file, source) {
  const problems = [];
  for (const specifier of extractImports(source)) {
    const problem = importViolation(file, specifier);
    if (problem) problems.push(problem);
  }
  if (layerOf(file) === "src" && /\bprocess\.env\b/.test(source)) problems.push(`${file}: browser code must not read process.env`);
  if (layerOf(file) === "api" && file.split("/").some((part) => part.startsWith("_"))) {
    problems.push(`${file}: shared helpers belong in server/, not api/_*`);
  }
  return problems;
}
