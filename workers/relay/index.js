/**
 * Uraiadal Relay Worker
 * Cloudflare Durable Objects — real-time WebSocket relay
 * Zero-knowledge: server never reads message content
 *
 * Deploy: wrangler deploy (on Cloudflare build server)
 */

// ── Durable Object: one instance per user ────────────────────────────────────
export class UserSession {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.ws    = null;  // active WebSocket connection
    this.id    = null;  // user's shortId
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request, url);
    }

    // Deliver a message to this user (called by sender's DO)
    if (url.pathname === "/deliver" && request.method === "POST") {
      return this.deliverMessage(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(request, url) {
    const shortId = url.searchParams.get("id");
    if (!shortId || !shortId.startsWith("urai_")) {
      return new Response("Invalid ID", { status: 400 });
    }

    this.id = shortId;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.ws = server;

    // Register this user as online in KV
    await this.env.REGISTRY.put(
      `online:${shortId}`,
      JSON.stringify({ shortId, lastSeen: Date.now() }),
      { expirationTtl: 60 } // 60s TTL — refreshed by heartbeat
    );

    server.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(data);
      } catch (e) {
        server.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      }
    });

    server.addEventListener("close", async () => {
      await this.env.REGISTRY.delete(`online:${shortId}`);
      this.ws = null;
    });

    server.addEventListener("error", () => {
      this.ws = null;
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(data) {
    const { type } = data;

    if (type === "message") {
      await this.routeMessage(data);
    } else if (type === "receipt") {
      await this.routeReceipt(data);
    } else if (type === "typing") {
      await this.routeTyping(data);
    } else if (type === "heartbeat") {
      // Refresh online status
      if (this.id) {
        await this.env.REGISTRY.put(
          `online:${this.id}`,
          JSON.stringify({ shortId: this.id, lastSeen: Date.now() }),
          { expirationTtl: 60 }
        );
        this.ws?.send(JSON.stringify({ type: "heartbeat_ack" }));
      }
    }
  }

  async routeMessage(data) {
    const { toId, messageId, payload, msgType, timestamp } = data;
    if (!toId || !messageId || !payload) return;

    // Store message in KV for offline delivery (TTL 7 days)
    const msgKey = `pending:${toId}:${messageId}`;
    await this.env.REGISTRY.put(msgKey, JSON.stringify({
      messageId,
      fromId: this.id,
      toId,
      payload,   // encrypted blob — server cannot read
      msgType:   msgType || "text",
      timestamp: timestamp || Date.now(),
    }), { expirationTtl: 604800 }); // 7 days

    // Try to deliver live if recipient is online
    const recipientId = this.env.USER_SESSION.idFromName(toId);
    const recipientDO = this.env.USER_SESSION.get(recipientId);

    try {
      const res = await recipientDO.fetch("https://relay/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          messageId,
          fromId: this.id,
          payload,
          msgType: msgType || "text",
          timestamp: timestamp || Date.now(),
        }),
      });

      if (res.ok) {
        // Message delivered live — send delivered receipt to sender
        this.ws?.send(JSON.stringify({
          type: "receipt",
          messageId,
          status: "delivered",
        }));
        // Delete from pending
        await this.env.REGISTRY.delete(msgKey);
      } else {
        // Offline — message stored for later
        this.ws?.send(JSON.stringify({
          type: "receipt",
          messageId,
          status: "sent",
        }));
      }
    } catch {
      this.ws?.send(JSON.stringify({
        type: "receipt",
        messageId,
        status: "sent",
      }));
    }
  }

  async routeReceipt(data) {
    const { toId, messageId, status } = data;
    if (!toId) return;
    const recipientId = this.env.USER_SESSION.idFromName(toId);
    const recipientDO = this.env.USER_SESSION.get(recipientId);
    await recipientDO.fetch("https://relay/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "receipt", messageId, fromId: this.id, status }),
    }).catch(() => {});
  }

  async routeTyping(data) {
    const { toId, isTyping } = data;
    if (!toId) return;
    const recipientId = this.env.USER_SESSION.idFromName(toId);
    const recipientDO = this.env.USER_SESSION.get(recipientId);
    await recipientDO.fetch("https://relay/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "typing", fromId: this.id, isTyping }),
    }).catch(() => {});
  }

  async deliverMessage(request) {
    if (!this.ws) {
      return new Response("offline", { status: 503 });
    }
    const data = await request.json();
    this.ws.send(JSON.stringify(data));
    return new Response("ok");
  }
}

// ── Main Worker ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── WebSocket upgrade → route to user's Durable Object ──
    if (url.pathname === "/ws") {
      const shortId = url.searchParams.get("id");
      if (!shortId || !shortId.startsWith("urai_")) {
        return new Response("Invalid ID", { status: 400 });
      }
      const doId = env.USER_SESSION.idFromName(shortId);
      const doObj = env.USER_SESSION.get(doId);
      return doObj.fetch(request);
    }

    // ── Register user pubkeys ──
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const { shortId, signingPubKey, exchangePubKey } = await request.json();
        if (!shortId?.startsWith("urai_")) {
          return Response.json({ error: "Invalid ID" }, { status: 400, headers: corsHeaders });
        }
        await env.REGISTRY.put(`user:${shortId}`, JSON.stringify({
          shortId,
          signingPubKey,
          exchangePubKey,
          registeredAt: Date.now(),
        }));
        return Response.json({ success: true, shortId }, { headers: corsHeaders });
      } catch {
        return Response.json({ error: "Bad request" }, { status: 400, headers: corsHeaders });
      }
    }

    // ── Lookup user pubkeys ──
    if (url.pathname.startsWith("/lookup/") && request.method === "GET") {
      const shortId = url.pathname.replace("/lookup/", "");
      const data = await env.REGISTRY.get(`user:${shortId}`);
      if (!data) {
        return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(JSON.parse(data), { headers: corsHeaders });
    }

    // ── Get pending offline messages ──
    if (url.pathname === "/pending" && request.method === "GET") {
      const shortId = url.searchParams.get("id");
      if (!shortId) return Response.json({ messages: [] }, { headers: corsHeaders });

      const list = await env.REGISTRY.list({ prefix: `pending:${shortId}:` });
      const messages = await Promise.all(
        list.keys.map(async (k) => {
          const val = await env.REGISTRY.get(k.name);
          return val ? JSON.parse(val) : null;
        })
      );

      // Delete delivered pending messages
      await Promise.all(list.keys.map(k => env.REGISTRY.delete(k.name)));

      return Response.json({
        messages: messages.filter(Boolean)
      }, { headers: corsHeaders });
    }

    // ── Check online status ──
    if (url.pathname.startsWith("/online/") && request.method === "GET") {
      const shortId = url.pathname.replace("/online/", "");
      const data = await env.REGISTRY.get(`online:${shortId}`);
      return Response.json({
        online: !!data,
        lastSeen: data ? JSON.parse(data).lastSeen : null,
      }, { headers: corsHeaders });
    }

    // ── Health check ──
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "Uraiadal Relay",
        version: "1.0.0",
        timestamp: Date.now(),
      }, { headers: corsHeaders });
    }

    return new Response("Uraiadal Relay v1.0", { headers: corsHeaders });
  }
};
