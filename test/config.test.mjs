import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConfigError,
  initConfig,
  loadApiKey,
  loadConfig,
  validateConfig,
} from "../src/config.mjs";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "cbb-local-"));
}

test("init writes a private config with a strong local token", async () => {
  const dir = await tempDir();
  const { configPath, config } = await initConfig({ dir, envId: "cloud1-abcd", port: 8799 });
  const info = await stat(configPath);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o600);
  }
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.config.envId, "cloud1-abcd");
  assert.equal(loaded.config.port, 8799);
  assert.ok(loaded.config.localToken.length >= 32);
  assert.equal(loaded.config.apiKeyFile, path.join(dir, "api-key"));
});

test("init refuses to overwrite without --force", async () => {
  const dir = await tempDir();
  await initConfig({ dir, envId: "cloud1-abcd" });
  await assert.rejects(initConfig({ dir, envId: "cloud1-abcd" }), /already exists/);
});

test("invalid envId / functionName / port are rejected", () => {
  const base = { localToken: "t".repeat(40) };
  assert.throws(() => validateConfig({ ...base, envId: "a!" }), ConfigError);
  assert.throws(
    () => validateConfig({ ...base, envId: "cloud1-ok", functionName: "1bad" }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...base, envId: "cloud1-ok", port: 80 }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...base, envId: "cloud1-ok", models: ["hy3", "hy3"] }),
    ConfigError,
  );
});

test("group-readable config is refused", async () => {
  const dir = await tempDir();
  const { configPath } = await initConfig({ dir, envId: "cloud1-abcd" });
  if (process.platform === "win32") return;
  await chmod(configPath, 0o644);
  await assert.rejects(loadConfig(configPath), /chmod 600/);
});

test("api key loads from a 600 file and rejects loose permissions", async () => {
  const dir = await tempDir();
  const { config } = await initConfig({ dir, envId: "cloud1-abcd" });
  await writeFile(config.apiKeyFile, "MY-CLOUDBASE-KEY\n", { mode: 0o600 });
  await chmod(config.apiKeyFile, 0o600);
  assert.equal(await loadApiKey(config, {}), "MY-CLOUDBASE-KEY");

  if (process.platform !== "win32") {
    await chmod(config.apiKeyFile, 0o640);
    await assert.rejects(loadApiKey(config, {}), /chmod 600/);
  }
});

test("CLOUDBASE_API_KEY takes precedence over the file", async () => {
  const dir = await tempDir();
  const { config } = await initConfig({ dir, envId: "cloud1-abcd" });
  assert.equal(await loadApiKey(config, { CLOUDBASE_API_KEY: "FROM-ENV" }), "FROM-ENV");
});

test("missing config gives an actionable error", async () => {
  const dir = await tempDir();
  await assert.rejects(loadConfig(path.join(dir, "config.json")), /cloudbase-bridge init/);
});

test("config JSON never contains an API key field", async () => {
  const dir = await tempDir();
  const { configPath } = await initConfig({ dir, envId: "cloud1-abcd" });
  const text = await readFile(configPath, "utf8");
  assert.equal(/apiKey\s*:/i.test(text), false);
});

test("init writes an empty extraParams block", async () => {
  const dir = await tempDir();
  const { config } = await initConfig({ dir, envId: "cloud1-abcd" });
  assert.deepEqual(config.extraParams, {});
});

test("extraParams are validated per model", () => {
  const base = { envId: "cloud1-abcd", localToken: "t".repeat(40), models: ["hy4"] };
  const config = validateConfig({
    ...base,
    extraParams: { hy4: { thinking: { type: "disabled" } } },
  });
  assert.deepEqual(config.extraParams.hy4, { thinking: { type: "disabled" } });

  assert.throws(
    () => validateConfig({ ...base, extraParams: { hy4: { model: "hy3" } } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...base, extraParams: { hy3: {} } }),
    /not in models/,
  );
  assert.throws(() => validateConfig({ ...base, extraParams: [] }), ConfigError);
});

test("a guard forms a small-budget entry and is validated", () => {
  const base = { envId: "cloud1-abcd", localToken: "t".repeat(40), models: ["hy4"] };
  const config = validateConfig({
    ...base,
    extraParams: { hy4: { when: { maxTokensAtMost: 4096 }, params: { thinking: { type: "disabled" } } } },
  });
  assert.deepEqual(config.extraParams.hy4, {
    when: { maxTokensAtMost: 4096 },
    params: { thinking: { type: "disabled" } },
  });

  const cases = [
    [{ when: {} }, /maxTokensAtMost/],
    [{ when: { maxTokensAtMost: 0 } }, /positive integer/],
    [{ when: { maxTokensAtMost: "4096" } }, /positive integer/],
    [{ when: { maxTokensAtMost: 4096, whatever: 1 } }, /only "maxTokensAtMost"/],
    [{ when: "small" }, /must be an object/],
    [{ when: { maxTokensAtMost: 4096 }, params: { thinking: { type: "maybe" } } }, /thinking/],
    [{ when: { maxTokensAtMost: 4096 }, thinking: { type: "disabled" } }, /only "when" and "params"/],
  ];
  for (const [entry, message] of cases) {
    assert.throws(() => validateConfig({ ...base, extraParams: { hy4: entry } }), message);
  }
});
