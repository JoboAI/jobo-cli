import {
  FeedCursorRestartRequiredError,
  InsufficientCreditsError,
  JoboApiError,
  JoboTransportError,
  RateLimitError,
} from "@jobo-ai/connector-core";

/** Process exit codes. Stable: scripts and agents branch on them. */
export const EXIT = {
  OK: 0,
  /** The API refused the request (400, 403, an unexpected status) or something else failed. */
  ERROR: 1,
  /** Bad command line: unknown flag, missing argument, invalid value. Nothing billable was sent. */
  USAGE: 2,
  /** No API key, a malformed one, one the API rejected (401), or a sign-in that did not complete. */
  AUTH: 3,
  /** 402: included jobs and wallet balance cannot cover the request. */
  CREDITS: 4,
  /** 429 after the built-in retries. */
  RATE_LIMIT: 5,
  /** 404: unknown id, or an endpoint a sandbox key cannot call. */
  NOT_FOUND: 6,
  /** Network failure, timeout, or a 5xx that outlasted the retries. */
  UNAVAILABLE: 7,
  /** The feed cursor can no longer be used; start a new scan. */
  CURSOR: 8,
} as const;

export const URLS = {
  apiKeys: "https://enterprise.jobo.world/api-keys",
  billing: "https://enterprise.jobo.world/credits",
  register: "https://enterprise.jobo.world/register",
  status: "https://jobo.world/status",
  docs: "https://jobo.world/docs",
  rateLimits: "https://jobo.world/docs/rate-limits",
  billingDocs: "https://jobo.world/docs/billing",
  feedBuilder: "https://jobo.world/api/feed-builder",
} as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.ERROR) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** A mistake on the command line. Raised before any billed request is sent, so it never costs anything. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
  }
}

export interface ErrorContext {
  /** Sentence used for a plain 404, e.g. "No job has that id." */
  notFound?: string;
  /** `x-correlation-id` of the failed response, quoted for support. */
  correlationId?: string;
  /** Flag that lowers the wallet precheck for this command, e.g. "--page-size". */
  sizeFlag?: string;
}

export interface DescribedError {
  message: string;
  exitCode: number;
}

function bodyString(body: unknown, key: string): string | null {
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** `text` as one sentence: trimmed, with a full stop unless it already ends in punctuation. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turn anything thrown into one line for stderr and an exit code.
 *
 * The 402 and 429 bodies carry checkout links priced for the account
 * (`top_up_url`, `upgrade_url`); those are shown as they are. The dashboard
 * URLs are the fallback when the body has none.
 */
export function describeError(error: unknown, context: ErrorContext = {}): DescribedError {
  if (error instanceof CliError) return { message: error.message, exitCode: error.exitCode };

  if (error instanceof InsufficientCreditsError) {
    const detail =
      error.detail ?? "Your included jobs and wallet balance cannot cover this request.";
    const topUp = bodyString(error.body, "top_up_url") ?? URLS.billing;
    const upgrade = bodyString(error.body, "upgrade_url");
    const smaller = context.sizeFlag
      ? ` The wallet check prices a full page, so a smaller ${context.sizeFlag} needs less.`
      : "";
    return {
      message: `${sentence(detail)} Top up: ${topUp}${upgrade ? ` Plans: ${upgrade}` : ""}${smaller}`,
      exitCode: EXIT.CREDITS,
    };
  }

  if (error instanceof FeedCursorRestartRequiredError) {
    return {
      message:
        "This feed cursor cannot be continued (a legacy stable_scan:false scan reached its 1,000,000-result limit). " +
        "Discard it and start a new scan: run the command again without --cursor (`jobo feed` has moved a --cursor-file that held it to FILE.dead).",
      exitCode: EXIT.CURSOR,
    };
  }

  if (error instanceof RateLimitError) {
    const group = bodyString(error.body, "group");
    const wait = error.retryAfterSeconds != null ? ` Retry in ${error.retryAfterSeconds}s.` : "";
    const upgrade = bodyString(error.body, "upgrade_url");
    return {
      message:
        `Rate limited${group ? ` (${group})` : ""}: ${sentence(error.detail ?? "too many requests")}${wait}` +
        ` Limits: ${URLS.rateLimits}${upgrade ? ` Higher limits: ${upgrade}` : ""}`,
      exitCode: EXIT.RATE_LIMIT,
    };
  }

  if (error instanceof JoboApiError) {
    const detail = error.detail ?? error.message;
    const support = context.correlationId ? ` (correlation id ${context.correlationId})` : "";

    if (error.status === 401) {
      return {
        message:
          `The API rejected this key: ${sentence(detail)} Check it under Developers → API Keys at ${URLS.apiKeys}, ` +
          "then run `jobo login` to sign in again, or `jobo auth` to save another key.",
        exitCode: EXIT.AUTH,
      };
    }
    if (error.status === 404) {
      if (error.code === "not_available_in_sandbox") {
        return {
          message:
            "This endpoint is not available with a sandbox key (jbe_test_…). The sandbox serves job search and lookups by id (`jobo job`, `jobo company`); use a live key for the rest.",
          exitCode: EXIT.NOT_FOUND,
        };
      }
      return { message: context.notFound ?? `Not found: ${sentence(detail)}`, exitCode: EXIT.NOT_FOUND };
    }
    if (error.status === 400 && error.code === "invalid_cursor") {
      return {
        message:
          "The feed cursor could not be decoded. Discard it and start a new scan: run the command again without --cursor (`jobo feed` has moved a --cursor-file that held it to FILE.dead).",
        exitCode: EXIT.CURSOR,
      };
    }
    if (error.status === 400 || error.status === 422) {
      return { message: `The API rejected the request: ${sentence(detail)}`, exitCode: EXIT.ERROR };
    }
    if (error.status === 403) {
      return { message: `Not allowed for this key or account: ${sentence(detail)}`, exitCode: EXIT.ERROR };
    }
    if (error.status === 408 || error.status >= 500) {
      return {
        message: `The Jobo API is unavailable (HTTP ${error.status}) after retrying: ${sentence(detail)} Status: ${URLS.status}${support}`,
        exitCode: EXIT.UNAVAILABLE,
      };
    }
    return { message: `Jobo API error (HTTP ${error.status}): ${sentence(detail)}${support}`, exitCode: EXIT.ERROR };
  }

  if (error instanceof JoboTransportError) {
    return { message: `Could not reach the Jobo API: ${sentence(error.message)}`, exitCode: EXIT.UNAVAILABLE };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { message, exitCode: EXIT.ERROR };
}
