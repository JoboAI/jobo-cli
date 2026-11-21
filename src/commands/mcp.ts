import { flag, wrap, type CommandDef, type Ctx } from "../args";
import data from "../data/mcp-clients.json";
import { UsageError } from "../errors";
import { toJson, toTable } from "../output";

/**
 * `jobo mcp` is a renderer over `src/data/mcp-clients.json` and nothing else:
 * every client, command, path and note it prints comes from that file. Adding
 * a client is a data change.
 */
export interface McpClient {
  slug: string;
  name: string;
  vendor?: string;
  productUrl?: string;
  category: "coding-agent" | "ide" | "llm" | "ai-builder";
  /** The client's own MCP documentation. */
  docsUrl: string;
  /** `http`: the client speaks Streamable HTTP itself. `stdio-bridge`: it needs `npx mcp-remote`. */
  transport: "http" | "stdio-bridge";
  oauth: "native" | "bridge" | "unsupported";
  install: {
    kind: "command" | "config-file" | "ui";
    command: string | null;
    path: string | null;
    projectPath: string | null;
    language: "json" | "toml" | "yaml" | "bash";
    snippet: string | null;
    uiSteps: string[];
  };
  /** How the OAuth sign-in happens in this client. */
  signIn?: string;
  /** How to confirm the server is connected. */
  verify?: string;
  notes: string[];
  verified: string;
  sources: string[];
}

export interface McpClientsFile {
  serverUrl: string;
  serverName: string;
  clients: McpClient[];
}

export const MCP_CLIENTS = data as unknown as McpClientsFile;

const CATEGORIES: Record<string, string> = {
  "coding-agent": "Coding agents",
  ide: "IDEs",
  llm: "AI assistants",
  "ai-builder": "AI app builders",
};
const TRANSPORTS: Record<string, string> = {
  http: "Streamable HTTP, spoken by the client itself",
  "stdio-bridge": "stdio, bridged to the remote server with `npx mcp-remote`",
};
const SIGN_IN: Record<string, string> = {
  native: "OAuth in the client: sign in with your Jobo account, no API key",
  bridge: "OAuth through the mcp-remote bridge, which opens the Jobo sign-in in your browser; no API key",
  unsupported: "this client cannot complete the OAuth sign-in the server requires",
};
const HOW: Record<string, string> = { command: "command", "config-file": "config file", ui: "settings UI" };

/** Problems that would make an entry render wrongly. Empty when the file is sound. */
export function validateMcpClients(file: unknown): string[] {
  const problems: string[] = [];
  const root = (file ?? {}) as Partial<McpClientsFile>;
  if (typeof root.serverUrl !== "string" || !/^https:\/\//.test(root.serverUrl)) problems.push("serverUrl must be an https URL");
  if (typeof root.serverName !== "string" || root.serverName === "") problems.push("serverName is required");
  if (!Array.isArray(root.clients) || root.clients.length === 0) return [...problems, "clients must be a non-empty array"];

  const seen = new Set<string>();
  for (const client of root.clients) {
    const at = `clients[${client?.slug ?? "?"}]`;
    if (typeof client?.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(client.slug)) problems.push(`${at}: slug must be lower-case kebab`);
    else if (seen.has(client.slug)) problems.push(`${at}: duplicate slug`);
    else seen.add(client.slug);
    if (typeof client?.name !== "string" || client.name === "") problems.push(`${at}: name is required`);
    if (!(client?.category in CATEGORIES)) problems.push(`${at}: unknown category "${client?.category}"`);
    if (!(client?.transport in TRANSPORTS)) problems.push(`${at}: unknown transport "${client?.transport}"`);
    if (!(client?.oauth in SIGN_IN)) problems.push(`${at}: unknown oauth "${client?.oauth}"`);
    if (typeof client?.docsUrl !== "string" || !/^https:\/\//.test(client.docsUrl)) problems.push(`${at}: docsUrl must be an https URL`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(client?.verified ?? "")) problems.push(`${at}: verified must be YYYY-MM-DD`);
    if (!Array.isArray(client?.notes)) problems.push(`${at}: notes must be an array`);
    if (!Array.isArray(client?.sources) || client.sources.length === 0) problems.push(`${at}: sources must list at least one URL`);

    const install = client?.install;
    if (!install || !(install.kind in HOW)) {
      problems.push(`${at}: unknown install.kind "${install?.kind}"`);
      continue;
    }
    if (install.kind === "command" && !install.command && !install.snippet) {
      problems.push(`${at}: kind "command" needs install.command or install.snippet`);
    }
    if (install.kind === "config-file" && (!(install.path || install.projectPath) || !install.snippet)) {
      problems.push(`${at}: kind "config-file" needs install.snippet and a path or projectPath`);
    }
    if (install.kind === "ui" && !(Array.isArray(install.uiSteps) && install.uiSteps.length > 0)) {
      problems.push(`${at}: kind "ui" needs install.uiSteps`);
    }
  }
  return problems;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

const WIDTH = 100;

function paragraph(heading: string, text: string): string[] {
  return ["", `${heading}:`, wrap(text, WIDTH, "  ")];
}

/** "~/.x/mcp.json (or .x/mcp.json for one project)", from whichever paths the entry has. */
function configFiles(install: McpClient["install"]): string | null {
  if (install.path && install.projectPath) return `${install.path} (or ${install.projectPath} for one project)`;
  if (install.path) return install.path;
  if (install.projectPath) return `${install.projectPath} in your project`;
  return null;
}

export function renderClient(file: McpClientsFile, client: McpClient): string {
  const install = client.install;
  const files = configFiles(install);
  const out: string[] = [];
  out.push(`${client.name}: connect the Jobo job search MCP server`, "");
  out.push(`Server:     ${file.serverName} at ${file.serverUrl}`);
  out.push(`Transport:  ${TRANSPORTS[client.transport] ?? client.transport}`);
  out.push(`Auth:       ${SIGN_IN[client.oauth] ?? client.oauth}`, "");

  // The contract only requires a snippet; for a command it is then the command.
  const command = install.command ?? install.snippet;
  if (install.kind === "command" && command) {
    out.push("Run:", "", indent(command));
    if (install.snippet && install.snippet !== command) {
      out.push("", files ? `Or add this to ${files}:` : "Or use:", "", indent(install.snippet));
    } else if (files) {
      out.push("", `Config file: ${files}`);
    }
  } else if (install.kind === "config-file") {
    out.push(`Add this to ${files ?? "the client's MCP config file"}:`, "", indent(install.snippet ?? ""));
  } else {
    out.push("In the client:", "");
    (install.uiSteps ?? []).forEach((step, index) => {
      out.push(wrap(`${index + 1}. ${step}`, WIDTH, "  ").replace(/\n {2}/g, "\n     "));
    });
    if (install.snippet) out.push("", indent(install.snippet));
    if (files) out.push("", `Config file: ${files}`);
  }

  if (client.signIn) out.push(...paragraph("Sign in", client.signIn));
  if (client.verify) out.push(...paragraph("Check it worked", client.verify));
  if (client.notes?.length) {
    out.push("", "Notes:");
    for (const entry of client.notes) out.push(wrap(`- ${entry}`, WIDTH, "  ").replace(/\n {2}/g, "\n    "));
  }
  out.push("", `Client docs: ${client.docsUrl}`, `Checked:     ${client.verified}`);
  out.push("", "This command only prints instructions; it changes no files.");
  return `${out.join("\n")}\n`;
}

export function renderClientList(file: McpClientsFile): string {
  const out: string[] = [];
  out.push(`The hosted Jobo job search MCP server: ${file.serverUrl}`);
  out.push("Sign-in is OAuth with your Jobo account; no API key is involved.", "");
  const categories = [...new Set([...Object.keys(CATEGORIES), ...file.clients.map((client) => client.category)])];
  for (const category of categories) {
    const clients = file.clients.filter((client) => client.category === category);
    if (clients.length === 0) continue;
    out.push(`${CATEGORIES[category] ?? category}:`);
    const table = toTable(
      clients.map((client) => ({ slug: client.slug, name: client.name, how: HOW[client.install.kind] ?? client.install.kind })),
      [{ key: "slug" }, { key: "name" }, { key: "how", header: "set up by" }],
    );
    // Drop the header row: the category line is the heading.
    out.push(indent(table.trimEnd().split("\n").slice(1).join("\n")), "");
  }
  out.push("Show the steps for one client: jobo mcp <client>");
  return `${out.join("\n")}\n`;
}

function findClient(file: McpClientsFile, query: string): McpClient | undefined {
  const wanted = query.toLowerCase();
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    file.clients.find((client) => client.slug === wanted) ??
    file.clients.find((client) => squash(client.slug) === squash(wanted) || squash(client.name) === squash(wanted))
  );
}

async function run(ctx: Ctx): Promise<number> {
  const file = MCP_CLIENTS;
  const json = flag(ctx.values, "json");
  const query = ctx.positionals.join(" ").trim();

  if (query === "") {
    await ctx.io.stdout.write(json ? toJson(file) : renderClientList(file));
    return 0;
  }
  const client = findClient(file, query);
  if (!client) {
    throw new UsageError(
      `No MCP client called "${query}". Known clients: ${file.clients.map((entry) => entry.slug).join(", ")}. ` +
        `Any other client that supports Streamable HTTP takes the same URL: ${file.serverUrl}`,
    );
  }
  await ctx.io.stdout.write(
    json ? toJson({ serverUrl: file.serverUrl, serverName: file.serverName, client }) : renderClient(file, client),
  );
  return 0;
}

export const mcpCommand: CommandDef = {
  name: "mcp",
  summary: "Show how to connect the hosted Jobo MCP server to an AI client",
  usage: ["", "<client>"],
  description:
    `Prints the steps to add the hosted Jobo job search MCP server (${MCP_CLIENTS.serverUrl}) to an AI client: the command to run, the config to paste or the settings to click through. ` +
    "With no argument it lists the clients it knows. The server signs you in with your Jobo account through OAuth, so no API key is needed, and its searches bill like `jobo search`: per job returned.\n\n" +
    "Print-only: this command never writes to another tool's configuration.",
  options: {
    json: { type: "boolean", description: "Print the client entry (or the whole list) as JSON." },
  },
  examples: ["jobo mcp", ...MCP_CLIENTS.clients.slice(0, 2).map((client) => `jobo mcp ${client.slug}`)],
  run,
};
