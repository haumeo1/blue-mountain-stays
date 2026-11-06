// Local development entry. Run via `npm run dev`, which builds dist/ first.
// .env.local is loaded into this server process only; it is never served.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevServer, loadEnvironmentFile, resolvePort } from "./lib/dev-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";

await loadEnvironmentFile(join(root, ".env.local"));
const port = resolvePort(process.env.PORT);

const server = await createDevServer({ root });
server.listen(port, host, () => {
  console.log(`Blue Mountain House is running at http://${host}:${port}`);
});
