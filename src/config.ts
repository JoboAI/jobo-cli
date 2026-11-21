import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_BASE_URL, assertValidApiKeyFormat } from "@jobo-ai/connector-core";

import { CliError, EXIT, URLS, UsageError } from "./errors";
import type { Io } from "./io";

export type KeySource = "flag" | "env" | "config";

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

interface ConfigFile {
  api_key?: string;
}

/**
 * `$XDG_CONFIG_HOME/jobo/config.json`, defaulting to `~/.config/jobo/config.json`
 * on Linux and macOS and `%APPDATA%\jobo\config.json` on Windows.
 */
export function configPath(io: Pick<Io, "env" | "homedir" | "platform">): string {
  const xdg = io.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "jobo", "config.json");
  if (io.platform === "win32" && io.env.APPDATA?.trim()) {
    return join(io.env.APPDATA.trim(), "jobo", "config.json");
  }
  return join(io.homedir, ".config", "jobo", "config.json");
}

function readConfig(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} is not valid JSON. Fix it, or delete it and run \`jobo auth\` again.`);
  }
  return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : {};
}

export function readSavedKey(io: Pick<Io, "env" | "homedir" | "platform">): string | null {
  const key = readConfig(configPath(io)).api_key;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
}

/** Owner-only file (0600) in an owner-only directory (0700). */
export function saveKey(io: Pick<Io, "env" | "homedir" | "platform">, key: string): string {
  const path = configPath(io);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const config: ConfigFile = { ...readConfig(path), api_key: key };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten one that already existed.
  chmodSync(path, 0o600);
  return path;
}

/** Returns true when a saved key was removed. */
export function removeSavedKey(io: Pick<Io, "env" | "homedir" | "platform">): boolean {
  const path = configPath(io);
  if (!existsSync(path)) return false;
  const config = readConfig(path);
  if (config.api_key === undefined) return false;
  delete config.api_key;
  if (Object.keys(config).length === 0) rmSync(path);
  else writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** True when group or others can read the config file. Always false on Windows. */
export function isConfigExposed(io: Pick<Io, "env" | "homedir" | "platform">): boolean {
  if (io.platform === "win32") return false;
  const path = configPath(io);
  return existsSync(path) && (statSync(path).mode & 0o077) !== 0;
}

/** `--api-key` beats `JOBO_API_KEY`, which beats the saved key. */
export function resolveApiKey(io: Pick<Io, "env" | "homedir" | "platform">, flagValue?: string): ResolvedKey | null {
  if (flagValue?.trim()) return { key: flagValue.trim(), source: "flag" };
  const env = io.env.JOBO_API_KEY?.trim();
  if (env) return { key: env, source: "env" };
  const saved = readSavedKey(io);
  return saved ? { key: saved, source: "config" } : null;
}

export function requireApiKey(io: Pick<Io, "env" | "homedir" | "platform">, flagValue?: string): ResolvedKey {
  const resolved = resolveApiKey(io, flagValue);
  if (!resolved) {
    throw new CliError(
      `No API key. Run \`jobo auth\`, set JOBO_API_KEY, or pass --api-key. Create a key at ${URLS.apiKeys}`,
      EXIT.AUTH,
    );
  }
  assertKeyShape(resolved.key);
  return resolved;
}

export function assertKeyShape(key: string): void {
  try {
    assertValidApiKeyFormat(key);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), EXIT.AUTH);
  }
}

/** `jbe_live_…ab12`: the environment prefix and the last four characters, never more. */
export function maskKey(key: string): string {
  const prefix = /^jbe_(live|test)_/.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

export function keyEnvironment(key: string): "live" | "sandbox" {
  return key.startsWith("jbe_test_") ? "sandbox" : "live";
}

/**
 * `--api-url` beats `JOBO_API_URL`, which beats the one public host. Plain
 * HTTP is refused except for a local address: it would put the key on the wire
 * in clear text, and the real host answers HTTP with a redirect that drops the
 * request body.
 */
export function resolveApiUrl(io: Pick<Io, "env">, flagValue?: string): string {
  const raw = flagValue?.trim() || io.env.JOBO_API_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a valid API URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError(`The API URL must use https (plain http is only accepted for localhost): ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}
