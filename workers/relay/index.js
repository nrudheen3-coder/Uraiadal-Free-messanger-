/**
 * Uraiadal Relay Worker v2
 * Uses KV polling + WebSocket hybrid
 * Works 100% on Cloudflare free plan
 */

export class UserSession {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.sessions = new Map(); // wsId → WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request, url);
    }

    if (url.pathname === "/deliver" && request.method === "POST") {
      return this.deliver(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(request, url) {
    const shortId = url.searchParams.get("id");
    if (!shortId?.startsWith("urai_")) {
      return new Response("Invalid ID", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [shortId]);

    // Mark user online
    await this.env.REGISTRY.put(
      `online:${shortId}`,
      JSON.stringify({ shortId, lastSeen: Date.now() }),
      { expirationTtl: 120 }
    );

    // Deliver any pending offline messages immediately
    const pending = await this.env.REGISTRY.list({ prefix: `msg:${shortId}:` });
    for (const key of pending.keys) {
      const val = await this.env.REGISTRY.get(key.name);
      if (val) {
        server.send(val);
        await this.env.REGISTRY.delete(key.name);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called when message received from WebSocket
  async webSocketMessage(ws, message) {
    const tags   = this.state.getTags(ws);
    const fromId = tags[0];
    if (!fromId) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    const { type } = data;

    if (type === "heartbeat") {
      await this.env.REGISTRY.put(
        `online:${fromId}`,
        JSON.stringify({ shortId: fromId, lastSeen: Date.now() }),
        { expirationTtl: 120 }
      );
      ws.send(JSON.stringify({ type: "heartbeat_ack" }));
      return;
    }

    if (type === "message") {
      const { toId, messageId, payload, msgType, timestamp } = data;
      if (!toId || !messageId) return;

      const envelope = JSON.stringify({
        type:      "message",
        messageId,
        fromId,
        payload,
        msgType:   msgType || "text",
        timestamp: timestamp || Date.now(),
      });

      // Try live delivery via recipient's Durable Object
      const recipDO = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(toId)
      );

      let delivered = false;
      try {
        const res = await recipDO.fetch(
          new Request("https://relay/deliver", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: envelope,
          })
        );
        delivered = res.ok && (await res.text()) === "ok";
      } catch {}

      if (delivered) {
        // Confirm delivery to sender
        ws.send(JSON.stringify({ type: "receipt", messageId, status: "delivered" }));
      } else {
        // Store for offline delivery (7 days TTL)
        await this.env.REGISTRY.put(
          `msg:${toId}:${messageId}`,
          envelope,
          { expirationTtl: 604800 }
        );
        ws.send(JSON.stringify({ type: "receipt", messageId, status: "sent" }));
      }
    }

    if (type === "receipt") {
      const { toId, messageId, status } = data;
      if (!toId) return;
      const recipDO = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(toId)
      );
      await recipDO.fetch(new Request("https://relay/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "receipt", messageId, fromId, status }),
      })).catch(() => {});
    }

    if (type === "typing") {
      const { toId, isTyping } = data;
      if (!toId) return;
      const recipDO = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(toId)
      );
      await recipDO.fetch(new Request("https://relay/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "typing", fromId, isTyping }),
      })).catch(() => {});
    }
  }

  async webSocketClose(ws) {
    const tags    = this.state.getTags(ws);
    const shortId = tags[0];
    if (shortId) {
      await this.env.REGISTRY.delete(`online:${shortId}`);
    }
  }

  async webSocketError(ws) {
    const tags    = this.state.getTags(ws);
    const shortId = tags[0];
    if (shortId) {
      await this.env.REGISTRY.delete(`online:${shortId}`);
    }
  }

  // Deliver message to all active WebSockets for this user
  async deliver(request) {
    const data = await request.text();
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return new Response("offline", { status: 503 });
    }
    for (const ws of sockets) {
      try { ws.send(data); } catch {}
    }
    return new Response("ok");
  }
}

// ── Main Worker ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    // ── WebSocket ──
    if (url.pathname === "/ws") {
      const shortId = url.searchParams.get("id");
      if (!shortId?.startsWith("urai_")) {
        return new Response("Invalid ID", { status: 400 });
      }
      const doId = env.USER_SESSION.idFromName(shortId);
      return env.USER_SESSION.get(doId).fetch(request);
    }

    // ── Register ──
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const { shortId, signingPubKey, exchangePubKey } = await request.json();
        if (!shortId?.startsWith("urai_")) {
          return json({ error: "Invalid ID" }, 400);
        }
        await env.REGISTRY.put(`user:${shortId}`, JSON.stringify({
          shortId, signingPubKey, exchangePubKey,
          registeredAt: Date.now(),
        }));
        return json({ success: true, shortId });
      } catch {
        return json({ error: "Bad request" }, 400);
      }
    }

    // ── Lookup ──
    if (url.pathname.startsWith("/lookup/")) {
      const shortId = url.pathname.replace("/lookup/", "");
      const data    = await env.REGISTRY.get(`user:${shortId}`);
      if (!data) return json({ error: "Not found" }, 404);
      return json(JSON.parse(data));
    }

    // ── Pending messages (for polling fallback) ──
    if (url.pathname === "/pending") {
      const shortId = url.searchParams.get("id");
      if (!shortId) return json({ messages: [] });
      const list = await env.REGISTRY.list({ prefix: `msg:${shortId}:` });
      const messages = await Promise.all(
        list.keys.map(async (k) => {
          const val = await env.REGISTRY.get(k.name);
          if (val) {
            await env.REGISTRY.delete(k.name);
            return JSON.parse(val);
          }
          return null;
        })
      );
      return json({ messages: messages.filter(Boolean) });
    }

    // ── Online status ──
    if (url.pathname.startsWith("/online/")) {
      const shortId = url.pathname.replace("/online/", "");
      const data    = await env.REGISTRY.get(`online:${shortId}`);
      return json({ online: !!data, lastSeen: data ? JSON.parse(data).lastSeen : null });
    }

    // ── Health ──
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "Uraiadal Relay", version: "2.0.0", timestamp: Date.now() });
    }

    return new Response("Uraiadal Relay v2.0", { headers: cors });
  }
};
