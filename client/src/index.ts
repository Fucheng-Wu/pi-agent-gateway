import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type PermissionDecision, type PermissionRequest } from "../../shared/types.js";
import { validateClientMessage } from "../../shared/validation.js";
export * from "../../shared/types.js";

export class GatewayError extends Error {
  constructor(message: string, readonly code = "CLIENT_ERROR", readonly sessionId?: string) { super(message); this.name = "GatewayError"; }
}

export interface GatewayClientOptions {
  requestTimeoutMs?: number;
  reconnect?: boolean;
  /** No permission is granted automatically. Supply a human-facing approval handler or respond explicitly. */
  onPermission?: (permission: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
  onError?: (error: Error) => void;
  WebSocket?: typeof WebSocket;
}

type Response<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
type Pending = { expected: ServerMessage["type"]; resolve: (message: ServerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A single connection with correlated requests, deadlines, heartbeats and snapshot resubscription. */
export class GatewayClient {
  private socket?: WebSocket;
  private ready = false;
  private stopped = true;
  private attempts = 0;
  private serial = 0;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(message: ServerMessage) => void>();
  private stateListeners = new Set<(state: "connecting" | "connected" | "disconnected") => void>();
  private sessions = new Set<string>();
  private workspace?: string;
  private readonly Socket: typeof WebSocket;

  constructor(readonly url: string, private readonly options: GatewayClientOptions = {}) {
    this.Socket = options.WebSocket ?? globalThis.WebSocket;
    if (!this.Socket) throw new GatewayError("WebSocket is unavailable; use Node.js 22+ or provide options.WebSocket");
  }

  onMessage(listener: (message: ServerMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onState(listener: (state: "connecting" | "connected" | "disconnected") => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  private report(error: unknown): void { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
  private state(value: "connecting" | "connected" | "disconnected"): void { for (const listener of this.stateListeners) { try { listener(value); } catch (error) { this.report(error); } } }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.state("connecting");
    const connection = new Promise<void>((resolve, reject) => {
      const socket = new this.Socket(this.url);
      this.socket = socket;
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const openTimer = setTimeout(() => { fail(new GatewayError("Connection timed out", "TIMEOUT")); socket.close(); }, this.options.requestTimeoutMs ?? 30_000);
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) { socket.close(); return; }
        clearTimeout(openTimer);
        void this.rawRequest({ type: "init", protocolVersion: PROTOCOL_VERSION }, "init").then(async () => {
          if (this.socket !== socket || this.stopped) return;
          this.ready = true;
          this.attempts = 0;
          this.startHeartbeat();
          // Refresh every watched conversation after reconnect; no mutating command is replayed.
          await Promise.all([...this.sessions].map((sessionId) => this.rawRequest({ type: "load_session", sessionId }, "session_state").catch((error) => {
            this.sessions.delete(sessionId);
            this.report(error);
          })));
          if (this.socket !== socket || this.stopped) return;
          settled = true;
          this.state("connected");
          resolve();
        }).catch((error) => { fail(error); socket.close(); });
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        let message: ServerMessage;
        try { message = JSON.parse(String(event.data)); }
        catch { this.report(new GatewayError("Invalid JSON from gateway", "BAD_RESPONSE")); return; }
        if (!message || typeof message.type !== "string") return;
        if (message.type === "session_deleted") this.sessions.delete(message.sessionId);
        if ((message.type === "workspace" || message.type === "init") && message.workspace) {
          if (this.workspace && this.workspace !== message.workspace.path) this.sessions.clear();
          this.workspace = message.workspace.path;
        }
        if (message.type === "pong") { clearTimeout(this.pongTimer); this.pongTimer = undefined; }
        const pending = message.requestId ? this.pending.get(message.requestId) : undefined;
        if (pending && (message.type === "error" || message.type === pending.expected)) {
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId!);
          if (message.type === "error") pending.reject(new GatewayError(message.message, message.code, message.sessionId));
          else pending.resolve(message);
        }
        for (const listener of this.listeners) { try { listener(message); } catch (error) { this.report(error); } }
        if (message.type === "permission_request" && this.options.onPermission) {
          void Promise.resolve().then(() => this.options.onPermission!(message.permission))
            .then((decision) => this.rawRequest({ type: "permission_response", permissionId: message.permission.id, decision }, "ack"))
            .catch((error) => this.report(error));
        }
      };
      socket.onerror = () => { fail(new GatewayError("WebSocket connection failed", "DISCONNECTED")); socket.close(); };
      socket.onclose = () => {
        clearTimeout(openTimer);
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.ready = false;
        this.connecting = undefined;
        this.clearHeartbeat();
        const error = new GatewayError("Connection closed; request outcome may be unknown", "DISCONNECTED");
        fail(error);
        this.rejectPending(error);
        this.state("disconnected");
        if (!this.stopped && this.options.reconnect !== false) {
          const delay = Math.min(15_000, 800 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 300;
          this.reconnectTimer = setTimeout(() => { void this.connect().catch((reason) => this.report(reason)); }, delay);
        }
      };
    });
    this.connecting = connection;
    return connection.finally(() => { if (this.connecting === connection) this.connecting = undefined; });
  }

  async request<T extends ServerMessage["type"] = "ack">(command: ClientMessage, responseType: T = "ack" as T): Promise<Response<T>> {
    await this.connect();
    return this.rawRequest(command, responseType);
  }

  private rawRequest<T extends ServerMessage["type"]>(command: ClientMessage, expected: T): Promise<Response<T>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.Socket.OPEN) return Promise.reject(new GatewayError("Gateway is disconnected", "DISCONNECTED"));
    const requestId = command.requestId ?? `client-${Date.now()}-${++this.serial}`;
    try { validateClientMessage({ ...command, requestId }); }
    catch (error) { return Promise.reject(error); }
    if (this.pending.has(requestId)) return Promise.reject(new GatewayError("requestId is already pending", "DUPLICATE_REQUEST"));
    return new Promise<Response<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayError("Request timed out; do not automatically retry a mutating command", "TIMEOUT"));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(requestId, { expected, resolve: (message) => resolve(message as Response<T>), reject, timer });
      try { socket.send(JSON.stringify({ ...command, requestId })); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  async watchSession(sessionId: string): Promise<Response<"session_state">> {
    const wasReady = this.ready;
    this.sessions.add(sessionId);
    await this.connect();
    // connect() already refreshes subscriptions, but returning an explicit current snapshot is useful to callers.
    return this.rawRequest({ type: "load_session", sessionId }, "session_state").catch((error) => {
      if (!wasReady) this.sessions.delete(sessionId);
      throw error;
    });
  }

  unwatchSession(sessionId: string): void { this.sessions.delete(sessionId); }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => this.socket?.close(), 10_000);
      void this.rawRequest({ type: "ping" }, "pong").catch(() => this.socket?.close());
    }, 25_000);
  }
  private clearHeartbeat(): void { clearInterval(this.heartbeat); clearTimeout(this.pongTimer); this.heartbeat = this.pongTimer = undefined; }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }

  close(): void {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    this.rejectPending(new GatewayError("Client closed", "DISCONNECTED"));
    this.socket?.close();
  }
}
