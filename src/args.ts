import { parseArgs } from "node:util";

import { UsageError } from "./errors";
import type { Io } from "./io";
import { canonical, didYouMean, nearest } from "./suggest";

/** Where shell completion finds values that have no closed set. */
export type Completer =
  /** Leave the word to the shell's own file completion. */
  | { kind: "file" }
  /** Well-known values of an open set: offered, not enforced. */
  | { kind: "values"; values: readonly string[] }
  /** A filter facet: the whole list (cached on disk), or a prefix query per keystroke. */
  | { kind: "facet"; facet: string; mode: "list" | "prefix" }
  /** Companies by name or domain prefix, completed to their domain. */
  | { kind: "companies" }
  /** Places by prefix: free text for search, `country=…,city=…` for the feed. */
  | { kind: "locations"; format: "text" | "feed" };

/** What a value may be. Shared by options and positional arguments. */
export interface ValueSpec {
  /**
   * The closed set of values. Help lists them, parsing rejects anything else
   * (after matching case and separators) and completion offers them.
   */
  choices?: readonly string[];
  /** How completion finds values when there is no closed set. */
  complete?: Completer;
}

/**
 * One command-line option. The same record feeds the parser, the help text
 * and shell completion, so a flag cannot be documented without existing,
 * exist without being documented, or complete to a value the parser rejects.
 */
export interface OptionSpec extends ValueSpec {
  type: "string" | "boolean";
  short?: string;
  /** May be given more than once. */
  multiple?: boolean;
  /** One value may hold several items separated by commas. */
  split?: boolean;
  /**
   * Other spellings the parser accepts for this flag. Help and completion show
   * the one name; a description mentions an alias worth knowing.
   */
  aliases?: readonly string[];
  /** Placeholder shown in help for a string option, e.g. `N` or `FILE`. */
  value?: string;
  description: string;
  /** How to write the value. Shown last in help, after the choices. */
  hint?: string;
  /** Help section. Defaults to "Options". */
  group?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;
export type ParsedValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface CommandDef {
  name: string;
  summary: string;
  /** Usage lines, without the leading program path. */
  usage: string[];
  description?: string;
  options?: OptionSpecs;
  /** What each positional argument may be, by position. Used by completion. */
  args?: readonly ValueSpec[];
  /** Adds the shared output flags (--json, --jsonl, --csv, --table, --output, …). */
  output?: boolean;
  examples?: string[];
  /** Message for a plain 404 from this command. */
  notFound?: string;
  /** The flag that lowers this command's wallet precheck, named in the 402 message. */
  sizeFlag?: string;
  subcommands?: CommandDef[];
  run?: (ctx: Ctx) => Promise<number | void>;
}

export interface Ctx {
  io: Io;
  values: ParsedValues;
  positionals: string[];
  command: CommandDef;
  /** Full invocation path, e.g. "jobo skill install". */
  path: string;
  /** Lower-cased headers of the last API response, kept for the error line's correlation id. */
  lastHeaders: Record<string, string>;
  /** Status of the last API response; 0 when the last request got none. */
  lastStatus: number;
}

export const GLOBAL_OPTIONS: OptionSpecs = {
  "api-key": {
    type: "string",
    value: "KEY",
    description: "API key for this command. Beats JOBO_API_KEY and the saved key.",
    group: "Global",
  },
  "api-url": {
    type: "string",
    value: "URL",
    description: "API base URL (default https://connect.jobo.world, or JOBO_API_URL). For proxies and tests.",
    group: "Global",
  },
  quiet: {
    type: "boolean",
    description: "No usage lines, progress or notes on stderr. Errors are still printed.",
    group: "Global",
  },
  help: { type: "boolean", short: "h", description: "Show help for this command.", group: "Global" },
  version: { type: "boolean", short: "V", description: "Print the version.", group: "Global" },
};

export const OUTPUT_OPTIONS: OptionSpecs = {
  json: { type: "boolean", description: "JSON (the default when stdout is not a terminal).", group: "Output" },
  jsonl: { type: "boolean", description: "One JSON record per line.", group: "Output" },
  csv: { type: "boolean", description: "CSV with a header row.", group: "Output" },
  table: { type: "boolean", description: "Human-readable table (the default in a terminal).", group: "Output" },
  fields: {
    type: "string",
    split: true,
    value: "LIST",
    description:
      "Comma-separated fields to keep, as dot paths (id,title,company.name). Sets the columns of a table or CSV. JSON records are reduced to those keys, with every value as the API returned it.",
    group: "Output",
  },
  output: {
    type: "string",
    short: "o",
    value: "FILE",
    description:
      "Write the data to FILE instead of stdout. Without a format flag the extension decides (.json, .jsonl, .ndjson, .csv). A run that fails before it has anything to write leaves no file behind.",
    complete: { kind: "file" },
    group: "Output",
  },
  overwrite: { type: "boolean", description: "Replace FILE if it exists (refused otherwise).", group: "Output" },
  append: {
    type: "boolean",
    description: "Append to FILE if it exists (JSONL and CSV only; the CSV header is not repeated).",
    group: "Output",
  },
};

export function optionsFor(command: CommandDef): OptionSpecs {
  return { ...(command.options ?? {}), ...(command.output ? OUTPUT_OPTIONS : {}), ...GLOBAL_OPTIONS };
}

/** Every spelling a command accepts, mapped to the option it means. A real name always beats an alias. */
export function optionNames(specs: OptionSpecs): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of Object.keys(specs)) names.set(name, name);
  for (const [name, spec] of Object.entries(specs)) {
    for (const alias of spec.aliases ?? []) if (!names.has(alias)) names.set(alias, name);
  }
  return names;
}

/**
 * One value of a closed set, in its canonical spelling. Case and separators
 * are forgiven (`Remote`, `Full Time`); anything else is an error that names
 * the nearest valid value. `label` says where the value came from.
 */
export function choice(raw: string, choices: readonly string[], label: string): string {
  const match = canonical(raw, choices);
  if (match !== undefined) return match;
  // The API matches these literally: an unknown value is not a 400, it is zero results.
  throw new UsageError(`${label}: unknown value "${raw}".${didYouMean(raw, choices)} Valid values: ${choices.join(", ")}.`);
}

type OptionToken = { kind: "option"; name: string; rawName: string; index: number; value?: string; inlineValue?: boolean };

function unknownFlag(token: OptionToken, argv: readonly string[], names: Map<string, string>): string {
  // `-json` arrives as the short group -j -s -o -n: report the word as it was typed.
  const typed = token.rawName.startsWith("--") ? token.rawName : (argv[token.index] ?? token.rawName);
  const guess = nearest(typed.replace(/^-+/, ""), [...names.keys()]);
  if (guess !== undefined) return `Unknown flag ${typed}. Did you mean --${names.get(guess) ?? guess}?`;
  return `Unknown flag ${typed}.${typed.startsWith("--") ? "" : ' To pass a value that starts with "-", put it after "--".'}`;
}

/**
 * Parse one command's arguments. Node's `parseArgs` splits the words; what
 * they mean is decided here, so every message is ours: an unknown flag names
 * the nearest real one, an alias lands on its option, and a value of a closed
 * set comes back in its canonical spelling.
 */
export function parseCommandArgs(
  argv: string[],
  specs: OptionSpecs,
): { values: ParsedValues; positionals: string[] } {
  const names = optionNames(specs);
  const options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  for (const [spelling, name] of names) {
    const spec = specs[name] as OptionSpec;
    options[spelling] = {
      type: spec.type,
      ...(spec.short && spelling === name ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
    };
  }

  let tokens: ReadonlyArray<{ kind: string }>;
  try {
    // Not strict: an unknown flag becomes a token to explain, not Node's own error text.
    tokens = parseArgs({ args: argv, options, allowPositionals: true, strict: false, tokens: true }).tokens ?? [];
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const values: ParsedValues = {};
  const positionals: string[] = [];
  for (const entry of tokens) {
    if (entry.kind === "positional") positionals.push((entry as { kind: "positional"; value: string }).value);
    if (entry.kind !== "option") continue;
    const token = entry as OptionToken;
    const name = names.get(token.name);
    if (name === undefined) throw new UsageError(unknownFlag(token, argv, names));
    const spec = specs[name] as OptionSpec;
    const flagLabel = token.rawName;

    if (spec.type === "boolean") {
      if (token.value !== undefined) throw new UsageError(`${flagLabel} takes no value (got "${token.value}").`);
      values[name] = true;
      continue;
    }
    if (token.value === undefined) {
      throw new UsageError(`${flagLabel} needs a value: ${flagLabel} <${spec.value ?? "value"}>.`);
    }
    if (!token.inlineValue && token.value.length > 1 && token.value.startsWith("-")) {
      throw new UsageError(
        `${flagLabel} needs a value, and "${token.value}" looks like another flag. If it is the value, write ${flagLabel}=${token.value}.`,
      );
    }
    if (spec.multiple) values[name] = [...((values[name] as string[] | undefined) ?? []), token.value];
    else values[name] = token.value;
  }

  for (const [name, spec] of Object.entries(specs)) {
    const value = values[name];
    if (!spec.choices || value === undefined || typeof value === "boolean") continue;
    const choices = spec.choices;
    const check = (text: string): string =>
      (spec.split ? text.split(",") : [text])
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => choice(item, choices, `--${name}`))
        .join(",");
    values[name] = Array.isArray(value) ? value.map((item) => check(String(item))) : check(value);
  }

  return { values, positionals };
}

// ── Typed readers ────────────────────────────────────────────────────────────

export function str(values: ParsedValues, name: string): string | undefined {
  const value = values[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function flag(values: ParsedValues, name: string): boolean {
  return values[name] === true;
}

export function list(values: ParsedValues, name: string): string[] | undefined {
  const value = values[name];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return [value];
  return undefined;
}

export function int(
  values: ParsedValues,
  name: string,
  bounds: { min: number; max?: number },
): number | undefined {
  const raw = str(values, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} takes a whole number, got "${raw}".`);
  const value = Number(raw);
  if (value < bounds.min || (bounds.max !== undefined && value > bounds.max)) {
    const range = bounds.max !== undefined ? `${bounds.min}–${bounds.max}` : `${bounds.min} or more`;
    throw new UsageError(`--${name} must be ${range}, got ${raw}.`);
  }
  return value;
}

// ── Help ─────────────────────────────────────────────────────────────────────

export function wrap(text: string, width: number, indent = ""): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line !== "" && indent.length + line.length + 1 + word.length > width) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }
    lines.push(line === "" ? "" : indent + line);
  }
  return lines.join("\n");
}

const HELP_WIDTH = 100;
const GROUP_ORDER = ["Options", "Filters", "Paging", "Output", "Global"];

function optionLabel(name: string, spec: OptionSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    ";
  const value = spec.type === "string" ? ` <${spec.value ?? "value"}>` : "";
  return `${short}--${name}${value}`;
}

/** An option's help: what it does, the values it takes when they are a closed set, then how to write them. */
export function optionHelp(spec: OptionSpec): string {
  const parts = [spec.description];
  // A placeholder such as <true|false> already says it all.
  if (spec.choices && spec.value !== spec.choices.join("|")) {
    parts.push(`${spec.multiple || spec.split ? "Any of" : "One of"}: ${spec.choices.join(", ")}.`);
  }
  if (spec.hint) parts.push(spec.hint);
  return parts.join(" ");
}

export function renderHelp(command: CommandDef, path: string): string {
  const out: string[] = [];
  out.push(`${path} — ${command.summary}`, "");
  out.push("Usage:");
  for (const usage of command.usage) out.push(`  ${path}${usage ? ` ${usage}` : ""}`);
  if (command.description) out.push("", wrap(command.description, HELP_WIDTH));

  if (command.subcommands?.length) {
    out.push("", "Commands:");
    const width = Math.max(...command.subcommands.map((sub) => sub.name.length));
    for (const sub of command.subcommands) out.push(`  ${sub.name.padEnd(width)}  ${sub.summary}`);
  }

  const specs = optionsFor(command);
  const groups = new Map<string, Array<[string, OptionSpec]>>();
  for (const entry of Object.entries(specs)) {
    const group = entry[1].group ?? "Options";
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 1 : ia) - (ib === -1 ? 1 : ib);
  });
  for (const group of ordered) {
    out.push("", `${group}:`);
    for (const [name, spec] of groups.get(group) ?? []) {
      const label = optionLabel(name, spec);
      const indent = " ".repeat(34);
      const description = wrap(optionHelp(spec), HELP_WIDTH, indent).trimStart();
      if (label.length + 2 <= 32) out.push(`  ${label.padEnd(32)}${description}`);
      else out.push(`  ${label}`, `${indent}${description}`);
    }
  }

  if (command.examples?.length) {
    out.push("", "Examples:");
    for (const example of command.examples) out.push(`  ${example}`);
  }
  return `${out.join("\n")}\n`;
}
