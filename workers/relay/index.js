/**
 * Uraiadal Relay Worker v4
 * KV-first for ALL signal types — guaranteed delivery
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

    // Flush ALL pending items (messages + call signals)
    const pending = await this.env.REGISTRY.list({ prefix: `pending:${shortId}:` });
    for (const key of pending.keys) {
      const val = await this.env.REGISTRY.get(key.name);
      if (val) {
        server.send(val);
        await this.env.REGISTRY.delete(key.name);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMsg) {
    // Size guard
    if (rawMsg.length > 65536) return;

    const tags   = this.state.getTags(ws);
    const fromId = tags[0];
    if (!fromId) return;

    let data;
    try { data = JSON.parse(rawMsg); } catch { return; }

    const { type } = data;

    // ── Heartbeat ──────────────────────────────────────────────────────────
    if (type === "heartbeat") {
      await this.env.REGISTRY.put(
        `online:${fromId}`,
        JSON.stringify({ shortId: fromId, ts: Date.now() }),
        { expirationTtl: 120 }
      );
      ws.send(JSON.stringify({ type: "heartbeat_ack" }));
      return;
    }

    // ── Chat message ───────────────────────────────────────────────────────
    if (type === "message") {
      const { toId, messageId, payload, msgType, timestamp } = data;
      if (!toId || !messageId) return;

      // Rate limit: 60 msgs/min per sender
      const rlKey   = `rl:${fromId}`;
      const rlCount = parseInt(await this.env.REGISTRY.get(rlKey) || "0");
      if (rlCount > 60) {
        ws.send(JSON.stringify({ type:"error", message:"Rate limited" }));
        return;
      }
      await this.env.REGISTRY.put(rlKey, String(rlCount + 1), { expirationTtl: 60 });

      const envelope = JSON.stringify({
        type: "message", messageId, fromId, toId,
        payload, msgType: msgType || "text",
        timestamp: timestamp || Date.now(),
      });

      // Always store first (7 day TTL)
      const kvKey = `pending:${toId}:msg_${messageId}`;
      await this.env.REGISTRY.put(kvKey, envelope, { expirationTtl: 604800 });

      // Attempt live delivery
      const delivered = await this._deliverLive(toId, envelope);
      if (delivered) await this.env.REGISTRY.delete(kvKey);

      ws.send(JSON.stringify({
        type: "receipt", messageId,
        status: delivered ? "delivered" : "sent",
      }));
      return;
    }

    // ── Receipts ───────────────────────────────────────────────────────────
    if (type === "receipt") {
      const { toId, messageId, status } = data;
      if (!toId) return;
      const envelope = JSON.stringify({ type:"receipt", messageId, fromId, status });
      const kvKey    = `pending:${toId}:rcpt_${messageId}_${Date.now()}`;
      await this.env.REGISTRY.put(kvKey, envelope, { expirationTtl: 86400 });
      const ok = await this._deliverLive(toId, envelope);
      if (ok) await this.env.REGISTRY.delete(kvKey);
      return;
    }

    // ── Typing ─────────────────────────────────────────────────────────────
    if (type === "typing") {
      const { toId, isTyping } = data;
      if (!toId) return;
      // Typing is ephemeral — live only, no KV
      await this._deliverLive(toId,
        JSON.stringify({ type:"typing", fromId, isTyping })
      );
      return;
    }

    // ── Call signaling ─────────────────────────────────────────────────────
    if (type === "call_signal") {
      const { toId, signal } = data;
      if (!toId || !signal) return;

      const envelope = JSON.stringify({ type:"call_signal", fromId, signal });
      const sigType  = signal.type || "unknown";

      // offer + answer + hangup + reject → store in KV (short TTL 2 min)
      // ice candidates → live only (stale ICE is useless)
      if (sigType !== "ice") {
        const kvKey = `pending:${toId}:call_${sigType}_${Date.now()}`;
        await this.env.REGISTRY.put(kvKey, envelope, { expirationTtl: 120 });
        const ok = await this._deliverLive(toId, envelope);
        if (ok) await this.env.REGISTRY.delete(kvKey);
      } else {
        // ICE — live only
        await this._deliverLive(toId, envelope);
      }
      return;
    }
  }

  // Deliver to recipient's active WebSocket via their DO instance
  async _deliverLive(toId, envelope) {
    try {
      const recipDO = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(toId)
      );
      const res = await recipDO.fetch(
        new Request("https://relay/deliver", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    envelope,
        })
      );
      return res.ok && (await res.text()) === "ok";
    } catch { return false; }
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
    const url = new URL(request.url);

    const allowedOrigins = [
      "https://uraiadal.pages.dev",
      "http://localhost:5173",
      "http://localhost:3000",
    ];
    const origin     = request.headers.get("Origin") || "";
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    const cors = {
      "Access-Control-Allow-Origin":  corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const shortId = url.searchParams.get("id");
      if (!shortId?.startsWith("urai_")) {
        return new Response("Invalid ID", { status: 400 });
      }
      const doId = env.USER_SESSION.idFromName(shortId);
      return env.USER_SESSION.get(doId).fetch(request);
    }

    // Register pubkeys
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const { shortId, signingPubKey, exchangePubKey } = await request.json();
        if (!shortId?.startsWith("urai_")) return json({ error:"Invalid ID" }, 400);
        await env.REGISTRY.put(`user:${shortId}`, JSON.stringify({
          shortId, signingPubKey, exchangePubKey, ts: Date.now(),
        }));
        return json({ success:true, shortId });
      } catch { return json({ error:"Bad request" }, 400); }
    }

    // Lookup pubkeys
    if (url.pathname.startsWith("/lookup/")) {
      const shortId = url.pathname.replace("/lookup/", "");
      const data    = await env.REGISTRY.get(`user:${shortId}`);
      if (!data) return json({ error:"Not found" }, 404);
      return json(JSON.parse(data));
    }

    // Pending — fetch all queued items (messages + call signals)
    if (url.pathname === "/pending") {
      const shortId = url.searchParams.get("id");
      if (!shortId) return json({ messages:[] });
      const list = await env.REGISTRY.list({ prefix:`pending:${shortId}:` });
      const items = await Promise.all(
        list.keys.map(async k => {
          const val = await env.REGISTRY.get(k.name);
          if (val) {
            await env.REGISTRY.delete(k.name);
            return JSON.parse(val);
          }
          return null;
        })
      );
      // Separate chat messages from other signals
      const all = items.filter(Boolean);
      return json({
        messages: all.filter(i => i.type === "message"),
        signals:  all.filter(i => i.type !== "message"),
      });
    }

    // Online status
    if (url.pathname.startsWith("/online/")) {
      const shortId = url.pathname.replace("/online/", "");
      const data    = await env.REGISTRY.get(`online:${shortId}`);
      return json({ online:!!data, lastSeen: data ? JSON.parse(data).ts : null });
    }

    // ── Call signaling via HTTP (reliable, no WS needed) ──
    // POST /signal — store signal for recipient
    if (url.pathname === "/signal" && request.method === "POST") {
      try {
        // Parse body — accept any valid JSON
        let body;
        try { body = await request.json(); }
        catch { return json({ error:"Invalid JSON" }, 400); }

        const { fromId, toId, signal } = body;

        // Basic presence check
        if (!fromId || !toId || !signal) {
          return json({ error:"Missing fields" }, 400);
        }

        // ID format check
        if (!String(fromId).startsWith("urai_") || !String(toId).startsWith("urai_")) {
          return json({ error:"Invalid IDs" }, 400);
        }

        // Accept any signal with a type string, or default to "unknown"
        const sigType = signal.type || "unknown";

        // TTL: ICE=30s, offer/answer/hangup/reject=120s
        const ttl = sigType === "ice" ? 30 : 120;

        // Store signal — serialize safely
        const envelope = JSON.stringify({ fromId, signal, ts:Date.now() });
        const key = `sig:${toId}:${sigType}_${fromId}_${Date.now()}`;
        await env.REGISTRY.put(key, envelope, { expirationTtl:ttl });

        // also attempt live WS delivery
        try {
          const doId    = env.USER_SESSION.idFromName(toId);
          const doInst  = env.USER_SESSION.get(doId);
          await doInst.fetch(new Request("https://relay/deliver", {
            method:  "POST",
            headers: { "Content-Type":"application/json" },
            body:    JSON.stringify({ type:"call_signal", fromId, signal }),
          }));
        } catch {}

        return json({ success:true });
      } catch { return json({ error:"Bad request" }, 400); }
    }

    // GET /signal?id=urai_xxx — fetch pending signals for recipient
    if (url.pathname === "/signal" && request.method === "GET") {
      const shortId = url.searchParams.get("id");
      if (!shortId?.startsWith("urai_")) return json({ signals:[] });
      const list = await env.REGISTRY.list({ prefix:`sig:${shortId}:` });
      const signals = await Promise.all(
        list.keys.map(async k => {
          const val = await env.REGISTRY.get(k.name);
          if (val) {
            await env.REGISTRY.delete(k.name);
            return JSON.parse(val);
          }
          return null;
        })
      );
      return json({ signals: signals.filter(Boolean) });
    }

    // Health
    if (url.pathname === "/health") {
      return json({ status:"ok", service:"Uraiadal Relay", version:"4.1.0", timestamp:Date.now() });
    }

    return new Response("Uraiadal Relay v4.0", { headers:cors });
  }
};
