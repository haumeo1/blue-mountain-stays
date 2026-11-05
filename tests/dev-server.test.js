import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanUrlRedirect, createDevServer, discoverApiRoutes, parseRequestPath, resolveStaticFile } from "../scripts/lib/dev-server.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bmh-dev-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await mkdir(join(root, "api", "_lib"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), "home");
  await writeFile(join(root, "dist", "admin.html"), "admin");
  await writeFile(join(root, "dist", "assets", "guest.js"), "console.log(1);");
  await writeFile(join(root, "secret.txt"), "secret");
  await symlink(join(root, "secret.txt"), join(root, "dist", "leak.txt"));
  await writeFile(join(root, "api", "hello.js"), [
    "export default async function handler(request, response) {",
    "  await new Promise((done) => setTimeout(done, 5));",
    "  response.setHeader(\"Content-Type\", \"application/json\");",
    "  response.end(JSON.stringify({ query: request.query }));",
    "}",
    ""
  ].join("\n"));
  await writeFile(join(root, "api", "_lib", "util.js"), "export default function handler() {}\n");
  return root;
}

test("rejects dotfiles, traversal, and malformed paths", () => {
  assert.equal(parseRequestPath("/.env.local"), null);
  assert.equal(parseRequestPath("/api/.hidden"), null);
  assert.equal(parseRequestPath("/assets/%2e%2e%2fsecret.txt"), null);
  assert.equal(parseRequestPath("/a%5c..%5csecret"), null);
  assert.equal(parseRequestPath("/x%00"), null);
  assert.equal(parseRequestPath("/%E0%A4%A"), null);
  assert.equal(parseRequestPath("http://example.com/"), null);
  assert.equal(parseRequestPath("/admin?x=1").pathname, "/admin");
});

test("mirrors Vercel clean URL redirects", () => {
  assert.equal(cleanUrlRedirect("/admin.html"), "/admin");
  assert.equal(cleanUrlRedirect("/index.html", "?a=1"), "/?a=1");
  assert.equal(cleanUrlRedirect("/admin/"), "/admin");
  assert.equal(cleanUrlRedirect("//evil.com/"), "/evil.com");
  assert.equal(cleanUrlRedirect("/admin"), null);
  assert.equal(cleanUrlRedirect("/"), null);
});

test("resolves only regular files inside dist", async () => {
  const root = await createFixture();
  try {
    const dist = join(root, "dist");
    assert.equal(await resolveStaticFile(dist, "/"), await realpath(join(dist, "index.html")));
    assert.equal(await resolveStaticFile(dist, "/admin"), await realpath(join(dist, "admin.html")));
    assert.equal(await resolveStaticFile(dist, "/leak.txt"), null);
    assert.equal(await resolveStaticFile(dist, "/missing"), null);
    assert.equal(await resolveStaticFile(dist, "/assets"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository API routes exclude helper files", async () => {
  const routes = await discoverApiRoutes(join(repoRoot, "api"));
  assert.ok(routes.has("/api/config"));
  assert.ok(routes.has("/api/admin/bookings"));
  assert.ok([...routes.keys()].every((route) => !route.includes("/_")));
});

test("serves dist and awaited API handlers only", async () => {
  const root = await createFixture();
  const server = await createDevServer({ root });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(await home.text(), "home");
    assert.equal((await fetch(`${base}/admin`)).status, 200);
    const redirect = await fetch(`${base}/admin.html`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/admin");
    const api = await fetch(`${base}/api/hello?x=1`);
    assert.deepEqual(await api.json(), { query: { x: "1" } });
    assert.equal((await fetch(`${base}/api/_lib/util`)).status, 404);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/leak.txt`)).status, 404);
    assert.equal((await fetch(`${base}/secret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/.env.local`)).status, 400);
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
