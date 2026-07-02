import { WebSocketServer, WebSocket } from 'ws';

export interface BridgeRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface BridgeResponse {
	id: string;
	result?: unknown;
	error?: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface SendOptions {
	/** If true, resolve after a short delay instead of waiting for a response (for APIs that never respond). */
	fireAndForget?: boolean;
	/** Override the default timeout for this request (ms). */
	timeout?: number;
}

interface QueuedRequest {
	method: string;
	params: Record<string, unknown>;
	options: SendOptions;
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

type EditorType = 'schematic' | 'pcb' | 'unknown';

interface ClientSession {
	editorType: EditorType;
	connectedAt: number;
	lastActivityAt: number;
	projectInfo?: {
		uuid: string;
		name: string;
		documents?: Array<{ type: string; uuid: string; name: string; pages?: Array<{ uuid: string; name: string }> }>;
	};
}

export class WebSocketBridge {
	private wss: WebSocketServer | null = null;
	private clients = new Set<WebSocket>();
	/** Session info per connected client. */
	private clientSession = new Map<WebSocket, ClientSession>();
	private pendingRequests = new Map<string, PendingRequest>();
	private requestIdCounter = 0;
	private readonly timeout: number;
	private readonly maxConcurrent: number;
	private activeRequests = 0;
	private requestQueue: QueuedRequest[] = [];
	/** Maps request ID to the client that received it, so responses route back correctly. */
	private requestClientMap = new Map<string, WebSocket>();
	/** True once start()'s promise has resolved, so background rebind retries don't resolve twice. */
	private started = false;
	/** Pending EADDRINUSE rebind timer, if any. */
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(private readonly port: number = 15168, timeout = 120000, maxConcurrent = 3) {
		this.timeout = timeout;
		this.maxConcurrent = maxConcurrent;
	}

	/**
	 * Start the bridge WebSocket server.
	 *
	 * The EasyEDA Pro extension connects OUT to a fixed port, so only one MCP
	 * server process can own that port at a time. If the port is already taken
	 * (e.g. another Claude session's MCP server, or an orphaned process), we do
	 * NOT crash — the MCP stdio layer still comes up and serves tools (which
	 * report "extension not connected"), and we keep retrying the bind in the
	 * background so the bridge self-heals the moment the port frees up.
	 */
	start(): Promise<void> {
		return new Promise((resolve) => {
			const resolveOnce = () => {
				if (!this.started) {
					this.started = true;
					resolve();
				}
			};

			const attemptListen = () => {
				if (this.stopped) return;
				const wss = new WebSocketServer({ port: this.port });

				wss.on('listening', () => {
					this.wss = wss;
					console.error(`[Bridge] WebSocket Server listening on port ${this.port}`);
					resolveOnce();
				});

				wss.on('error', (err: NodeJS.ErrnoException) => {
					if (err.code === 'EADDRINUSE') {
						console.error(
							`[Bridge] Port ${this.port} is already in use — another EasyEDA MCP server (likely a different Claude session) owns the bridge. ` +
							`Tools will report "not connected" until it frees up. Retrying in 5s...`,
						);
						// Bring the MCP layer up anyway so the server doesn't die,
						// then keep trying to claim the port in the background.
						resolveOnce();
						try { wss.close(); } catch { /* ignore */ }
						if (this.retryTimer) clearTimeout(this.retryTimer);
						this.retryTimer = setTimeout(attemptListen, 5000);
					} else {
						console.error(`[Bridge] WebSocket Server error:`, err);
						// Non-fatal: keep the MCP layer alive rather than exiting.
						resolveOnce();
					}
				});

				wss.on('connection', (ws) => this.handleConnection(ws));
			};

			attemptListen();
		});
	}

	private handleConnection(ws: WebSocket): void {
		this.clients.add(ws);
		this.clientSession.set(ws, { editorType: 'unknown', connectedAt: Date.now(), lastActivityAt: Date.now() });
		console.error(`[Bridge] EDA Pro Extension connected (${this.clients.size} client(s) total)`);

		// Keep the Electron/Chromium WebSocket alive with periodic pings
		const pingInterval = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.ping();
			} else {
				clearInterval(pingInterval);
			}
		}, 10000);

		ws.on('pong', () => {
			// Connection confirmed alive — no action needed
		});

		ws.on('message', (data) => {
			try {
				const raw = JSON.parse(data.toString());
				// Handle identify messages from the extension
				if (raw.type === 'identify' && raw.editorType) {
					const session = this.clientSession.get(ws);
					if (session) {
						session.editorType = raw.editorType as EditorType;
						session.lastActivityAt = Date.now();
						if (raw.projectInfo) {
							session.projectInfo = raw.projectInfo;
						}
					}
					const projectLabel = raw.projectInfo?.name ? ` | project: "${raw.projectInfo.name}"` : '';
					console.error(`[Bridge] Client identified: editor=${raw.editorType}${projectLabel}`);
					return;
				}
				// Heartbeat pings from the extension — respond inline without queuing
				if (raw.method === 'sys.ping') {
					ws.send(JSON.stringify({ id: raw.id, result: { pong: true } }));
					return;
				}
				const response: BridgeResponse = raw;
				this.handleResponse(response);
			} catch (err) {
				console.error('[Bridge] Failed to parse message:', err);
			}
		});

		ws.on('close', () => {
			clearInterval(pingInterval);
			this.clients.delete(ws);
			this.clientSession.delete(ws);
			console.error(`[Bridge] EDA Pro Extension disconnected (${this.clients.size} client(s) remaining)`);
			// Reject pending requests that were sent to this client.
			// Delete from maps before calling reject so onRequestComplete (which
			// pending.reject wraps) doesn't see stale entries if it re-enters.
			for (const [id, pending] of this.pendingRequests) {
				if (this.requestClientMap.get(id) === ws) {
					clearTimeout(pending.timer);
					this.pendingRequests.delete(id);
					this.requestClientMap.delete(id);
					pending.reject(new Error('EDA Pro Extension disconnected'));
				}
			}
		});

		ws.on('error', (err) => {
			console.error('[Bridge] Client error:', err);
		});
	}

	isConnected(): boolean {
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) return true;
		}
		return false;
	}

	getClientCount(): number {
		let count = 0;
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) count++;
		}
		return count;
	}

	getConnectedEditorTypes(): string[] {
		const types: string[] = [];
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) {
				types.push(this.clientSession.get(ws)?.editorType ?? 'unknown');
			}
		}
		return types;
	}

	getSessionInfo(): Array<{ editorType: string; connectedAt: number; lastActivityAt: number; projectInfo?: ClientSession['projectInfo'] }> {
		const sessions: Array<{ editorType: string; connectedAt: number; lastActivityAt: number; projectInfo?: ClientSession['projectInfo'] }> = [];
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) {
				const s = this.clientSession.get(ws);
				if (s) {
					sessions.push({
						editorType: s.editorType,
						connectedAt: s.connectedAt,
						lastActivityAt: s.lastActivityAt,
						projectInfo: s.projectInfo,
					});
				}
			}
		}
		return sessions;
	}

	/**
	 * Get the best client for a given method.
	 * Routes sch.* to schematic clients and pcb.* to PCB clients.
	 * Falls back to any open client if no typed match is found.
	 */
	private getClient(method?: string): WebSocket | null {
		let desired: EditorType | null = null;
		if (method?.startsWith('sch.')) desired = 'schematic';
		else if (method?.startsWith('pcb.')) desired = 'pcb';

		// Prefer a client whose declared editor type matches
		if (desired) {
			for (const ws of this.clients) {
				if (ws.readyState === WebSocket.OPEN && this.clientSession.get(ws)?.editorType === desired) {
					return ws;
				}
			}
		}

		// Fall back to any open client (covers single-client and 'unknown' type)
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) return ws;
		}
		return null;
	}

	async send(method: string, params: Record<string, unknown> = {}, options: SendOptions = {}): Promise<unknown> {
		if (!this.isConnected()) {
			throw new Error('EDA Pro Extension is not connected. Open EasyEDA Pro and ensure the extension is loaded (it auto-connects on startup). If already open, use the Claude > Connect Claude menu item.');
		}

		// For editor-specific commands, check that the right editor type is connected
		if (method.startsWith('sch.') && !this.hasEditorType('schematic')) {
			throw new Error('No schematic editor connected. Switch to a schematic tab in EasyEDA Pro and use Claude > Connect Claude if needed.');
		}
		if (method.startsWith('pcb.') && !this.hasEditorType('pcb')) {
			throw new Error('No PCB editor connected. Switch to a PCB tab in EasyEDA Pro and use Claude > Connect Claude if needed.');
		}

		return new Promise((resolve, reject) => {
			if (this.activeRequests < this.maxConcurrent) {
				this.activeRequests++;
				this.executeSend(method, params, options, resolve, reject);
			} else {
				this.requestQueue.push({ method, params, options, resolve, reject });
			}
		});
	}

	private hasEditorType(type: EditorType): boolean {
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN && this.clientSession.get(ws)?.editorType === type) return true;
		}
		// Also accept 'unknown' type as a fallback (single-client mode)
		if (this.clients.size === 1) {
			for (const ws of this.clients) {
				if (ws.readyState === WebSocket.OPEN) return true;
			}
		}
		return false;
	}

	/**
	 * Send a request to ALL connected clients and collect results.
	 * Useful for querying state across multiple EDA Pro instances.
	 */
	async sendToAll(method: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
		const openClients: WebSocket[] = [];
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) openClients.push(ws);
		}
		if (openClients.length === 0) {
			throw new Error('No EDA Pro Extensions connected.');
		}

		const results = await Promise.allSettled(
			openClients.map((client) => this.sendToClient(client, method, params)),
		);

		return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: (r as PromiseRejectedResult).reason?.message }));
	}

	private sendToClient(client: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = String(++this.requestIdCounter);
		const request: BridgeRequest = { id, method, params };
		const requestTimeout = this.timeout;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				this.requestClientMap.delete(id);
				reject(new Error(`Request timed out after ${requestTimeout}ms: ${method}`));
			}, requestTimeout);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.requestClientMap.set(id, client);
			client.send(JSON.stringify(request));
		});
	}

	private executeSend(
		method: string,
		params: Record<string, unknown>,
		options: SendOptions,
		resolve: (value: unknown) => void,
		reject: (reason: Error) => void,
	): void {
		const client = this.getClient(method);
		if (!client) {
			reject(new Error('No EDA Pro Extension connected.'));
			this.onRequestComplete();
			return;
		}

		// Update last activity timestamp for this client's session
		const session = this.clientSession.get(client);
		if (session) session.lastActivityAt = Date.now();

		const id = String(++this.requestIdCounter);
		const request: BridgeRequest = { id, method, params };
		const requestTimeout = options.timeout ?? this.timeout;

		if (options.fireAndForget) {
			client.send(JSON.stringify(request));
			setTimeout(() => {
				resolve({ fireAndForget: true, method, message: 'Request sent. EDA Pro may not respond for this operation — check the schematic visually.' });
				this.onRequestComplete();
			}, 500);
			return;
		}

		const timer = setTimeout(() => {
			this.pendingRequests.delete(id);
			this.requestClientMap.delete(id);
			reject(new Error(`Request timed out after ${requestTimeout}ms: ${method}`));
			this.onRequestComplete();
		}, requestTimeout);

		this.pendingRequests.set(id, {
			resolve: (value) => {
				resolve(value);
				this.onRequestComplete();
			},
			reject: (reason) => {
				reject(reason);
				this.onRequestComplete();
			},
			timer,
		});
		this.requestClientMap.set(id, client);
		client.send(JSON.stringify(request));
	}

	private onRequestComplete(): void {
		this.activeRequests--;
		if (this.requestQueue.length > 0 && this.activeRequests < this.maxConcurrent) {
			const next = this.requestQueue.shift()!;
			this.activeRequests++;
			this.executeSend(next.method, next.params, next.options, next.resolve, next.reject);
		}
	}

	private handleResponse(response: BridgeResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			console.error(`[Bridge] Received response for unknown request: ${response.id}`);
			return;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(response.id);
		this.requestClientMap.delete(response.id);

		if (response.error) {
			pending.reject(new Error(response.error));
		} else {
			pending.resolve(response.result);
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}

		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Bridge shutting down'));
			this.pendingRequests.delete(id);
		}
		this.requestClientMap.clear();

		for (const ws of this.clients) {
			ws.close();
		}
		this.clients.clear();
		this.clientSession.clear();

		return new Promise((resolve) => {
			if (this.wss) {
				this.wss.close(() => {
					console.error('[Bridge] WebSocket Server closed');
					resolve();
				});
			} else {
				resolve();
			}
		});
	}
}
