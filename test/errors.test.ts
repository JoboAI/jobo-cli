import {
  FeedCursorRestartRequiredError,
  InsufficientCreditsError,
  JoboApiError,
  JoboTransportError,
  RateLimitError,
} from "@jobo-ai/connector-core";
import { describe, expect, it } from "vitest";

import { EXIT, UsageError, describeError } from "../src/errors";
import { LIVE_KEY, harness, json } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };

describe("describeError", () => {
  it("402: the API's sentence, its own top-up and plan links, and the size hint", () => {
    const error = new InsufficientCreditsError({
      status: 402,
      message: "Insufficient credits",
      detail: "This request needs 75 credits ($0.075). Your wallet balance is 12 credits ($0.012). Top up your wallet to continue.",
      body: {
        top_up_url: "https://enterprise.jobo.world/credits?topup=10&src=api_402",
        upgrade_url: "https://enterprise.jobo.world/credits?plan=job_search&tier=2&src=api_402",
      },
    });
    const described = describeError(error, { sizeFlag: "--page-size" });
    expect(described.exitCode).toBe(EXIT.CREDITS);
    expect(described.message).toContain("This request needs 75 credits ($0.075).");
    expect(described.message).toContain("Top up: https://enterprise.jobo.world/credits?topup=10&src=api_402");
    expect(described.message).toContain("Plans: https://enterprise.jobo.world/credits?plan=job_search&tier=2&src=api_402");
    expect(described.message).toContain("smaller --page-size");
    expect(described.message).not.toContain("\n");
  });

  it("402 without links falls back to the billing page", () => {
    const described = describeError(new InsufficientCreditsError({ status: 402, message: "Insufficient credits" }));
    expect(described.message).toContain("Top up: https://enterprise.jobo.world/credits");
    expect(described.message).not.toContain("Plans:");
  });

  it("429: the group, the wait and the limits page", () => {
    const error = new RateLimitError({
      status: 429,
      message: "Rate limit exceeded",
      detail: "Per-minute JobSearch request limit of 20 exceeded. Try again shortly.",
      body: { group: "JobSearch", retry_after_seconds: 42 },
      retryAfterSeconds: 42,
    });
    const described = describeError(error);
    expect(described.exitCode).toBe(EXIT.RATE_LIMIT);
    expect(described.message).toContain("Rate limited (JobSearch)");
    expect(described.message).toContain("Retry in 42s.");
    expect(described.message).toContain("https://jobo.world/docs/rate-limits");
  });

  it("401: points at the API keys page", () => {
    const described = describeError(new JoboApiError({ status: 401, message: "Invalid or expired API key" }));
    expect(described.exitCode).toBe(EXIT.AUTH);
    expect(described.message).toContain("https://enterprise.jobo.world/api-keys");
  });

  it("404: the sandbox refusal, a command's own wording, or the API's detail", () => {
    const sandbox = describeError(new JoboApiError({ status: 404, message: "x", code: "not_available_in_sandbox" }));
    expect(sandbox).toMatchObject({ exitCode: EXIT.NOT_FOUND });
    expect(sandbox.message).toContain("sandbox key");

    const plain = new JoboApiError({ status: 404, message: "Not Found", detail: "No job exists with the given id" });
    expect(describeError(plain, { notFound: "No job has that id." }).message).toBe("No job has that id.");
    expect(describeError(plain).message).toBe("Not found: No job exists with the given id.");
  });

  it("dead feed cursors exit 8", () => {
    expect(describeError(new FeedCursorRestartRequiredError({ status: 409, message: "x" })).exitCode).toBe(EXIT.CURSOR);
    expect(describeError(new JoboApiError({ status: 400, message: "x", code: "invalid_cursor" })).exitCode).toBe(EXIT.CURSOR);
  });

  it("400 carries the API's detail; 5xx names the status page and the correlation id", () => {
    const bad = describeError(new JoboApiError({ status: 400, message: "x", detail: "page_size must be between 1 and 100" }));
    expect(bad).toEqual({ exitCode: EXIT.ERROR, message: "The API rejected the request: page_size must be between 1 and 100." });

    const down = describeError(new JoboApiError({ status: 503, message: "An error occurred" }), { correlationId: "abc123" });
    expect(down.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(down.message).toContain("https://jobo.world/status");
    expect(down.message).toContain("correlation id abc123");
  });

  it("transport failures exit 7; usage errors exit 2; anything else exits 1", () => {
    expect(describeError(new JoboTransportError("getaddrinfo ENOTFOUND connect.jobo.world"))).toEqual({
      exitCode: EXIT.UNAVAILABLE,
      message: "Could not reach the Jobo API: getaddrinfo ENOTFOUND connect.jobo.world.",
    });
    expect(describeError(new UsageError("bad flag")).exitCode).toBe(EXIT.USAGE);
    expect(describeError(new Error("boom"))).toEqual({ exitCode: EXIT.ERROR, message: "boom" });
  });
});

describe("errors through a command", () => {
  it("402 is not retried and prints one line", async () => {
    const h = harness({
      env,
      responder: () =>
        json(
          402,
          {
            error: "Insufficient credits",
            detail: "This request needs 30 credits ($0.03). Your wallet balance is 0 credits ($0.00). Top up your wallet to continue.",
            top_up_url: "https://enterprise.jobo.world/credits?topup=10&src=api_402",
            upgrade_url: null,
          },
          { "x-credits-required": "30", "x-credits-balance": "0" },
        ),
    });
    expect(await h.run("search", "x")).toBe(4);
    expect(h.requests).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.stdout()).toBe("");
    const lines = h.stderr().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: This request needs 30 credits/);
    expect(lines[0]).toContain("--page-size");
  });

  it("429 waits out Retry-After, then gives up with exit 5", async () => {
    const h = harness({
      env,
      responder: () =>
        json(
          429,
          { code: "rate_limit_exceeded", error: "Rate limit exceeded", detail: "Per-minute JobSearch request limit of 20 exceeded. Try again shortly.", group: "JobSearch", retry_after_seconds: 7 },
          { "retry-after": "7" },
        ),
    });
    expect(await h.run("search", "x")).toBe(5);
    expect(h.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([7000, 7000]);
    expect(h.stderr()).toContain("waiting 7s before retrying");
    expect(h.stderr()).toContain("error: Rate limited (JobSearch)");
  });

  it("recovers when a retry succeeds", async () => {
    const h = harness({
      env,
      responder: (_request, index) =>
        index === 0
          ? json(429, { code: "rate_limit_exceeded", detail: "Slow down." }, { "retry-after": "2" })
          : json(200, { jobs: [], total: 0, page: 1, page_size: 10, total_pages: 0, facets: {} }),
    });
    expect(await h.run("search", "x")).toBe(0);
    expect(h.requests).toHaveLength(2);
  });

  it("401 exits 3 and names the keys page", async () => {
    const h = harness({ env, responder: () => json(401, { error: "Invalid or expired API key" }) });
    expect(await h.run("search", "x")).toBe(3);
    expect(h.requests).toHaveLength(1);
    expect(h.stderr()).toContain("https://enterprise.jobo.world/api-keys");
  });

  it("a network failure is retried, then exits 7", async () => {
    const h = harness({
      env,
      responder: () => {
        throw new JoboTransportError("connect ECONNREFUSED");
      },
    });
    expect(await h.run("job", "abc")).toBe(7);
    expect(h.requests).toHaveLength(3);
    expect(h.stderr()).toContain("Could not reach the Jobo API");
  });

  it("an unknown flag is a usage error that points at --help", async () => {
    const h = harness({ env });
    expect(await h.run("search", "x", "--remote")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--remote");
    expect(h.stderr()).toContain("jobo search --help");
  });

  it("an unknown command is a usage error", async () => {
    const h = harness({ env });
    expect(await h.run("serach", "x")).toBe(2);
    expect(h.stderr()).toContain('Unknown command "serach"');
  });
});
