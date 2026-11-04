import { startTestServer, type TestServer } from "../helpers/server-harness";

let promise: Promise<TestServer> | null = null;

// One server per worker process; all e2e tests in a worker share it.
export function getSharedServer(): Promise<TestServer> {
  if (!promise) {
    promise = startTestServer();
  }
  return promise;
}

export async function stopSharedServer(): Promise<void> {
  if (!promise) {
    return;
  }
  const server = await promise;
  promise = null;
  await server.stop();
}
