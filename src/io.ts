import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { JoboTransportError, type Transport } from "@jobo-ai/connector-core";

/**
 * Everything the CLI touches outside its own process memory, except the
 * filesystem. `run()` takes one of these, so tests drive the real command code
 * with a fake transport and in-memory streams: no network, no API key.
 */
export interface Io {
  stdout: OutputStream;
  stderr: OutputStream;
  stdin: InputStream;
  env: Record<string, string | undefined>;
  cwd: string;
  homedir: string;
  platform: NodeJS.Platform;
  transport: Transport;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Hands `url` to the default browser. Resolves false, and never rejects, when none could be started. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Calls `handler` once if the user presses Ctrl-C. Returns a function that stops listening. */
  onInterrupt: (handler: () => void) => () => void;
}

export interface OutputStream {
  /** Resolves once the chunk is handed to the OS, so a feed cursor is only saved after its jobs are out. */
  write(chunk: string): Promise<void>;
  isTTY: boolean;
  columns?: number;
}

export interface InputStream {
  isTTY: boolean;
  /** Everything piped in, for `echo $KEY | jobo auth`. */
  readAll(): Promise<string>;
  /** Interactive prompt that echoes `*` instead of the typed characters. */
  promptSecret(prompt: string): Promise<string>;
}

/**
 * `fetch`-based transport. Redirects are never followed: the API does not
 * redirect HTTPS requests, and following one would carry `X-Api-Key` to
 * whatever host the redirect names.
 */
export const fetchTransport: Transport = {
  async request(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new JoboTransportError(`the request timed out after ${Math.round(req.timeoutMs / 1000)}s`, error);
      }
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
      const message = error instanceof Error ? error.message : String(error);
      throw new JoboTransportError(cause ? `${message} (${cause})` : message, error);
    } finally {
      clearTimeout(timer);
    }
  },
};

function processStream(stream: NodeJS.WriteStream): OutputStream {
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          // The reader closed the pipe (`| head`): it has what it wanted. Stop
          // now rather than fetch, and be billed for, output nobody will read.
          if ((error as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") process.exit(0);
          if (error) reject(error);
          else resolve();
        });
      }),
    get isTTY() {
      return Boolean(stream.isTTY);
    },
    get columns() {
      return stream.columns;
    },
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read one line with the terminal in raw mode, echoing `*` per character. */
function promptSecret(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        process.stderr.write("*");
      }
    };

    input.on("data", onData);
  });
}

/**
 * Start the platform's URL opener: `open` on macOS, `start` on Windows,
 * `xdg-open` elsewhere. The URL is one argument and no shell runs it, except
 * on Windows, where `start` is part of cmd.exe: there "&" would end the
 * command, so the characters cmd.exe acts on are escaped.
 */
function openBrowser(url: string): Promise<boolean> {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", url.replace(/[&|<>^]/g, "^$&")]]
        : ["xdg-open", [url]];
  return new Promise<boolean>((resolve) => {
    try {
      // Its own process group off Windows, so the Ctrl-C that cancels a sign-in does not reach the browser.
      const child = spawn(command, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
      // No opener on this machine (a server, a container): the caller has printed the URL.
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        // The browser outlives the CLI and must not hold it open.
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function onInterrupt(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return () => {
    process.removeListener("SIGINT", handler);
  };
}

export function realIo(): Io {
  return {
    stdout: processStream(process.stdout),
    stderr: processStream(process.stderr),
    stdin: {
      get isTTY() {
        return Boolean(process.stdin.isTTY);
      },
      readAll: readAllStdin,
      promptSecret,
    },
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    platform: process.platform,
    transport: fetchTransport,
    sleep: (ms) => delay(ms),
    now: () => new Date(),
    openBrowser,
    onInterrupt,
  };
}
