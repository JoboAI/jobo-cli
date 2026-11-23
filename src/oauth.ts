/**
 * "Sign in with Jobo": OAuth 2.0 authorization code with PKCE (S256), for a
 * public client on a loopback redirect.
 *
 * The access token the flow ends with is an ordinary Jobo API key. It does not
 * expire and is never refreshed, and a public client holds no secret, so there
 * is no refresh token and no `client_secret` anywhere in here. `jobo login`
 * drives these pieces, and `jobo logout` hands the key back with `revokeKey`;
 * nothing in this file prints or saves.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { JoboTransportError, isValidApiKeyFormat, type Transport, type TransportResponse } from "@jobo-ai/connector-core";

import { CliError, EXIT, URLS, sentence } from "./errors";

/** The CLI's registered client id. The server accepts any port on its loopback redirect. */
export const CLIENT_ID = "jobo-cli";
/** `api` signs the app in for a key; `email` adds the account's address to the answer. */
export const SCOPE = "api email";

/** The registered redirect names this address and this path exactly: not `localhost`, and no other path. */
const LOOPBACK = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const TOKEN_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 15_000;

// ── PKCE and the authorization request ───────────────────────────────────────

/** 32 random bytes as 43 URL-safe characters: a PKCE verifier (RFC 7636 asks for 43 to 128), or a `state`. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge for a verifier: BASE64URL(SHA256(verifier)), without padding. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function authorizationUrl(authUrl: string, request: { redirectUri: string; state: string; challenge: string }): string {
  const params: Array<[string, string]> = [
    ["response_type", "code"],
    ["client_id", CLIENT_ID],
    ["redirect_uri", request.redirectUri],
    ["scope", SCOPE],
    ["state", request.state],
    ["code_challenge", request.challenge],
    ["code_challenge_method", "S256"],
  ];
  const url = new URL(`${authUrl}/connect/authorize`);
  // The space in the scope goes out as %20, which every server reads; "+" depends on form decoding.
  url.search = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return url.toString();
}

/** Text from the network on its way to a terminal: no control characters, and no longer than a message needs. */
export function printable(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ── The loopback listener ────────────────────────────────────────────────────

export interface Callback {
  /** The query the browser came back with. */
  params: URLSearchParams;
  /** Answers the waiting browser tab with a small page. Resolves once it is sent, or the tab is gone. */
  reply(signedIn: boolean): Promise<void>;
}

export interface CallbackListener {
  /** `http://127.0.0.1:<port>/callback`, on the port the system picked. */
  redirectUri: string;
  /** The first request for the callback path. Any later one is refused. */
  callback: Promise<Callback>;
  /** Stops listening and drops open connections. Safe to call twice. */
  close(): Promise<void>;
}

const PAGES = {
  signedIn: "Signed in. You can close this tab.",
  // The reason is on the terminal. Nothing from the request is written into a page.
  failed: "Sign-in did not complete. Return to the terminal for the reason.",
  used: "This sign-in has already come back once. Return to the terminal.",
} as const;

function page(message: string): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Jobo CLI</title></head>\n<body><p>${message}</p></body>\n</html>\n`;
}

function send(response: ServerResponse, status: number, type: "text/html" | "text/plain", body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // A tab that was closed, or a connection that dropped, must not leave the command waiting.
    response.once("close", () => resolve());
    response.once("error", () => resolve());
    try {
      response.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", Connection: "close" });
      response.end(body, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Listen on 127.0.0.1, on a port the system picks, for the one request the
 * sign-in ends with: `GET /callback`. Everything else is answered 404,
 * including a request whose Host is not this address: the redirect only ever
 * names it, so another Host is some other page reaching for the port.
 */
export async function listenForCallback(): Promise<CallbackListener> {
  let deliver: (callback: Callback) => void = () => {};
  const callback = new Promise<Callback>((resolve) => {
    deliver = resolve;
  });
  let host = "";
  let taken = false;

  const server = createServer((request, response) => {
    let url: URL | null;
    try {
      url = new URL(request.url ?? "", `http://${LOOPBACK}`);
    } catch {
      url = null;
    }
    if (!url || request.headers.host !== host || request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      void send(response, 404, "text/plain", "Not found.\n");
      return;
    }
    if (taken) {
      void send(response, 400, "text/html", page(PAGES.used));
      return;
    }
    taken = true;
    deliver({
      params: url.searchParams,
      reply: (signedIn) => send(response, signedIn ? 200 : 400, "text/html", page(signedIn ? PAGES.signedIn : PAGES.failed)),
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      // Before the port is bound this fails the sign-in; afterwards it is a no-op, and keeps a late error from being thrown.
      server.on("error", reject);
      server.listen(0, LOOPBACK, () => resolve());
    });
  } catch (error) {
    throw new CliError(
      `Could not listen on ${LOOPBACK} for the sign-in to come back: ${sentence(error instanceof Error ? error.message : String(error))}`,
    );
  }
  host = `${LOOPBACK}:${(server.address() as AddressInfo).port}`;

  return {
    redirectUri: `http://${host}${CALLBACK_PATH}`,
    callback,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A browser keeps its connection open; without this the close would wait for it.
        server.closeAllConnections();
      }),
  };
}

// ── The token request ────────────────────────────────────────────────────────

export interface SignIn {
  /** The access token, which is a Jobo API key. */
  key: string;
  /** Present when the `email` scope was granted. */
  accountEmail: string | null;
}

function accountEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = printable(value);
  return email === value.trim() && email.length <= 254 && /^\S+@\S+$/.test(email) ? email : null;
}

/**
 * Exchange the authorization code for the key. One attempt: a code can be
 * exchanged once, so a retry could only fail. Throws a `CliError` that never
 * holds the token, whatever the server sent.
 */
export async function exchangeCode(
  transport: Transport,
  authUrl: string,
  grant: { code: string; verifier: string; redirectUri: string },
  userAgent: string,
): Promise<SignIn> {
  let response: TransportResponse;
  try {
    response = await transport.request({
      method: "POST",
      url: `${authUrl}/connect/token`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": userAgent },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: grant.redirectUri,
        code: grant.code,
        code_verifier: grant.verifier,
      }).toString(),
      timeoutMs: TOKEN_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof JoboTransportError)) throw error;
    throw new CliError(
      `Could not reach the sign-in server at ${authUrl}, so nothing was saved: ${sentence(error.message)}`,
      EXIT.UNAVAILABLE,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the status decides below.
  }
  const text = (name: string): string | null => {
    const value = body[name];
    return typeof value === "string" && printable(value) !== "" ? printable(value) : null;
  };

  if (response.status >= 500) {
    throw new CliError(
      `The sign-in server is unavailable (HTTP ${response.status}), so nothing was saved. Run \`jobo login\` again. Status: ${URLS.status}`,
      EXIT.UNAVAILABLE,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const reason = text("error_description") ?? text("error") ?? `HTTP ${response.status}`;
    throw new CliError(`Sign-in was refused, so nothing was saved: ${sentence(reason)} Run \`jobo login\` again.`, EXIT.AUTH);
  }

  const token = body.access_token;
  if (typeof token !== "string" || !isValidApiKeyFormat(token)) {
    throw new CliError(
      "Sign-in did not return a Jobo API key, so nothing was saved. Run `jobo login` again, or save a key with `jobo auth`.",
      EXIT.AUTH,
    );
  }
  return { key: token.trim(), accountEmail: accountEmail(body.account_email) };
}

// ── Handing the key back ─────────────────────────────────────────────────────

/**
 * Hand a signed-in key back to Jobo (RFC 7009): the key is revoked and the
 * Jobo CLI is disconnected from the account. Jobo only does this for the app
 * the key was issued to, and answers 200 whether or not the key was still
 * live. False when the server could not be reached or refused the request;
 * never throws for either.
 */
export async function revokeKey(transport: Transport, authUrl: string, key: string, userAgent: string): Promise<boolean> {
  try {
    const response = await transport.request({
      method: "POST",
      url: `${authUrl}/connect/revoke`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
      body: new URLSearchParams({ token: key, client_id: CLIENT_ID }).toString(),
      timeoutMs: REVOKE_TIMEOUT_MS,
    });
    return response.status === 200;
  } catch (error) {
    if (!(error instanceof JoboTransportError)) throw error;
    return false;
  }
}
