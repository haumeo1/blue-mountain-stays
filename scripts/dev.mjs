import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const port = Number(process.env.PORT || 3000);

await loadEnvironment(join(root, ".env.local"));

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const relative = `${url.pathname.slice(1)}.js`;
      const module = await import(`${pathToFileURL(join(root, relative)).href}?t=${Date.now()}`);
      request.query = Object.fromEntries(url.searchParams.entries());
      return module.default(request, response);
    }

    const route = url.pathname === "/" ? "/single.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
    const safePath = normalize(route).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, safePath);
    const content = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", types[extname(filePath)] || "application/octet-stream");
    response.end(content);
  } catch (error) {
    if (!response.headersSent) response.statusCode = error.code === "ENOENT" ? 404 : 500;
    response.end(response.statusCode === 404 ? "Not found" : "Development server error");
    if (response.statusCode === 500) console.error(error);
  }
});

server.listen(port, () => {
  console.log(`Blue Mountain House is running at http://localhost:${port}`);
});

async function loadEnvironment(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const separator = line.indexOf("=");
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
