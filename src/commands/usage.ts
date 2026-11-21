import { JoboApiError, type UsageInfo } from "@jobo-ai/connector-core";

import type { CommandDef, Ctx } from "../args";
import { keyEnvironment, maskKey } from "../config";
import { URLS, UsageError } from "../errors";
import { emitDocument, openSink, resolveFormat, toKeyValue } from "../output";
import { formatCredits, formatNumber, openSession } from "../session";

interface UsageReport {
  key: string;
  key_source: string;
  environment: "live" | "sandbox";
  rate_limit: { group: string | null; limit: number | null; remaining: number | null };
  wallet_balance_credits: number | null;
  wallet_balance_usd: number | null;
  included_jobs: { limit: number | null; remaining: number | null };
  billing_url: string;
  note: string;
}

function usageView(document: unknown): string {
  const report = document as UsageReport;
  const limit = report.rate_limit;
  const rate =
    limit.remaining != null && limit.limit != null
      ? `${formatNumber(limit.remaining)} of ${formatNumber(limit.limit)} requests left this minute${limit.group ? ` (${limit.group} group)` : ""}`
      : null;
  const quota = report.included_jobs;
  return (
    toKeyValue([
      ["Key", `${report.key} (${report.environment}, from ${report.key_source})`],
      ["Rate limit", rate],
      ["Wallet", report.wallet_balance_credits != null ? formatCredits(report.wallet_balance_credits) : null],
      [
        "Included jobs",
        quota.remaining != null
          ? `${formatNumber(quota.remaining)} left${quota.limit != null ? ` of ${formatNumber(quota.limit)}` : ""}`
          : null,
      ],
      ["Billing", report.billing_url],
    ]) + `\n${report.note}\n`
  );
}

const SOURCES = { flag: "--api-key", env: "JOBO_API_KEY", config: "the saved key" } as const;

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo usage takes no arguments.");
  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    let usage: UsageInfo | null;
    try {
      // The free call: connector metadata is rate limited but never billed.
      usage = (await session.client.filters()).usage;
    } catch (error) {
      // A sandbox key is refused here (404), after authentication; the refusal still carries the headers.
      if (!(error instanceof JoboApiError && error.code === "not_available_in_sandbox")) throw error;
      usage = error.usage;
    }

    const environment = keyEnvironment(session.key.key);
    const balance = usage?.creditsBalance ?? null;
    const report: UsageReport = {
      key: maskKey(session.key.key),
      key_source: SOURCES[session.key.source],
      environment,
      rate_limit: {
        group: usage?.rateLimitGroup ?? null,
        limit: usage?.rateLimitLimit ?? null,
        remaining: usage?.rateLimitRemaining ?? null,
      },
      wallet_balance_credits: balance,
      wallet_balance_usd: balance != null ? balance / 1000 : null,
      included_jobs: { limit: usage?.quotaLimit ?? null, remaining: usage?.quotaRemaining ?? null },
      billing_url: URLS.billing,
      note:
        environment === "sandbox"
          ? "Sandbox keys are never billed and use no included jobs."
          : balance != null || usage?.quotaRemaining != null
            ? "Wallet and included-job figures are as of this response."
            : "The API reports the wallet balance and included jobs only on billed Search and Feed responses, so a free call cannot show them: " +
              "read the usage line `jobo search` and `jobo feed` print on stderr, or open the billing page.",
    };
    await emitDocument(ctx, sink, format, report, usageView);
  } finally {
    sink.close();
  }
  return 0;
}

export const usageCommand: CommandDef = {
  name: "usage",
  summary: "Show which key is in use and its rate-limit position (free)",
  usage: [""],
  description:
    "Makes one free call and reports what its response headers say: the rate-limit group, its per-minute limit and the requests left. " +
    "The API has no balance endpoint, and it sends the wallet balance (X-Credits-Balance) and included jobs (X-Quota-*) only on billed Search and Feed responses; " +
    `this command shows them when the response carries them and otherwise points to ${URLS.billing}. ` +
    "For what a request cost, read the usage line `jobo search` and `jobo feed` print on stderr.",
  output: true,
  examples: ["jobo usage", "jobo usage --json"],
  run,
};
