import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Ascend to the directory containing src/server.ts; works under vitest,
// playwright, and tsx regardless of module format.
function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, "src", "server.ts"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir);
    }
    dir = parent;
  }
}

export const repoRoot = findRepoRoot(process.cwd());

export type TestServer = {
  port: number;
  baseUrl: string;
  dataDir: string;
  child: ChildProcess;
  ownerCookie: string;
  ownerPassword: string;
  apiKey: string;
  requestPath(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
};

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function apiRequest(baseUrl: string, requestPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${requestPath}`, init);
}

function jsonInit(method: string, body: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

// A note meta file without any collab state, as written by older versions.
export function writeLegacyNote(dataDir: string, id: string, title: string, markdown: string) {
  const notesDir = path.join(dataDir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, `${id}.md`), markdown, "utf8");
  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(notesDir, `${id}.json`),
    `${JSON.stringify(
      {
        id,
        title,
        shareId: `legacy${id}`,
        shareAccess: "none",
        createdAt: timestamp,
        updatedAt: timestamp,
        threads: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function startTestServer(options: { beforeStart?: (dataDir: string) => void } = {}): Promise<TestServer> {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jot-test-"));
  fs.mkdirSync(path.join(dataDir, "notes"), { recursive: true });
  options.beforeStart?.(dataDir);

  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      "src/server.ts",
      `--port=${port}`,
      `--data=${dataDir}`,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
      if (output.length > 40) output.shift();
    });
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // server not listening yet
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!healthy) {
    child.kill("SIGTERM");
    throw new Error(`test server failed to start:\n${output.join("")}`);
  }

  const ownerPassword = crypto.randomBytes(12).toString("base64url");
  const setupResponse = await fetch(
    `${baseUrl}/api/auth/setup`,
    jsonInit("POST", {
      password: ownerPassword,
      confirmPassword: ownerPassword,
    }),
  );
  if (!setupResponse.ok) {
    throw new Error(`auth setup failed: ${setupResponse.status}`);
  }
  const { token } = (await setupResponse.json()) as { token: string };

  const tokenResponse = await fetch(`${baseUrl}/api/auth/token`, jsonInit("POST", { token }));
  if (!tokenResponse.ok) {
    throw new Error(`token exchange failed: ${tokenResponse.status}`);
  }
  const setCookies = tokenResponse.headers.getSetCookie();
  const sessionCookie = setCookies.find((cookie) => cookie.startsWith("md_owner_session="));
  if (!sessionCookie) {
    throw new Error(`no owner session cookie issued: ${JSON.stringify(setCookies)}`);
  }
  const ownerCookie = sessionCookie.split(";")[0];

  const keyResponse = await fetch(`${baseUrl}/api/keys`, jsonInit("POST", { label: "tests" }, ownerCookie));
  if (!keyResponse.ok) {
    throw new Error(`api key creation failed: ${keyResponse.status}`);
  }
  const { key: apiKey } = (await keyResponse.json()) as { key: string };

  return {
    port,
    baseUrl,
    dataDir,
    child,
    ownerCookie,
    ownerPassword,
    apiKey,
    requestPath(requestPath, init = {}) {
      const headers: Record<string, string> = {
        Cookie: ownerCookie,
        ...((init.headers as Record<string, string>) || {}),
      };
      let body = init.body;
      if (body !== undefined && typeof body !== "string") {
        body = JSON.stringify(body);
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }
      return fetch(`${baseUrl}${requestPath}`, { ...init, headers, body });
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createNote(server: TestServer, markdown?: string): Promise<{ id: string; title: string }> {
  const created = await server.requestPath("/api/notes", { method: "POST" });
  const { note } = (await created.json()) as { note: { id: string; title: string } };
  if (markdown !== undefined) {
    const updated = await server.requestPath(`/api/notes/${note.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    if (!updated.ok) {
      throw new Error(`failed to set markdown: ${updated.status}`);
    }
  }
  return note;
}
