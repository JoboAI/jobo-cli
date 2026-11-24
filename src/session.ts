import {
  InsufficientCreditsError,
  JoboApiError,
  JoboClient,
  RateLimitError,
  isValidApiKeyFormat,
  nextDelayMs,
  resolveRetryOptions,
  withRetry,
  type Transport,
  type UsageInfo,
} from "@jobo-ai/connector-core";

import pkg from "../package.json";
import { flag, str, type Ctx } from "./args";
import { requireApiKey, resolveApiKey, resolveApiUrl, type ResolvedKey } from "./config";
import type { Io } from "./io";

export const VERSION: string = pkg.version;
export const USER_AGENT = `jobo-cli/${VERSION}`;
/** Sent as `X-Jobo-Client`, so the API can attribute traffic to this connector. */
export const CLIENT_NAME = "cli";

/** Feed calls can work for up to 90 seconds before answering; the docs ask for at least 120. */
export const FEED_TIMEOUT_MS = 130_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface Session {
  client: JoboClient;
  key: ResolvedKey;
  apiUrl: string;
  /** Usage parsed off the most recent response, successful or not. */
  usage(): UsageInfo | null;
  /** Lower-cased headers of the most recent response. */
  headers(): Record<string, string>;
}

/** Writes a note to stderr unless `--quiet`. Data never goes through here. */
export function note(ctx: Pick<Ctx, "io" | "values">, message: string): void {
  if (flag(ctx.values, "quiet")) return;
  void ctx.io.stderr.write(`${message}\n`);
}

/** Wraps the host transport to remember the last response's status and headers. */
function recording(inner: Transport, ctx: Ctx): Transport {
  return {
    async request(req) {
      // Cleared first, so a request that never gets a response leaves nothing stale behind.
      ctx.lastStatus = 0;
      ctx.lastHeaders = {};
      const response = await inner.request(req);
      ctx.lastStatus = response.status;
      ctx.lastHeaders = response.headers;
      return response;
    },
  };
}

const MAX_RETRY_WAIT_MS = 60_000;

/**
 * The wait between attempts. The shared client takes a 429's `Retry-After`
 * from the header but a 5xx's only from the body, and the feed's
 * `503 Retry-After: 5` carries it in the header: wait at least that long, as
 * the API asks. Waits are announced so a throttled run does not look hung.
 */
function retrySleep(ctx: Ctx): (ms: number) => Promise<void> {
  return async (ms) => {
    let wait = ms;
    const retryAfter = Number(ctx.lastHeaders["retry-after"]);
    if (ctx.lastStatus >= 500 && Number.isFinite(retryAfter) && retryAfter > 0) {
      wait = Math.max(wait, Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS));
    }
    if (wait >= 1000) note(ctx, `waiting ${Math.round(wait / 1000)}s before retrying…`);
    await ctx.io.sleep(wait);
  };
}

export function openSession(ctx: Ctx, options: { timeoutMs?: number } = {}): Session {
  const key = requireApiKey(ctx.io, str(ctx.values, "api-key"));
  const apiUrl = resolveApiUrl(ctx.io, str(ctx.values, "api-url"));
  const state: { usage: UsageInfo | null } = { usage: null };

  const client = new JoboClient({
    apiKey: key.key,
    baseUrl: apiUrl,
    transport: recording(ctx.io.transport, ctx),
    retry: { sleep: retrySleep(ctx) },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: USER_AGENT,
    client: CLIENT_NAME,
    onUsage: (usage) => {
      state.usage = usage;
    },
  });

  return { client, key, apiUrl, usage: () => state.usage, headers: () => ctx.lastHeaders };
}

/**
 * A client for free lookups that must never hold a command up or speak for
 * it: one attempt, a short timeout, nothing announced. Shell completion and
 * the feed's size estimate use it. Null when there is no usable key.
 */
export function quickClient(
  io: Io,
  options: { timeoutMs: number; apiKey?: string; apiUrl?: string },
): JoboClient | null {
  const key = resolveApiKey(io, options.apiKey);
  if (!key || !isValidApiKeyFormat(key.key)) return null;
  return new JoboClient({
    apiKey: key.key,
    baseUrl: resolveApiUrl(io, options.apiUrl),
    transport: io.transport,
    retry: { maxAttempts: 1, sleep: io.sleep },
    timeoutMs: options.timeoutMs,
    userAgent: USER_AGENT,
    client: CLIENT_NAME,
  });
}

/**
 * `GET` without `X-Api-Key`, for the one endpoint that takes none
 * (`GET /api/companies/{id}`), so it works before `jobo auth`.
 */
export async function anonymousGet(ctx: Ctx, path: string): Promise<{ data: unknown; headers: Record<string, string> }> {
  const apiUrl = resolveApiUrl(ctx.io, str(ctx.values, "api-url"));
  return withRetry(async () => {
    const response = await recording(ctx.io.transport, ctx).request({
      method: "GET",
      url: `${apiUrl}${path}`,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, "X-Jobo-Client": CLIENT_NAME },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    let parsed: unknown = null;
    try {
      parsed = response.body === "" ? null : JSON.parse(response.body);
    } catch {
      parsed = response.body;
    }
    if (response.status >= 200 && response.status < 300) return { data: parsed, headers: response.headers };
    const field = (name: string) =>
      parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[name] === "string"
        ? ((parsed as Record<string, unknown>)[name] as string)
        : null;
    const detail = field("detail") ?? field("error") ?? field("title");
    throw new JoboApiError({
      status: response.status,
      message: detail ?? `Jobo API returned HTTP ${response.status}`,
      code: field("code"),
      detail,
      body: parsed,
    });
  }, resolveRetryOptions({ sleep: retrySleep(ctx) }));
}

/** A response that is not 2xx, as the error class the shared client would throw for it. */
function apiError(status: number, headers: Record<string, string>, body: string): JoboApiError {
  let parsed: unknown = null;
  try {
    parsed = body === "" ? null : JSON.parse(body);
  } catch {
    parsed = body;
  }
  const field = (name: string) =>
    parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[name] === "string"
      ? ((parsed as Record<string, unknown>)[name] as string)
      : null;
  const detail = field("detail") ?? field("error") ?? field("title");
  const options = { status, message: detail ?? `Jobo API returned HTTP ${status}`, code: field("code"), detail, body: parsed };
  if (status === 402) return new InsufficientCreditsError(options);
  if (status === 429) {
    const seconds = Number(headers["retry-after"]);
    return new RateLimitError({ ...options, retryAfterSeconds: Number.isFinite(seconds) ? seconds : null });
  }
  return new JoboApiError(options);
}

/**
 * `GET` a billed endpoint that the shared client has no method for (Hiring
 * Signals, until connector-core 0.7.0 is on npm), on the session's key.
 *
 * Sent again only after a 429, which the API answers before it reads, let
 * alone bills, anything. Never after a timeout, a dropped connection or a 5xx:
 * the page may have been charged with its answer lost, and sending it again
 * would charge it twice. Those surface at once for the command to explain.
 */
export async function billedGet(
  ctx: Ctx,
  session: Session,
  pathAndQuery: string,
): Promise<{ data: unknown; headers: Record<string, string> }> {
  const transport = recording(ctx.io.transport, ctx);
  const retry = resolveRetryOptions({ sleep: retrySleep(ctx) });
  for (let attempt = 1; ; attempt++) {
    const response = await transport.request({
      method: "GET",
      url: `${session.apiUrl}${pathAndQuery}`,
      headers: {
        Accept: "application/json",
        "X-Api-Key": session.key.key,
        "User-Agent": USER_AGENT,
        "X-Jobo-Client": CLIENT_NAME,
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      let data: unknown = null;
      try {
        data = response.body === "" ? null : JSON.parse(response.body);
      } catch {
        // A 2xx that is not JSON was still answered, and may have been billed: report it, never resend it.
        throw new JoboApiError({
          status: response.status,
          message: `The Jobo API answered HTTP ${response.status} with a body that is not JSON.`,
        });
      }
      return { data, headers: response.headers };
    }
    const error = apiError(response.status, response.headers, response.body);
    if (!(error instanceof RateLimitError) || attempt >= retry.maxAttempts) throw error;
    await retry.sleep(nextDelayMs(error, attempt, retry));
  }
}

// ── Cost reporting ───────────────────────────────────────────────────────────

const number = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return number.format(value);
}

/** 1,000 credits = $1.00. Three decimals, because one job is $0.003. */
export function formatCredits(credits: number): string {
  const dollars = (credits / 1000).toFixed(3).replace(/(\.\d\d)0$/, "$1");
  return `${formatNumber(credits)} credits ($${dollars})`;
}

/**
 * The billing facts a response reported, as one stderr line; null when it
 * reported none (free endpoints send no wallet or included-jobs headers).
 */
export function usageLine(usage: UsageInfo | null, headers: Record<string, string>): string | null {
  const parts: string[] = [];
  if (headers["x-jobo-environment"] === "sandbox") parts.push("sandbox key: not billed");
  if (usage?.creditsDeducted != null) parts.push(`${formatCredits(usage.creditsDeducted)} charged`);
  const billed = headers["x-jobs-billed"];
  if (billed !== undefined && /^\d+$/.test(billed)) parts.push(`${formatNumber(Number(billed))} jobs billed`);
  if (usage?.creditsBalance != null) parts.push(`wallet ${formatCredits(usage.creditsBalance)}`);
  if (usage?.quotaRemaining != null) {
    const limit = usage.quotaLimit != null ? ` of ${formatNumber(usage.quotaLimit)}` : "";
    parts.push(`included jobs left ${formatNumber(usage.quotaRemaining)}${limit}`);
  }
  if (headers["x-billing-status"]) parts.push(`billing status ${headers["x-billing-status"]}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Print the usage line for the session's last response, with an optional prefix such as "page 2". */
export function reportUsage(ctx: Ctx, session: Session, prefix = "usage"): void {
  const line = usageLine(session.usage(), session.headers());
  if (line) note(ctx, `${prefix}: ${line}`);
  if (session.headers()["x-billing-status"]?.toLowerCase() === "unconfirmed") {
    note(
      ctx,
      "warning: these jobs were delivered but wallet settlement could not be confirmed; do not replay this page automatically.",
    );
  }
}
