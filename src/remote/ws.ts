import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import { networkInterfaces } from "os";
import type { Duplex } from "stream";

export const DEFAULT_SERVER_PORT = 31415;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PING_INTERVAL_MS = 25_000;

export function generateServerToken(): string {
	return randomBytes(24).toString("hex");
}

export function tokensMatch(expected: string, provided: string): boolean {
	if (!expected) return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

// Normalizes a user-entered address ("100.64.0.1:31415", "ws://host:31415", "https://host") into an http(s) base URL.
export function normalizeHttpUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: /^wss?:\/\//i.test(trimmed)
			? trimmed.replace(/^ws/i, "http")
			: `http://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (!url.port && url.protocol === "http:" && !/:(\d+)(\/|$)/.test(withScheme.replace(/^https?:\/\//i, ""))) {
			url.port = String(DEFAULT_SERVER_PORT);
		}
		return url.origin;
	} catch {
		return "";
	}
}

export function normalizeWsUrl(raw: string, path: string, token: string): string {
	const base = normalizeHttpUrl(raw);
	if (!base) return "";
	const wsBase = base.replace(/^http/i, "ws");
	const url = new URL(path, wsBase);
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

function isTailscaleIp(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// Lists reachable WebSocket URLs for the server, with Tailscale 100.64.0.0/10 addresses first.
export function discoverServerUrls(port: number, bindHost = "0.0.0.0"): string[] {
	if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
		return [`ws://${bindHost}:${port}`];
	}
	const tailscale: string[] = [];
	const lan: string[] = [];
	const nets = networkInterfaces();
	for (const entries of Object.values(nets)) {
		for (const net of entries ?? []) {
			if (net.internal || net.family !== "IPv4") continue;
			const url = `ws://${net.address}:${port}`;
			if (isTailscaleIp(net.address)) tailscale.push(url);
			else lan.push(url);
		}
	}
	return [...new Set([...tailscale, ...lan])];
}

export class ServerWebSocket {
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private closed = false;
	private awaitingPong = false;
	private messageListeners = new Set<(text: string) => void>();
	private closeListeners = new Set<() => void>();
	private pingTimer: ReturnType<typeof setInterval>;

	constructor(private socket: Duplex) {
		this.pingTimer = setInterval(() => {
			if (this.awaitingPong) {
				this.closed = true;
				this.socket.destroy();
				this.finishClose();
				return;
			}
			this.awaitingPong = true;
			this.sendFrame(0x9, Buffer.alloc(0));
		}, PING_INTERVAL_MS);
		this.pingTimer.unref?.();
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("close", () => this.finishClose());
		socket.on("error", () => this.finishClose());
	}

	onMessage(fn: (text: string) => void): void {
		this.messageListeners.add(fn);
	}

	onClose(fn: () => void): void {
		this.closeListeners.add(fn);
	}

	clearListeners(): void {
		this.messageListeners.clear();
		this.closeListeners.clear();
	}

	send(text: string): void {
		if (this.closed) return;
		this.sendFrame(0x1, Buffer.from(text, "utf8"));
	}

	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		const reasonBuf = Buffer.from(reason.slice(0, 120), "utf8");
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		this.sendFrame(0x8, payload);
		this.closed = true;
		this.socket.end();
		this.finishClose();
	}

	private sendFrame(opcode: number, payload: Buffer): void {
		if (this.closed) return;
		const len = payload.length;
		let header: Buffer;
		if (len < 126) {
			header = Buffer.alloc(2);
			header[0] = 0x80 | opcode;
			header[1] = len;
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		try {
			this.socket.write(Buffer.concat([header, payload]));
		} catch {
			this.finishClose();
		}
	}

	private onData(chunk: Buffer): void {
		if (this.closed) return;
		this.awaitingPong = false;
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

		while (this.buffer.length >= 2) {
			const b0 = this.buffer[0];
			const b1 = this.buffer[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let payloadLen = b1 & 0x7f;
			let offset = 2;

			if (payloadLen === 126) {
				if (this.buffer.length < 4) return;
				payloadLen = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (payloadLen === 127) {
				if (this.buffer.length < 10) return;
				const bigLen = this.buffer.readBigUInt64BE(2);
				if (bigLen > BigInt(MAX_FRAME_BYTES)) {
					this.close(1009, "Frame too large");
					return;
				}
				payloadLen = Number(bigLen);
				offset = 10;
			}

			if (payloadLen > MAX_FRAME_BYTES) {
				this.close(1009, "Frame too large");
				return;
			}

			const maskLen = masked ? 4 : 0;
			if (this.buffer.length < offset + maskLen + payloadLen) return;

			const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
			offset += maskLen;
			const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
			this.buffer = this.buffer.subarray(offset + payloadLen);

			if (mask) {
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			}

			if (opcode === 0x8) {
				// Close frame
				this.sendFrame(0x8, Buffer.alloc(0));
				this.closed = true;
				this.socket.destroy();
				this.finishClose();
				return;
			}
			if (opcode === 0x9) {
				// Ping -> Pong
				this.sendFrame(0xa, payload);
				continue;
			}
			if (opcode === 0xa) {
				continue;
			}
			if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
				this.fragments.push(payload);
				if (fin) {
					const full = Buffer.concat(this.fragments).toString("utf8");
					this.fragments = [];
					for (const fn of this.messageListeners) fn(full);
				}
			}
		}
	}

	private finishClose(): void {
		clearInterval(this.pingTimer);
		if (!this.closeListeners.size) return;
		const listeners = [...this.closeListeners];
		this.closeListeners.clear();
		for (const fn of listeners) fn();
	}
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): ServerWebSocket | null {
	const key = req.headers["sec-websocket-key"];
	if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || !key) {
		socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
		socket.destroy();
		return null;
	}
	const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
	socket.write(
		[
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"\r\n",
		].join("\r\n"),
	);
	if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
	if ("setKeepAlive" in socket && typeof (socket as { setKeepAlive?: (enable: boolean, delay: number) => void }).setKeepAlive === "function") {
		(socket as { setKeepAlive: (enable: boolean, delay: number) => void }).setKeepAlive(true, 15_000);
	}
	const ws = new ServerWebSocket(socket);
	if (head.length) socket.emit("data", head);
	return ws;
}
