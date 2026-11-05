// Local development server. Serves ONLY generated dist/ files and explicit api/ route
// modules. Source, server/, dotfiles, and anything outside dist/ are never served.
import { createServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

// Returns null for anything suspicious: non-origin-form URLs, malformed escapes,
// NUL bytes, backslashes, and any dot-prefixed segment (dotfiles and traversal).
export function parseRequestPath(rawUrl = "/") {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null;
  let url;
  try { url = new URL(`http://localhost${rawUrl}`); } catch { return null; }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  if (pathname.split("/").some((segment) => segment.startsWith("."))) return null;
  return { rawPathname: url.pathname, pathname, search: url.search, searchParams: url.searchParams };
}

// Mirrors Vercel cleanUrls + trailingSlash:false redirects.
export function cleanUrlRedirect(rawPathname, search = "") {
  let target = rawPathname;
  if (target.endsWith(".html")) target = target.slice(0, -5);
  if (target === "/index" || target.endsWith("/index")) target = target.slice(0, -6) || "/";
  if (target.length > 1 && target.endsWith("/")) target = target.replace(/\/+$/, "") || "/";
  if (target === rawPathname) return null;
  return `/${target.replace(/^\/+/, "")}${search}`;
}

export async function resolveStaticFile(distDir, pathname) {
  let candidate = pathname === "/" ? "/index.html" : pathname;
  if (!extname(candidate)) candidate = `${candidate}.html`;
  const root = await realpath(distDir);
  const target = resolve(root, `.${candidate}`);
  if (!target.startsWith(root + sep)) return null;
  let real;
  try { real = await realpath(target); } catch { return null; }
  if (!real.startsWith(root + sep)) return null;
  const info = await stat(real);
  return info.isFile() ? real : null;
}

// Only regular .js files under api/ become routes. Names starting with "_" or "."
// and symlinks are skipped, so helpers can never be exposed as endpoints.
export async function discoverApiRoutes(apiDir) {
  const routes = new Map();
  async function walk(directory, prefix) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, `${prefix}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith(".js")) routes.set(`${prefix}/${entry.name.slice(0, -3)}`, fullPath);
    }
  }
  await walk(apiDir, "/api");
  return routes;
}

export async function loadEnvironmentFile(filePath) {
  let content;
  try { content = await readFile(filePath, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function sendText(response, status, message) {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

export async function createDevServer({ root, distDir = join(root, "dist"), apiDir = join(root, "api") }) {
  try { await stat(join(distDir, "index.html")); } catch {
    throw new Error("dist/index.html is missing. Run `npm run build` first.");
  }
  const apiRoutes = await discoverApiRoutes(apiDir);
  const modules = new Map();

  return createServer(async (request, response) => {
    try {
      const parsed = parseRequestPath(request.url);
      if (!parsed) return sendText(response, 400, "Bad request");
      const { rawPathname, pathname, search, searchParams } = parsed;

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        const file = apiRoutes.get(pathname);
        if (!file) return sendText(response, 404, "Not found");
        let module = modules.get(file);
        if (!module) {
          module = await import(pathToFileURL(file).href);
          modules.set(file, module);
        }
        if (typeof module.default !== "function") throw new Error(`${pathname} has no default handler export`);
        request.query = Object.fromEntries(searchParams.entries());
        await module.default(request, response);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        return sendText(response, 405, "Method not allowed");
      }

      const redirect = cleanUrlRedirect(rawPathname, search);
      if (redirect) {
        applySecurityHeaders(response);
        response.statusCode = 308;
        response.setHeader("Location", redirect);
        return response.end();
      }

      const file = await resolveStaticFile(distDir, pathname);
      if (!file) return sendText(response, 404, "Not found");
      const body = await readFile(file);
      applySecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", CONTENT_TYPES[extname(file)] || "application/octet-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendText(response, 500, "Development server error");
      else response.end();
    }
  });
}
