/**
 * Shell completion, answered by the CLI itself.
 *
 * The scripts `jobo completion <shell>` prints are static: on every TAB they
 * run `jobo __complete -- <words so far>` and offer what it prints, one
 * candidate per line. Everything a candidate can be comes from the command
 * registry and its option specs, so the scripts never go stale.
 *
 * A completion must never get in the way: it prints nothing rather than an
 * error, and its lookups use free endpoints only, once, with a short timeout.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FilterOptionsFacet } from "@jobo-ai/connector-core";

import { optionNames, optionsFor, type CommandDef, type OptionSpec, type ValueSpec } from "./args";
import { cacheDir, resolveApiUrl } from "./config";
import { feedLocation, placeName } from "./filters";
import type { Io } from "./io";
import { quickClient } from "./session";

/** The hidden command the completion scripts call. */
export const COMPLETE_COMMAND = "__complete";
/** Printed alone when the word is a file name, which the shell completes better than we can. */
export const FILES = "__files__";

/**
 * How long one lookup may take before TAB gives up. A request from another
 * continent spends about a second on the connection alone, and the lookups
 * themselves were measured at 0.4 to 3 seconds against the live API, so a
 * shorter limit made completion come and go.
 */
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60_000;
/** The most values a facet request returns; a list this long may have been cut off. */
const LIST_LIMIT = 250;
const PREFIX_LIMIT = 20;
const SUGGEST_LIMIT = 10;
/** The suggest endpoints answer nothing to a shorter query. */
const MIN_SUGGEST_LENGTH = 2;

// ── Looked-up values ─────────────────────────────────────────────────────────

interface CachedList {
  api_url: string;
  fetched_at: string;
  values: string[];
}

function readCache(file: string): CachedList | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CachedList>;
    if (typeof parsed.api_url !== "string" || typeof parsed.fetched_at !== "string" || !Array.isArray(parsed.values)) return null;
    return { api_url: parsed.api_url, fetched_at: parsed.fetched_at, values: parsed.values.filter((value) => typeof value === "string") };
  } catch {
    return null;
  }
}

function writeCache(file: string, dir: string, content: CachedList): void {
  try {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(content));
    renameSync(temp, file);
  } catch {
    // The cache only saves a request; without it the next TAB asks again.
  }
}

const startsWith = (value: string, typed: string): boolean => value.toLowerCase().startsWith(typed.toLowerCase());

/** A facet small enough to hold whole: one request, then about ten minutes from disk. */
async function facetList(io: Io, facet: FilterOptionsFacet, typed: string): Promise<string[]> {
  const client = quickClient(io, { timeoutMs: TIMEOUT_MS });
  if (!client) return [];
  const apiUrl = resolveApiUrl(io);
  const dir = cacheDir(io);
  const file = join(dir, `complete-${facet}.json`);

  const cached = readCache(file);
  const age = cached ? io.now().getTime() - Date.parse(cached.fetched_at) : Number.NaN;
  let values = cached && cached.api_url === apiUrl && age >= 0 && age < CACHE_TTL_MS ? cached.values : null;
  if (!values) {
    const { data } = await client.filterOptions(facet, { limit: LIST_LIMIT });
    values = (data.options ?? []).map((option) => option.key).filter((key) => typeof key === "string" && key !== "");
    // No facet is empty: an empty answer is a fault, and not worth remembering for ten minutes.
    if (values.length > 0) writeCache(file, dir, { api_url: apiUrl, fetched_at: io.now().toISOString(), values });
  }

  // A full page may be the head of a longer list: ask for what it does not hold.
  if (typed !== "" && values.length >= LIST_LIMIT && !values.some((value) => startsWith(value, typed))) {
    return facetPrefix(io, facet, typed);
  }
  return values;
}

async function facetPrefix(io: Io, facet: FilterOptionsFacet, typed: string): Promise<string[]> {
  const client = quickClient(io, { timeoutMs: TIMEOUT_MS });
  if (!client) return [];
  const { data } = await client.filterOptions(facet, { ...(typed !== "" ? { q: typed } : {}), limit: PREFIX_LIMIT });
  return (data.options ?? []).map((option) => option.key);
}

async function companyDomains(io: Io, typed: string): Promise<string[]> {
  if (typed.length < MIN_SUGGEST_LENGTH) return [];
  const client = quickClient(io, { timeoutMs: TIMEOUT_MS });
  if (!client) return [];
  const { data } = await client.suggestCompanies(typed, SUGGEST_LIMIT);
  return (data.suggestions ?? []).map((company) => company.domain ?? "");
}

async function places(io: Io, typed: string, format: "text" | "feed"): Promise<string[]> {
  // In `country=Germany,city=Ber` the place being typed is what follows the last "=".
  const query = (format === "feed" ? typed.slice(typed.lastIndexOf("=") + 1) : typed).trim();
  if (query.length < MIN_SUGGEST_LENGTH) return [];
  const client = quickClient(io, { timeoutMs: TIMEOUT_MS });
  if (!client) return [];
  const { data } = await client.suggestLocations(query, SUGGEST_LIMIT);
  return (data.suggestions ?? []).map((place) => (format === "feed" ? (feedLocation(place) ?? "") : placeName(place)));
}

// ── Candidates ───────────────────────────────────────────────────────────────

interface Reply {
  values: string[];
  files?: boolean;
}

const NOTHING: Reply = { values: [] };

const matching = (values: readonly string[], typed: string): Reply => ({
  values: values.filter((value) => startsWith(value, typed)),
});

/**
 * Candidates for one value. `lead` is the part of the word that is not the
 * value (`--sort=`); every candidate is the whole word, as shells replace it.
 */
async function valueReply(io: Io, spec: ValueSpec & Pick<OptionSpec, "split">, typed: string, lead: string): Promise<Reply> {
  if (!spec.choices && spec.complete?.kind === "file") return { values: [], files: true };

  // In a comma-separated value only the last item is being typed; the rest is kept as it is.
  const cut = spec.split ? typed.lastIndexOf(",") + 1 : 0;
  const kept = typed.slice(0, cut);
  const item = typed.slice(cut);
  const taken = new Set(kept.split(",").map((entry) => entry.trim().toLowerCase()));

  let values: readonly string[] = [];
  // The API already matched a looked-up value (a company by name, completed to
  // its domain), so its text need not start with what was typed. Those that do
  // are still preferred: a shell extends the word in place only for them.
  let matched = false;
  const source = spec.complete;
  if (spec.choices) values = spec.choices;
  else if (source?.kind === "values") values = source.values;
  else if (source?.kind === "facet" && source.mode === "list") values = await facetList(io, source.facet as FilterOptionsFacet, item);
  else if (source?.kind === "facet") {
    values = await facetPrefix(io, source.facet as FilterOptionsFacet, item);
    matched = true;
  } else if (source?.kind === "companies") {
    values = await companyDomains(io, item);
    matched = true;
  } else if (source?.kind === "locations") {
    values = await places(io, item, source.format);
    matched = true;
  }

  const extending = values.filter((value) => startsWith(value, item));
  const offered = (matched && extending.length === 0 ? values : extending).filter(
    (value) => value !== "" && !taken.has(value.toLowerCase()),
  );
  return { values: offered.map((value) => `${lead}${kept}${value}`) };
}

async function reply(words: readonly string[], io: Io, commands: readonly CommandDef[]): Promise<Reply> {
  // A word still inside quotes arrives with its opening quote.
  const current = (words[words.length - 1] ?? "").replace(/^["']/, "");
  const before = words.slice(0, -1);
  const commandNames = commands.map((entry) => entry.name);

  const first = before[0];
  if (first === undefined) {
    return matching(current.startsWith("-") ? ["--help", "--version"] : [...commandNames, "help"], current);
  }
  if (first === "help") return before.length === 1 ? matching(commandNames, current) : NOTHING;

  let command = commands.find((entry) => entry.name === first);
  if (!command) return NOTHING;
  let rest = before.slice(1);
  if (command.subcommands) {
    const sub = command.subcommands.find((entry) => entry.name === rest[0]);
    if (sub) {
      command = sub;
      rest = rest.slice(1);
    } else if (rest.length === 0 && !current.startsWith("-")) {
      return matching(command.subcommands.map((entry) => entry.name), current);
    }
  }

  const specs = optionsFor(command);
  const names = optionNames(specs);
  const shorts = new Map(Object.entries(specs).flatMap(([name, spec]) => (spec.short ? [[spec.short, name] as const] : [])));

  // Walk the finished words: which flags are spent, how many arguments were given, and whether the last flag still waits for its value.
  const used = new Set<string>();
  let pending: string | undefined;
  let positionals = 0;
  let literal = false;
  for (const word of rest) {
    if (pending !== undefined) pending = undefined;
    else if (literal) positionals++;
    else if (word === "--") literal = true;
    else if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = names.get(word.slice(2, equals === -1 ? undefined : equals));
      if (name === undefined) continue;
      used.add(name);
      if (specs[name]?.type === "string" && equals === -1) pending = name;
    } else if (word.startsWith("-") && word.length > 1) {
      const name = shorts.get(word.charAt(1));
      if (name === undefined) continue;
      used.add(name);
      // `-o FILE` takes the next word; `-oFILE` carries its value.
      if (specs[name]?.type === "string" && word.length === 2) pending = name;
    } else positionals++;
  }

  if (pending !== undefined) return valueReply(io, specs[pending] as OptionSpec, current, "");
  if (!literal && current.startsWith("--") && current.includes("=")) {
    const equals = current.indexOf("=");
    const spec = specs[names.get(current.slice(2, equals)) ?? ""];
    return spec?.type === "string" ? valueReply(io, spec, current.slice(equals + 1), current.slice(0, equals + 1)) : NOTHING;
  }
  if (!literal && current.startsWith("-")) {
    const flags = Object.entries(specs)
      .filter(([name, spec]) => spec.multiple || !used.has(name))
      .map(([name]) => `--${name}`);
    return matching(flags, current);
  }
  const argument = command.args?.[positionals];
  return argument ? valueReply(io, argument, current, "") : NOTHING;
}

/**
 * bash splits a word at "=" and ":" before it asks: `--sort=rel` arrives as
 * `--sort`, `=`, `rel`, and whatever is offered replaces only the last piece.
 * Put such words back together, and report the part bash already holds so it
 * can be taken off each candidate. Other shells pass whole words, which this
 * leaves alone.
 */
export function rejoin(words: readonly string[]): { words: string[]; held: string } {
  const breaker = (word: string) => word === "=" || word === ":";
  const out: string[] = [];
  let glue = false;
  let pieces = 0;
  words.forEach((word, index) => {
    // An empty last word after "=" is a new word: with the cursor right after the "=", bash sends the "=" itself last.
    const fresh = out.length === 0 || (!breaker(word) && !glue) || (glue && word === "" && index === words.length - 1);
    if (fresh) {
      out.push(word);
      pieces = 1;
    } else {
      out[out.length - 1] += word;
      pieces++;
    }
    glue = breaker(word);
  });
  const last = words[words.length - 1] ?? "";
  const whole = out[out.length - 1] ?? "";
  const held = pieces < 2 ? "" : breaker(last) ? whole : whole.slice(0, whole.length - last.length);
  return { words: out, held };
}

/** The candidates for the last of `words` (the words typed after `jobo`), or `[FILES]`. */
export async function complete(typed: readonly string[], io: Io, commands: readonly CommandDef[]): Promise<string[]> {
  const { words, held } = rejoin(typed.length > 0 ? typed : [""]);
  const answer = await reply(words, io, commands);
  if (answer.files) return [FILES];
  const lines = answer.values
    .filter((value) => value.startsWith(held))
    .map((value) => value.slice(held.length))
    // One candidate per line: a value that would break the protocol is not offered.
    .filter((value) => value !== "" && !/[\r\n\t]/.test(value));
  return [...new Set(lines)];
}

/** `jobo __complete -- <words…>`: print the candidates, and never anything else. */
export async function runComplete(argv: readonly string[], io: Io, commands: readonly CommandDef[]): Promise<void> {
  try {
    const separator = argv.indexOf("--");
    const lines = await complete(separator === -1 ? argv : argv.slice(separator + 1), io, commands);
    if (lines.length > 0) await io.stdout.write(lines.map((line) => `${line}\n`).join(""));
  } catch {
    // No key, no network, a slow API, a broken cache: the shell gets no candidates and no noise.
  }
}
