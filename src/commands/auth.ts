import { JoboApiError, JoboClient } from "@jobo-ai/connector-core";

import { flag, str, type CommandDef, type Ctx } from "../args";
import {
  DEFAULT_AUTH_URL,
  assertKeyShape,
  configPath,
  isConfigExposed,
  isSavedKeySignedIn,
  keyEnvironment,
  maskKey,
  readSavedEmail,
  readSavedKey,
  removeSavedKey,
  resolveApiKey,
  resolveApiUrl,
  resolveAuthUrl,
  saveKey,
} from "../config";
import { CliError, EXIT, URLS, UsageError } from "../errors";
import { revokeKey } from "../oauth";
import { CLIENT_NAME, USER_AGENT } from "../session";

const SOURCE_LABELS = { flag: "--api-key", env: "the JOBO_API_KEY environment variable", config: "the config file" } as const;

async function out(ctx: Ctx, text: string): Promise<void> {
  await ctx.io.stdout.write(`${text}\n`);
}

async function show(ctx: Ctx): Promise<number> {
  const path = configPath(ctx.io);
  const active = resolveApiKey(ctx.io, str(ctx.values, "api-key"));
  const saved = readSavedKey(ctx.io);
  // Only a key that `jobo login` saved has an account to name.
  const email = readSavedEmail(ctx.io);
  const account = email ? `, signed in as ${email}` : "";
  await out(ctx, `Config file: ${path}${saved ? "" : " (no key saved)"}`);
  if (!active) {
    await out(ctx, `No API key in use. Run \`jobo login\` to sign in, save a key with \`jobo auth\`, or set JOBO_API_KEY. Create a key at ${URLS.apiKeys}`);
    return EXIT.AUTH;
  }
  await out(
    ctx,
    `Key in use: ${maskKey(active.key)} (${keyEnvironment(active.key)}), from ${SOURCE_LABELS[active.source]}${active.source === "config" ? account : ""}`,
  );
  if (saved && active.source !== "config") {
    await out(ctx, `Saved key: ${maskKey(saved)} (${keyEnvironment(saved)})${account}, overridden by ${SOURCE_LABELS[active.source]}`);
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
    "The key's shape is checked first, then the key itself with one call that is never billed. " +
    "To sign in with your browser and have the key saved for you, run `jobo login`.\n\n" +
    "Which key a command uses: --api-key, then the JOBO_API_KEY environment variable, then the saved key. " +
    `Live keys start with jbe_live_, sandbox keys (free, fictional data) with jbe_test_. Create one at ${URLS.apiKeys}; new accounts sign up at ${URLS.register}.`,
  options: {
    show: {
      type: "boolean",
      description: "Print the config file location, the key in use, masked, and the account `jobo login` signed in. Sends nothing.",
    },
    "no-verify": { type: "boolean", description: "Save the key without checking it against the API." },
  },
  examples: ["jobo auth", "jobo auth --api-key jbe_live_…", "echo \"$JOBO_API_KEY\" | jobo auth", "jobo auth --show"],
  run,
};

async function runLogout(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo logout takes no arguments.");
  const path = configPath(ctx.io);
  const saved = readSavedKey(ctx.io);
  const email = readSavedEmail(ctx.io);
  // Only a key `jobo login` was given is handed back. One the user created is theirs to keep or revoke.
  const signedIn = saved !== null && isSavedKeySignedIn(ctx.io);
  const revoked = signedIn && (await revokeKey(ctx.io.transport, resolveAuthUrl(ctx.io, str(ctx.values, "auth-url")), saved, USER_AGENT));

  const removed = removeSavedKey(ctx.io);
  await out(ctx, removed ? `Removed the saved key${email ? ` for ${email}` : ""} from ${path}` : `No saved key in ${path}`);
  if (removed && revoked) {
    await out(ctx, "The key is revoked, and the Jobo CLI is disconnected from your Jobo account.");
  } else if (removed && signedIn) {
    await out(
      ctx,
      "Warning: Jobo could not be reached, so the key is not revoked. To finish, disconnect the Jobo CLI under " +
        `Developers → API Keys in the Jobo dashboard: ${URLS.apiKeys}`,
    );
  } else if (removed) {
    await out(ctx, `Note: the key itself is not revoked. It is a key you created; revoke it under Developers → API Keys: ${URLS.apiKeys}`);
  }
  if (ctx.io.env.JOBO_API_KEY?.trim()) {
    await out(ctx, "Note: JOBO_API_KEY is still set in this environment, and commands will keep using it.");
  }
  return 0;
}

export const logoutCommand: CommandDef = {
  name: "logout",
  summary: "Remove the saved key and sign-in",
  usage: [""],
  description:
    "Deletes the key from the config file, with what `jobo login` saved next to it. A key you got by signing in with `jobo login` is also handed back to Jobo: " +
    "it is revoked, and the Jobo CLI is disconnected from your account. If Jobo cannot be reached the key is still removed from this machine, and the command says where to finish. " +
    `A key you created and saved with \`jobo auth\` is only removed here; revoke it under Developers → API Keys in the dashboard (${URLS.apiKeys}). A key in JOBO_API_KEY is not touched.`,
  options: {
    "auth-url": {
      type: "string",
      value: "URL",
      description: `Sign-in host that revokes the key (default ${DEFAULT_AUTH_URL}, or JOBO_AUTH_URL). For tests.`,
    },
  },
  run: runLogout,
};
