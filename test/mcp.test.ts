import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MCP_CLIENTS,
  renderClient,
  renderClientList,
  serverOf,
  validateMcpClients,
  type McpClient,
  type McpClientsFile,
} from "../src/commands/mcp";
import { harness } from "./helpers";

function client(overrides: Omit<Partial<McpClient>, "install"> & { install?: Partial<McpClient["install"]> }): McpClient {
  const { install, ...rest } = overrides;
  return {
    slug: "example",
    name: "Example",
    category: "llm",
    docsUrl: "https://example.com/docs/mcp",
    transport: "http",
    oauth: "native",
    notes: [],
    verified: "2026-11-20",
    sources: ["https://example.com/docs/mcp"],
    ...rest,
    install: {
      kind: "command",
      command: "example mcp add jobo",
      path: null,
      projectPath: null,
      language: "bash",
      snippet: null,
      uiSteps: [],
      ...install,
    },
  };
}

describe("src/data/mcp-clients.json", () => {
  it("is well-formed", () => {
    expect(validateMcpClients(MCP_CLIENTS)).toEqual([]);
  });

  it("points at the hosted servers", () => {
    expect(MCP_CLIENTS.serverUrl).toBe("https://jobs-mcp.jobo.world/mcp");
    expect(MCP_CLIENTS.serverName).toBe("jobo-job-search");
    expect(MCP_CLIENTS.servers).toEqual({
      "job-search": { name: "jobo-job-search", url: "https://jobs-mcp.jobo.world/mcp", auth: "oauth" },
      developer: { name: "jobo-developer", url: "https://dev-mcp.jobo.world/mcp", auth: "api-key" },
    });
  });

  it("names its own server's URL in every entry's command or snippet, and never the other server's", () => {
    for (const entry of MCP_CLIENTS.clients) {
      const text = `${entry.install.command ?? ""}\n${entry.install.snippet ?? ""}\n${entry.install.uiSteps.join("\n")}`;
      const own = serverOf(MCP_CLIENTS, entry);
      expect(text, entry.slug).toContain(own.url);
      for (const other of Object.values(MCP_CLIENTS.servers ?? {})) {
        if (other.url !== own.url) expect(text, entry.slug).not.toContain(other.url);
      }
    }
  });

  it("sets coding agents and IDEs up for the developer server, and assistants for job search", () => {
    const serverFor = (slug: string) => MCP_CLIENTS.clients.find((entry) => entry.slug === slug)?.server;
    for (const slug of ["claude-code", "codex", "cursor", "vs-code", "roo-code"]) expect(serverFor(slug), slug).toBe("developer");
    for (const slug of ["chatgpt", "claude", "perplexity"]) expect(serverFor(slug), slug).toBe("job-search");
    for (const entry of MCP_CLIENTS.clients) {
      if (entry.category === "llm") expect(entry.server, entry.slug).toBe("job-search");
    }
  });

  it("never holds an API key: a developer-server entry reads one from the environment or shows a placeholder", () => {
    for (const entry of MCP_CLIENTS.clients) {
      expect(JSON.stringify(entry), entry.slug).not.toMatch(/jbe_(live|test)_[A-Za-z0-9]/);
      if (serverOf(MCP_CLIENTS, entry).auth !== "api-key") continue;
      expect(entry.oauth, entry.slug).toBe("none");
      const text = `${entry.install.command ?? ""}\n${entry.install.snippet ?? ""}\n${entry.install.uiSteps.join("\n")}`;
      expect(text, entry.slug).toMatch(/JOBO_API_KEY|<your Jobo API key>|your Jobo API key/);
    }
  });

  it("is rejected when an entry is broken", () => {
    const broken = {
      serverUrl: "http://insecure.example/mcp",
      serverName: "jobo-job-search",
      clients: [
        client({ slug: "Bad Slug", category: "toaster" as McpClient["category"] }),
        client({ slug: "dup" }),
        client({ slug: "dup", install: { kind: "config-file", command: null, snippet: "{}" } }),
        client({ slug: "clicky", install: { kind: "ui", command: null } }),
      ],
    };
    const problems = validateMcpClients(broken);
    expect(problems).toContain("serverUrl must be an https URL");
    expect(problems.some((p) => p.includes("slug must be lower-case kebab"))).toBe(true);
    expect(problems.some((p) => p.includes('unknown category "toaster"'))).toBe(true);
    expect(problems.some((p) => p.includes("duplicate slug"))).toBe(true);
    expect(problems.some((p) => p.includes('"config-file" needs install.snippet and a path or projectPath'))).toBe(true);
    expect(problems.some((p) => p.includes('"ui" needs install.uiSteps'))).toBe(true);
  });

  it("is rejected when an entry names a server that is not there, or mixes up the two kinds of auth", () => {
    const servers = {
      "job-search": { name: "jobo-job-search", url: "https://jobs-mcp.jobo.world/mcp", auth: "oauth" as const },
      developer: { name: "jobo-developer", url: "https://dev-mcp.jobo.world/mcp", auth: "api-key" as const },
    };
    const file = (entry: McpClient) => ({ serverUrl: servers["job-search"].url, serverName: "jobo-job-search", servers, clients: [entry] });

    expect(validateMcpClients(file(client({ server: "developer", oauth: "none" })))).toEqual([]);
    expect(validateMcpClients(file(client({ server: "job-search", oauth: "native" })))).toEqual([]);
    expect(validateMcpClients(file(client({ server: "analytics" }))).some((p) => p.includes('unknown server "analytics"'))).toBe(true);
    expect(validateMcpClients(file(client({ server: "developer", oauth: "native" }))).some((p) => p.includes('oauth must be "none"'))).toBe(true);
    expect(validateMcpClients(file(client({ server: "job-search", oauth: "none" }))).some((p) => p.includes('oauth must be "none"'))).toBe(true);
    expect(
      validateMcpClients({ ...file(client({})), servers: { developer: { name: "", url: "http://x", auth: "password" } } }).filter((p) =>
        p.startsWith("servers.developer"),
      ),
    ).toHaveLength(3);
  });
});

describe("jobo mcp", () => {
  it("lists every client in the data file", async () => {
    const h = harness();
    expect(await h.run("mcp")).toBe(0);
    for (const entry of MCP_CLIENTS.clients) {
      expect(h.stdout()).toContain(entry.slug);
      expect(h.stdout()).toContain(entry.name);
    }
    // Both servers, and what each one takes. Wrapping moves the line breaks.
    const flat = h.stdout().replace(/\s+/g, " ");
    expect(flat).toContain(MCP_CLIENTS.serverUrl);
    expect(flat).toContain("no API key");
    expect(flat).toContain("https://dev-mcp.jobo.world/mcp");
    expect(flat).toContain("your Jobo API key as a header");
  });

  it.each(MCP_CLIENTS.clients.map((entry) => [entry.slug, entry] as const))(
    "prints the %s setup straight from its entry",
    async (slug, entry) => {
      const h = harness();
      expect(await h.run("mcp", slug)).toBe(0);
      const text = h.stdout();
      // Wrapping moves line breaks, so compare prose with whitespace collapsed.
      const flat = text.replace(/\s+/g, " ");
      const has = (value: string) => expect(flat, `${slug}: ${value}`).toContain(value.replace(/\s+/g, " ").trim());

      for (const line of (entry.install.command ?? "").split("\n").filter(Boolean)) expect(text).toContain(`  ${line}`);
      for (const line of (entry.install.snippet ?? "").split("\n").filter(Boolean)) expect(text).toContain(`  ${line}`);
      if (entry.install.path) has(entry.install.path);
      if (entry.install.projectPath) has(entry.install.projectPath);
      for (const step of entry.install.uiSteps) has(step);
      if (entry.signIn) has(entry.signIn);
      if (entry.verify) has(entry.verify);
      for (const entryNote of entry.notes) has(entryNote);
      has(entry.docsUrl);
      has(entry.verified);
      const server = serverOf(MCP_CLIENTS, entry);
      expect(text).toContain(`Server:     ${server.name} at ${server.url}`);
      // The auth step is headed by what the server takes.
      expect(text).toContain(server.auth === "api-key" ? "\nAPI key:\n" : "\nSign in:\n");
      expect(text).not.toContain(server.auth === "api-key" ? "\nSign in:\n" : "\nAPI key:\n");
      expect(text).toContain("changes no files");
    },
  );

  it("needs no key, sends nothing and writes no files", async () => {
    const h = harness();
    await h.run("mcp");
    for (const entry of MCP_CLIENTS.clients) await h.run("mcp", entry.slug);
    expect(h.requests).toHaveLength(0);
    expect(readdirSync(h.home)).toEqual([]);
    expect(readdirSync(h.cwd)).toEqual([]);
  });

  it("finds a client by name as well as slug", async () => {
    const first = MCP_CLIENTS.clients[0] as McpClient;
    const h = harness();
    expect(await h.run("mcp", ...first.name.toUpperCase().split(" "))).toBe(0);
    expect(h.stdout()).toContain(`${first.name}: connect`);
  });

  it("keeps slugs and names unambiguous, so a lookup finds one client", () => {
    const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = MCP_CLIENTS.clients.flatMap((entry) => [...new Set([squash(entry.slug), squash(entry.name)])]);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it("rejects an unknown client and lists the known ones", async () => {
    const h = harness();
    expect(await h.run("mcp", "netscape-navigator")).toBe(2);
    expect(h.stderr()).toContain("claude-code");
    expect(h.stderr()).toContain(MCP_CLIENTS.serverUrl);
  });

  it("--json prints the raw data", async () => {
    const all = harness();
    await all.run("mcp", "--json");
    expect(JSON.parse(all.stdout())).toEqual(MCP_CLIENTS);

    const one = harness();
    await one.run("mcp", "cursor", "--json");
    const cursor = JSON.parse(one.stdout()) as { serverUrl: string; serverName: string; client: McpClient };
    expect(cursor.client.slug).toBe("cursor");
    // The server of that client, not always job search.
    expect(cursor.serverUrl).toBe("https://dev-mcp.jobo.world/mcp");
    expect(cursor.serverName).toBe("jobo-developer");

    const assistant = harness();
    await assistant.run("mcp", "claude", "--json");
    expect((JSON.parse(assistant.stdout()) as { serverUrl: string }).serverUrl).toBe(MCP_CLIENTS.serverUrl);
  });

  it("says which server a client is set up for", async () => {
    const coding = harness();
    await coding.run("mcp", "claude-code");
    expect(coding.stdout()).toContain("Claude Code: connect the Jobo developer MCP server");
    expect(coding.stdout()).toContain("Auth:       your Jobo API key, sent as a header; there is no sign-in");

    const assistant = harness();
    await assistant.run("mcp", "claude");
    expect(assistant.stdout()).toContain("Claude: connect the Jobo job search MCP server");
    expect(assistant.stdout()).toContain("OAuth in the client");
  });
});

// The command must render any entry the data file can hold, not just the seed entries.
describe("rendering is data-driven", () => {
  const file = (entry: McpClient): McpClientsFile => ({ serverUrl: "https://jobs-mcp.jobo.world/mcp", serverName: "jobo-job-search", clients: [entry] });

  it("renders a UI-only client as numbered steps", () => {
    const entry = client({
      slug: "clicky",
      name: "Clicky",
      install: { kind: "ui", command: null, uiSteps: ["Open Settings", "Choose Connectors", "Paste the server URL"], snippet: "https://jobs-mcp.jobo.world/mcp" },
    });
    const text = renderClient(file(entry), entry);
    expect(text).toContain("  1. Open Settings\n  2. Choose Connectors\n  3. Paste the server URL");
    expect(text).toContain("  https://jobs-mcp.jobo.world/mcp");
  });

  it("renders a stdio-bridge client with its config file and project path", () => {
    const entry = client({
      slug: "bridgey",
      name: "Bridgey",
      category: "ai-builder",
      transport: "stdio-bridge",
      oauth: "bridge",
      install: {
        kind: "config-file",
        command: null,
        path: "~/.bridgey/mcp.toml",
        projectPath: ".bridgey/mcp.toml",
        language: "toml",
        snippet: '[mcp.jobo-job-search]\ncommand = "npx"\nargs = ["mcp-remote", "https://jobs-mcp.jobo.world/mcp"]',
      },
      notes: ["Restart Bridgey after editing the file."],
    });
    const text = renderClient(file(entry), entry);
    expect(text).toContain("npx mcp-remote");
    expect(text).toContain("OAuth through the mcp-remote bridge");
    expect(text).toContain("Add this to ~/.bridgey/mcp.toml (or .bridgey/mcp.toml for one project):");
    expect(text).toContain('  args = ["mcp-remote", "https://jobs-mcp.jobo.world/mcp"]');
    expect(text).toContain("  - Restart Bridgey after editing the file.");
    expect(renderClientList(file(entry))).toContain("AI app builders:");
  });

  it("renders a config file that only exists per project, and the sign-in and check steps", () => {
    const entry = client({
      install: { kind: "config-file", command: null, path: null, projectPath: ".vscode/settings.json", language: "json", snippet: "{}" },
      signIn: "Approve access in the browser window that opens.",
      verify: "The server shows as connected.",
    });
    const text = renderClient(file(entry), entry);
    expect(text).toContain("Add this to .vscode/settings.json in your project:");
    expect(text).toContain("Sign in:\n  Approve access in the browser window that opens.");
    expect(text).toContain("Check it worked:\n  The server shows as connected.");
  });

  it("runs the snippet when a command entry has no separate command", () => {
    const entry = client({ install: { kind: "command", command: null, snippet: "example mcp add jobo https://jobs-mcp.jobo.world/mcp" } });
    expect(validateMcpClients(file(entry))).toEqual([]);
    expect(renderClient(file(entry), entry)).toContain("Run:\n\n  example mcp add jobo https://jobs-mcp.jobo.world/mcp\n");
  });

  it("says so when a client cannot sign in", () => {
    const entry = client({ oauth: "unsupported" });
    expect(renderClient(file(entry), entry)).toContain("cannot complete the OAuth sign-in");
  });

  it("shows a config snippet next to a command when the entry has both", () => {
    const entry = client({ install: { kind: "command", command: "example mcp add jobo", path: "~/.example/config.toml", snippet: '[mcp_servers.jobo]\nurl = "https://jobs-mcp.jobo.world/mcp"' } });
    const text = renderClient(file(entry), entry);
    expect(text).toContain("Run:\n\n  example mcp add jobo");
    expect(text).toContain("Or add this to ~/.example/config.toml:");
  });
});
