import { parseArgs } from "node:util";

import { UsageError } from "./errors";
import type { Io } from "./io";

/**
 * One command-line option. The same record feeds `parseArgs` and the help
 * text, so a flag cannot be documented without existing or exist without
 * being documented.
 */
export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  /** May be given more than once. */
  multiple?: boolean;
  /** Placeholder shown in help for a string option, e.g. `N` or `FILE`. */
  value?: string;
  description: string;
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
    value: "LIST",
    description:
      "Comma-separated fields to keep, as dot paths (id,title,company.name). Sets the columns of a table or CSV; JSON records are reduced to those keys.",
    group: "Output",
  },
  output: {
    type: "string",
    short: "o",
    value: "FILE",
    description:
      "Write the data to FILE instead of stdout. Without a format flag the extension decides (.json, .jsonl, .ndjson, .csv).",
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

export function parseCommandArgs(
  argv: string[],
  specs: OptionSpecs,
): { values: ParsedValues; positionals: string[] } {
  const options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    options[name] = {
      type: spec.type,
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
    };
  }
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: parsed.values as ParsedValues, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
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
      const description = wrap(spec.description, HELP_WIDTH, indent).trimStart();
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
