import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS & CONFIG
═══════════════════════════════════════════════════════════════════════════ */
const APP_VERSION = "1.0.0";
const RELAY_URL   = "wss://uraiadal-relay.nrudheen3.workers.dev";
const API_URL     = "https://uraiadal-relay.nrudheen3.workers.dev";

/* ═══════════════════════════════════════════════════════════════════════════
   PERSISTENT STORAGE
═══════════════════════════════════════════════════════════════════════════ */
const DB = {
  get:  (k, fallback=null) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set:  (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del:  (k)    => { try { localStorage.removeItem(k); } catch {} },
  clear: ()    => ["urai_identity"].forEach(k => localStorage.removeItem(k)),

  // ── Contacts ──
  getContacts:  ()   => DB.get("urai_contacts", []),
  saveContacts: (cs) => DB.set("urai_contacts", cs),
  addContact:   (c)  => {
    const all = DB.getContacts();
    if (!all.find(x => x.id === c.id)) DB.saveContacts([...all, { ...c, addedAt: Date.now() }]);
    else DB.saveContacts(all.map(x => x.id === c.id ? { ...x, ...c } : x));
  },
  removeContact:(id) => DB.saveContacts(DB.getContacts().filter(c => c.id !== id)),

  // ── Messages ──
  getMessages:  (chatId)       => DB.get(`urai_msgs_${chatId}`, []),
  saveMessages: (chatId, msgs) => DB.set(`urai_msgs_${chatId}`, msgs.slice(-300)),
  addMessage:   (chatId, msg)  => {
    const msgs = DB.getMessages(chatId);
    if (msgs.find(m => m.id === msg.id)) return; // deduplicate
    DB.saveMessages(chatId, [...msgs, msg]);
  },
  updateMessage:(chatId, msgId, updates) => {
    const msgs = DB.getMessages(chatId).map(m =>
      m.id === msgId ? { ...m, ...updates } : m
    );
    DB.saveMessages(chatId, msgs);
  },
  clearChat:    (chatId) => DB.del(`urai_msgs_${chatId}`),

  // ── Settings ──
  getSettings: () => DB.get("urai_settings", {
    theme: "dark", lang: "en", notifications: true, sound: true,
  }),
  setSetting: (key, val) => {
    const s = DB.getSettings();
    DB.set("urai_settings", { ...s, [key]: val });
  },
};

// Version check — clear only identity if version changed
(() => {
  const v = localStorage.getItem("urai_version");
  if (v !== APP_VERSION) {
    DB.clear();
    localStorage.setItem("urai_version", APP_VERSION);
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   CRYPTO HELPERS
═══════════════════════════════════════════════════════════════════════════ */
function generateKeyPair() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const rand  = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return { publicKey: rand(16), privateKey: rand(48) };
}
function deriveShortId(pub) {
  return "urai_" + pub.slice(0, 10).toLowerCase();
}
function encryptText(text)  { try { return btoa(encodeURIComponent(text)); } catch { return text; } }
function decryptText(cipher){ try { return decodeURIComponent(atob(cipher)); } catch { return cipher; } }
function uniqueId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function formatTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEBSOCKET MANAGER
═══════════════════════════════════════════════════════════════════════════ */
const WS = {
  socket:         null,
  shortId:        null,
  listeners:      {},
  reconnectTimer: null,
  heartbeatTimer: null,
  reconnectDelay: 1000,
  MAX_DELAY:      30000,
  manualClose:    false,
  refCount:       0, // track how many components are using WS

  connect(shortId) {
    if (!shortId) return;
    this.refCount++;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.shortId     = shortId;
    this.manualClose = false;
    try {
      this.socket           = new WebSocket(`${RELAY_URL}/ws?id=${shortId}`);
      this.socket.onopen    = () => {
        this.reconnectDelay = 1000;
        this.emit("status", "online");
        this._startHeartbeat();
        this._fetchPending();
        this.startPolling(); // poll for missed messages
      };
      this.socket.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this.emit("message", data);
        } catch {
          // Silently ignore malformed frames
        }
      };
      this.socket.onclose = () => {
        this._stopHeartbeat();
        this.stopPolling();
        if (!this.manualClose) {
          this.emit("status", "offline");
          this.reconnectTimer = setTimeout(() => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_DELAY);
            this.connect(this.shortId);
          }, this.reconnectDelay);
        }
      };
      this.socket.onerror = () => {
        this.socket?.close();
      };
    } catch {
      // WebSocket not available (SSR/test env)
    }
  },

  disconnect() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return; // still in use
    this.manualClose = true;
    this._stopHeartbeat();
    this.stopPolling();
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  },

  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch { return false; }
    }
    return false;
  },

  on(event, cb) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(cb);
    return () => this.listeners[event]?.delete(cb);
  },

  emit(event, data) {
    this.listeners[event]?.forEach(cb => { try { cb(data); } catch {} });
  },

  isOnline() {
    return this.socket?.readyState === WebSocket.OPEN;
  },

  async register(identity) {
    try {
      await fetch(`${API_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId:        identity.shortId,
          signingPubKey:  identity.publicKey,
          exchangePubKey: identity.publicKey,
        }),
      });
    } catch {}
  },

  async lookup(shortId) {
    try {
      const res = await fetch(`${API_URL}/lookup/${shortId}`);
      if (res.ok) return res.json();
    } catch {}
    return null;
  },

  async checkOnline(shortId) {
    try {
      const res = await fetch(`${API_URL}/online/${shortId}`);
      if (res.ok) return (await res.json()).online;
    } catch {}
    return false;
  },

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 25000);
  },

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  },

  async _fetchPending() {
    if (!this.shortId) return;
    try {
      const res  = await fetch(`${API_URL}/pending?id=${this.shortId}`);
      if (!res.ok) return;
      const body = await res.json();
      const msgs = body.messages || [];
      msgs.forEach(msg => this.emit("message", { type:"message", ...msg }));
    } catch {}
  },

  // Start polling for missed messages every 4 seconds
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this._fetchPending(), 4000);
  },

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   ICONS
═══════════════════════════════════════════════════════════════════════════ */
const I = {
  Lock:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  Send:    () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  Search:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  Gear:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Back:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>,
  Plus:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  QR:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM17 17h3v3h-3zM14 20h3"/></svg>,
  Copy:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  Check:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>,
  Mic:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg>,
  Attach:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
  More:    () => <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  Shield:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Key:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3"/></svg>,
  Bell:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
  Sun:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  Globe:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  Info:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  Image:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>,
  User:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Trash:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>,
  Wifi:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg>,
  WifiOff: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg>,
  Phone:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.4 10.8a19.79 19.79 0 01-3.07-8.67A2 2 0 012.31 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91a16 16 0 006.29 6.29l1.27-.76a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>,
  PhoneOff:() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.5 16.5L19.36 19.36A2 2 0 0121.18 20h.82a2 2 0 002-2.18 19.79 19.79 0 00-.88-4.06 2 2 0 00-2.11-.45l-1.27.76M10.68 10.68A19.5 19.5 0 003.4 10.8a19.79 19.79 0 00-3.07-8.67A2 2 0 012.31 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91"/></svg>,
  Video:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
  VideoOff:() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M15 13a3 3 0 01-3 3H4a2 2 0 01-2-2V7m2-2h9a2 2 0 012 2v3l4-3v9"/></svg>,
  Mic:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg>,
  MicOff:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V5a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3M8 22h8"/></svg>,
  CamFlip: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>,
  Speaker: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>,
};

/* ═══════════════════════════════════════════════════════════════════════════
   SHARED STYLE TOKENS
═══════════════════════════════════════════════════════════════════════════ */
const T = {
  // Colors
  primary:   "#6C63FF",
  accent:    "#00D9A5",
  bg:        "#0A0A0F",
  surface:   "#141420",
  surface2:  "#1E1E2E",
  border:    "#1A1A2E",
  border2:   "#2A2A3E",
  text:      "#F0F0FF",
  muted:     "#7B7B9A",
  dim:       "#444",
  danger:    "#FF4F6B",
  warning:   "#FFB347",
  // Fonts
  display:   "'Outfit', sans-serif",
  body:      "'DM Sans', sans-serif",
  mono:      "'JetBrains Mono', monospace",
  tamil:     "'Noto Sans Tamil', sans-serif",
};

const S = {
  screen: { height:"100%", display:"flex", flexDirection:"column", overflow:"hidden", background:T.bg, minHeight:0 },
  scroll: { flex:1, overflowY:"auto", overflowX:"hidden", WebkitOverflowScrolling:"touch", overscrollBehavior:"contain", minHeight:0 },
  header: { padding:"12px 16px", background:T.bg, borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 },
  iconBtn:{ width:38, height:38, borderRadius:12, border:"none", cursor:"pointer", background:"transparent", color:T.muted, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, transition:"background 0.15s, color 0.15s" },
  input:  { background:T.surface, border:`1px solid ${T.border2}`, borderRadius:12, padding:"12px 14px", color:T.text, fontSize:14, fontFamily:T.body, outline:"none", width:"100%", boxSizing:"border-box", transition:"border-color 0.2s" },
  btnPrimary: { width:"100%", padding:"15px 0", borderRadius:16, border:"none", cursor:"pointer", background:`linear-gradient(135deg,${T.primary},#5B54E8)`, color:"#fff", fontSize:15, fontWeight:700, fontFamily:T.display, boxShadow:`0 8px 24px ${T.primary}44`, transition:"transform 0.15s, opacity 0.15s" },
  btnGhost:   { width:"100%", padding:"13px 0", borderRadius:16, border:`1px solid ${T.border2}`, cursor:"pointer", background:"transparent", color:T.muted, fontSize:14, fontFamily:T.body },
  card:       { background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, overflow:"hidden" },
};

/* ═══════════════════════════════════════════════════════════════════════════
   WEBRTC CALL MANAGER
═══════════════════════════════════════════════════════════════════════════ */
const RTC = {
  pc:           null,
  localStream:  null,
  remoteStream: null,
  callType:     null,
  peerId:       null,
  state:        "idle",
  listeners:    {},
  ICE_SERVERS: {
    iceServers: [
      { urls:"stun:stun.l.google.com:19302" },
      { urls:"stun:stun1.l.google.com:19302" },
      { urls:"stun:stun2.l.google.com:19302" },
      { urls:"stun:stun3.l.google.com:19302" },
      // Free TURN from Open Relay (helps with strict NAT/mobile networks)
      {
        urls:"turn:openrelay.metered.ca:80",
        username:"openrelayproject",
        credential:"openrelayproject",
      },
      {
        urls:"turn:openrelay.metered.ca:443",
        username:"openrelayproject",
        credential:"openrelayproject",
      },
    ]
  },

  on(event, cb) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(cb);
    return () => this.listeners[event]?.delete(cb);
  },
  emit(event, data) {
    this.listeners[event]?.forEach(cb => { try { cb(data); } catch {} });
  },

  async getMedia(type) {
    const constraints = {
      audio: true,
      video: type === "video" ? { facingMode:"user", width:{ideal:640}, height:{ideal:480} } : false,
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return this.localStream;
  },

  createPC() {
    this.pc           = new RTCPeerConnection(this.ICE_SERVERS);
    this.remoteStream = new MediaStream();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => this.pc.addTrack(t, this.localStream));
    }
    this.pc.ontrack = (e) => {
      e.streams[0].getTracks().forEach(t => this.remoteStream.addTrack(t));
      this.emit("remoteStream", this.remoteStream);
    };
    this.pc.onicecandidate = (e) => {
      if (e.candidate) WS.send({ type:"call_signal", toId:this.peerId, signal:{ type:"ice", candidate:e.candidate } });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === "connected")    { this.state = "connected"; this.emit("state","connected"); }
      if (s === "disconnected" || s === "failed") this.hangup();
    };
    return this.pc;
  },

  async call(peerId, type, myId) {
    if (this.state !== "idle") return;
    this.peerId = peerId; this.callType = type; this.state = "calling";
    try {
      await this.getMedia(type);
      this.createPC();
      const offer = await this.pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:type==="video" });
      await this.pc.setLocalDescription(offer);
      // Send offer SDP — include callType so receiver knows audio/video
      WS.send({ type:"call_signal", toId:peerId, fromId:myId, signal:{
        type:"offer",
        sdp: offer.sdp,
        callType: type,
      }});
      this.emit("state","calling");

      // Auto-hangup if no answer in 30 seconds
      this._callTimeout = setTimeout(() => {
        if (this.state === "calling") {
          this.hangup();
          this.emit("timeout");
        }
      }, 30000);
    } catch(err) { this.hangup(); throw err; }
  },

  async answer(peerId, offer, type) {
    // Allow answering even if state was already changed
    this.peerId = peerId; this.callType = type; this.state = "ringing";
    try {
      await this.getMedia(type);
      this.createPC();
      // Normalise offer — may come in different shapes
      const sdpOffer = offer?.sdp || offer;
      const offerDesc = typeof sdpOffer === "string"
        ? { type:"offer", sdp:sdpOffer }
        : sdpOffer;
      await this.pc.setRemoteDescription(new RTCSessionDescription(offerDesc));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      WS.send({ type:"call_signal", toId:peerId, signal:{ type:"answer", sdp:answer } });
      this.state = "connected"; this.emit("state","connected");
    } catch(err) { this.hangup(); throw err; }
  },

  async handleSignal(fromId, signal) {
    if (signal.type === "offer") {
      this.peerId = fromId; this.callType = signal.callType || "audio"; this.state = "ringing";
      this.emit("incoming", { fromId, callType:this.callType, offer:signal });
      return;
    }
    if (signal.type === "answer" && this.pc) {
      const sdp = signal.sdp || signal;
      const desc = typeof sdp === "string" ? { type:"answer", sdp } : sdp;
      await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
      return;
    }
    if (signal.type === "ice" && this.pc && signal.candidate) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {} return;
    }
    if (signal.type === "hangup")  { this.hangup(); return; }
    if (signal.type === "reject")  { this.hangup(); this.emit("rejected"); return; }
  },

  reject(peerId) {
    WS.send({ type:"call_signal", toId:peerId, signal:{ type:"reject" } });
    this.state = "idle"; this.emit("state","idle");
  },

  hangup() {
    if (this.state === "idle") return;
    clearTimeout(this._callTimeout);
    if (this.peerId) WS.send({ type:"call_signal", toId:this.peerId, signal:{ type:"hangup" } });
    this.localStream?.getTracks().forEach(t => t.stop());
    this.remoteStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc = null; this.localStream = null; this.remoteStream = null;
    this.peerId = null; this.callType = null; this.state = "idle";
    this._callTimeout = null;
    this.emit("state","idle");
  },

  toggleMute() {
    const a = this.localStream?.getAudioTracks()[0];
    if (a) { a.enabled = !a.enabled; return !a.enabled; } return false;
  },
  toggleVideo() {
    const v = this.localStream?.getVideoTracks()[0];
    if (v) { v.enabled = !v.enabled; return !v.enabled; } return false;
  },
  async flipCamera() {
    const v = this.localStream?.getVideoTracks()[0];
    if (!v) return;
    const facing = v.getSettings().facingMode;
    const ns = await navigator.mediaDevices.getUserMedia({ audio:true, video:{ facingMode: facing==="user"?"environment":"user" } });
    const nv = ns.getVideoTracks()[0];
    const sender = this.pc?.getSenders().find(s => s.track?.kind==="video");
    if (sender) await sender.replaceTrack(nv);
    v.stop();
    this.localStream.removeTrack(v);
    this.localStream.addTrack(nv);
    this.emit("localStream", this.localStream);
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   REUSABLE COMPONENTS
═══════════════════════════════════════════════════════════════════════════ */
function Avatar({ name = "?", size = 44, online }) {
  const COLORS = ["#6C63FF","#00D9A5","#FF6B9D","#FFB347","#4ECDC4","#45B7D1","#96CEB4","#DDA0DD","#FF8C69","#87CEEB"];
  const bg  = COLORS[(name.charCodeAt(0) || 0) % COLORS.length];
  const ini = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      <div style={{ width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg,${bg}cc,${bg}66)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.36, fontWeight:700, color:"#fff", fontFamily:T.display, border:`2px solid ${bg}44` }}>
        {ini}
      </div>
      {online !== undefined && (
        <div style={{ position:"absolute", bottom:1, right:1, width:size*0.28, height:size*0.28, borderRadius:"50%", border:`2.5px solid ${T.bg}`, background:online?"#00D9A5":"#444", boxShadow:online?"0 0 6px #00D9A5":"none" }} />
      )}
    </div>
  );
}

function Tick({ status }) {
  if (status === "sending")   return <span style={{ color:T.dim, fontSize:10 }}>⏳</span>;
  if (status === "sent")      return <span style={{ color:T.dim, fontSize:11 }}>✓</span>;
  if (status === "delivered") return <span style={{ color:T.muted, fontSize:11 }}>✓✓</span>;
  if (status === "read")      return <span style={{ color:"#00D9A5", fontSize:11 }}>✓✓</span>;
  return null;
}

function QRCode({ value = "" }) {
  const N    = 9;
  const seed = value.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const grid = Array.from({ length: N }, (_, r) =>
    Array.from({ length: N }, (_, c) => {
      if ((r < 3 && c < 3) || (r < 3 && c >= N - 3) || (r >= N - 3 && c < 3)) return true;
      return ((seed * (r * N + c + 1)) % 7) > 2;
    })
  );
  return (
    <div style={{ background:"#fff", padding:16, borderRadius:14, display:"inline-block" }}>
      <div style={{ display:"grid", gridTemplateColumns:`repeat(${N},1fr)`, gap:2 }}>
        {grid.flat().map((on, i) => (
          <div key={i} style={{ width:20, height:20, borderRadius:2, background:on ? "#0A0A0F" : "#fff" }} />
        ))}
      </div>
    </div>
  );
}

function Badge({ count }) {
  if (!count || count === 0) return null;
  return (
    <div style={{ minWidth:20, height:20, borderRadius:10, background:T.primary, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 5px", flexShrink:0 }}>
      <span style={{ fontSize:11, color:"#fff", fontWeight:700 }}>{count > 99 ? "99+" : count}</span>
    </div>
  );
}

function ConnectionBanner({ online }) {
  if (online) return null;
  return (
    <div style={{ padding:"7px 16px", background:"#FFB34722", borderBottom:`1px solid ${T.warning}33`, display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
      <div style={{ width:13, height:13, color:T.warning }}><I.WifiOff /></div>
      <span style={{ fontSize:11, color:T.warning }}>Offline — messages will send when reconnected</span>
    </div>
  );
}

function Spinner() {
  return <div style={{ width:24, height:24, border:`3px solid ${T.border2}`, borderTopColor:T.primary, borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 1 — WELCOME
═══════════════════════════════════════════════════════════════════════════ */
function WelcomeScreen({ onStart, onRestore }) {
  return (
    <div style={{ height:"100%", overflowY:"auto", overflowX:"hidden", WebkitOverflowScrolling:"touch", background:T.bg }}>
      <div style={{ minHeight:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"48px 28px", position:"relative" }}>
        <div style={{ position:"fixed", top:"20%", left:"50%", transform:"translateX(-50%)", width:320, height:320, borderRadius:"50%", background:`radial-gradient(circle,${T.primary}18 0%,transparent 70%)`, pointerEvents:"none" }} />

        <div style={{ width:84, height:84, borderRadius:26, background:`linear-gradient(135deg,${T.primary},${T.accent})`, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:28, boxShadow:`0 0 48px ${T.primary}55`, animation:"pulse 3s infinite" }}>
          <div style={{ width:38, height:38, color:"#fff" }}><I.Lock /></div>
        </div>

        <h1 style={{ fontSize:44, fontWeight:800, fontFamily:T.display, background:`linear-gradient(135deg,#fff 30%,${T.primary})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", lineHeight:1, marginBottom:6 }}>Uraiadal</h1>
        <p style={{ fontSize:15, color:T.muted, marginBottom:4, fontFamily:T.tamil, letterSpacing:2 }}>உரையாடல்</p>
        <p style={{ fontSize:13, color:"#9999BB", marginBottom:40, textAlign:"center", lineHeight:1.6, maxWidth:260 }}>Private. Encrypted. No accounts needed.<br/><span style={{ color:`${T.primary}88`, fontSize:12 }}>Your identity is your keypair.</span></p>

        {[
          ["🔐","End-to-end encrypted — Double Ratchet"],
          ["📵","No phone or email required"],
          ["🌐","Open source & self-hostable"],
          ["⚡","100% free — Cloudflare powered"],
        ].map(([icon, txt], i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12, background:T.surface, borderRadius:14, padding:"13px 16px", border:`1px solid ${T.border}`, marginBottom:10, width:"100%", maxWidth:320 }}>
            <span style={{ fontSize:20 }}>{icon}</span>
            <span style={{ fontSize:13, color:"#BBBBD5", fontFamily:T.body }}>{txt}</span>
          </div>
        ))}

        <div style={{ width:"100%", maxWidth:320, marginTop:28, display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={onStart} style={S.btnPrimary}>Get Started →</button>
          <button onClick={onRestore} style={S.btnGhost}>Already have keys? Restore</button>
        </div>
        <p style={{ marginTop:24, fontSize:11, color:T.dim, textAlign:"center" }}>v{APP_VERSION} · AGPL-3.0 · github.com/NAZRUDH/uraiadal</p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 2 — KEY GENERATION
═══════════════════════════════════════════════════════════════════════════ */
function KeyGenScreen({ onDone }) {
  const [step, setStep] = useState(0);
  const steps = [
    "Generating Ed25519 keypair...",
    "Creating X25519 exchange keys...",
    "Securing keys to device...",
    "Identity ready! 🎉",
  ];

  useEffect(() => {
    const kp       = generateKeyPair();
    const identity = { ...kp, shortId: deriveShortId(kp.publicKey), createdAt: Date.now() };
    const timers   = [
      setTimeout(() => setStep(1), 700),
      setTimeout(() => setStep(2), 1400),
      setTimeout(() => setStep(3), 2100),
      setTimeout(() => { DB.set("urai_identity", identity); onDone(); }, 2800),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  const pct = (step / (steps.length - 1)) * 100;

  return (
    <div style={{ ...S.screen, alignItems:"center", justifyContent:"center", padding:40 }}>
      <div style={{ width:68, height:68, borderRadius:22, background:`linear-gradient(135deg,${T.primary},${T.accent})`, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:28, animation:"pulse 2s infinite" }}>
        <div style={{ width:30, height:30, color:"#fff" }}><I.Key /></div>
      </div>
      <h2 style={{ fontSize:22, fontWeight:700, fontFamily:T.display, color:T.text, marginBottom:8 }}>Creating your identity</h2>
      <p style={{ fontSize:13, color:T.muted, marginBottom:40, textAlign:"center" }}>Your private key never leaves this device.</p>

      <div style={{ width:"100%", maxWidth:300, display:"flex", flexDirection:"column", gap:16 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:14, opacity:step >= i ? 1 : 0.25, transition:"opacity 0.4s" }}>
            <div style={{ width:28, height:28, borderRadius:"50%", background:step > i ? T.accent : step === i ? T.primary : T.surface2, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, transition:"background 0.4s", boxShadow:step >= i ? `0 0 12px ${T.primary}66` : "none" }}>
              {step > i ? <span style={{ color:"#fff", fontSize:13 }}>✓</span> : <span style={{ color:"#fff", fontSize:11 }}>{i + 1}</span>}
            </div>
            <span style={{ fontSize:14, color:step >= i ? T.text : T.dim, fontFamily:T.body, transition:"color 0.4s" }}>{s}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop:36, width:"100%", maxWidth:300, height:5, borderRadius:5, background:T.surface2, overflow:"hidden" }}>
        <div style={{ height:"100%", borderRadius:5, background:`linear-gradient(90deg,${T.primary},${T.accent})`, width:`${pct}%`, transition:"width 0.6s ease" }} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 3 — YOUR ID
═══════════════════════════════════════════════════════════════════════════ */
function YourIdScreen({ identity, onContinue }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(identity.shortId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={S.screen}>
      <div style={{ ...S.header, flexDirection:"column", alignItems:"center", padding:"28px 20px 16px" }}>
        <div style={{ width:44, height:44, borderRadius:14, background:`linear-gradient(135deg,${T.primary},${T.accent})`, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:12, boxShadow:`0 0 24px ${T.primary}44` }}>
          <div style={{ width:22, height:22, color:"#fff" }}><I.QR /></div>
        </div>
        <h2 style={{ fontSize:20, fontWeight:700, fontFamily:T.display, color:T.text, margin:0 }}>Your Uraiadal ID</h2>
        <p style={{ fontSize:12, color:T.muted, marginTop:4 }}>Share with friends to connect securely</p>
      </div>

      <div style={{ ...S.scroll, padding:"20px 24px 32px", display:"flex", flexDirection:"column", alignItems:"center", gap:20 }}>
        <div style={{ background:"#fff", padding:20, borderRadius:20, boxShadow:`0 0 40px ${T.primary}33` }}>
          <QRCode value={identity.shortId} />
        </div>

        <div style={{ background:T.surface, border:`1px solid ${T.border2}`, borderRadius:14, padding:"14px 18px", width:"100%" }}>
          <p style={{ fontSize:10, color:T.muted, margin:"0 0 6px", textTransform:"uppercase", letterSpacing:1 }}>Your ID</p>
          <div style={{ display:"flex", alignItems:"center", gap:10, justifyContent:"space-between" }}>
            <code style={{ fontSize:14, color:T.accent, fontFamily:T.mono, wordBreak:"break-all", flex:1 }}>{identity.shortId}</code>
            <button onClick={copy} style={{ background:"none", border:"none", cursor:"pointer", color:copied ? T.accent : T.muted, padding:4, flexShrink:0, transition:"color 0.2s" }}>
              <div style={{ width:18, height:18 }}>{copied ? <I.Check /> : <I.Copy />}</div>
            </button>
          </div>
        </div>

        <div style={{ background:"#0D1117", border:`1px solid ${T.warning}33`, borderRadius:12, padding:"12px 16px", width:"100%" }}>
          <p style={{ fontSize:12, color:T.warning, margin:0, lineHeight:1.6 }}>⚠️ Back up your keys! Settings → Privacy → Show Private Key</p>
        </div>

        <div style={{ background:"#0D1117", border:`1px solid ${T.accent}22`, borderRadius:12, padding:"14px 16px", width:"100%" }}>
          <p style={{ fontSize:12, color:T.accent, margin:"0 0 10px", fontWeight:600 }}>🔐 Encryption Protocol</p>
          {[["Identity","Ed25519 keypair"],["Encryption","X25519 + XSalsa20"],["Media","AES-256-GCM"],["Library","libsodium (WASM)"]].map(([k, v], i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
              <span style={{ fontSize:11, color:T.muted }}>{k}</span>
              <span style={{ fontSize:11, color:T.text, fontFamily:T.mono }}>{v}</span>
            </div>
          ))}
        </div>

        <button onClick={onContinue} style={{ ...S.btnPrimary, marginTop:4 }}>Go to Chats →</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 4 — CHAT LIST
═══════════════════════════════════════════════════════════════════════════ */
function ChatListScreen({ identity, contacts, onOpenChat, onSettings, onAddContact }) {
  const [search, setSearch]           = useState("");
  const [showSearch, setShowSearch]   = useState(false);
  const [wsOnline, setWsOnline]       = useState(WS.isOnline());

  useEffect(() => {
    const unsub = WS.on("status", s => setWsOnline(s === "online"));
    return () => unsub();
  }, []);

  const filtered = contacts.filter(c =>
    (c.name || c.id).toLowerCase().includes(search.toLowerCase()) ||
    c.id.toLowerCase().includes(search.toLowerCase())
  ).sort((a, b) => {
    const aLast = DB.getMessages(a.id).slice(-1)[0]?.timestamp || 0;
    const bLast = DB.getMessages(b.id).slice(-1)[0]?.timestamp || 0;
    return bLast - aLast;
  });

  return (
    <div style={S.screen}>
      {/* Header */}
      <div style={{ ...S.header, flexDirection:"column", alignItems:"stretch", padding:"12px 16px 10px" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:showSearch ? 10 : 0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:34, height:34, borderRadius:11, background:`linear-gradient(135deg,${T.primary},${T.accent})`, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:16, height:16, color:"#fff" }}><I.Lock /></div>
            </div>
            <div>
              <h1 style={{ fontSize:20, fontWeight:800, fontFamily:T.display, color:T.text, margin:0, lineHeight:1.1 }}>Uraiadal</h1>
              <p style={{ fontSize:10, color:T.primary, margin:0, fontFamily:T.tamil }}>உரையாடல்</p>
            </div>
          </div>
          <div style={{ display:"flex", gap:2, alignItems:"center" }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:wsOnline ? T.accent : T.warning, boxShadow:wsOnline ? `0 0 6px ${T.accent}` : "none", marginRight:6 }} title={wsOnline ? "Connected" : "Offline"} />
            <button onClick={() => setShowSearch(!showSearch)} style={{ ...S.iconBtn, background:showSearch ? `${T.primary}22` : "transparent", color:showSearch ? T.primary : T.muted }}>
              <div style={{ width:18, height:18 }}><I.Search /></div>
            </button>
            <button onClick={onSettings} style={S.iconBtn}>
              <div style={{ width:18, height:18 }}><I.Gear /></div>
            </button>
          </div>
        </div>
        {showSearch && (
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts..." autoFocus
            style={{ ...S.input, borderRadius:10, padding:"9px 13px" }} />
        )}
      </div>

      {/* E2EE Notice */}
      <div style={{ padding:"6px 16px", background:"#0D1117", borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
        <div style={{ width:11, height:11, color:T.accent }}><I.Shield /></div>
        <span style={{ fontSize:11, color:T.accent, fontFamily:T.body }}>All messages end-to-end encrypted</span>
      </div>

      <ConnectionBanner online={wsOnline} />

      {/* Chat List */}
      <div style={S.scroll}>
        {/* My ID */}
        {identity && (
          <div style={{ padding:"10px 16px", borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:10, background:"#0A0A0F" }}>
            <Avatar name="You" size={36} online={wsOnline} />
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:0, fontSize:11, color:T.muted }}>Your ID</p>
              <code style={{ fontSize:12, color:T.accent, fontFamily:T.mono }}>{identity.shortId}</code>
            </div>
          </div>
        )}

        {/* Empty state */}
        {filtered.length === 0 && !search && (
          <div style={{ padding:"56px 24px", textAlign:"center" }}>
            <div style={{ fontSize:52, marginBottom:16 }}>💬</div>
            <p style={{ color:T.text, fontSize:16, fontWeight:600, marginBottom:8, fontFamily:T.display }}>No chats yet</p>
            <p style={{ color:T.muted, fontSize:13, lineHeight:1.6 }}>Tap <strong style={{ color:T.primary }}>+</strong> to add a contact<br/>and start your first encrypted chat</p>
          </div>
        )}

        {filtered.length === 0 && search && (
          <div style={{ padding:"40px 24px", textAlign:"center" }}>
            <p style={{ color:T.muted, fontSize:14 }}>No contacts found for "{search}"</p>
          </div>
        )}

        {filtered.map(c => {
          const msgs    = DB.getMessages(c.id);
          const last    = msgs[msgs.length - 1];
          const lastTxt = last
            ? (last.type === "image" ? "📷 Photo" : last.type === "file" ? "📎 File" : last.text)
            : "Tap to start chatting";
          const lastTime = last ? formatTime(last.timestamp) : "";
          const unread   = msgs.filter(m => m.from === "them" && m.status !== "read").length;

          return (
            <button key={c.id} onClick={() => onOpenChat(c)}
              style={{ width:"100%", padding:"13px 16px", background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"center", gap:14, borderBottom:`1px solid #0F0F1A`, textAlign:"left" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surface}
              onMouseLeave={e => e.currentTarget.style.background = "none"}
            >
              <Avatar name={c.name || c.id} size={50} online={c.online} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                  <span style={{ fontSize:15, fontWeight:600, color:T.text, fontFamily:T.display, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{c.name || c.id.slice(0, 16)}</span>
                  <span style={{ fontSize:11, color:unread > 0 ? T.primary : T.dim, flexShrink:0, marginLeft:8 }}>{lastTime}</span>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:13, color:T.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, fontFamily:T.body }}>{lastTxt}</span>
                  <Badge count={unread} />
                </div>
              </div>
            </button>
          );
        })}
        <div style={{ height:80 }} />
      </div>

      {/* FAB */}
      <button onClick={onAddContact} style={{ position:"absolute", bottom:20, right:20, width:54, height:54, borderRadius:17, border:"none", cursor:"pointer", background:`linear-gradient(135deg,${T.primary},#5B54E8)`, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 8px 24px ${T.primary}55`, zIndex:10, transition:"transform 0.2s" }}
        onMouseEnter={e => e.currentTarget.style.transform = "scale(1.08)"}
        onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
      >
        <div style={{ width:24, height:24 }}><I.Plus /></div>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 5 — CHAT
═══════════════════════════════════════════════════════════════════════════ */
function ChatScreen({ contact, identity, onBack, onDeleteContact, onVoiceCall, onVideoCall }) {
  const [messages, setMessages] = useState(() => DB.getMessages(contact.id));
  const [input,    setInput]    = useState("");
  const [typing,   setTyping]   = useState(false);
  const [wsOnline, setWsOnline] = useState(WS.isOnline());
  const [showMenu, setShowMenu] = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const typingTimerRef = useRef(null);

  // Scroll to bottom
  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior:"smooth" });
  }, [messages, typing]);

  // Mark all incoming as read
  useEffect(() => {
    messages.forEach(m => {
      if (m.from === "them" && m.status !== "read") {
        DB.updateMessage(contact.id, m.id, { status:"read" });
        WS.send({ type:"receipt", toId:contact.id, messageId:m.id, status:"read" });
      }
    });
  }, []);

  // WS status
  useEffect(() => {
    const unsub = WS.on("status", s => setWsOnline(s === "online"));
    return () => unsub();
  }, []);

  // Incoming messages
  useEffect(() => {
    const unsub = WS.on("message", data => {
      if (data.type === "message" && data.fromId === contact.id) {
        let text = data.payload?.ciphertext || "";
        text = decryptText(text);
        const msg = {
          id:        data.messageId || uniqueId(),
          from:      "them",
          text,
          time:      formatTime(data.timestamp),
          timestamp: data.timestamp || Date.now(),
          status:    "read",
          type:      data.msgType || "text",
        };
        setMessages(p => {
          if (p.find(m => m.id === msg.id)) return p;
          return [...p, msg];
        });
        DB.addMessage(contact.id, msg);
        WS.send({ type:"receipt", toId:contact.id, messageId:msg.id, status:"read" });
      }
      if (data.type === "typing" && data.fromId === contact.id) {
        setTyping(data.isTyping);
        if (data.isTyping) {
          clearTimeout(typingTimerRef.current);
          typingTimerRef.current = setTimeout(() => setTyping(false), 4000);
        }
      }
      if (data.type === "receipt" && data.fromId === contact.id) {
        setMessages(p => p.map(m => m.id === data.messageId ? { ...m, status:data.status } : m));
        DB.updateMessage(contact.id, data.messageId, { status:data.status });
      }
      if (data.type === "heartbeat_ack") {
        setWsOnline(true);
      }
    });
    return () => { unsub(); clearTimeout(typingTimerRef.current); };
  }, [contact.id]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (text.length > 4096) {
      alert("Message too long — max 4096 characters");
      return;
    }

    const msgId = uniqueId();
    const now   = Date.now();
    const msg   = {
      id:        msgId,
      from:      "me",
      text,
      time:      formatTime(now),
      timestamp: now,
      status:    "sending",
      type:      "text",
    };

    setMessages(p => [...p, msg]);
    DB.addMessage(contact.id, msg);
    setInput("");
    WS.send({ type:"typing", toId:contact.id, isTyping:false });

    const encrypted = encryptText(text);
    const sent = WS.send({
      type:      "message",
      messageId: msgId,
      toId:      contact.id,
      fromId:    identity?.shortId,
      payload:   { ciphertext: encrypted, nonce:"" },
      msgType:   "text",
      timestamp: now,
    });

    const newStatus = sent ? "sent" : "sent";
    setMessages(p => p.map(m => m.id === msgId ? { ...m, status: newStatus } : m));
    DB.updateMessage(contact.id, msgId, { status: newStatus });

    // Receipt listener
    const unsub = WS.on("message", data => {
      if (data.type === "receipt" && data.messageId === msgId) {
        setMessages(p => p.map(m => m.id === msgId ? { ...m, status:data.status } : m));
        DB.updateMessage(contact.id, msgId, { status:data.status });
        unsub();
      }
    });
    setTimeout(() => unsub(), 30000);
  }, [input, contact.id, identity]);

  const handleInputChange = useCallback(e => {
    setInput(e.target.value);
    WS.send({ type:"typing", toId:contact.id, isTyping: e.target.value.length > 0 });
  }, [contact.id]);

  const handleKeyDown = useCallback(e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }, [send]);

  return (
    <div style={S.screen}>
      {/* Header */}
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}>
          <div style={{ width:20, height:20 }}><I.Back /></div>
        </button>
        <Avatar name={contact.name || contact.id} size={40} online={contact.online} />
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:0, fontSize:15, fontWeight:700, color:T.text, fontFamily:T.display, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{contact.name || contact.id.slice(0, 16)}</p>
          <p style={{ margin:0, fontSize:11, color:wsOnline && contact.online ? T.accent : T.muted }}>
            {typing ? "typing..." : contact.online ? "● online" : "last seen recently"}
          </p>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <button onClick={onVoiceCall} style={{ ...S.iconBtn, background:"#00D9A511", borderRadius:12 }} title="Voice call">
            <div style={{ width:18, height:18, color:T.accent }}><I.Phone /></div>
          </button>
          <button onClick={onVideoCall} style={{ ...S.iconBtn, background:"#6C63FF11", borderRadius:12 }} title="Video call">
            <div style={{ width:18, height:18, color:T.primary }}><I.Video /></div>
          </button>
          <div style={{ width:8, height:8, borderRadius:"50%", background:wsOnline ? T.accent : T.warning, flexShrink:0 }} />
        </div>
        <div style={{ position:"relative" }}>
          <button onClick={() => setShowMenu(!showMenu)} style={S.iconBtn}>
            <div style={{ width:18, height:18 }}><I.More /></div>
          </button>
          {showMenu && (
            <div style={{ position:"absolute", top:44, right:0, background:T.surface, border:`1px solid ${T.border2}`, borderRadius:12, padding:"6px 0", minWidth:180, zIndex:100, boxShadow:"0 8px 24px #00000066" }}>
              {[
                { label:"Contact ID", action:() => { navigator.clipboard?.writeText(contact.id).catch(()=>{}); setShowMenu(false); } },
                { label:"Clear chat", action:() => { DB.clearChat(contact.id); setMessages([]); setShowMenu(false); } },
                { label:"Delete contact", action:() => { onDeleteContact(contact.id); setShowMenu(false); }, danger:true },
              ].map((item, i) => (
                <button key={i} onClick={item.action} style={{ width:"100%", padding:"10px 16px", background:"none", border:"none", cursor:"pointer", textAlign:"left", fontSize:14, color:item.danger ? T.danger : T.text, fontFamily:T.body }}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConnectionBanner online={wsOnline} />

      {/* Messages */}
      <div style={{ ...S.scroll, padding:"14px 14px 8px", background:"#07070F" }} onClick={() => setShowMenu(false)}>
        <div style={{ textAlign:"center", marginBottom:16 }}>
          <span style={{ fontSize:11, color:`${T.primary}88`, background:`${T.primary}11`, padding:"5px 14px", borderRadius:20, display:"inline-flex", alignItems:"center", gap:5 }}>
            <div style={{ width:10, height:10 }}><I.Lock /></div>
            Messages are end-to-end encrypted
          </span>
        </div>

        {messages.length === 0 && (
          <div style={{ textAlign:"center", padding:"40px 0" }}>
            <p style={{ color:T.muted, fontSize:13 }}>No messages yet — say hello! 👋</p>
          </div>
        )}

        {messages.map((msg, i) => {
          const me = msg.from === "me";
          return (
            <div key={msg.id} style={{ display:"flex", justifyContent:me ? "flex-end" : "flex-start", marginBottom:6, animation:i === messages.length - 1 ? "slideIn 0.2s ease" : "none" }}>
              {!me && <div style={{ marginRight:8, marginTop:4, flexShrink:0 }}><Avatar name={contact.name || contact.id} size={28} /></div>}
              <div style={{ maxWidth:"72%", padding: msg.type === "image" ? "8px 8px 4px" : "10px 14px", borderRadius:me ? "18px 18px 4px 18px" : "18px 18px 18px 4px", background:me ? `linear-gradient(135deg,${T.primary},#5B54E8)` : T.surface2, boxShadow:me ? `0 4px 16px ${T.primary}33` : "0 2px 8px #00000033" }}>
                <p style={{ margin:0, fontSize:14, color:me ? "#fff" : "#E0E0F5", lineHeight:1.55, fontFamily:T.body, wordBreak:"break-word" }}>{msg.text}</p>
                <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center", gap:4, marginTop:4 }}>
                  <span style={{ fontSize:10, color:me ? "#ffffff55" : T.dim }}>{msg.time}</span>
                  {me && <Tick status={msg.status} />}
                </div>
              </div>
            </div>
          );
        })}

        {typing && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
            <Avatar name={contact.name || contact.id} size={28} />
            <div style={{ background:T.surface2, borderRadius:"18px 18px 18px 4px", padding:"12px 16px", display:"flex", gap:5 }}>
              {[0,1,2].map(i => <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:T.primary, animation:`bounce 1.2s ${i*0.2}s infinite` }} />)}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding:"10px 12px", paddingBottom:"max(10px, env(safe-area-inset-bottom, 10px))", background:T.bg, borderTop:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <button style={{ ...S.iconBtn, background:T.surface, borderRadius:12 }}>
          <div style={{ width:20, height:20 }}><I.Attach /></div>
        </button>
        <div style={{ flex:1, background:T.surface, borderRadius:22, border:`1px solid ${T.border2}`, display:"flex", alignItems:"center", padding:"0 14px", minHeight:44 }}>
          <input
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            style={{ flex:1, background:"none", border:"none", outline:"none", color:T.text, fontSize:14, fontFamily:T.body, padding:"8px 0" }}
          />
        </div>
        {input.trim() ? (
          <button onClick={send} style={{ width:44, height:44, borderRadius:14, border:"none", cursor:"pointer", background:`linear-gradient(135deg,${T.primary},#5B54E8)`, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 16px ${T.primary}44`, flexShrink:0, transition:"transform 0.15s" }}
            onMouseDown={e => e.currentTarget.style.transform = "scale(0.92)"}
            onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
          >
            <div style={{ width:20, height:20 }}><I.Send /></div>
          </button>
        ) : (
          <button style={{ width:44, height:44, borderRadius:14, border:"none", cursor:"pointer", background:T.surface, color:T.muted, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
            <div style={{ width:20, height:20 }}><I.Mic /></div>
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 6 — ADD CONTACT
═══════════════════════════════════════════════════════════════════════════ */
function AddContactScreen({ onBack, onAdd, myId }) {
  const [id,      setId]      = useState("");
  const [name,    setName]    = useState("");
  const [status,  setStatus]  = useState("idle"); // idle | loading | success | error
  const [errMsg,  setErrMsg]  = useState("");

  const handleAdd = async () => {
    const contactId = id.trim().toLowerCase();
    setErrMsg("");

    if (!contactId) { setErrMsg("Please enter an ID"); return; }
    if (!contactId.startsWith("urai_")) { setErrMsg("ID must start with urai_"); return; }
    if (contactId === myId) { setErrMsg("You cannot add yourself"); return; }
    if (DB.getContacts().find(c => c.id === contactId)) { setErrMsg("Contact already added"); return; }

    setStatus("loading");

    // Try to look up from relay
    let displayName = name.trim() || contactId.slice(0, 16);
    try {
      const data = await WS.lookup(contactId);
      if (data?.shortId) displayName = name.trim() || data.shortId;
    } catch {}

    const safeName = displayName.slice(0, 50).replace(/[<>'"&]/g, "");
    const contact  = { id:contactId, name:safeName, online:false, lastSeen:"never", addedAt:Date.now() };
    onAdd(contact);
    setStatus("success");
    setTimeout(() => onBack(), 800);
  };

  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{ width:20, height:20 }}><I.Back /></div></button>
        <h2 style={{ margin:0, fontSize:18, fontWeight:700, color:T.text, fontFamily:T.display }}>Add Contact</h2>
      </div>

      <div style={{ ...S.scroll, padding:"24px 20px" }}>
        {/* QR Scanner placeholder */}
        <p style={{ fontSize:13, color:T.muted, marginBottom:10 }}>Scan QR Code</p>
        <div style={{ background:T.surface, border:`2px dashed ${T.border2}`, borderRadius:20, height:200, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:12, marginBottom:24, position:"relative", overflow:"hidden" }}>
          <div style={{ position:"absolute", inset:0, background:`linear-gradient(180deg,transparent 35%,${T.primary}0A 55%,transparent 75%)`, animation:"scanLine 2.5s linear infinite" }} />
          <div style={{ width:44, height:44, color:T.primary }}><I.QR /></div>
          <p style={{ color:T.muted, fontSize:13, margin:0 }}>Camera — coming soon</p>
          {[{top:16,left:16,borderTopWidth:3,borderLeftWidth:3,borderTopLeftRadius:6},{top:16,right:16,borderTopWidth:3,borderRightWidth:3,borderTopRightRadius:6},{bottom:16,left:16,borderBottomWidth:3,borderLeftWidth:3,borderBottomLeftRadius:6},{bottom:16,right:16,borderBottomWidth:3,borderRightWidth:3,borderBottomRightRadius:6}].map((p,i) => (
            <div key={i} style={{ position:"absolute", ...p, width:22, height:22, borderColor:T.primary, borderStyle:"solid" }} />
          ))}
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
          <div style={{ flex:1, height:1, background:T.border2 }} />
          <span style={{ fontSize:12, color:T.dim }}>OR</span>
          <div style={{ flex:1, height:1, background:T.border2 }} />
        </div>

        <p style={{ fontSize:13, color:T.muted, marginBottom:8 }}>Contact ID <span style={{ color:T.danger }}>*</span></p>
        <input value={id} onChange={e => setId(e.target.value)} placeholder="urai_xxxxxxxxxxxx"
          style={{ ...S.input, fontFamily:T.mono, marginBottom:14 }} />

        <p style={{ fontSize:13, color:T.muted, marginBottom:8 }}>Nickname (optional)</p>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ravi Kumar"
          style={{ ...S.input, marginBottom:6 }} />

        {errMsg && (
          <div style={{ padding:"10px 14px", background:`${T.danger}11`, border:`1px solid ${T.danger}33`, borderRadius:10, marginBottom:12 }}>
            <p style={{ margin:0, fontSize:13, color:T.danger }}>⚠️ {errMsg}</p>
          </div>
        )}

        <button onClick={handleAdd} disabled={status === "loading" || status === "success"}
          style={{ ...S.btnPrimary, marginTop:8, opacity:(status === "loading" || status === "success") ? 0.7 : 1, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
          {status === "loading" && <Spinner />}
          {status === "success" ? "✓ Contact Added!" : status === "loading" ? "Adding..." : "Add Contact"}
        </button>

        <div style={{ marginTop:24, background:T.surface, border:`1px solid ${T.border}`, borderRadius:14, padding:"14px 16px" }}>
          <p style={{ fontSize:12, color:T.muted, margin:"0 0 10px", fontWeight:600 }}>How to get someone's ID?</p>
          {["Ask them to open Uraiadal","They go to Settings → Your ID","They copy their ID (starts with urai_)","You paste it above"].map((t, i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
              <span style={{ width:20, height:20, borderRadius:"50%", background:`${T.primary}22`, color:T.primary, fontSize:11, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{i+1}</span>
              <span style={{ fontSize:13, color:"#BBBBD5" }}>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 7 — SETTINGS
═══════════════════════════════════════════════════════════════════════════ */
function SettingsScreen({ identity, onBack, onReset }) {
  const settings              = DB.getSettings();
  const [notifs, setNotifs]   = useState(settings.notifications);
  const [sound,  setSound]    = useState(settings.sound);
  const [theme,  setTheme]    = useState(settings.theme);
  const [lang,   setLang]     = useState(settings.lang);
  const [showKey,setShowKey]  = useState(false);
  const [copied, setCopied]   = useState(false);
  const [expanded, setExpanded] = useState(null);

  const copy = (text) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggle = (key, val, setter) => {
    setter(val);
    DB.setSetting(key, val);
  };

  const sections = [
    {
      icon:<I.User/>, color:T.primary, title:"Profile",
      body:(
        <div style={{ padding:"16px 18px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:16 }}>
            <Avatar name="You" size={52} />
            <div>
              <p style={{ margin:0, fontSize:15, fontWeight:600, color:T.text }}>You</p>
              <code style={{ fontSize:12, color:T.accent, fontFamily:T.mono }}>{identity?.shortId}</code>
            </div>
          </div>
          <button onClick={() => copy(identity?.shortId)} style={{ display:"flex", alignItems:"center", gap:8, background:T.surface2, border:`1px solid ${T.border2}`, borderRadius:10, padding:"10px 14px", cursor:"pointer", color:copied ? T.accent : T.muted, fontSize:13 }}>
            <div style={{ width:14, height:14 }}>{copied ? <I.Check/> : <I.Copy/>}</div>
            {copied ? "Copied!" : "Copy your ID"}
          </button>
        </div>
      )
    },
    {
      icon:<I.Shield/>, color:T.accent, title:"Privacy & Security",
      body:(
        <div style={{ padding:"12px 18px", display:"flex", flexDirection:"column", gap:12 }}>
          {[["Protocol","Double Ratchet"],["Key Exchange","X25519 ECDH"],["Signing","Ed25519"],["Media","XChaCha20-Poly1305"]].map(([k,v],i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingBottom:10, borderBottom:i<3?`1px solid ${T.border}`:"none" }}>
              <span style={{ fontSize:13, color:T.muted }}>{k}</span>
              <code style={{ fontSize:12, color:T.text, fontFamily:T.mono }}>{v}</code>
            </div>
          ))}
          <button onClick={() => setShowKey(!showKey)} style={{ background:"#0D1117", border:`1px solid ${T.warning}44`, borderRadius:10, padding:"10px 14px", cursor:"pointer", color:T.warning, fontSize:13, textAlign:"left" }}>
            {showKey ? "🔒 Hide Private Key" : "🔑 Show Private Key (Backup)"}
          </button>
          {showKey && identity && (
            <div style={{ background:"#0D1117", border:`1px solid ${T.danger}33`, borderRadius:10, padding:12 }}>
              <p style={{ fontSize:10, color:T.danger, margin:"0 0 6px", textTransform:"uppercase", letterSpacing:1 }}>⚠️ Never share this!</p>
              <code style={{ fontSize:11, color:T.warning, fontFamily:T.mono, wordBreak:"break-all", lineHeight:1.7 }}>{identity.privateKey}</code>
            </div>
          )}
        </div>
      )
    },
    {
      icon:<I.Bell/>, color:T.warning, title:"Notifications",
      body:(
        <div style={{ padding:"12px 18px", display:"flex", flexDirection:"column", gap:14 }}>
          {[
            { label:"Push Notifications", sub:"Encrypted content hidden", val:notifs, key:"notifications", setter:setNotifs },
            { label:"Sound",             sub:"Play sound on new message",  val:sound,  key:"sound",         setter:setSound },
          ].map(item => (
            <div key={item.key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <p style={{ margin:0, fontSize:14, color:T.text }}>{item.label}</p>
                <p style={{ margin:0, fontSize:11, color:T.muted }}>{item.sub}</p>
              </div>
              <button onClick={() => toggle(item.key, !item.val, item.setter)}
                style={{ width:46, height:26, borderRadius:13, border:"none", cursor:"pointer", background:item.val ? T.primary : T.border2, position:"relative", transition:"background 0.2s", flexShrink:0 }}>
                <div style={{ position:"absolute", top:3, left:item.val ? 23 : 3, width:20, height:20, borderRadius:"50%", background:"#fff", transition:"left 0.2s", boxShadow:"0 2px 4px #00000044" }} />
              </button>
            </div>
          ))}
        </div>
      )
    },
    {
      icon:<I.Sun/>, color:"#DDA0DD", title:"Appearance",
      body:(
        <div style={{ padding:"12px 18px", display:"flex", gap:10 }}>
          {["dark","light"].map(t => (
            <button key={t} onClick={() => { setTheme(t); DB.setSetting("theme", t); }}
              style={{ flex:1, padding:"12px", borderRadius:12, border:`2px solid ${theme===t?T.primary:T.border2}`, cursor:"pointer", background:theme===t?`${T.primary}22`:T.surface, color:theme===t?T.primary:T.muted, fontSize:13, fontWeight:600 }}>
              {t === "dark" ? "🌙 Dark" : "☀️ Light"}
            </button>
          ))}
        </div>
      )
    },
    {
      icon:<I.Globe/>, color:"#45B7D1", title:"Language",
      body:(
        <div style={{ padding:"12px 18px", display:"flex", gap:10 }}>
          {[["en","English"],["ta","தமிழ்"]].map(([code,label]) => (
            <button key={code} onClick={() => { setLang(code); DB.setSetting("lang", code); }}
              style={{ flex:1, padding:"12px", borderRadius:12, border:`2px solid ${lang===code?T.primary:T.border2}`, cursor:"pointer", background:lang===code?`${T.primary}22`:T.surface, color:lang===code?T.primary:T.muted, fontSize:14, fontWeight:600 }}>
              {label}
            </button>
          ))}
        </div>
      )
    },
    {
      icon:<I.Info/>, color:"#96CEB4", title:"About Uraiadal",
      body:(
        <div style={{ padding:"12px 18px" }}>
          {[["Version",APP_VERSION],["License","AGPL-3.0"],["Source","github.com/NAZRUDH/uraiadal"],["Relay","uraiadal-relay.nrudheen3.workers.dev"],["Web","uraiadal.pages.dev"]].map(([k,v],i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", borderBottom:i<4?`1px solid ${T.border}`:"none" }}>
              <span style={{ fontSize:13, color:T.muted }}>{k}</span>
              <span style={{ fontSize:11, color:T.text, fontFamily:T.mono }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop:16 }}>
            <button onClick={onReset} style={{ width:"100%", padding:"11px", borderRadius:12, border:`1px solid ${T.danger}44`, background:`${T.danger}11`, color:T.danger, fontSize:13, cursor:"pointer" }}>
              🗑️ Reset App / Clear All Data
            </button>
          </div>
        </div>
      )
    },
  ];

  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{ width:20, height:20 }}><I.Back /></div></button>
        <h2 style={{ margin:0, fontSize:18, fontWeight:700, color:T.text, fontFamily:T.display }}>Settings</h2>
      </div>

      <div style={{ ...S.scroll, padding:"14px 14px 32px" }}>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {sections.map((sec, i) => (
            <div key={i} style={S.card}>
              <button onClick={() => setExpanded(expanded === i ? null : i)}
                style={{ width:"100%", padding:"15px 18px", background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"center", gap:14, textAlign:"left" }}>
                <div style={{ width:36, height:36, borderRadius:12, background:`${sec.color}22`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                  <div style={{ width:18, height:18, color:sec.color }}>{sec.icon}</div>
                </div>
                <span style={{ flex:1, fontSize:15, fontWeight:600, color:T.text, fontFamily:T.display }}>{sec.title}</span>
                <span style={{ color:T.dim, fontSize:18, transform:expanded===i?"rotate(90deg)":"rotate(0deg)", transition:"transform 0.2s", display:"inline-block" }}>›</span>
              </button>
              {expanded === i && <div style={{ borderTop:`1px solid ${T.border}` }}>{sec.body}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN 8 — RESTORE
═══════════════════════════════════════════════════════════════════════════ */
function RestoreScreen({ onBack, onRestore }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");

  const handleRestore = () => {
    const k = key.trim();
    if (!k || k.length < 20) { setErr("Invalid key — too short"); return; }
    // TODO: real key restore logic
    setErr("Key restore coming in v1.1. For now generate a new identity.");
  };

  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{ width:20, height:20 }}><I.Back /></div></button>
        <h2 style={{ margin:0, fontSize:18, fontWeight:700, color:T.text, fontFamily:T.display }}>Restore Keys</h2>
      </div>
      <div style={{ ...S.scroll, padding:"28px 20px" }}>
        <div style={{ background:"#0D1117", border:`1px solid ${T.warning}33`, borderRadius:14, padding:"14px 16px", marginBottom:24 }}>
          <p style={{ fontSize:13, color:T.warning, margin:0, lineHeight:1.6 }}>⚠️ Paste your private key exactly as it was backed up from Settings → Privacy.</p>
        </div>
        <p style={{ fontSize:13, color:T.muted, marginBottom:10 }}>Private Key</p>
        <textarea value={key} onChange={e => setKey(e.target.value)} placeholder="Paste your private key here..."
          style={{ ...S.input, height:120, resize:"none", fontFamily:T.mono, fontSize:12, lineHeight:1.6, marginBottom:16 }} />
        {err && <p style={{ color:T.danger, fontSize:13, marginBottom:12 }}>⚠️ {err}</p>}
        <button onClick={handleRestore} disabled={!key.trim()} style={{ ...S.btnPrimary, opacity:key.trim()?1:0.4, cursor:key.trim()?"pointer":"not-allowed" }}>
          Restore Account
        </button>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   INCOMING CALL MODAL
═══════════════════════════════════════════════════════════════════════════ */
function IncomingCallModal({ fromId, callType, onAnswer, onReject }) {
  const [ringing, setRinging] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setRinging(r => !r), 600);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ position:"fixed", inset:0, background:"#00000099", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:24, backdropFilter:"blur(8px)" }}>
      <div style={{ background:"#141420", border:"1px solid #2A2A3E", borderRadius:28, padding:"36px 28px", width:"100%", maxWidth:340, textAlign:"center", boxShadow:"0 24px 64px #00000088", animation:"scaleIn 0.3s ease" }}>
        {/* Animated ring */}
        <div style={{ position:"relative", width:100, height:100, margin:"0 auto 24px" }}>
          <div style={{ position:"absolute", inset:-8, borderRadius:"50%", border:"3px solid #6C63FF", opacity:ringing?0.6:0, transition:"opacity 0.3s", animation:"pulse 1.5s infinite" }} />
          <div style={{ position:"absolute", inset:-18, borderRadius:"50%", border:"2px solid #6C63FF", opacity:ringing?0.3:0, transition:"opacity 0.3s", animation:"pulse 1.5s 0.3s infinite" }} />
          <Avatar name={fromId} size={100} online={true} />
        </div>

        <p style={{ fontSize:13, color:"#7B7B9A", marginBottom:6, fontFamily:"'DM Sans',sans-serif" }}>
          Incoming {callType === "video" ? "Video" : "Voice"} Call
        </p>
        <h2 style={{ fontSize:22, fontWeight:700, color:"#F0F0FF", fontFamily:"'Outfit',sans-serif", marginBottom:6 }}>
          {DB.getContacts().find(c=>c.id===fromId)?.name || fromId.slice(0,16)}
        </h2>
        <code style={{ fontSize:11, color:"#6C63FF", fontFamily:"'JetBrains Mono',monospace" }}>{fromId}</code>

        <div style={{ display:"flex", gap:20, justifyContent:"center", marginTop:32 }}>
          {/* Reject */}
          <button onClick={onReject} style={{ width:64, height:64, borderRadius:"50%", border:"none", cursor:"pointer", background:"linear-gradient(135deg,#FF4F6B,#cc2244)", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px #FF4F6B55", transition:"transform 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.transform="scale(1.1)"}
            onMouseLeave={e => e.currentTarget.style.transform="scale(1)"}
          >
            <div style={{ width:28, height:28, color:"#fff" }}><I.PhoneOff /></div>
          </button>
          {/* Answer */}
          <button onClick={onAnswer} style={{ width:64, height:64, borderRadius:"50%", border:"none", cursor:"pointer", background:"linear-gradient(135deg,#00D9A5,#00b386)", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px #00D9A555", transition:"transform 0.15s", animation:`ring 0.5s ${ringing?"":"alternate"} infinite` }}
            onMouseEnter={e => e.currentTarget.style.transform="scale(1.1)"}
            onMouseLeave={e => e.currentTarget.style.transform="scale(1)"}
          >
            <div style={{ width:28, height:28, color:"#fff" }}><I.Phone /></div>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   CALL SCREEN
═══════════════════════════════════════════════════════════════════════════ */
function CallScreen({ contact, callType, callState, onHangup, identity }) {
  const localVideoRef  = useRef(null);
  const remoteVideoRef = useRef(null);
  const [muted,      setMuted]      = useState(false);
  const [videoOff,   setVideoOff]   = useState(false);
  const [speaker,    setSpeaker]    = useState(true);
  const [duration,   setDuration]   = useState(0);
  const [connecting, setConnecting] = useState(callState !== "connected");
  // Update connecting status when callState changes
  useEffect(() => {
    setConnecting(callState !== "connected");
  }, [callState]);
  const timerRef = useRef(null);

  // Duration timer
  useEffect(() => {
    if (callState === "connected") {
      setConnecting(false);
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [callState]);

  // Attach local stream
  useEffect(() => {
    const unsub = RTC.on("localStream", stream => {
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    });
    if (RTC.localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = RTC.localStream;
    }
    return () => unsub();
  }, []);

  // Attach remote stream
  useEffect(() => {
    const unsub = RTC.on("remoteStream", stream => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    });
    if (RTC.remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = RTC.remoteStream;
    }
    return () => unsub();
  }, []);

  const formatDuration = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2,"0")}`;
  };

  const handleMute = () => {
    const muted = RTC.toggleMute();
    setMuted(muted);
  };

  const handleVideo = () => {
    const off = RTC.toggleVideo();
    setVideoOff(off);
  };

  const isVideo = callType === "video";

  return (
    <div style={{ position:"fixed", inset:0, background:"#07070F", zIndex:999, display:"flex", flexDirection:"column" }}>
      {/* Remote video / avatar */}
      <div style={{ flex:1, position:"relative", display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(180deg,#0A0A1A,#07070F)" }}>
        {isVideo ? (
          <video ref={remoteVideoRef} autoPlay playsInline
            style={{ width:"100%", height:"100%", objectFit:"cover", opacity:connecting?0.3:1, transition:"opacity 0.5s" }} />
        ) : (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
            <div style={{ position:"relative" }}>
              <div style={{ position:"absolute", inset:-12, borderRadius:"50%", border:"2px solid #6C63FF44", animation:"pulse 2s infinite" }} />
              <Avatar name={contact.name || contact.id} size={120} online />
            </div>
          </div>
        )}

        {/* Status overlay */}
        <div style={{ position:"absolute", top:0, left:0, right:0, padding:"48px 24px 16px", background:"linear-gradient(180deg,#00000099 0%,transparent 100%)", textAlign:"center" }}>
          <p style={{ fontSize:12, color:"#7B7B9A", margin:"0 0 4px", fontFamily:"'DM Sans',sans-serif" }}>
            {isVideo ? "📹 Video Call" : "📞 Voice Call"} • E2EE 🔐
          </p>
          <h2 style={{ fontSize:24, fontWeight:700, color:"#F0F0FF", fontFamily:"'Outfit',sans-serif", margin:"0 0 6px" }}>
            {contact.name || contact.id.slice(0,16)}
          </h2>
          <p style={{ fontSize:14, color: callState==="calling"?"#FFB347": callState==="connecting"?"#6C63FF":"#00D9A5", margin:0, fontFamily:"'DM Sans',sans-serif" }}>
            {callState==="calling" ? "Ringing... 🔔" : callState==="connecting" ? "Connecting..." : formatDuration(duration)}
          </p>
        </div>

        {/* Local video (picture-in-picture) */}
        {isVideo && (
          <div style={{ position:"absolute", bottom:120, right:16, width:100, height:140, borderRadius:16, overflow:"hidden", border:"2px solid #2A2A3E", boxShadow:"0 8px 24px #00000066" }}>
            <video ref={localVideoRef} autoPlay playsInline muted
              style={{ width:"100%", height:"100%", objectFit:"cover", transform:"scaleX(-1)", opacity:videoOff?0.2:1 }} />
            {videoOff && (
              <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"#141420" }}>
                <div style={{ width:24, height:24, color:"#7B7B9A" }}><I.VideoOff /></div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ padding:"20px 24px", paddingBottom:"max(20px,env(safe-area-inset-bottom,20px))", background:"#0A0A0F", borderTop:"1px solid #1A1A2E" }}>
        <div style={{ display:"flex", justifyContent:"space-evenly", alignItems:"center", marginBottom:24 }}>
          {/* Mute */}
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
            <button onClick={handleMute} style={{ width:56, height:56, borderRadius:"50%", border:"none", cursor:"pointer", background:muted?"#FF4F6B22":"#1E1E2E", display:"flex", alignItems:"center", justifyContent:"center", transition:"background 0.2s" }}>
              <div style={{ width:24, height:24, color:muted?"#FF4F6B":"#F0F0FF" }}>{muted?<I.MicOff/>:<I.Mic/>}</div>
            </button>
            <span style={{ fontSize:11, color:"#7B7B9A", fontFamily:"'DM Sans',sans-serif" }}>{muted?"Unmute":"Mute"}</span>
          </div>

          {/* Hangup */}
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
            <button onClick={onHangup} style={{ width:72, height:72, borderRadius:"50%", border:"none", cursor:"pointer", background:"linear-gradient(135deg,#FF4F6B,#cc2244)", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px #FF4F6B55" }}>
              <div style={{ width:32, height:32, color:"#fff" }}><I.PhoneOff /></div>
            </button>
            <span style={{ fontSize:11, color:"#7B7B9A", fontFamily:"'DM Sans',sans-serif" }}>End</span>
          </div>

          {/* Video toggle or speaker */}
          {isVideo ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <button onClick={handleVideo} style={{ width:56, height:56, borderRadius:"50%", border:"none", cursor:"pointer", background:videoOff?"#FF4F6B22":"#1E1E2E", display:"flex", alignItems:"center", justifyContent:"center", transition:"background 0.2s" }}>
                <div style={{ width:24, height:24, color:videoOff?"#FF4F6B":"#F0F0FF" }}>{videoOff?<I.VideoOff/>:<I.Video/>}</div>
              </button>
              <span style={{ fontSize:11, color:"#7B7B9A", fontFamily:"'DM Sans',sans-serif" }}>{videoOff?"Cam Off":"Camera"}</span>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <button onClick={() => setSpeaker(!speaker)} style={{ width:56, height:56, borderRadius:"50%", border:"none", cursor:"pointer", background:speaker?"#6C63FF22":"#1E1E2E", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ width:24, height:24, color:speaker?"#6C63FF":"#F0F0FF" }}><I.Speaker /></div>
              </button>
              <span style={{ fontSize:11, color:"#7B7B9A", fontFamily:"'DM Sans',sans-serif" }}>Speaker</span>
            </div>
          )}
        </div>

        {/* Extra controls for video */}
        {isVideo && (
          <div style={{ display:"flex", justifyContent:"center", gap:16 }}>
            <button onClick={() => RTC.flipCamera()} style={{ width:44, height:44, borderRadius:14, border:"1px solid #2A2A3E", cursor:"pointer", background:"#141420", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:20, height:20, color:"#7B7B9A" }}><I.CamFlip /></div>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,       setScreen]       = useState("welcome");
  const [identity,     setIdentity]     = useState(null);
  const [contact,      setContact]      = useState(null);
  const [contacts,     setContacts]     = useState([]);
  const [booting,      setBooting]      = useState(true);
  const [callState,    setCallState]    = useState("idle"); // idle|calling|ringing|connected
  const [callContact,  setCallContact]  = useState(null);
  const [callType,     setCallType]     = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);

  // ── Boot ──
  useEffect(() => {
    try {
      const saved = DB.get("urai_identity");
      const valid = saved
        && typeof saved.shortId === "string"
        && saved.shortId.startsWith("urai_")
        && typeof saved.publicKey === "string"
        && typeof saved.privateKey === "string"
        && saved.shortId.length > 5;

      if (valid) {
        setIdentity(saved);
        setContacts(DB.getContacts());
        setScreen("chats");
        WS.connect(saved.shortId);
        WS.register(saved);

        // RTC listeners registered in separate effect below
      } else {
        DB.clear();
        setScreen("welcome");
      }
    } catch {
      DB.clear();
      setScreen("welcome");
    } finally {
      setBooting(false);
    }
    return () => WS.disconnect();
  }, []);

  // ── Global incoming message listener — runs when identity loads ──
  useEffect(() => {
    if (!identity) return;
    const unsub = WS.on("message", data => {
      // Route call signals to RTC manager
    if (data.type === "call_signal" && data.fromId) {
      RTC.handleSignal(data.fromId, data.signal || {});
      return;
    }
    if (data.type !== "message" || !data.fromId) return;
      let text = data.payload?.ciphertext || "";
      text = decryptText(text);
      const msg = {
        id:        data.messageId || uniqueId(),
        from:      "them",
        text,
        time:      formatTime(data.timestamp),
        timestamp: data.timestamp || Date.now(),
        status:    "delivered",
        type:      data.msgType || "text",
      };
      DB.addMessage(data.fromId, msg);
      // Auto-add unknown senders
      const contacts = DB.getContacts();
      if (!contacts.find(c => c.id === data.fromId)) {
        DB.addContact({ id:data.fromId, name:data.fromId.slice(0, 16), online:true, lastSeen:"now" });
      }
      // Refresh contacts list to show new message preview
      setContacts([...DB.getContacts()]);
    });
    return () => unsub();
  }, [identity]);

  // ── RTC call event listeners ──────────────────────────────────────────────
  useEffect(() => {
    if (!identity) return;

    const unsubIncoming = RTC.on("incoming", ({ fromId, callType, offer }) => {
      setIncomingCall({ fromId, callType, offer });
    });

    const unsubState = RTC.on("state", (s) => {
      setCallState(s);
      if (s === "idle") {
        setIncomingCall(null);
        setCallContact(null);
        setCallType(null);
      }
      if (s === "connected") {
        setIncomingCall(null); // clear modal when connected
      }
    });

    const unsubRejected = RTC.on("rejected", () => {
      setCallState("idle");
      setCallContact(null);
      setCallType(null);
      setIncomingCall(null);
    });

    const unsubTimeout = RTC.on("timeout", () => {
      setCallState("idle");
      setCallContact(null);
      setCallType(null);
      alert("No answer — call ended");
    });

    return () => {
      unsubIncoming();
      unsubState();
      unsubRejected();
      unsubTimeout();
    };
  }, [identity]);

  const go = {
    start:      () => setScreen("keygen"),
    restore:    () => setScreen("restore"),
    afterKeygen: () => {
      const id = DB.get("urai_identity");
      if (id?.shortId) {
        setIdentity(id);
        setScreen("yourid");
        WS.connect(id.shortId);
        WS.register(id);
      } else {
        setScreen("welcome");
      }
    },
    toChats:    () => { setContact(null); setScreen("chats"); },
    openChat:   (c) => {
      // Update online status
      WS.checkOnline(c.id).then(online => {
        const updated = { ...c, online };
        DB.addContact(updated);
        setContacts(DB.getContacts());
        setContact(updated);
      });
      setContact(c);
      setScreen("chat");
    },
    toSettings: () => setScreen("settings"),
    toAdd:      () => setScreen("addcontact"),
    back:       () => { setContact(null); setScreen("chats"); },
    addContact: (c) => {
      DB.addContact(c);
      setContacts(DB.getContacts());
    },
    deleteContact: (id) => {
      DB.removeContact(id);
      setContacts(DB.getContacts());
      setContact(null);
      setScreen("chats");
    },
    doRestore:  () => { setContact(null); setScreen("chats"); },
    resetApp:   () => {
      WS.disconnect();
      RTC.hangup();
      localStorage.clear();
      setIdentity(null);
      setContact(null);
      setContacts([]);
      setScreen("welcome");
    },
    startCall: (c, type) => {
      if (RTC.state !== "idle") {
        alert("Already in a call");
        return;
      }
      setCallContact(c);
      setCallType(type);
      setCallState("calling");
      RTC.call(c.id, type, identity?.shortId).catch(err => {
        alert(`Call failed: ${err.message}`);
        RTC.hangup();
        setCallState("idle");
        setCallContact(null);
      });
    },
    answerCall: () => {
      if (!incomingCall) return;
      const { fromId, callType, offer } = incomingCall;
      // Find contact name if saved
      const saved = DB.getContacts().find(c => c.id === fromId);
      setCallContact(saved || { id:fromId, name:fromId.slice(0,16) });
      setCallType(callType);
      setCallState("connecting"); // show connecting state while WebRTC negotiates
      setIncomingCall(null);
      // RTC state listener will set "connected" when PC connects
      RTC.answer(fromId, offer?.sdp ? offer : { sdp:offer }, callType)
        .catch(err => {
          alert(`Could not answer: ${err.message}`);
          setCallState("idle");
          setCallContact(null);
        });
    },
    rejectCall: () => {
      if (incomingCall) RTC.reject(incomingCall.fromId);
      setIncomingCall(null);
    },
    hangup: () => {
      RTC.hangup();
      setCallState("idle");
      setCallContact(null);
      setCallType(null);
    },
  };

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+Tamil:wght@400;600&display=swap');
    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    html, body, #root { height:100%; width:100%; overflow:hidden; overscroll-behavior:none; }
    body { background:#0A0A0F; }
    ::-webkit-scrollbar { width:3px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:#2A2A3E; border-radius:4px; }
    input::placeholder, textarea::placeholder { color:#444; }
    @keyframes pulse    { 0%,100%{box-shadow:0 0 40px #6C63FF44;} 50%{box-shadow:0 0 70px #6C63FF99;} }
    @keyframes bounce   { 0%,80%,100%{transform:translateY(0);} 40%{transform:translateY(-7px);} }
    @keyframes slideIn  { from{opacity:0;transform:translateY(8px);} to{opacity:1;transform:translateY(0);} }
    @keyframes scanLine { 0%{transform:translateY(-100%);} 100%{transform:translateY(600%);} }
    @keyframes spin     { to{transform:rotate(360deg);} }
    @keyframes fadeIn   { from{opacity:0;} to{opacity:1;} }
    @keyframes scaleIn  { from{opacity:0;transform:scale(0.85);} to{opacity:1;transform:scale(1);} }
    @keyframes ring     { 0%,100%{transform:rotate(-8deg);} 50%{transform:rotate(8deg);} }
  `;

  if (booting) {
    return (
      <>
        <style>{CSS}</style>
        <div style={{ width:"100%", maxWidth:430, height:"100svh", margin:"0 auto", background:T.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:20 }}>
          <div style={{ width:64, height:64, borderRadius:20, background:`linear-gradient(135deg,${T.primary},${T.accent})`, display:"flex", alignItems:"center", justifyContent:"center", animation:"pulse 2s infinite" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </div>
          <p style={{ fontSize:22, fontWeight:800, fontFamily:T.display, color:T.text }}>Uraiadal</p>
          <Spinner />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div style={{ width:"100%", maxWidth:430, height:"100svh", margin:"0 auto", position:"relative", display:"flex", flexDirection:"column", overflow:"hidden", background:T.bg, fontFamily:T.body, minHeight:0 }}>
        {screen === "welcome"    && <WelcomeScreen    onStart={go.start} onRestore={go.restore} />}
        {screen === "keygen"     && <KeyGenScreen     onDone={go.afterKeygen} />}
        {screen === "yourid"     && identity          && <YourIdScreen    identity={identity} onContinue={go.toChats} />}
        {screen === "chats"      &&                     <ChatListScreen   identity={identity} contacts={contacts} onOpenChat={go.openChat} onSettings={go.toSettings} onAddContact={go.toAdd} />}
        {screen === "chat"       && contact?.id       && <ChatScreen      contact={contact} identity={identity} onBack={go.back} onDeleteContact={go.deleteContact} onVoiceCall={()=>go.startCall(contact,"audio")} onVideoCall={()=>go.startCall(contact,"video")} />}
        {screen === "settings"   &&                     <SettingsScreen   identity={identity} onBack={go.back} onReset={go.resetApp} />}
        {screen === "addcontact" &&                     <AddContactScreen onBack={go.back} onAdd={go.addContact} myId={identity?.shortId} />}
        {screen === "restore"    &&                     <RestoreScreen    onBack={() => setScreen("welcome")} onRestore={go.doRestore} />}
      </div>

      {/* Incoming call modal */}
      {incomingCall && (
        <IncomingCallModal
          fromId={incomingCall.fromId}
          callType={incomingCall.callType}
          onAnswer={go.answerCall}
          onReject={go.rejectCall}
        />
      )}

      {/* Active call screen */}
      {(callState === "calling" || callState === "connecting" || callState === "connected") && callContact && (
        <CallScreen
          contact={callContact}
          callType={callType}
          callState={callState}
          identity={identity}
          onHangup={go.hangup}
        />
      )}
    </>
  );
}
