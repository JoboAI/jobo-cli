import { flag, str, type CommandDef, type Ctx } from "../args";
import { DEFAULT_AUTH_URL, configPath, maskKey, readSavedEmail, readSavedKey, resolveAuthUrl, saveKey } from "../config";
import { CliError, EXIT, URLS, UsageError, sentence } from "../errors";
import {
  authorizationUrl,
  exchangeCode,
  listenForCallback,
  pkceChallenge,
  printable,
  randomToken,
  type Callback,
  type SignIn,
} from "../oauth";
import { USER_AGENT, note } from "../session";

/** How long a person gets to sign in and approve before the command stops waiting. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

function span(ms: number): string {
  const minutes = ms >= 60_000;
  const count = Math.max(1, Math.round(ms / (minutes ? 60_000 : 1000)));
  return `${count} ${minutes ? "minute" : "second"}${count === 1 ? "" : "s"}`;
}

/** The browser's return, unless the wait runs out or the user presses Ctrl-C first. */
function waitForCallback(ctx: Ctx, callback: Promise<Callback>, timeoutMs: number): Promise<Callback> {
  return new Promise<Callback>((resolve, reject) => {
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      stopListening();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new CliError(
            `Sign-in timed out: nothing came back from the browser within ${span(timeoutMs)}, so nothing was saved. Run \`jobo login\` again.`,
            EXIT.AUTH,
          ),
        ),
      );
    }, timeoutMs);
    const stopListening = ctx.io.onInterrupt(() => {
      // The terminal has just echoed ^C: give the error a line of its own.
      void ctx.io.stderr.write("\n");
      settle(() => reject(new CliError("Sign-in cancelled. Nothing was saved.")));
    });
    void callback.then((value) => settle(() => resolve(value)));
  });
}

/** The code a callback carries, once it is shown to answer this sign-in and not to report a refusal. */
function authorizationCode(params: URLSearchParams, state: string): string {
  if (params.get("state") !== state) {
    throw new CliError(
      "The response did not belong to this sign-in (its state did not match), so nothing was saved. Run `jobo login` again.",
      EXIT.AUTH,
    );
  }
  const error = params.get("error");
  if (error) {
    const reason = printable(params.get("error_description") ?? "") || printable(error);
    throw new CliError(`Sign-in was not completed, so nothing was saved: ${sentence(reason)}`, EXIT.AUTH);
  }
  const code = params.get("code");
  if (!code) {
    throw new CliError("The response carried no authorization code, so nothing was saved. Run `jobo login` again.", EXIT.AUTH);
  }
  return code;
}

/**
 * Sign in through the browser and save the key that comes back. `timeoutMs`
 * is how long to wait for the browser; tests shorten it.
 */
export async function login(ctx: Ctx, options: { timeoutMs?: number } = {}): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError(`jobo login takes no arguments (got "${ctx.positionals[0]}").`);
  if (str(ctx.values, "api-key")) {
    throw new UsageError(
      "jobo login takes no --api-key: signing in is how it gets one. To save a key you already have, run `jobo auth --api-key KEY`.",
    );
  }
  const authUrl = resolveAuthUrl(ctx.io, str(ctx.values, "auth-url"));
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  const saved = readSavedKey(ctx.io);
  if (saved) {
    const email = readSavedEmail(ctx.io);
    note(ctx, `${configPath(ctx.io)} already holds a key (${maskKey(saved)}${email ? `, signed in as ${email}` : ""}). Signing in replaces it.`);
  }

  const listener = await listenForCallback();
  try {
    const verifier = randomToken();
    const state = randomToken();
    const url = authorizationUrl(authUrl, { redirectUri: listener.redirectUri, state, challenge: pkceChallenge(verifier) });
    const browser = !flag(ctx.values, "no-browser");

    // Printed whatever --quiet says and before the browser is tried: without the URL there is no way to sign in.
    await ctx.io.stderr.write(
      `${browser ? "Opening your browser to sign in with Jobo. If it does not open, use this URL:" : "To sign in with Jobo, open this URL in a browser on this machine:"}\n\n` +
        `  ${url}\n\n` +
        `Waiting for the sign-in to finish. It times out after ${span(timeoutMs)}; press Ctrl-C to cancel.\n`,
    );
    // Not awaited: a machine with no browser, or a slow opener, changes nothing about the wait.
    if (browser) void ctx.io.openBrowser(url).catch(() => false);

    const callback = await waitForCallback(ctx, listener.callback, timeoutMs);
    let signIn: SignIn;
    let path: string;
    try {
      const code = authorizationCode(callback.params, state);
      signIn = await exchangeCode(ctx.io.transport, authUrl, { code, verifier, redirectUri: listener.redirectUri }, USER_AGENT);
      // The same file, written the same way, as a key given to `jobo auth`.
      path = saveKey(ctx.io, signIn.key, { accountEmail: signIn.accountEmail });
    } catch (error) {
      await callback.reply(false);
      throw error;
    }
    await callback.reply(true);
    await listener.close();

    await ctx.io.stdout.write(`${signIn.accountEmail ? `Signed in as ${signIn.accountEmail}.` : "Signed in."} The key is saved to ${path}\n`);
    if (ctx.io.env.JOBO_API_KEY?.trim()) {
      await ctx.io.stdout.write("Note: JOBO_API_KEY is set in this environment and takes precedence over the saved sign-in.\n");
    }
    return EXIT.OK;
  } finally {
    await listener.close();
  }
}

export const loginCommand: CommandDef = {
  name: "login",
  summary: "Sign in with Jobo in your browser",
  usage: ["[--no-browser]"],
  description:
    "Opens the Jobo sign-in page in your browser. After you sign in and approve, the API key for your account comes back to this command on 127.0.0.1 and is saved where `jobo auth` saves one: " +
    "$XDG_CONFIG_HOME/jobo/config.json, by default ~/.config/jobo/config.json (%APPDATA%\\jobo\\config.json on Windows), readable by you only (mode 0600), with the email of the account. " +
    "A key that is already saved is replaced. The key is never printed.\n\n" +
    "The sign-in URL is always printed, so you can open it yourself. The browser has to run on the machine this command runs on, because the sign-in comes back to an address on that machine. " +
    `The command waits ${span(LOGIN_TIMEOUT_MS)}, and Ctrl-C cancels it. On a remote machine, in a script or in CI, use an API key: \`jobo auth\`, or the JOBO_API_KEY environment variable, which beats the saved key.\n\n` +
    `The key does not expire. It stops working when you run \`jobo logout\`, which revokes it, or disconnect the Jobo CLI under Developers → API Keys at ${URLS.apiKeys}.`,
  options: {
    "no-browser": { type: "boolean", description: "Print the sign-in URL without trying to open a browser." },
    "auth-url": {
      type: "string",
      value: "URL",
      description: `Sign-in host (default ${DEFAULT_AUTH_URL}, or JOBO_AUTH_URL). For tests.`,
    },
  },
  examples: ["jobo login", "jobo login --no-browser"],
  run: (ctx) => login(ctx),
};
