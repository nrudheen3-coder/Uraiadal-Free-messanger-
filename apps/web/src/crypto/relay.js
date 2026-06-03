/**
 * Uraiadal Relay Client
 * Connects to Cloudflare Workers Durable Object WebSocket relay
 */

const RELAY_URL = import.meta.env.VITE_RELAY_URL || "wss://relay.uraiadal.workers.dev";

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;
const listeners = new Map();

/** Connect to relay with identity token */
export function connectRelay(shortId, authToken) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(`${RELAY_URL}/ws?id=${shortId}&token=${authToken}`);

  ws.onopen = () => {
    console.log("[Relay] Connected ✓");
    reconnectDelay = 1000;
    emit("connect");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      emit(data.type, data);
    } catch (e) {
      console.warn("[Relay] Bad message:", e);
    }
  };

  ws.onclose = () => {
    console.log("[Relay] Disconnected — retrying in", reconnectDelay, "ms");
    emit("disconnect");
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connectRelay(shortId, authToken);
    }, reconnectDelay);
  };

  ws.onerror = (err) => {
    console.error("[Relay] Error:", err);
    emit("error", err);
  };
}

/** Disconnect and stop reconnecting */
export function disconnectRelay() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

/** Send an encrypted message payload */
export function sendMessage(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[Relay] Not connected — message queued");
    return false;
  }
  ws.send(JSON.stringify({ type: "message", ...payload }));
  return true;
}

/** Send delivery receipt */
export function sendReceipt(messageId, recipientId, status) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "receipt", messageId, recipientId, status }));
}

/** Send typing indicator */
export function sendTyping(recipientId, isTyping) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "typing", recipientId, isTyping }));
}

/** Subscribe to relay events */
export function onRelayEvent(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => listeners.get(event).delete(callback);
}

function emit(event, data) {
  listeners.get(event)?.forEach(cb => cb(data));
}

export function isConnected() {
  return ws?.readyState === WebSocket.OPEN;
}
