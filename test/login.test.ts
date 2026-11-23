import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { JoboTransportError } from "@jobo-ai/connector-core";
import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../src/args";
import { COMMANDS } from "../src/cli";
import { LOGIN_TIMEOUT_MS, login, loginCommand } from "../src/commands/login";
import { COMPLETE_COMMAND } from "../src/complete";
import { configPath, maskKey, readSavedEmail, resolveApiKey, resolveAuthUrl, saveKey } from "../src/config";
import { CliError, EXIT } from "../src/errors";
import { fetchTransport } from "../src/io";
import { CLIENT_ID, SCOPE, authorizationUrl, pkceChallenge, randomToken } from "../src/oauth";
import { LIVE_KEY, OTHER_LIVE_KEY, TEST_KEY, harness, json, type Harness, type HarnessOptions } from "./helpers";
import { ACCOUNT_EMAIL, authorize, browse, fakeAuthServer, httpGet, printedSignInUrl, type FakeAuthServer } from "./signin";

const posix = process.platform !== "win32";

/**
 * A harness whose sign-in goes to `auth` over real HTTP: the token request
 * leaves through the CLI's own fetch transport, and the callback arrives on
 * the port the command really listens on. Nothing leaves 127.0.0.1.
 */
function signingIn(auth: FakeAuthServer, options: HarnessOptions = {}): Harness {
  const h = harness({ ...options, env: { JOBO_AUTH_URL: auth.url, ...options.env } });
  h.io.transport = fetchTransport;
  return h;
}

/** The sign-in URL the command printed, once it has. `from` skips what an earlier run in the same harness printed. */
function signInUrl(h: Harness, from = 0): Promise<URL> {
  return vi.waitFor(() => {
    const url = printedSignInUrl(h.stderr().slice(from));
    if (!url) throw new Error(`No sign-in URL printed yet:\n${h.stderr().slice(from)}`);
    return url;
  });
}

function savedConfig(h: Harness): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(h.io), "utf8")) as Record<string, unknown>;
}

/** Nobody is listening where the sign-in was meant to come back. */
async function expectClosed(url: URL): Promise<void> {
  await expect(httpGet(url.searchParams.get("redirect_uri") ?? "")).rejects.toThrow(/ECONNREFUSED/);
}

describe("PKCE and the authorization URL", () => {
  it("derives the S256 challenge of RFC 7636, appendix B", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes verifiers and states of 43 unreserved characters, new each time", () => {
    const tokens = Array.from({ length: 20 }, () => randomToken());
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(20);
    expect(pkceChallenge(tokens[0] ?? "")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("builds the authorization request the contract asks for", () => {
    const url = new URL(
      authorizationUrl("https://enterprise.jobo.world", { redirectUri: "http://127.0.0.1:49152/callback", state: "the-state", challenge: "the-challenge" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://enterprise.jobo.world/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "jobo-cli",
      redirect_uri: "http://127.0.0.1:49152/callback",
      scope: "api email",
      state: "the-state",
      code_challenge: "the-challenge",
      code_challenge_method: "S256",
    });
    // The scope's space is %20 on the wire, and the redirect is one encoded value.
    expect(url.search).toContain("scope=api%20email");
    expect(url.search).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback");
    expect(CLIENT_ID).toBe("jobo-cli");
    expect(SCOPE).toBe("api email");
  });

  it("signs in at the dashboard unless --auth-url or JOBO_AUTH_URL says otherwise, over https only", () => {
    expect(resolveAuthUrl({ env: {} })).toBe("https://enterprise.jobo.world");
    expect(resolveAuthUrl({ env: { JOBO_AUTH_URL: "http://127.0.0.1:9999/" } })).toBe("http://127.0.0.1:9999");
    expect(resolveAuthUrl({ env: { JOBO_AUTH_URL: "http://127.0.0.1:1" } }, "https://auth.example")).toBe("https://auth.example");
    expect(() => resolveAuthUrl({ env: {} }, "http://enterprise.jobo.world")).toThrow(/sign-in URL must use https/);
    expect(() => resolveAuthUrl({ env: { JOBO_AUTH_URL: "not a url" } })).toThrow(/not a valid sign-in URL/);
  });
});

describe("jobo login", () => {
  it("signs in through the browser and saves the key with the account's email", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login");

    // The URL is printed, and handed to the browser, with the contract's parameters.
    const url = await signInUrl(h);
    expect(h.opened).toEqual([url.toString()]);
    expect(`${url.origin}${url.pathname}`).toBe(`${auth.url}/connect/authorize`);
    expect([...url.searchParams.keys()]).toEqual([
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("jobo-cli");
    expect(url.searchParams.get("scope")).toBe("api email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 127.0.0.1, never localhost; a port the system picked; exactly /callback.
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
    expect(h.stderr()).toContain("Opening your browser to sign in with Jobo");
    expect(h.stderr()).toContain("times out after 5 minutes");
    expect(LOGIN_TIMEOUT_MS).toBe(5 * 60_000);

    // The browser's part. The page it ends on is only sent once the key is saved.
    const page = await browse(url);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Signed in. You can close this tab.");
    expect(await done).toBe(0);

    // One exchange, as a form, with the verifier behind the challenge (the fake server checks the hash).
    expect(auth.tokenRequests).toHaveLength(1);
    const exchange = auth.tokenRequests[0];
    expect(exchange?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(exchange?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      client_id: "jobo-cli",
      redirect_uri: url.searchParams.get("redirect_uri"),
      code: "code-1",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(pkceChallenge(exchange?.form.get("code_verifier") ?? "")).toBe(url.searchParams.get("code_challenge"));

    // Saved where `jobo auth` saves, and used like any other key.
    expect(savedConfig(h)).toEqual({ api_key: LIVE_KEY, signed_in: true, account_email: ACCOUNT_EMAIL });
    expect(resolveApiKey(h.io)).toEqual({ key: LIVE_KEY, source: "config" });
    expect(h.stdout()).toBe(`Signed in as ${ACCOUNT_EMAIL}. The key is saved to ${configPath(h.io)}\n`);

    // The key is never shown, masked or not.
    expect(h.stdout() + h.stderr()).not.toContain(LIVE_KEY);
    expect(h.stdout() + h.stderr()).not.toContain(maskKey(LIVE_KEY));
    await expectClosed(url);
  });

  it("never sends a client_secret", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login", "--no-browser");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);
    expect(auth.tokenRequests).toHaveLength(1);
    expect(auth.tokenRequests[0]?.form.has("client_secret")).toBe(false);
    expect([...(auth.tokenRequests[0]?.form.keys() ?? [])].sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
    expect(auth.tokenRequests[0]?.headers.authorization).toBeUndefined();
  });

  it("--no-browser prints the URL and opens nothing; --auth-url beats JOBO_AUTH_URL", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth, { env: { JOBO_AUTH_URL: "https://unused.example" } });
    const done = h.run("login", "--no-browser", "--auth-url", auth.url);
    const url = await signInUrl(h);
    expect(url.origin).toBe(auth.url);
    expect(h.opened).toEqual([]);
    expect(h.stderr()).toContain("To sign in with Jobo, open this URL in a browser on this machine:");
    expect((await browse(url)).status).toBe(200);
    expect(await done).toBe(0);
  });

  it("carries on when no browser can be started", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth, { browser: false });
    const done = h.run("login");
    const url = await signInUrl(h);
    expect(h.opened).toHaveLength(1);
    await browse(url);
    expect(await done).toBe(0);
    expect(savedConfig(h).api_key).toBe(LIVE_KEY);
  });

  it("prints the URL even with --quiet", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    saveKey(h.io, OTHER_LIVE_KEY);
    const done = h.run("login", "--quiet");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);
    expect(h.stderr()).not.toContain("already holds a key");
  });

  it("saves a sign-in that came without an email", async () => {
    const auth = await fakeAuthServer();
    auth.token = { status: 200, body: { access_token: LIVE_KEY, token_type: "Bearer", scope: "api" } };
    const h = signingIn(auth);
    const done = h.run("login");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);
    expect(savedConfig(h)).toEqual({ api_key: LIVE_KEY, signed_in: true });
    expect(h.stdout()).toBe(`Signed in. The key is saved to ${configPath(h.io)}\n`);
  });

  it("fails on a wrong state: nothing is exchanged and nothing is saved (exit 3)", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login");
    const back = await authorize(await signInUrl(h));
    back.searchParams.set("state", "someone-elses-state");

    const page = await httpGet(back);
    expect(page.status).toBe(400);
    expect(page.body).toContain("Sign-in did not complete");
    expect(await done).toBe(EXIT.AUTH);
    expect(h.stderr()).toContain("error: The response did not belong to this sign-in (its state did not match)");
    expect(auth.tokenRequests).toHaveLength(0);
    expect(existsSync(configPath(h.io))).toBe(false);
    expect(h.stdout()).toBe("");
  });

  it("fails on a callback with no state at all", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login");
    const back = await authorize(await signInUrl(h));
    back.searchParams.delete("state");
    expect((await httpGet(back)).status).toBe(400);
    expect(await done).toBe(EXIT.AUTH);
    expect(auth.tokenRequests).toHaveLength(0);
  });

  it("shows the description when the user declines (exit 3)", async () => {
    const auth = await fakeAuthServer();
    auth.decline = { error: "access_denied", description: "The user denied the request" };
    const h = signingIn(auth);
    const done = h.run("login");

    const page = await browse(await signInUrl(h));
    expect(page.status).toBe(400);
    // The page is fixed text: nothing from the request is written into it.
    expect(page.body).not.toContain("denied");
    expect(await done).toBe(EXIT.AUTH);
    expect(h.stderr()).toContain("error: Sign-in was not completed, so nothing was saved: The user denied the request.");
    expect(auth.tokenRequests).toHaveLength(0);
    expect(existsSync(configPath(h.io))).toBe(false);
  });

  it("names the error code when a refusal has no description, and keeps control characters off the terminal", async () => {
    const auth = await fakeAuthServer();
    auth.decline = { error: "server_error", description: "" };
    const plain = signingIn(auth);
    const first = plain.run("login");
    await browse(await signInUrl(plain));
    expect(await first).toBe(EXIT.AUTH);
    expect(plain.stderr()).toContain("so nothing was saved: server_error.");

    auth.decline = { error: "access_denied", description: "Denied\u001b[2J\u0007 by policy" };
    const h = signingIn(auth);
    const done = h.run("login");
    await browse(await signInUrl(h));
    expect(await done).toBe(EXIT.AUTH);
    expect(h.stderr()).toContain("Denied [2J by policy.");
    expect(h.stderr()).not.toMatch(/[\u001b\u0007]/);
  });

  it("shows the token endpoint's error_description on a 400 (exit 3)", async () => {
    const auth = await fakeAuthServer();
    auth.token = { status: 400, body: { error: "invalid_grant", error_description: "The authorization code has expired" } };
    const h = signingIn(auth);
    const done = h.run("login");

    const page = await browse(await signInUrl(h));
    expect(page.status).toBe(400);
    expect(await done).toBe(EXIT.AUTH);
    expect(h.stderr()).toContain("error: Sign-in was refused, so nothing was saved: The authorization code has expired. Run `jobo login` again.");
    expect(auth.tokenRequests).toHaveLength(1);
    expect(existsSync(configPath(h.io))).toBe(false);
  });

  it("refuses a token that is not a Jobo key, without printing it (exit 3)", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    saveKey(h.io, OTHER_LIVE_KEY);
    for (const body of [{ access_token: "eyJhbGciOi.not-a-jobo-key", token_type: "Bearer" }, { token_type: "Bearer" }, "<html>"]) {
      auth.token = { status: 200, body };
      const mark = h.stderr().length;
      const done = h.run("login", "--quiet");
      expect((await browse(await signInUrl(h, mark))).status).toBe(400);
      expect(await done).toBe(EXIT.AUTH);
    }
    expect(h.stderr()).toContain("error: Sign-in did not return a Jobo API key, so nothing was saved.");
    expect(h.stderr()).not.toContain("not-a-jobo-key");
    // The key that was there is still there.
    expect(savedConfig(h)).toEqual({ api_key: OTHER_LIVE_KEY });
  });

  it("times out when nothing comes back, and stops listening (exit 3)", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const ctx: Ctx = { io: h.io, values: {}, positionals: [], command: loginCommand, path: "jobo login", lastHeaders: {}, lastStatus: 0 };

    const failure: unknown = await login(ctx, { timeoutMs: 40 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).exitCode).toBe(EXIT.AUTH);
    expect((failure as CliError).message).toBe(
      "Sign-in timed out: nothing came back from the browser within 1 second, so nothing was saved. Run `jobo login` again.",
    );
    expect(existsSync(configPath(h.io))).toBe(false);
    expect(auth.tokenRequests).toHaveLength(0);
    await expectClosed(await signInUrl(h));
  });

  it("Ctrl-C cancels the wait and stops listening (exit 1)", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login");
    const url = await signInUrl(h);
    h.interrupt();
    expect(await done).toBe(EXIT.ERROR);
    expect(h.stderr().endsWith("\nerror: Sign-in cancelled. Nothing was saved.\n")).toBe(true);
    expect(existsSync(configPath(h.io))).toBe(false);
    await expectClosed(url);
    // Nothing is left listening for Ctrl-C either.
    expect(() => h.interrupt()).not.toThrow();
  });

  it("refuses a second callback while the first is being exchanged", async () => {
    const auth = await fakeAuthServer();
    let release: () => void = () => {};
    auth.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = signingIn(auth);
    const done = h.run("login");
    const back = await authorize(await signInUrl(h));

    const first = httpGet(back);
    await vi.waitFor(() => expect(auth.tokenRequests).toHaveLength(1));
    const second = await httpGet(back);
    expect(second.status).toBe(400);
    expect(second.body).toContain("already come back once");

    release();
    expect((await first).status).toBe(200);
    expect(await done).toBe(0);
    expect(auth.tokenRequests).toHaveLength(1);
    expect(savedConfig(h).api_key).toBe(LIVE_KEY);
  });

  it("answers 404 to a Host that is not the loopback address, and to anything but GET /callback", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    const done = h.run("login");
    const back = await authorize(await signInUrl(h));

    // The right path, code and state, from a page that reached the port by another name.
    for (const host of ["evil.example", `evil.example:${back.port}`, `localhost:${back.port}`, "127.0.0.1", `127.0.0.1:${Number(back.port) + 1}`]) {
      const page = await httpGet(back, { host });
      expect(page, host).toEqual({ status: 404, body: "Not found.\n" });
    }
    expect((await httpGet(back, { method: "POST" })).status).toBe(404);
    expect((await httpGet(new URL("/", back))).status).toBe(404);
    expect((await httpGet(new URL(`/callback/extra${back.search}`, back))).status).toBe(404);
    expect((await httpGet(new URL("/favicon.ico", back))).status).toBe(404);
    expect(auth.tokenRequests).toHaveLength(0);

    // None of those used the sign-in up: the real return still works.
    expect((await httpGet(back)).status).toBe(200);
    expect(await done).toBe(0);
    expect(savedConfig(h).api_key).toBe(LIVE_KEY);
  });

  it("says that a saved key is replaced, then replaces it", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    saveKey(h.io, OTHER_LIVE_KEY);
    const done = h.run("login");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);
    expect(h.stderr()).toContain(`${configPath(h.io)} already holds a key (jbe_live_…wxyz). Signing in replaces it.`);
    expect(h.stderr()).not.toContain(OTHER_LIVE_KEY);
    expect(savedConfig(h)).toEqual({ api_key: LIVE_KEY, signed_in: true, account_email: ACCOUNT_EMAIL });

    // A second sign-in names the account the first one saved.
    const mark = h.stderr().length;
    const again = h.run("login");
    await browse(await signInUrl(h, mark));
    expect(await again).toBe(0);
    expect(h.stderr().slice(mark)).toContain(`already holds a key (jbe_live_…bbbb, signed in as ${ACCOUNT_EMAIL}). Signing in replaces it.`);
  });

  it("JOBO_API_KEY keeps its precedence, and the command says so", async () => {
    const auth = await fakeAuthServer();
    const h = signingIn(auth, { env: { JOBO_API_KEY: TEST_KEY } });
    const done = h.run("login");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);
    expect(h.stdout()).toContain("Note: JOBO_API_KEY is set in this environment and takes precedence over the saved sign-in.");
    expect(savedConfig(h).api_key).toBe(LIVE_KEY);
    expect(resolveApiKey(h.io)).toEqual({ key: TEST_KEY, source: "env" });
  });

  it("writes the config the way `jobo auth` does: same file, same modes, other settings kept", async () => {
    const pasted = harness();
    expect(await pasted.run("auth", "--api-key", LIVE_KEY, "--no-verify")).toBe(0);

    const auth = await fakeAuthServer();
    const h = signingIn(auth);
    // A file that was there already, readable by others, with a setting the CLI does not know.
    mkdirSync(dirname(configPath(h.io)), { recursive: true });
    writeFileSync(configPath(h.io), '{"something_else":true}\n', { mode: 0o644 });
    const done = h.run("login");
    await browse(await signInUrl(h));
    expect(await done).toBe(0);

    expect(relative(h.home, configPath(h.io))).toBe(relative(pasted.home, configPath(pasted.io)));
    expect(savedConfig(h)).toEqual({ something_else: true, api_key: LIVE_KEY, signed_in: true, account_email: ACCOUNT_EMAIL });
    expect(readFileSync(configPath(h.io), "utf8").endsWith("}\n")).toBe(true);
    if (posix) {
      expect(statSync(configPath(h.io)).mode & 0o777).toBe(0o600);
      expect(statSync(configPath(h.io)).mode & 0o777).toBe(statSync(configPath(pasted.io)).mode & 0o777);
    }

    // In a directory the command had to create, the directory is owner-only too, as with `jobo auth`.
    const fresh = signingIn(auth);
    const second = fresh.run("login");
    await browse(await signInUrl(fresh));
    expect(await second).toBe(0);
    if (posix) {
      expect(statSync(configPath(fresh.io)).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(configPath(fresh.io))).mode & 0o777).toBe(statSync(dirname(configPath(pasted.io))).mode & 0o777);
      expect(statSync(dirname(configPath(fresh.io))).mode & 0o077).toBe(0);
    }
  });

  it("takes no arguments and no --api-key, and checks the sign-in URL before it listens (exit 2)", async () => {
    const h = harness();
    expect(await h.run("login", "now")).toBe(EXIT.USAGE);
    expect(await h.run("login", "--api-key", LIVE_KEY)).toBe(EXIT.USAGE);
    expect(h.stderr()).toContain("To save a key you already have, run `jobo auth --api-key KEY`.");
    expect(await h.run("login", "--auth-url", "http://enterprise.jobo.world")).toBe(EXIT.USAGE);
    expect(h.stderr()).toContain("The sign-in URL must use https");
    expect(h.stderr()).not.toContain("/connect/authorize");
    expect(h.opened).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  it("exits 7 when the sign-in server cannot be reached or is failing", async () => {
    // The harness's own transport stands in for the token endpoint here; the callback is still a real request.
    const cases: Array<[HarnessOptions["responder"], string]> = [
      [
        () => {
          throw new JoboTransportError("connect ECONNREFUSED");
        },
        "error: Could not reach the sign-in server at https://auth.example, so nothing was saved: connect ECONNREFUSED.",
      ],
      [() => json(503, { error: "unavailable" }), "error: The sign-in server is unavailable (HTTP 503), so nothing was saved."],
    ];
    for (const [responder, message] of cases) {
      const h = harness({ responder });
      const done = h.run("login", "--auth-url", "https://auth.example");
      const url = await signInUrl(h);
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "a-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      expect((await httpGet(back)).status).toBe(400);
      expect(await done).toBe(EXIT.UNAVAILABLE);
      expect(h.stderr()).toContain(message);
      // One attempt: a code can be exchanged once.
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]?.url).toBe("https://auth.example/connect/token");
      expect(h.requests[0]?.method).toBe("POST");
      expect(h.sleeps).toEqual([]);
      expect(existsSync(configPath(h.io))).toBe(false);
    }
  });
});

describe("after a sign-in", () => {
  it("jobo auth --show names the account and never the key", async () => {
    const h = harness();
    saveKey(h.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
    expect(readSavedEmail(h.io)).toBe(ACCOUNT_EMAIL);
    expect(await h.run("auth", "--show")).toBe(0);
    expect(h.stdout()).toContain(`Key in use: jbe_live_…bbbb (live), from the config file, signed in as ${ACCOUNT_EMAIL}`);
    expect(h.stdout()).not.toContain(LIVE_KEY);
    expect(h.requests).toHaveLength(0);

    // Overridden by the environment: the account belongs to the saved key, not to the one in use.
    const overridden = harness({ env: { JOBO_API_KEY: TEST_KEY } });
    saveKey(overridden.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
    expect(await overridden.run("auth", "--show")).toBe(0);
    expect(overridden.stdout()).toContain("Key in use: jbe_test_…dddd (sandbox), from the JOBO_API_KEY environment variable\n");
    expect(overridden.stdout()).toContain(
      `Saved key: jbe_live_…bbbb (live), signed in as ${ACCOUNT_EMAIL}, overridden by the JOBO_API_KEY environment variable`,
    );
  });

  it("a key saved with jobo auth afterwards is no longer tied to the account", async () => {
    const h = harness();
    saveKey(h.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
    expect(await h.run("auth", "--api-key", OTHER_LIVE_KEY, "--no-verify")).toBe(0);
    expect(savedConfig(h)).toEqual({ api_key: OTHER_LIVE_KEY });
    expect(readSavedEmail(h.io)).toBeNull();
    expect(await h.run("auth", "--show")).toBe(0);
    expect(h.stdout()).not.toContain("signed in as");
  });

  it("jobo logout hands a signed-in key back to Jobo, then removes it", async () => {
    const h = harness({ responder: () => ({ status: 200, headers: {}, body: "" }) });
    saveKey(h.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
    expect(await h.run("logout")).toBe(0);

    // RFC 7009: the key as the token, from the app it was issued to. A public client sends no secret.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("POST");
    expect(h.requests[0]?.url).toBe("https://enterprise.jobo.world/connect/revoke");
    expect(h.requests[0]?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(h.requests[0]?.body ?? ""))).toEqual({ token: LIVE_KEY, client_id: "jobo-cli" });

    expect(existsSync(configPath(h.io))).toBe(false);
    expect(h.stdout()).toBe(
      `Removed the saved key for ${ACCOUNT_EMAIL} from ${configPath(h.io)}\n` +
        "The key is revoked, and the Jobo CLI is disconnected from your Jobo account.\n",
    );
    expect(h.stdout()).not.toContain(LIVE_KEY);
    expect(h.stderr()).not.toContain(LIVE_KEY);

    // Nothing saved: nothing to revoke, and nothing is sent.
    expect(await h.run("logout")).toBe(0);
    expect(h.stdout().endsWith(`No saved key in ${configPath(h.io)}\n`)).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("jobo logout revokes at the sign-in host it was pointed at", async () => {
    const h = harness({ env: { JOBO_AUTH_URL: "http://127.0.0.1:8123" }, responder: () => ({ status: 200, headers: {}, body: "" }) });
    saveKey(h.io, LIVE_KEY, { accountEmail: null });
    expect(await h.run("logout")).toBe(0);
    expect(h.requests[0]?.url).toBe("http://127.0.0.1:8123/connect/revoke");
    expect(h.stdout()).toContain(`Removed the saved key from ${configPath(h.io)}\n`);
  });

  it("jobo logout still removes the key when Jobo cannot be reached, and says where to finish", async () => {
    const unreachable = [
      (): never => {
        throw new JoboTransportError("getaddrinfo ENOTFOUND enterprise.jobo.world");
      },
      () => ({ status: 503, headers: {}, body: "" }),
    ];
    for (const responder of unreachable) {
      const h = harness({ responder });
      saveKey(h.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
      expect(await h.run("logout")).toBe(0);
      expect(existsSync(configPath(h.io))).toBe(false);
      expect(h.stdout()).toBe(
        `Removed the saved key for ${ACCOUNT_EMAIL} from ${configPath(h.io)}\n` +
          "Warning: Jobo could not be reached, so the key is not revoked. To finish, disconnect the Jobo CLI under Developers → API Keys " +
          "in the Jobo dashboard: https://enterprise.jobo.world/api-keys\n",
      );
      expect(h.stdout()).not.toContain(LIVE_KEY);
    }
  });

  it("jobo logout never sends a key the user created, and says it is not revoked", async () => {
    const h = harness();
    saveKey(h.io, LIVE_KEY);
    expect(await h.run("logout")).toBe(0);
    expect(existsSync(configPath(h.io))).toBe(false);
    expect(h.stdout()).toBe(
      `Removed the saved key from ${configPath(h.io)}\n` +
        "Note: the key itself is not revoked. It is a key you created; revoke it under Developers → API Keys: https://enterprise.jobo.world/api-keys\n",
    );
    // No transport call: the harness has no responder, so one would have thrown.
    expect(h.requests).toHaveLength(0);
  });

  it("a key saved over a sign-in with jobo auth is no longer handed back", async () => {
    const h = harness();
    saveKey(h.io, LIVE_KEY, { accountEmail: ACCOUNT_EMAIL });
    expect(await h.run("auth", "--api-key", OTHER_LIVE_KEY, "--no-verify")).toBe(0);
    expect(savedConfig(h)).toEqual({ api_key: OTHER_LIVE_KEY });
    expect(await h.run("logout")).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it("jobo logout keeps other settings and still mentions JOBO_API_KEY", async () => {
    const h = harness({ env: { JOBO_API_KEY: TEST_KEY }, responder: () => ({ status: 200, headers: {}, body: "" }) });
    mkdirSync(dirname(configPath(h.io)), { recursive: true });
    writeFileSync(
      configPath(h.io),
      JSON.stringify({ something_else: true, api_key: LIVE_KEY, signed_in: true, account_email: ACCOUNT_EMAIL }),
    );
    expect(await h.run("logout")).toBe(0);
    expect(savedConfig(h)).toEqual({ something_else: true });
    expect(h.stdout()).toContain("JOBO_API_KEY is still set");
    expect(h.stdout()).toContain("The key is revoked");
  });

  it("a command with no key points at jobo login first", async () => {
    const h = harness();
    expect(await h.run("search", "x")).toBe(EXIT.AUTH);
    expect(h.stderr()).toContain("Run `jobo login` to sign in, or save a key with `jobo auth`, set JOBO_API_KEY, or pass --api-key.");
    expect(await h.run("auth", "--show")).toBe(EXIT.AUTH);
    expect(h.stdout()).toContain("Run `jobo login` to sign in");
  });
});

describe("login and logout in the command line's own surfaces", () => {
  it("are commands, with help that needs no key", async () => {
    expect(COMMANDS.slice(0, 3).map((command) => command.name)).toEqual(["login", "auth", "logout"]);

    const h = harness();
    expect(await h.run("--help")).toBe(0);
    expect(h.stdout()).toContain("  login        Sign in with Jobo in your browser");
    expect(h.stdout()).toContain("  logout       Remove the saved key and sign-in");
    expect(h.stdout()).toContain("Get started: jobo login");

    const help = harness();
    expect(await help.run("login", "--help")).toBe(0);
    expect(help.stdout()).toContain("jobo login [--no-browser]");
    expect(help.stdout()).toContain("--no-browser");
    expect(help.stdout()).toContain("--auth-url <URL>");
    expect(help.stdout()).toContain("JOBO_API_KEY");
    expect(help.opened).toEqual([]);
    expect(await help.run("help", "logout")).toBe(0);
    expect(help.stdout()).toContain("jobo logout");
  });

  it("are offered by shell completion, with the flags of login", async () => {
    const h = harness();
    const candidates = async (...words: string[]): Promise<string[]> => {
      const before = h.stdout().length;
      expect(await h.run(COMPLETE_COMMAND, "--", ...words)).toBe(0);
      return h.stdout().slice(before).split("\n").filter(Boolean);
    };
    expect(await candidates("")).toEqual(expect.arrayContaining(["login", "logout"]));
    expect(await candidates("lo")).toEqual(["login", "logout", "locations"]);
    expect(await candidates("log")).toEqual(["login", "logout"]);
    expect(await candidates("help", "logi")).toEqual(["login"]);
    expect(await candidates("login", "--no")).toEqual(["--no-browser"]);
    expect(await candidates("login", "--a")).toEqual(["--auth-url", "--api-key", "--api-url"]);
    expect(await candidates("login", "--no-browser", "--no")).toEqual([]);
    expect(await candidates("logout", "--q")).toEqual(["--quiet"]);
    expect(h.stderr()).toBe("");
    expect(h.opened).toEqual([]);
  });

  it("suggests login for a near miss", async () => {
    const h = harness();
    expect(await h.run("logn")).toBe(EXIT.USAGE);
    expect(h.stderr()).toContain("`jobo login`");
  });
});
