#!/usr/bin/env node
/**
 * CLI: `init` writes a private config + local token; `serve` runs the gateway.
 */

import process from "node:process";
import {
  ConfigError,
  SERVICE,
  VERSION,
  DEFAULT_FUNCTION,
  DEFAULT_PORT,
  defaultConfigPath,
  defaultConfigDir,
  initConfig,
  loadApiKey,
  loadConfig,
} from "../src/config.mjs";
import { createLogger } from "../src/log.mjs";
import { createBridgeServer } from "../src/server.mjs";

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "serve";

function takeFlag(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigError(`${name} requires a value`);
  }
  argv.splice(index, 2);
  return value;
}

function hasFlag(name) {
  const index = argv.indexOf(name);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function printUsage() {
  console.log(`cloudbase-bridge ${VERSION}

Usage:
  cloudbase-bridge init --env-id <env-id> [--function aiProxy] [--region cn|intl]
                        [--port ${DEFAULT_PORT}] [--dir <config-dir>] [--force]
  cloudbase-bridge serve [--config <config.json>] [--verbose]
  cloudbase-bridge --version

The server binds 127.0.0.1 only. The CloudBase API key is read from
$CLOUDBASE_API_KEY or the api-key file next to config.json (mode 600).
`);
}

async function runInit() {
  const envId = takeFlag("--env-id", undefined);
  const functionName = takeFlag("--function", DEFAULT_FUNCTION);
  const region = takeFlag("--region", "cn");
  const port = Number(takeFlag("--port", String(DEFAULT_PORT)));
  const dir = takeFlag("--dir", defaultConfigDir());
  const force = hasFlag("--force");

  const { configPath, config } = await initConfig({
    dir,
    envId,
    functionName,
    region,
    port,
    force,
  });
  const keyFile = config.apiKeyFile;

  console.log(`created ${configPath} (mode 600)`);
  console.log("");
  console.log("Next:");
  console.log(
    `  1. store your CloudBase server API key:\n     printf '%s' '<YOUR_KEY>' > ${shellQuote(keyFile)} && chmod 600 ${shellQuote(keyFile)}`,
  );
  console.log(`  2. start the bridge:  node ${shellQuote(process.argv[1])} serve`);
  console.log("  3. add it in Magpie as an OpenAI-compatible provider:");
  console.log(`       Base URL:  http://127.0.0.1:${config.port}/v1`);
  console.log(`       API key:   ${config.localToken}`);
  console.log(`       Models:    ${config.models.join(", ")}`);
  console.log("");
  console.log(
    "The API key above is the local bridge token, not your CloudBase key. Keep it in Magpie's provider config only.",
  );
}

async function runServe() {
  const configPath = takeFlag(
    "--config",
    process.env.CLOUDBASE_BRIDGE_CONFIG || defaultConfigPath(),
  );
  const verbose = hasFlag("--verbose");
  const level = verbose ? "debug" : process.env.LOG_LEVEL || "info";
  const logger = createLogger({ level });

  const { config } = await loadConfig(configPath);
  const apiKey = await loadApiKey(config);
  const server = createBridgeServer({ config, apiKey, logger });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, "127.0.0.1");
  });

  logger("info", "listening", {
    url: `http://127.0.0.1:${config.port}/v1`,
    function: config.functionName,
    models: config.models.length,
    maxConcurrent: config.maxConcurrent,
    remoteImages: config.allowRemoteImages,
  });

  const shutdown = (signal) => {
    logger("info", "shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return;
  }
  if (hasFlag("--version")) {
    console.log(`${SERVICE} ${VERSION}`);
    return;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    throw new ConfigError(`Node.js >= 20 is required (running ${process.versions.node}).`);
  }

  if (command === "init") {
    await runInit();
    return;
  }
  if (command === "serve") {
    await runServe();
    return;
  }
  printUsage();
  throw new ConfigError(`unknown command: ${command}`);
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`error: ${error.message}`);
  } else if (error && error.code === "EADDRINUSE") {
    console.error(`error: port is already in use; change "port" in the config.`);
  } else {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.LOG_LEVEL === "debug") console.error(error);
  }
  process.exit(1);
});
