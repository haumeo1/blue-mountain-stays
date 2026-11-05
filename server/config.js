// Server-only runtime configuration. Never imported by browser code.

// True on Vercel production/preview deployments (but not `vercel dev`).
export function isDeployedEnvironment(env = process.env) {
  if (env.VERCEL_ENV) return env.VERCEL_ENV !== "development";
  return env.VERCEL === "1";
}

// Demo mode must be requested explicitly and is only honoured locally. Deployed
// environments never fall back to local booking simulation.
export function demoModeEnabled(env = process.env) {
  if (env.DEMO_MODE !== "true") return false;
  if (isDeployedEnvironment(env)) return false;
  return env.NODE_ENV !== "production";
}
