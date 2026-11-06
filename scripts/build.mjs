// Production build. Copies an explicit allow-list from public/ and bundles the
// browser entries from src/ into dist/. dist/ is the only directory Vercel serves.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { importViolation } from "./lib/boundaries.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const srcDir = join(root, "src");

const PUBLIC_FILES = ["index.html", "admin.html", "booking.html", "single.css", "admin.css"];
const ENTRY_POINTS = { guest: "src/guest/index.js", admin: "src/admin/index.js", booking: "src/guest/booking.js" };
const EXPECTED_OUTPUT = new Set([...PUBLIC_FILES, ...Object.keys(ENTRY_POINTS).map((name) => `assets/${name}.js`)]);
// Server-only values that must never appear in dist/. Public values (URLs, publishable key, RESEND_FROM) are excluded.
const SECRET_ENV_KEYS = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "CALENDAR_FEED_TOKEN",
  "GUEST_TOKEN_SECRET",
  "CRON_SECRET",
  "DATABASE_URL"
];

const browserBoundary = {
  name: "browser-boundary",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point" || !args.importer.startsWith(srcDir + sep)) return undefined;
      const importer = relative(root, args.importer).split(sep).join("/");
      const problem = importViolation(importer, args.path);
      return problem ? { errors: [{ text: problem }] } : undefined;
    });
  }
};

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const fullPath = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "assets"), { recursive: true });
  for (const file of PUBLIC_FILES) await copyFile(join(root, "public", file), join(dist, file));

  await build({
    absWorkingDir: root,
    entryPoints: ENTRY_POINTS,
    outdir: "dist/assets",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    plugins: [browserBoundary]
  });

  const secretValues = SECRET_ENV_KEYS.map((key) => process.env[key]).filter((value) => value && value.length >= 8);
  const problems = [];
  for (const file of await listFiles(dist)) {
    const relativePath = relative(dist, file).split(sep).join("/");
    if (!EXPECTED_OUTPUT.has(relativePath)) problems.push(`Unexpected file in dist/: ${relativePath}`);
    const content = await readFile(file, "utf8");
    if (secretValues.some((value) => content.includes(value))) problems.push(`dist/${relativePath} contains a server-only environment value`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`Built ${EXPECTED_OUTPUT.size} files into dist/`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
