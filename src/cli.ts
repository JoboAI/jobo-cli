import {
  optionsFor,
  parseCommandArgs,
  renderHelp,
  wrap,
  flag,
  type CommandDef,
  type Ctx,
} from "./args";
import { authCommand, logoutCommand } from "./commands/auth";
import { companiesCommand, companyCommand } from "./commands/company";
import { completionCommand } from "./commands/completion";
import { expiredCommand } from "./commands/expired";
import { feedCommand } from "./commands/feed";
import { filtersCommand } from "./commands/filters";
import { geocodeCommand } from "./commands/geocode";
import { jobCommand } from "./commands/job";
import { locationsCommand } from "./commands/locations";
import { mcpCommand } from "./commands/mcp";
import { occupationsCommand } from "./commands/occupations";
import { searchCommand } from "./commands/search";
import { skillCommand } from "./commands/skill";
import { usageCommand } from "./commands/usage";
import { COMPLETE_COMMAND, runComplete } from "./complete";
import { EXIT, URLS, UsageError, describeError } from "./errors";
import type { Io } from "./io";
import { VERSION } from "./session";
import { didYouMean } from "./suggest";

export const COMMANDS: readonly CommandDef[] = [
  authCommand,
  logoutCommand,
  searchCommand,
  jobCommand,
  feedCommand,
  expiredCommand,
  companyCommand,
  companiesCommand,
  locationsCommand,
  geocodeCommand,
  filtersCommand,
  occupationsCommand,
  usageCommand,
  mcpCommand,
  skillCommand,
  completionCommand,
];

const PROGRAM = "jobo";

export function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const lines = [
    `${PROGRAM} — command-line client for the Jobo jobs API (v${VERSION})`,
    "",
    "Usage:",
    `  ${PROGRAM} <command> [arguments] [flags]`,
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Flags:",
    "  -h, --help       Show help. Works on every command: jobo search --help",
    "  -V, --version    Print the version.",
    "",
    wrap(
      "Cost: search bills every job it returns and the feed every job that is new to you, at $3.00 per 1,000 jobs after your plan's included jobs. " +
        "Job, company, location and filter lookups are free. Each billed request prints what it cost on stderr.",
      100,
    ),
    "",
    wrap(
      "Output: a table in a terminal, JSON when piped. --json, --jsonl, --csv and --output FILE choose otherwise. Data goes to stdout; costs, progress and errors go to stderr.",
      100,
    ),
    "",
    `Exit codes: 0 ok · 1 error · 2 usage · 3 auth · 4 insufficient credits · 5 rate limited · 6 not found · 7 API unreachable · 8 feed cursor must restart`,
    "",
    `Get started: ${PROGRAM} auth    Tab completion: ${PROGRAM} completion --help    Docs: ${URLS.docs}`,
  ];
  return `${lines.join("\n")}\n`;
}

function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((command) => command.name === name);
}

function unknownCommand(name: string): UsageError {
  const guess = didYouMean(name, COMMANDS.map((command) => command.name), (found) => `\`${PROGRAM} ${found}\``);
  return new UsageError(`Unknown command "${name}".${guess} Run \`${PROGRAM} --help\` for the list.`);
}

/**
 * Run one invocation and resolve to its exit code. Never throws and never
 * calls `process.exit`, so tests can call it directly.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  let command: CommandDef | undefined;
  let path = PROGRAM;
  let ctx: Ctx | undefined;

  try {
    const [first, ...rest] = argv;
    if (first === COMPLETE_COMMAND) {
      // The shell's side of TAB completion. Not a command: it has no help and never fails.
      await runComplete(rest, io, COMMANDS);
      return EXIT.OK;
    }
    if (first === undefined || first === "--help" || first === "-h" || first === "help") {
      const topic = first === "help" ? rest[0] : undefined;
      const target = topic ? findCommand(topic) : undefined;
      if (topic && !target) throw unknownCommand(topic);
      await io.stdout.write(target ? renderHelp(target, `${PROGRAM} ${target.name}`) : rootHelp());
      return EXIT.OK;
    }
    if (first === "--version" || first === "-V") {
      await io.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (first.startsWith("-")) {
      throw new UsageError(`Put the command first: \`${PROGRAM} <command> ${first}\`. Run \`${PROGRAM} --help\` for the list.`);
    }

    command = findCommand(first);
    if (!command) throw unknownCommand(first);
    path = `${PROGRAM} ${command.name}`;
    let args = rest;

    // A subcommand comes straight after its parent: `jobo skill install …`.
    if (command.subcommands && args[0] !== undefined && !args[0].startsWith("-")) {
      const subName = args[0];
      const names = command.subcommands.map((entry) => entry.name);
      const sub = command.subcommands.find((entry) => entry.name === subName);
      if (!sub) {
        throw new UsageError(
          `Unknown ${path} command "${subName}".${didYouMean(subName, names, (found) => `\`${path} ${found}\``)} Available: ${names.join(", ")}.`,
        );
      }
      args = args.slice(1);
      command = sub;
      path = `${path} ${sub.name}`;
    }

    const { values, positionals } = parseCommandArgs(args, optionsFor(command));
    if (flag(values, "version")) {
      await io.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (flag(values, "help") || !command.run) {
      await io.stdout.write(renderHelp(command, path));
      return EXIT.OK;
    }

    ctx = { io, values, positionals, command, path, lastHeaders: {}, lastStatus: 0 };
    return (await command.run(ctx)) ?? EXIT.OK;
  } catch (error) {
    const described = describeError(error, {
      notFound: command?.notFound,
      sizeFlag: command?.sizeFlag,
      correlationId: ctx?.lastHeaders["x-correlation-id"],
    });
    const hint = error instanceof UsageError && command ? `\nRun \`${path} --help\` for usage.` : "";
    await io.stderr.write(`error: ${described.message}${hint}\n`);
    return described.exitCode;
  }
}
