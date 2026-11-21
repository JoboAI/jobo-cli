import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import { extname, resolve } from "node:path";

import { flag, str, type Ctx, type ParsedValues } from "./args";
import { UsageError } from "./errors";
import type { Io } from "./io";

export type Format = "table" | "json" | "jsonl" | "csv";

const FORMAT_FLAGS: readonly Format[] = ["json", "jsonl", "csv", "table"];
const EXTENSIONS: Record<string, Format> = { ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl", ".csv": "csv" };

/** A column of a table or CSV. `get` overrides the dot-path lookup of `key`. */
export interface Column {
  key: string;
  header?: string;
  get?: (row: unknown) => unknown;
  /** Widest a table cell may get before it is cut with an ellipsis. */
  max?: number;
}

/**
 * Explicit flag, else the output file's extension, else a table for a terminal
 * and JSON for a pipe. `defaults` lets a command (the feed) pick another
 * fallback.
 */
export function resolveFormat(
  values: ParsedValues,
  io: Pick<Io, "stdout">,
  defaults: { tty?: Format; piped?: Format } = {},
): Format {
  const chosen = FORMAT_FLAGS.filter((name) => flag(values, name));
  if (chosen.length > 1) {
    throw new UsageError(`Pick one output format: ${chosen.map((name) => `--${name}`).join(", ")} were all given.`);
  }
  if (chosen[0]) return chosen[0];
  const file = str(values, "output");
  if (file) return EXTENSIONS[extname(file).toLowerCase()] ?? defaults.piped ?? "json";
  return io.stdout.isTTY ? (defaults.tty ?? "table") : (defaults.piped ?? "json");
}

export function parseFields(values: ParsedValues): string[] | undefined {
  const raw = str(values, "fields");
  if (raw === undefined) return undefined;
  const fields = raw
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length === 0) throw new UsageError("--fields needs at least one field name.");
  return fields;
}

// ── Sinks ────────────────────────────────────────────────────────────────────

export interface Sink {
  write(text: string): Promise<void>;
  close(): void;
  /** The file already held data and is being appended to, so a CSV header must not be repeated. */
  readonly continuing: boolean;
  readonly path: string | null;
  readonly width: number;
}

/**
 * Open the destination before anything is requested: a refused overwrite must
 * fail the command while it is still free.
 */
export function openSink(ctx: Pick<Ctx, "io" | "values">, format: Format): Sink {
  const file = str(ctx.values, "output");
  const overwrite = flag(ctx.values, "overwrite");
  const append = flag(ctx.values, "append");

  if (!file) {
    if (overwrite || append) throw new UsageError("--overwrite and --append only apply with --output FILE.");
    return {
      write: (text) => ctx.io.stdout.write(text),
      close: () => undefined,
      continuing: false,
      path: null,
      width: ctx.io.stdout.isTTY ? (ctx.io.stdout.columns ?? 100) : 160,
    };
  }

  if (overwrite && append) throw new UsageError("Use --overwrite or --append, not both.");
  if (append && format !== "jsonl" && format !== "csv") {
    throw new UsageError("--append only works with --jsonl or --csv: a JSON document or a table cannot be extended.");
  }

  const path = resolve(ctx.io.cwd, file);
  const exists = existsSync(path);
  if (exists && !overwrite && !append) {
    throw new UsageError(`${path} already exists. Pass --overwrite to replace it or --append to add to it.`);
  }
  const continuing = exists && append && statSync(path).size > 0;
  const fd = openSync(path, append ? "a" : "w");
  return {
    // Synchronous on purpose: when write() returns the rows are in the file,
    // which is what lets the feed save its cursor right after.
    write: async (text) => {
      writeSync(fd, text);
    },
    close: () => closeSync(fd),
    continuing,
    path,
    width: 160,
  };
}

// ── Values ───────────────────────────────────────────────────────────────────

export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function columnValue(row: unknown, column: Column): unknown {
  return column.get ? column.get(row) : getPath(row, column.key);
}

/** One-line text for a table or CSV cell. */
export function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.every((entry) => entry == null || typeof entry !== "object")
      ? value.map((entry) => cellText(entry)).join(", ")
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** Reduce a record to the requested fields, keyed by the field path as written. */
export function project(row: unknown, columns: readonly Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column.key] = columnValue(row, column) ?? null;
  return out;
}

/** A column over an already-flat record, whose key may itself contain dots. */
function flatColumn(key: string, max?: number): Column {
  return { key, max, get: (row) => (row as Record<string, unknown> | null)?.[key] };
}

/** `--fields` entries become columns, reusing a known column's getter when the name matches one. */
export function selectColumns(fields: readonly string[] | undefined, known: readonly Column[]): Column[] {
  if (!fields) return [...known];
  return fields.map((field) => known.find((column) => column.key === field) ?? { key: field });
}

// ── Renderers ────────────────────────────────────────────────────────────────

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function csvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly unknown[], columns: readonly Column[], options: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.header !== false) lines.push(columns.map((column) => csvCell(column.header ?? column.key)).join(","));
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(cellText(columnValue(row, column)))).join(","));
  }
  return lines.map((line) => `${line}\r\n`).join("");
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

export function toTable(rows: readonly unknown[], columns: readonly Column[], width = 100): string {
  if (columns.length === 0) return "";
  const cells = rows.map((row) => columns.map((column) => cellText(columnValue(row, column))));
  const headers = columns.map((column) => (column.header ?? column.key).toUpperCase());
  const widths = columns.map((column, index) => {
    const longest = Math.max(headers[index]?.length ?? 0, ...cells.map((line) => line[index]?.length ?? 0));
    return Math.min(longest, column.max ?? 60);
  });

  // Shrink the widest column until the row fits the terminal.
  const gap = 2;
  const total = () => widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
  while (total() > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 8) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
  }

  const line = (values: readonly string[]) =>
    values
      .map((value, index) => truncate(value, widths[index] ?? 0).padEnd(widths[index] ?? 0))
      .join(" ".repeat(gap))
      .trimEnd();

  return [line(headers), ...cells.map(line)].map((text) => `${text}\n`).join("");
}

/** Aligned `Label  value` lines for a single record; empty values are left out. */
export function toKeyValue(pairs: ReadonlyArray<readonly [string, unknown]>): string {
  const shown = pairs
    .map(([label, value]) => [label, cellText(value)] as const)
    .filter(([, text]) => text !== "");
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  return shown.map(([label, text]) => `${label.padEnd(width)}  ${text}\n`).join("");
}

// ── Emitters ─────────────────────────────────────────────────────────────────

export interface RecordsOutput {
  rows: readonly unknown[];
  /** Default table columns, and a lookup for `--fields` names. */
  columns: readonly Column[];
  /** Default CSV columns when they differ from the table's. */
  csvColumns?: readonly Column[];
  /** The JSON document for `--json`, given the (possibly projected) rows. */
  envelope: (rows: readonly unknown[]) => unknown;
  /** Shown instead of an empty table. */
  empty?: string;
}

/** Write a list of records in the chosen format. */
export async function emitRecords(
  ctx: Pick<Ctx, "io" | "values">,
  sink: Sink,
  format: Format,
  output: RecordsOutput,
): Promise<void> {
  const fields = parseFields(ctx.values);
  const csvColumns = output.csvColumns ?? output.columns;
  const known = format === "csv" ? [...csvColumns, ...output.columns] : [...output.columns, ...csvColumns];
  const columns = fields ? selectColumns(fields, known) : format === "csv" ? [...csvColumns] : [...output.columns];
  const rows = fields ? output.rows.map((row) => project(row, columns)) : output.rows;
  // After projection the field path is the record's own (flat) key.
  const plain = fields ? columns.map((column) => flatColumn(column.key, column.max)) : columns;

  if (format === "json") return sink.write(toJson(output.envelope(rows)));
  if (format === "jsonl") return sink.write(toJsonl(rows));
  if (format === "csv") return sink.write(toCsv(rows, plain, { header: !sink.continuing }));
  if (rows.length === 0) return sink.write(`${output.empty ?? "No results."}\n`);
  return sink.write(toTable(rows, plain, sink.width));
}

/** Write one record: a document in JSON, a key/value view in a terminal. */
export async function emitDocument(
  ctx: Pick<Ctx, "io" | "values">,
  sink: Sink,
  format: Format,
  document: unknown,
  view: (document: unknown) => string,
): Promise<void> {
  const fields = parseFields(ctx.values);
  const value = fields ? project(document, fields.map((field) => ({ key: field }))) : document;
  const columns = fields?.map((field) => flatColumn(field));

  if (format === "json") return sink.write(toJson(value));
  if (format === "jsonl") return sink.write(toJsonl([value]));
  if (format === "csv") {
    const csvColumns =
      columns ??
      Object.keys(document && typeof document === "object" ? document : {}).map((key) => flatColumn(key));
    return sink.write(toCsv([value], csvColumns, { header: !sink.continuing }));
  }
  if (columns) return sink.write(toKeyValue(columns.map((column) => [column.key, columnValue(value, column)])));
  return sink.write(view(document));
}
