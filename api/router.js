// The only Vercel Function. vercel.json rewrites /api/:path* → /api/router?route=:path*.
// Raw bytes for the Stripe webhook: Vercel's vanilla Node helpers still install a lazy JSON
// `request.body` getter and replay the raw stream. server/http.js readRawBody never evaluates that
// getter and reads the replayed bytes instead — that is the actual protection.
// `bodyParser: false` is a Next.js convention kept only for compatibility; it does NOT disable the
// vanilla Node helpers (only config `helpers: false` or NODEJS_HELPERS=0 does).
import { createHandler } from "../server/routes.js";

export const config = { api: { bodyParser: false } };

export default createHandler();
