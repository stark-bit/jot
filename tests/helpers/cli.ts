import { spawn } from "node:child_process";
import path from "node:path";

import { repoRoot } from "./server-harness";

export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function runCli(args: string[], home: string, timeoutMs = 20000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "cli", "jot.mjs"), ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli timed out: jot ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
