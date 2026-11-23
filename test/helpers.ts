import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TransportRequest, TransportResponse } from "@jobo-ai/connector-core";
import { afterAll } from "vitest";

import { run } from "../src/cli";
import type { Io } from "../src/io";

// Built at run time so no key-shaped literal sits in the repository.
export const LIVE_KEY = `jbe_live_${"a".repeat(21)}_${"b".repeat(43)}`;
export const OTHER_LIVE_KEY = `jbe_live_${"e".repeat(21)}_${"f".repeat(39)}wxyz`;
export const TEST_KEY = `jbe_test_${"c".repeat(21)}_${"d".repeat(43)}`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export type Responder = (
  request: TransportRequest,
  index: number,
) => TransportResponse | Promise<TransportResponse>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export interface HarnessOptions {
  responder?: Responder;
  env?: Record<string, string | undefined>;
  /** stdout is a terminal. Default false: piped. */
  tty?: boolean;
  columns?: number;
  stdinTTY?: boolean;
  stdinText?: string;
  /** What the masked prompt returns. */
  secret?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  /** What opening a browser reports. Default true: one was started. Nothing is ever opened. */
  browser?: boolean;
}

export interface Harness {
  io: Io;
  run(...argv: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  requests: TransportRequest[];
  /** Parsed JSON body of request `index`. */
  body(index?: number): Record<string, unknown>;
  sleeps: number[];
  prompts: string[];
  /** URLs the command handed to the browser. */
  opened: string[];
  /** Press Ctrl-C: calls whatever is listening for an interrupt. */
  interrupt(): void;
  home: string;
  cwd: string;
}

/**
 * A complete `Io` with no real network, terminal or environment behind it.
 * The home and working directories are fresh temp dirs, so the config file and
 * anything a command writes stay inside the test.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const requests: TransportRequest[] = [];
  const sleeps: number[] = [];
  const prompts: string[] = [];
  const opened: string[] = [];
  const interruptHandlers = new Set<() => void>();
  const home = mkdtempSync(join(tmpdir(), "jobo-cli-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "jobo-cli-cwd-"));
  tempDirs.push(home, cwd);

  const io: Io = {
    stdout: {
      write: async (chunk) => {
        out.push(chunk);
      },
      isTTY: options.tty ?? false,
      columns: options.columns ?? 120,
    },
    stderr: {
      write: async (chunk) => {
        err.push(chunk);
      },
      isTTY: false,
    },
    stdin: {
      isTTY: options.stdinTTY ?? true,
      readAll: async () => options.stdinText ?? "",
      promptSecret: async (prompt) => {
        prompts.push(prompt);
        return options.secret ?? "";
      },
    },
    env: options.env ?? {},
    cwd,
    homedir: home,
    platform: options.platform ?? process.platform,
    transport: {
      async request(request) {
        requests.push(request);
        if (!options.responder) throw new Error(`Unexpected request in a test with no responder: ${request.method} ${request.url}`);
        return options.responder(request, requests.length - 1);
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => options.now ?? new Date("2026-11-20T12:00:00.000Z"),
    openBrowser: async (url) => {
      opened.push(url);
      return options.browser ?? true;
    },
    onInterrupt: (handler) => {
      interruptHandlers.add(handler);
      return () => {
        interruptHandlers.delete(handler);
      };
    },
  };

  return {
    io,
    run: (...argv) => run(argv, io),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    requests,
    body: (index = 0) => JSON.parse(requests[index]?.body ?? "{}") as Record<string, unknown>,
    sleeps,
    prompts,
    opened,
    interrupt: () => {
      for (const handler of [...interruptHandlers]) handler();
    },
    home,
    cwd,
  };
}

export function job(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Engineer ${id}`,
    normalized_title: null,
    company: { id: `company-${id}`, name: "Acme, Inc.", website: "https://acme.example" },
    description: "Line one\nLine two",
    summary: null,
    listing_url: `https://jobs.example/${id}`,
    apply_url: `https://jobs.example/${id}/apply`,
    locations: [{ location: "Berlin, Germany", city: "Berlin", region: "Berlin", country: "Germany" }],
    compensation: { min: 100000, max: 140000, currency: "EUR", period: "yearly" },
    employment_type: "Full-time",
    workplace_type: "Remote",
    experience_level: "Senior",
    source: "greenhouse",
    created_at: "2026-11-18T08:00:00Z",
    updated_at: "2026-11-19T08:00:00Z",
    date_posted: "2026-11-18T00:00:00Z",
    ...overrides,
  };
}

export function searchPage(
  jobs: unknown[],
  paging: { total: number; page: number; page_size: number; total_pages: number },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { jobs, ...paging, facets: {}, ...extra };
}
