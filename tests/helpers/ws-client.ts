import WebSocket from "ws";

export type ServerMessage = Record<string, unknown> & { type: string };

type Waiter = {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

// Fake WebSocket client speaking the jot server protocol.
export class FakeWsClient {
  readonly inbox: ServerMessage[] = [];
  closed = false;
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly waiters: Waiter[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      this.inbox.push(message);
      this.dispatch();
    });
    ws.on("close", (code: number) => {
      this.closed = true;
      this.closeCode = code;
      this.dispatch();
    });
    ws.on("error", () => {
      // close event follows
    });
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<FakeWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new FakeWsClient(ws);
      const timer = setTimeout(() => {
        reject(new Error("websocket connect timed out"));
      }, 5000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once("close", () => {
        clearTimeout(timer);
        resolve(client);
      });
    });
  }

  send(message: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private dispatch() {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      const match = this.inbox.find(waiter.predicate);
      if (match) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.resolve(match);
      } else if (this.closed) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.reject(new Error("websocket closed while waiting"));
      }
    }
  }

  received(type: string): ServerMessage[] {
    return this.inbox.filter((message) => message.type === type);
  }

  async waitFor(
    type: string,
    predicate?: (message: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    const matches = this.inbox.filter((message) => message.type === type && (!predicate || predicate(message)));
    if (matches.length > 0) {
      return matches[0];
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${type}; received: ${this.inbox.map((m) => m.type).join(",") || "nothing"}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate: (message) => message.type === type && (!predicate || predicate(message)),
        resolve,
        reject,
        timer,
      });
      this.dispatch();
    });
  }

  async expectClose(timeoutMs = 3000): Promise<boolean> {
    if (this.closed) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
