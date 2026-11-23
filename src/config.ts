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
  /** True when `jobo login` saved the key: `jobo logout` then hands it back to Jobo. */
  signed_in?: boolean;
  /** The account `jobo login` signed in. A key saved any other way has none. */
  account_email?: string;
}

/** Where `jobo login` signs in: the dashboard host, which serves the OAuth endpoints. */
export const DEFAULT_AUTH_URL = "https://enterprise.jobo.world";

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

/**
 * Where regenerable data goes (the value lists shell completion caches):
 * `$XDG_CACHE_HOME/jobo`, defaulting to `~/.cache/jobo` on Linux and macOS and
 * `%LOCALAPPDATA%\jobo\cache` on Windows. Nothing here is worth keeping.
 */
export function cacheDir(io: Pick<Io, "env" | "homedir" | "platform">): string {
  const xdg = io.env.XDG_CACHE_HOME?.trim();
  if (xdg) return join(xdg, "jobo");
  if (io.platform === "win32" && io.env.LOCALAPPDATA?.trim()) {
    return join(io.env.LOCALAPPDATA.trim(), "jobo", "cache");
  }
  return join(io.homedir, ".cache", "jobo");
}

function readConfig(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} is not valid JSON. Fix it, or delete it and run \`jobo login\` or \`jobo auth\` again.`);
  }
  return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : {};
}

export function readSavedKey(io: Pick<Io, "env" | "homedir" | "platform">): string | null {
  const key = readConfig(configPath(io)).api_key;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
}

/** The account the saved key was signed in for, when `jobo login` saved it. Null without a saved key. */
export function readSavedEmail(io: Pick<Io, "env" | "homedir" | "platform">): string | null {
  if (!readSavedKey(io)) return null;
  const email = readConfig(configPath(io)).account_email;
  return typeof email === "string" && email.trim() !== "" ? email.trim() : null;
}

/** True when the saved key is one `jobo login` was given, not one the user created and saved with `jobo auth`. */
export function isSavedKeySignedIn(io: Pick<Io, "env" | "homedir" | "platform">): boolean {
  return readSavedKey(io) !== null && readConfig(configPath(io)).signed_in === true;
}

/**
 * Owner-only file (0600) in an owner-only directory (0700). `jobo auth` and
 * `jobo login` both save through here. `signIn` marks a key that `jobo login`
 * was given, with the account it is for when the sign-in shared the email;
 * saving a key without it forgets both for the key it replaces.
 */
export function saveKey(
  io: Pick<Io, "env" | "homedir" | "platform">,
  key: string,
  signIn?: { accountEmail: string | null },
): string {
  const path = configPath(io);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const config: ConfigFile = { ...readConfig(path), api_key: key };
  if (signIn) config.signed_in = true;
  else delete config.signed_in;
  if (signIn?.accountEmail) config.account_email = signIn.accountEmail;
  else delete config.account_email;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten one that already existed.
  chmodSync(path, 0o600);
  return path;
}

/** Removes the saved key and what a sign-in kept with it. Returns true when a saved key was removed. */
export function removeSavedKey(io: Pick<Io, "env" | "homedir" | "platform">): boolean {
  const path = configPath(io);
  if (!existsSync(path)) return false;
  const config = readConfig(path);
  const hadKey = config.api_key !== undefined;
  if (!hadKey && config.account_email === undefined && config.signed_in === undefined) return false;
  delete config.api_key;
  delete config.signed_in;
  delete config.account_email;
  if (Object.keys(config).length === 0) rmSync(path);
  else writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return hadKey;
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
      `No API key. Run \`jobo login\` to sign in, or save a key with \`jobo auth\`, set JOBO_API_KEY, or pass --api-key. Create a key at ${URLS.apiKeys}`,
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
  return checkedUrl(flagValue?.trim() || io.env.JOBO_API_URL?.trim() || DEFAULT_BASE_URL, "API");
}

/**
 * The host `jobo login` signs in at: `--auth-url` beats `JOBO_AUTH_URL`, which
 * beats the dashboard. Held to the same rule as the API URL, because the key
 * comes back from this host.
 */
export function resolveAuthUrl(io: Pick<Io, "env">, flagValue?: string): string {
  return checkedUrl(flagValue?.trim() || io.env.JOBO_AUTH_URL?.trim() || DEFAULT_AUTH_URL, "sign-in");
}

function checkedUrl(raw: string, what: "API" | "sign-in"): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a valid ${what} URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError(`The ${what} URL must use https (plain http is only accepted for localhost): ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}
