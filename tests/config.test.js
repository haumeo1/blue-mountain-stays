import test from "node:test";
import assert from "node:assert/strict";
import { demoModeEnabled, isDeployedEnvironment } from "../server/config.js";

test("demo mode requires an explicit flag", () => {
  assert.equal(demoModeEnabled({}), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "1" }), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true" }), true);
});

test("demo mode is never enabled on deployed environments", () => {
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL: "1" }), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL: "1", VERCEL_ENV: "preview" }), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL: "1", VERCEL_ENV: "production" }), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", NODE_ENV: "production" }), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL: "1", VERCEL_ENV: "development" }), true);
});

test("detects deployed Vercel environments", () => {
  assert.equal(isDeployedEnvironment({}), false);
  assert.equal(isDeployedEnvironment({ VERCEL: "1" }), true);
  assert.equal(isDeployedEnvironment({ VERCEL_ENV: "preview" }), true);
  assert.equal(isDeployedEnvironment({ VERCEL_ENV: "development" }), false);
});
