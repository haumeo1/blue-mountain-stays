// Local development entry. Run via `npm run dev`, which builds dist/ first.
// .env.local is loaded into this server process only; it is never served.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevServer, loadEnvironmentFile } from "./lib/dev-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);

await loadEnvironmentFile(join(root, ".env.local"));

const server = await createDevServer({ root });
server.listen(port, host, () => {
  console.log(`Blue Mountain House is running at http://${host}:${port}`);
});
