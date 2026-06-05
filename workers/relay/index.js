/**
 * Uraiadal Relay Worker v3
 * KV-first delivery — 100% reliable on free plan
 * Durable Objects for live WebSocket sessions
 */

export class UserSession {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
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

    // Mark online
    await this.env.REGISTRY.put(
      `online:${shortId}`,
      JSON.stringify({ shortId, ts: Date.now() }),
      { expirationTtl: 120 }
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const tags    = this.state.getTags(ws);
    const fromId  = tags[0];
    if (!fromId) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    const { type } = data;

    // ── Heartbeat ──
    if (type === "heartbeat") {
      await this.env.REGISTRY.put(
        `online:${fromId}`,
        JSON.stringify({ shortId: fromId, ts: Date.now() }),
        { expirationTtl: 120 }
      );
      ws.send(JSON.stringify({ type: "heartbeat_ack" }));
      return;
    }

    // ── Message: KV-first then live ──
    if (type === "message") {
      const { toId, messageId, payload, msgType, timestamp } = data;
      if (!toId || !messageId) return;

      const envelope = JSON.stringify({
        type:      "message",
        messageId,
        fromId,
        toId,
        payload,
        msgType:   msgType || "text",
        timestamp: timestamp || Date.now(),
      });

      // Step 1: Store in KV ALWAYS (guarantees polling delivery)
      await this.env.REGISTRY.put(
        `msg:${toId}:${messageId}`,
        envelope,
        { expirationTtl: 604800 }
      );

      // Step 2: Try live delivery too (faster)
      let delivered = false;
      try {
        const recipDO = this.env.USER_SESSION.get(
          this.env.USER_SESSION.idFromName(toId)
        );
        const res = await recipDO.fetch(
          new Request("https://relay/deliver", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: envelope,
          })
        );
        if (res.ok && (await res.text()) === "ok") {
          delivered = true;
          // Remove from KV since live delivered
          await this.env.REGISTRY.delete(`msg:${toId}:${messageId}`);
        }
      } catch {}

      // Step 3: Send receipt to sender
      ws.send(JSON.stringify({
        type:      "receipt",
        messageId,
        status:    delivered ? "delivered" : "sent",
      }));
      return;
    }

    // ── Receipt ──
    if (type === "receipt") {
      const { toId, messageId, status } = data;
      if (!toId) return;
      try {
        const recipDO = this.env.USER_SESSION.get(
          this.env.USER_SESSION.idFromName(toId)
        );
        await recipDO.fetch(new Request("https://relay/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "receipt", messageId, fromId, status }),
        }));
      } catch {}
      return;
    }

    // ── Typing ──
    if (type === "typing") {
      const { toId, isTyping } = data;
      if (!toId) return;
      try {
        const recipDO = this.env.USER_SESSION.get(
          this.env.USER_SESSION.idFromName(toId)
        );
        await recipDO.fetch(new Request("https://relay/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "typing", fromId, isTyping }),
        }));
      } catch {}
      return;
    }
  }

  async webSocketClose(ws) {
    const tags = this.state.getTags(ws);
    if (tags[0]) await this.env.REGISTRY.delete(`online:${tags[0]}`);
  }

  async webSocketError(ws) {
    const tags = this.state.getTags(ws);
    if (tags[0]) await this.env.REGISTRY.delete(`online:${tags[0]}`);
  }

  async deliver(request) {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return new Response("offline", { status: 503 });
    const data = await request.text();
    for (const ws of sockets) {
      try { ws.send(data); } catch {}
    }
    return new Response("ok");
  }
}

// ── Main Worker ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    // WebSocket
    if (url.pathname === "/ws") {
      const shortId = url.searchParams.get("id");
      if (!shortId?.startsWith("urai_")) return new Response("Invalid ID", { status: 400 });
      const doId = env.USER_SESSION.idFromName(shortId);
      return env.USER_SESSION.get(doId).fetch(request);
    }

    // Register pubkeys
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const { shortId, signingPubKey, exchangePubKey } = await request.json();
        if (!shortId?.startsWith("urai_")) return json({ error: "Invalid ID" }, 400);
        await env.REGISTRY.put(`user:${shortId}`, JSON.stringify({
          shortId, signingPubKey, exchangePubKey, ts: Date.now(),
        }));
        return json({ success: true, shortId });
      } catch { return json({ error: "Bad request" }, 400); }
    }

    // Lookup pubkeys
    if (url.pathname.startsWith("/lookup/")) {
      const shortId = url.pathname.replace("/lookup/", "");
      const data    = await env.REGISTRY.get(`user:${shortId}`);
      if (!data) return json({ error: "Not found" }, 404);
      return json(JSON.parse(data));
    }

    // Pending messages (KV polling)
    if (url.pathname === "/pending") {
      const shortId = url.searchParams.get("id");
      if (!shortId) return json({ messages: [] });
      const list = await env.REGISTRY.list({ prefix: `msg:${shortId}:` });
      const messages = await Promise.all(
        list.keys.map(async k => {
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

    // Online status
    if (url.pathname.startsWith("/online/")) {
      const shortId = url.pathname.replace("/online/", "");
      const data    = await env.REGISTRY.get(`online:${shortId}`);
      return json({ online: !!data, lastSeen: data ? JSON.parse(data).ts : null });
    }

    // Health
    if (url.pathname === "/health") {
      return json({ status:"ok", service:"Uraiadal Relay", version:"3.0.0", timestamp:Date.now() });
    }

    return new Response("Uraiadal Relay v3.0", { headers: cors });
  }
};
