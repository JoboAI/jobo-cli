#!/usr/bin/env node
import { run } from "./cli";
import { realIo } from "./io";

// A closed pipe (`jobo feed --all | head`) is the reader saying it has enough.
// Stop at once: every further feed batch would be billed and thrown away.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
// A closed stderr is only the log reader going away: the run carries on, and
// its exit code still says how it ended. Without this listener the stream's
// error event would crash the process.
process.stderr.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") return;
  throw error;
});

run(process.argv.slice(2), realIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
