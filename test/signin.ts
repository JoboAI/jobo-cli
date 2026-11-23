import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll } from "vitest";

import { LIVE_KEY } from "./helpers";

/**
 * What the sign-in tests need besides the harness: an authorization server to
 * sign in at, and the browser's part of the flow. Everything stays on
 * 127.0.0.1, and no browser is ever started.
 */

export const ACCOUNT_EMAIL = "user@example.com";

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

export interface FakeAuthServer {
  /** What `--auth-url` or `JOBO_AUTH_URL` is set to. */
  url: string;
  /** The query of every request that reached /connect/authorize. */
  authorizations: URLSearchParams[];
  /** Every request that reached /connect/token. */
  tokenRequests: Array<{ headers: IncomingHttpHeaders; form: URLSearchParams }>;
  /** What the token endpoint answers a valid exchange with. Tests replace it. */
  token: { status: number; body: unknown };
  /** When set, the user declined: the browser is sent back with this error instead of a code. */
  decline: { error: string; description: string } | null;
  /** When set, the token endpoint waits for this before it answers. */
  hold: Promise<void> | null;
}

/**
 * The two endpoints of the contract, checked the way the real server checks
 * them: the redirect must be the registered loopback one, a code is exchanged
 * once, the verifier must hash to the challenge the code was issued for, and a
 * public client that sends a secret is refused.
 */
export async function fakeAuthServer(): Promise<FakeAuthServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let issued = 0;
  const fake: FakeAuthServer = {
    url: "",
    authorizations: [],
    tokenRequests: [],
    token: { status: 200, body: { access_token: LIVE_KEY, token_type: "Bearer", scope: "api", account_email: ACCOUNT_EMAIL } },
    decline: null,
    hold: null,
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    };

    if (request.method === "GET" && url.pathname === "/connect/authorize") {
      const query = url.searchParams;
      fake.authorizations.push(query);
      const redirectUri = query.get("redirect_uri") ?? "";
      const valid =
        query.get("response_type") === "code" &&
        query.get("client_id") === "jobo-cli" &&
        query.get("code_challenge_method") === "S256" &&
        (query.get("code_challenge") ?? "") !== "" &&
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri);
      if (!valid) {
        answer(400, { error: "invalid_request", error_description: "The authorization request is not valid." });
        return;
      }

      const back = new URL(redirectUri);
      if (fake.decline) {
        back.searchParams.set("error", fake.decline.error);
        back.searchParams.set("error_description", fake.decline.description);
      } else {
        const code = `code-${++issued}`;
        codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", query.get("state") ?? "");
      answer(302, {}, { location: back.toString() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/connect/token") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        fake.tokenRequests.push({ headers: request.headers, form });
        void (async () => {
          await fake.hold;
          if (form.has("client_secret")) {
            answer(401, { error: "invalid_client", error_description: "A public client must not send a secret." });
            return;
          }
          const code = form.get("code") ?? "";
          const grant = codes.get(code);
          codes.delete(code);
          const verifier = form.get("code_verifier") ?? "";
          const valid =
            grant !== undefined &&
            form.get("grant_type") === "authorization_code" &&
            form.get("client_id") === "jobo-cli" &&
            form.get("redirect_uri") === grant.redirectUri &&
            /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
            createHash("sha256").update(verifier).digest("base64url") === grant.challenge;
          if (!valid) {
            answer(400, { error: "invalid_grant", error_description: "The authorization code is invalid or has expired." });
            return;
          }
          answer(fake.token.status, fake.token.body);
        })();
      });
      return;
    }

    answer(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** The sign-in URL in what a command has printed on stderr, or null while there is none. */
export function printedSignInUrl(stderr: string): URL | null {
  const match = /^\s+(https?:\/\/\S+\/connect\/authorize\?\S+)$/m.exec(stderr);
  return match ? new URL(match[1] ?? "") : null;
}

export interface Page {
  status: number;
  body: string;
}

/** One request with the Host header a test wants, which `fetch` does not let it set. */
export function httpGet(target: URL | string, options: { host?: string; method?: string } = {}): Promise<Page> {
  const url = new URL(target);
  return new Promise<Page>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.host ? { Host: options.host } : {},
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** The browser's first step: ask the authorization server, and learn where it sends the user back to. */
export async function authorize(signInUrl: URL): Promise<URL> {
  const response = await fetch(signInUrl, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`The authorization server answered ${response.status}: ${await response.text()}`);
  return new URL(response.headers.get("location") ?? "");
}

/** The whole of the browser's part: follow the sign-in URL, then the redirect back to the CLI. Returns the page it ends on. */
export async function browse(signInUrl: URL): Promise<Page> {
  return httpGet(await authorize(signInUrl));
}
