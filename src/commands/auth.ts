import { JoboApiError, JoboClient } from "@jobo-ai/connector-core";

import { flag, str, type CommandDef, type Ctx } from "../args";
import {
  assertKeyShape,
  configPath,
  isConfigExposed,
  keyEnvironment,
  maskKey,
  readSavedKey,
  removeSavedKey,
  resolveApiKey,
  resolveApiUrl,
  saveKey,
} from "../config";
import { CliError, EXIT, URLS, UsageError } from "../errors";
import { CLIENT_NAME, USER_AGENT } from "../session";

const SOURCE_LABELS = { flag: "--api-key", env: "the JOBO_API_KEY environment variable", config: "the config file" } as const;

async function out(ctx: Ctx, text: string): Promise<void> {
  await ctx.io.stdout.write(`${text}\n`);
}

async function show(ctx: Ctx): Promise<number> {
  const path = configPath(ctx.io);
  const active = resolveApiKey(ctx.io, str(ctx.values, "api-key"));
  const saved = readSavedKey(ctx.io);
  await out(ctx, `Config file: ${path}${saved ? "" : " (no key saved)"}`);
  if (!active) {
    await out(ctx, `No API key in use. Run \`jobo auth\` or set JOBO_API_KEY. Create a key at ${URLS.apiKeys}`);
    return EXIT.AUTH;
  }
  await out(ctx, `Key in use: ${maskKey(active.key)} (${keyEnvironment(active.key)}), from ${SOURCE_LABELS[active.source]}`);
  if (saved && active.source !== "config") {
    await out(ctx, `Saved key: ${maskKey(saved)} (${keyEnvironment(saved)}), overridden by ${SOURCE_LABELS[active.source]}`);
  }
  if (saved && isConfigExposed(ctx.io)) {
    await out(ctx, `Warning: ${path} is readable by other users. Run: chmod 600 ${path}`);
  }
  return 0;
}

/**
 * Check the key against the API with a call that is never billed. A sandbox
 * key is refused on this endpoint with `not_available_in_sandbox`, but only
 * after it has authenticated, so that refusal also proves the key.
 */
async function verify(ctx: Ctx, key: string): Promise<void> {
  const client = new JoboClient({
    apiKey: key,
    baseUrl: resolveApiUrl(ctx.io, str(ctx.values, "api-url")),
    transport: ctx.io.transport,
    retry: { sleep: ctx.io.sleep },
    userAgent: USER_AGENT,
    client: CLIENT_NAME,
  });
  try {
    await client.filters();
  } catch (error) {
    if (error instanceof JoboApiError && error.code === "not_available_in_sandbox") return;
    throw error;
  }
}

async function readKey(ctx: Ctx): Promise<string> {
  const fromFlag = str(ctx.values, "api-key");
  if (fromFlag) return fromFlag;
  if (!ctx.io.stdin.isTTY) {
    const piped = (await ctx.io.stdin.readAll()).trim();
    if (piped === "") throw new UsageError("No key on stdin. Pipe one in, or pass --api-key KEY.");
    return piped;
  }
  await ctx.io.stderr.write(`Create a key under Developers → API Keys: ${URLS.apiKeys}\n`);
  const typed = (await ctx.io.stdin.promptSecret("Jobo API key: ")).trim();
  if (typed === "") throw new UsageError("No key entered.");
  return typed;
}

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) {
    throw new UsageError(`jobo auth takes no arguments (got "${ctx.positionals[0]}"). Pass the key with --api-key, or run it bare to be prompted.`);
  }
  if (flag(ctx.values, "show")) return show(ctx);

  const key = await readKey(ctx);
  assertKeyShape(key);

  if (!flag(ctx.values, "no-verify")) {
    try {
      await verify(ctx, key);
    } catch (error) {
      if (error instanceof JoboApiError && error.status === 401) {
        throw new CliError(
          `The API rejected this key (invalid, revoked or expired); nothing was saved. Check it under Developers → API Keys at ${URLS.apiKeys}`,
          EXIT.AUTH,
        );
      }
      if (!flag(ctx.values, "quiet")) {
        await ctx.io.stderr.write("The key could not be checked, so nothing was saved. Pass --no-verify to save it unchecked.\n");
      }
      throw error;
    }
  }

  const path = saveKey(ctx.io, key);
  const checked = flag(ctx.values, "no-verify") ? "not checked against the API" : "accepted by the API";
  await out(ctx, `Saved ${maskKey(key)} (${keyEnvironment(key)} key, ${checked}) to ${path}`);
  if (ctx.io.env.JOBO_API_KEY?.trim() && ctx.io.env.JOBO_API_KEY.trim() !== key) {
    await out(ctx, "Note: JOBO_API_KEY is set to a different key and takes precedence over the saved one.");
  }
  return 0;
}

export const authCommand: CommandDef = {
  name: "auth",
  summary: "Save an API key, or show which key is in use",
  usage: ["[--api-key KEY]", "--show"],
  description:
    `Saves a key to the config file, readable by you only (mode 0600): $XDG_CONFIG_HOME/jobo/config.json, by default ~/.config/jobo/config.json (%APPDATA%\\jobo\\config.json on Windows). ` +
    "With no --api-key the key is read from stdin when piped, and otherwise prompted for without echoing it. " +
    "The key's shape is checked first, then the key itself with one call that is never billed.\n\n" +
    "Which key a command uses: --api-key, then the JOBO_API_KEY environment variable, then the saved key. " +
    `Live keys start with jbe_live_, sandbox keys (free, fictional data) with jbe_test_. Create one at ${URLS.apiKeys}; new accounts sign up at ${URLS.register}.`,
  options: {
    show: { type: "boolean", description: "Print the config file location and the key in use, masked. Sends nothing." },
    "no-verify": { type: "boolean", description: "Save the key without checking it against the API." },
  },
  examples: ["jobo auth", "jobo auth --api-key jbe_live_…", "echo \"$JOBO_API_KEY\" | jobo auth", "jobo auth --show"],
  run,
};

async function runLogout(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo logout takes no arguments.");
  const path = configPath(ctx.io);
  const removed = removeSavedKey(ctx.io);
  await out(ctx, removed ? `Removed the saved key from ${path}` : `No saved key in ${path}`);
  if (ctx.io.env.JOBO_API_KEY?.trim()) {
    await out(ctx, "Note: JOBO_API_KEY is still set in this environment, and commands will keep using it.");
  }
  return 0;
}

export const logoutCommand: CommandDef = {
  name: "logout",
  summary: "Remove the saved API key",
  usage: [""],
  description:
    "Deletes the key from the config file. It does not revoke the key: do that under Developers → API Keys in the dashboard. A key in JOBO_API_KEY is not touched.",
  run: runLogout,
};
