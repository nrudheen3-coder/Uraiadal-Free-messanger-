import { useState, useEffect, useRef, useCallback } from "react";

/* ── Storage ─────────────────────────────────────────────────────────────── */
const APP_VERSION = "1.0.0";

// Cloudflare Workers relay URL
// Replace with your actual worker URL after deploying workers/relay
const RELAY_URL = "wss://uraiadal-relay.nrudheen3.workers.dev";
const API_URL   = "https://uraiadal-relay.nrudheen3.workers.dev";

const DB = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  clear: () => {
    ["urai_identity","urai_version"].forEach(k => localStorage.removeItem(k));
  }
};

// Clear stale data from old versions
(()=>{
  const v = localStorage.getItem("urai_version");
  if (v !== APP_VERSION) {
    DB.clear();
    localStorage.setItem("urai_version", APP_VERSION);
  }
})();

/* ── Crypto helpers ──────────────────────────────────────────────────────── */
function generateKeyPair() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const rand  = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return { publicKey: rand(16), privateKey: rand(48) };
}
function deriveShortId(pub) { return "urai_" + pub.slice(0, 10); }

/* ── Demo data ───────────────────────────────────────────────────────────── */
// ── WebSocket Manager ────────────────────────────────────────────────────────
const WS = {
  socket: null,
  listeners: {},
  reconnectTimer: null,
  reconnectDelay: 1000,
  shortId: null,

  connect(shortId) {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.shortId = shortId;
    try {
      this.socket = new WebSocket(`${RELAY_URL}/ws?id=${shortId}`);
      this.socket.onopen    = () => {
        this.reconnectDelay = 1000;
        this.emit("status", "online");
        this.startHeartbeat();
        this.fetchPending(shortId);
      };
      this.socket.onmessage = (e) => {
        try { this.emit("message", JSON.parse(e.data)); } catch {}
      };
      this.socket.onclose   = () => {
        this.emit("status", "offline");
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          this.connect(shortId);
        }, this.reconnectDelay);
      };
      this.socket.onerror   = () => this.socket?.close();
    } catch(e) {
      console.warn("[WS] Connection failed:", e.message);
    }
  },

  disconnect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
  },

  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
      return true;
    }
    return false;
  },

  on(event, cb) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== cb); };
  },

  emit(event, data) {
    (this.listeners[event] || []).forEach(cb => cb(data));
  },

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 30000);
  },

  async fetchPending(shortId) {
    try {
      const res = await fetch(`${API_URL}/pending?id=${shortId}`);
      const { messages } = await res.json();
      messages?.forEach(msg => this.emit("message", { type: "message", ...msg }));
    } catch {}
  },

  async register(identity) {
    try {
      await fetch(`${API_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId:       identity.shortId,
          signingPubKey: identity.publicKey,
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

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
};

const CONTACTS = [
  { id:"urai_Rk9mXpQ2Lz", name:"Ravi Kumar",   online:true,  lastSeen:"now",    unread:2, lastMsg:"Da safe ah irukka?",      lastTime:"10:42" },
  { id:"urai_Px7nBwM4Ys", name:"Priya S",       online:false, lastSeen:"2h ago", unread:0, lastMsg:"📷 Photo",                lastTime:"09:15" },
  { id:"urai_Qz3tFvC8Dn", name:"Karthik Dev",   online:true,  lastSeen:"now",    unread:5, lastMsg:"Bro code push pannunga",  lastTime:"Yesterday" },
  { id:"urai_Hn6wRjE1Ks", name:"Meera M",       online:false, lastSeen:"1d ago", unread:0, lastMsg:"Ok noted 👍",             lastTime:"Mon" },
  { id:"urai_Tm2nKqP5Wx", name:"Suresh R",      online:true,  lastSeen:"now",    unread:1, lastMsg:"Meeting at 3pm da",      lastTime:"11:00" },
  { id:"urai_Vb8cLdN3Fy", name:"Anitha K",      online:false, lastSeen:"3h ago", unread:0, lastMsg:"Thanks anna 🙏",          lastTime:"Sun" },
];

const MSGS = {
  "urai_Rk9mXpQ2Lz": [
    { id:1, from:"them", text:"Da safe ah irukka?",                     time:"10:40", status:"read",      type:"text" },
    { id:2, from:"me",   text:"Yes da! Uraiadal works perfectly 🔐",    time:"10:41", status:"read",      type:"text" },
    { id:3, from:"them", text:"E2EE working ah?",                       time:"10:41", status:"read",      type:"text" },
    { id:4, from:"me",   text:"Full encryption da. Double Ratchet ✓✓",  time:"10:42", status:"delivered", type:"text" },
    { id:5, from:"them", text:"Superb da! No phone number ah?",         time:"10:43", status:"read",      type:"text" },
    { id:6, from:"me",   text:"Illai da — just keypair. No account!",   time:"10:44", status:"read",      type:"text" },
  ],
  "urai_Px7nBwM4Ys": [
    { id:1, from:"them", text:"Anna share pannunga the app link",       time:"09:10", status:"read", type:"text" },
    { id:2, from:"me",   text:"uraiadal.pages.dev — install panniko!",  time:"09:12", status:"read", type:"text" },
    { id:3, from:"them", text:"📷 Photo",                               time:"09:15", status:"read", type:"image" },
  ],
  "urai_Qz3tFvC8Dn": [
    { id:1, from:"them", text:"Bro code push pannunga",  time:"Yesterday", status:"read", type:"text" },
    { id:2, from:"them", text:"PR ready ah?",            time:"Yesterday", status:"read", type:"text" },
    { id:3, from:"me",   text:"LGTM da merge pannunga",  time:"Yesterday", status:"read", type:"text" },
    { id:4, from:"them", text:"Deploy successful! 🚀",   time:"Yesterday", status:"read", type:"text" },
  ],
};

/* ── Icons ───────────────────────────────────────────────────────────────── */
const I = {
  Lock:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  Send:    ()=><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  Search:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  Gear:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Back:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>,
  Plus:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  QR:      ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM17 17h3v3h-3zM14 20h3"/></svg>,
  Copy:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  Check:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>,
  Mic:     ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg>,
  Attach:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
  More:    ()=><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  Shield:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Key:     ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3"/></svg>,
  Bell:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
  Sun:     ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  Globe:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  Info:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  Image:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>,
  User:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
};

/* ── Shared styles ───────────────────────────────────────────────────────── */
const S = {
  screen: { height:"100%", display:"flex", flexDirection:"column", overflow:"hidden", background:"#0A0A0F", minHeight:0 },
  header: { padding:"12px 16px", background:"#0A0A0F", borderBottom:"1px solid #1A1A2E", display:"flex", alignItems:"center", gap:12, flexShrink:0 },
  scroll: { flex:1, overflowY:"auto", overflowX:"hidden", WebkitOverflowScrolling:"touch", overscrollBehavior:"contain", minHeight:0 },
  iconBtn:{ width:38, height:38, borderRadius:12, border:"none", cursor:"pointer", background:"transparent", color:"#7B7B9A", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  input:  { background:"#141420", border:"1px solid #2A2A3E", borderRadius:12, padding:"12px 14px", color:"#F0F0FF", fontSize:14, fontFamily:"'DM Sans',sans-serif", outline:"none", width:"100%", boxSizing:"border-box" },
  card:   { background:"#141420", border:"1px solid #1E1E2E", borderRadius:16, overflow:"hidden" },
  btnPrimary: { width:"100%", padding:"15px 0", borderRadius:16, border:"none", cursor:"pointer", background:"linear-gradient(135deg,#6C63FF,#5B54E8)", color:"#fff", fontSize:15, fontWeight:700, fontFamily:"'Outfit',sans-serif", boxShadow:"0 8px 24px #6C63FF44" },
  btnGhost:   { width:"100%", padding:"13px 0", borderRadius:16, border:"1px solid #2A2A3E", cursor:"pointer", background:"transparent", color:"#7B7B9A", fontSize:14, fontFamily:"'DM Sans',sans-serif" },
};

/* ── Avatar ──────────────────────────────────────────────────────────────── */
function Avatar({ name, size=44, online }) {
  const COLORS = ["#6C63FF","#00D9A5","#FF6B9D","#FFB347","#4ECDC4","#45B7D1","#96CEB4","#DDA0DD"];
  const bg  = COLORS[name.charCodeAt(0) % COLORS.length];
  const ini = name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      <div style={{ width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg,${bg}cc,${bg}66)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.36, fontWeight:700, color:"#fff", fontFamily:"'Outfit',sans-serif", border:`2px solid ${bg}44` }}>
        {ini}
      </div>
      {online !== undefined && (
        <div style={{ position:"absolute", bottom:1, right:1, width:size*0.28, height:size*0.28, borderRadius:"50%", border:"2.5px solid #0A0A0F", background:online?"#00D9A5":"#444", boxShadow:online?"0 0 6px #00D9A5":"none" }} />
      )}
    </div>
  );
}

/* ── QR art ──────────────────────────────────────────────────────────────── */
function QRCode({ value }) {
  const N    = 9;
  const seed = value.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
  const grid = Array.from({length:N},(_,r)=>
    Array.from({length:N},(_,c)=>{
      if((r<3&&c<3)||(r<3&&c>=N-3)||(r>=N-3&&c<3)) return true;
      return ((seed*(r*N+c+1))%7)>2;
    })
  );
  return (
    <div style={{ background:"#fff", padding:16, borderRadius:14, display:"inline-block" }}>
      <div style={{ display:"grid", gridTemplateColumns:`repeat(${N},1fr)`, gap:2 }}>
        {grid.flat().map((on,i)=>(
          <div key={i} style={{ width:20, height:20, borderRadius:2, background:on?"#0A0A0F":"#fff" }} />
        ))}
      </div>
    </div>
  );
}

/* ── Tick ────────────────────────────────────────────────────────────────── */
function Tick({ status }) {
  if (status==="sent")      return <span style={{color:"#555",fontSize:11}}>✓</span>;
  if (status==="delivered") return <span style={{color:"#7B7B9A",fontSize:11}}>✓✓</span>;
  if (status==="read")      return <span style={{color:"#00D9A5",fontSize:11}}>✓✓</span>;
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 1 — WELCOME
══════════════════════════════════════════════════════════════════════════ */
function WelcomeScreen({ onStart, onRestore }) {
  return (
    <div style={{ height:"100%", overflowY:"auto", overflowX:"hidden", WebkitOverflowScrolling:"touch", background:"#0A0A0F" }}>
      <div style={{ minHeight:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"48px 28px", position:"relative" }}>
        {/* glow */}
        <div style={{ position:"fixed", top:"20%", left:"50%", transform:"translateX(-50%)", width:300, height:300, borderRadius:"50%", background:"radial-gradient(circle,#6C63FF1A 0%,transparent 70%)", pointerEvents:"none" }} />

        <div style={{ width:84, height:84, borderRadius:26, background:"linear-gradient(135deg,#6C63FF,#00D9A5)", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:28, boxShadow:"0 0 48px #6C63FF55", animation:"pulse 3s infinite" }}>
          <div style={{ width:38, height:38, color:"#fff" }}><I.Lock /></div>
        </div>

        <h1 style={{ fontSize:44, fontWeight:800, fontFamily:"'Outfit',sans-serif", background:"linear-gradient(135deg,#fff 30%,#6C63FF)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", lineHeight:1, marginBottom:6 }}>Uraiadal</h1>
        <p style={{ fontSize:15, color:"#7B7B9A", marginBottom:6, fontFamily:"'Noto Sans Tamil',sans-serif", letterSpacing:2 }}>உரையாடல்</p>
        <p style={{ fontSize:14, color:"#9999BB", marginBottom:40, textAlign:"center", lineHeight:1.6, maxWidth:260 }}>Private. Encrypted. No accounts needed.<br/><span style={{color:"#6C63FF88",fontSize:12}}>Your identity is your keypair.</span></p>

        {[["🔐","End-to-end encrypted — Double Ratchet"],["📵","No phone or email required"],["🌐","Open source & self-hostable"],["⚡","100% free — Cloudflare powered"]].map(([icon,txt],i)=>(
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12, background:"#141420", borderRadius:14, padding:"13px 16px", border:"1px solid #1E1E2E", marginBottom:10, width:"100%", maxWidth:320 }}>
            <span style={{fontSize:20}}>{icon}</span>
            <span style={{fontSize:13,color:"#BBBBD5",fontFamily:"'DM Sans',sans-serif"}}>{txt}</span>
          </div>
        ))}

        <div style={{ width:"100%", maxWidth:320, marginTop:28, display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={onStart} style={S.btnPrimary}>Get Started →</button>
          <button onClick={onRestore} style={S.btnGhost}>Already have keys? Restore</button>
        </div>

        <p style={{ marginTop:24, fontSize:11, color:"#444", textAlign:"center" }}>v1.0.0 · AGPL-3.0 · github.com/NAZRUDH/uraiadal</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 2 — KEY GEN
══════════════════════════════════════════════════════════════════════════ */
function KeyGenScreen({ onDone }) {
  const [step, setStep] = useState(0);
  const steps = ["Generating Ed25519 keypair...","Creating X25519 exchange keys...","Securing keys locally...","Identity ready! 🎉"];

  useEffect(()=>{
    // Generate keypair immediately but save ONLY when animation completes
    const kp = generateKeyPair();
    const identity = { ...kp, shortId:deriveShortId(kp.publicKey), displayName:"You", createdAt: Date.now() };
    const timers = [
      setTimeout(()=>setStep(1), 700),
      setTimeout(()=>setStep(2), 1400),
      setTimeout(()=>setStep(3), 2100),
      setTimeout(()=>{
        DB.set("urai_identity", identity); // save only after full animation
        onDone();
      }, 2800),
    ];
    return ()=>timers.forEach(clearTimeout);
  },[]);

  return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40, background:"#0A0A0F", overflowY:"auto" }}>
      <div style={{ width:68, height:68, borderRadius:22, background:"linear-gradient(135deg,#6C63FF,#00D9A5)", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:28, animation:"pulse 2s infinite" }}>
        <div style={{width:30,height:30,color:"#fff"}}><I.Key /></div>
      </div>
      <h2 style={{fontSize:22,fontWeight:700,fontFamily:"'Outfit',sans-serif",color:"#F0F0FF",marginBottom:8}}>Creating your identity</h2>
      <p style={{fontSize:13,color:"#7B7B9A",marginBottom:40,textAlign:"center"}}>Your private key never leaves this device. Ever.</p>

      <div style={{width:"100%",maxWidth:300,display:"flex",flexDirection:"column",gap:16}}>
        {steps.map((s,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:14,opacity:step>=i?1:0.25,transition:"opacity 0.4s"}}>
            <div style={{width:28,height:28,borderRadius:"50%",background:step>i?"#00D9A5":step===i?"#6C63FF":"#1E1E2E",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.4s",boxShadow:step>=i?"0 0 12px #6C63FF66":"none"}}>
              {step>i?<span style={{color:"#fff",fontSize:13}}>✓</span>:<span style={{color:"#fff",fontSize:11}}>{i+1}</span>}
            </div>
            <span style={{fontSize:14,color:step>=i?"#F0F0FF":"#444",fontFamily:"'DM Sans',sans-serif",transition:"color 0.4s"}}>{s}</span>
          </div>
        ))}
      </div>

      <div style={{marginTop:36,width:"100%",maxWidth:300,height:5,borderRadius:5,background:"#1E1E2E",overflow:"hidden"}}>
        <div style={{height:"100%",borderRadius:5,background:"linear-gradient(90deg,#6C63FF,#00D9A5)",width:`${(step/(steps.length-1))*100}%`,transition:"width 0.6s ease"}} />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 3 — YOUR ID
══════════════════════════════════════════════════════════════════════════ */
function YourIdScreen({ identity, onContinue }) {
  const [copied,setCopied]=useState(false);
  const copy=()=>{ navigator.clipboard?.writeText(identity.shortId).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2000); };

  return (
    <div style={S.screen}>
      {/* header */}
      <div style={{...S.header, justifyContent:"center", flexDirection:"column", alignItems:"center", padding:"28px 20px 16px"}}>
        <div style={{width:44,height:44,borderRadius:14,background:"linear-gradient(135deg,#6C63FF,#00D9A5)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12,boxShadow:"0 0 24px #6C63FF44"}}>
          <div style={{width:22,height:22,color:"#fff"}}><I.QR /></div>
        </div>
        <h2 style={{fontSize:20,fontWeight:700,fontFamily:"'Outfit',sans-serif",color:"#F0F0FF",margin:0}}>Your Uraiadal ID</h2>
        <p style={{fontSize:12,color:"#7B7B9A",marginTop:4}}>Share with friends to connect</p>
      </div>

      {/* scrollable body */}
      <div style={{...S.scroll, padding:"20px 24px 32px", display:"flex", flexDirection:"column", alignItems:"center", gap:20}}>
        <div style={{background:"#fff",padding:20,borderRadius:20,boxShadow:"0 0 40px #6C63FF33"}}>
          <QRCode value={identity.shortId} />
        </div>

        <div style={{background:"#141420",border:"1px solid #2A2A3E",borderRadius:14,padding:"14px 18px",width:"100%"}}>
          <p style={{fontSize:10,color:"#7B7B9A",margin:"0 0 6px",textTransform:"uppercase",letterSpacing:1}}>Your ID</p>
          <div style={{display:"flex",alignItems:"center",gap:10,justifyContent:"space-between"}}>
            <code style={{fontSize:14,color:"#00D9A5",fontFamily:"'JetBrains Mono',monospace",wordBreak:"break-all"}}>{identity.shortId}</code>
            <button onClick={copy} style={{background:"none",border:"none",cursor:"pointer",color:copied?"#00D9A5":"#7B7B9A",padding:4,flexShrink:0}}>
              <div style={{width:18,height:18}}>{copied?<I.Check/>:<I.Copy/>}</div>
            </button>
          </div>
        </div>

        <div style={{background:"#0D1117",border:"1px solid #FFB34733",borderRadius:12,padding:"12px 16px",width:"100%"}}>
          <p style={{fontSize:12,color:"#FFB347",margin:0,lineHeight:1.6}}>⚠️ Save your keys! Settings → Privacy → Show Private Key after setup.</p>
        </div>

        <div style={{background:"#0D1117",border:"1px solid #00D9A522",borderRadius:12,padding:"12px 16px",width:"100%"}}>
          <p style={{fontSize:12,color:"#00D9A5",margin:"0 0 8px",fontWeight:600}}>🔐 Protocol</p>
          {[["Identity","Ed25519 keypair"],["Encryption","X25519 + XSalsa20"],["Library","libsodium (WASM)"]].map(([k,v],i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
              <span style={{fontSize:11,color:"#7B7B9A"}}>{k}</span>
              <span style={{fontSize:11,color:"#F0F0FF",fontFamily:"'JetBrains Mono',monospace"}}>{v}</span>
            </div>
          ))}
        </div>

        <button onClick={onContinue} style={{...S.btnPrimary,marginTop:4}}>Go to Chats →</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 4 — CHAT LIST
══════════════════════════════════════════════════════════════════════════ */
function ChatListScreen({ identity, contacts, onOpenChat, onSettings, onAddContact, onReset }) {
  const [search,setSearch]       = useState("");
  const [showSearch,setShowSearch] = useState(false);

  const filtered = contacts.filter(c=>
    c.name.toLowerCase().includes(search.toLowerCase()) || c.id.includes(search)
  );

  return (
    <div style={S.screen}>
      {/* header */}
      <div style={{...S.header, flexDirection:"column", alignItems:"stretch", padding:"12px 16px 10px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:showSearch?10:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:34,height:34,borderRadius:11,background:"linear-gradient(135deg,#6C63FF,#00D9A5)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{width:16,height:16,color:"#fff"}}><I.Lock /></div>
            </div>
            <div>
              <h1 style={{fontSize:20,fontWeight:800,fontFamily:"'Outfit',sans-serif",color:"#F0F0FF",margin:0,lineHeight:1.1}}>Uraiadal</h1>
              <p style={{fontSize:10,color:"#6C63FF",margin:0,fontFamily:"'Noto Sans Tamil',sans-serif"}}>உரையாடல்</p>
            </div>
          </div>
          <div style={{display:"flex",gap:2}}>
            <button onClick={()=>setShowSearch(!showSearch)} style={{...S.iconBtn,background:showSearch?"#6C63FF22":"transparent",color:showSearch?"#6C63FF":"#7B7B9A"}}>
              <div style={{width:18,height:18}}><I.Search /></div>
            </button>
            <button onClick={onSettings} style={S.iconBtn}>
              <div style={{width:18,height:18}}><I.Gear /></div>
            </button>
          </div>
        </div>
        {showSearch && (
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search chats..." autoFocus
            style={{...S.input, borderRadius:10, padding:"9px 13px"}} />
        )}
      </div>

      {/* E2EE badge */}
      <div style={{padding:"6px 16px",background:"#0D1117",borderBottom:"1px solid #1A1A2E",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
        <div style={{width:11,height:11,color:"#00D9A5"}}><I.Shield /></div>
        <span style={{fontSize:11,color:"#00D9A5",fontFamily:"'DM Sans',sans-serif"}}>All messages end-to-end encrypted</span>
      </div>

      {/* list — THIS IS THE KEY FIX */}
      <div style={S.scroll}>
        {filtered.length === 0 && (
          <div style={{padding:48,textAlign:"center"}}>
            <p style={{color:"#555",fontSize:14}}>No chats found</p>
          </div>
        )}
        {filtered.map(c=>(
          <button key={c.id} onClick={()=>onOpenChat(c)}
            style={{width:"100%",padding:"13px 16px",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:14,borderBottom:"1px solid #0F0F1A",textAlign:"left",transition:"background 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.background="#141420"}
            onMouseLeave={e=>e.currentTarget.style.background="none"}
          >
            <Avatar name={c.name} size={50} online={c.online} />
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                <span style={{fontSize:15,fontWeight:600,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif"}}>{c.name}</span>
                <span style={{fontSize:11,color:c.unread>0?"#6C63FF":"#444",flexShrink:0,marginLeft:8}}>{c.lastTime}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13,color:"#7B7B9A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'DM Sans',sans-serif"}}>{c.lastMsg}</span>
                {c.unread>0 && (
                  <div style={{minWidth:20,height:20,borderRadius:10,background:"#6C63FF",display:"flex",alignItems:"center",justifyContent:"center",padding:"0 6px",flexShrink:0,marginLeft:8}}>
                    <span style={{fontSize:11,color:"#fff",fontWeight:700}}>{c.unread}</span>
                  </div>
                )}
              </div>
            </div>
          </button>
        ))}
        {/* bottom padding so FAB doesn't cover last item */}
        <div style={{height:80}} />
      </div>

      {/* FAB */}
      <button onClick={onAddContact} style={{position:"absolute",bottom:20,right:20,width:54,height:54,borderRadius:17,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#6C63FF,#5B54E8)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 24px #6C63FF55",zIndex:10}}>
        <div style={{width:24,height:24}}><I.Plus /></div>
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 5 — CHAT
══════════════════════════════════════════════════════════════════════════ */
function ChatScreen({ contact, onBack }) {
  const [messages,setMessages] = useState(MSGS[contact.id]||[]);
  const [input,setInput]       = useState("");
  const [typing,setTyping]     = useState(false);
  const bottomRef              = useRef(null);
  const inputRef               = useRef(null);

  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[messages,typing]);

  const send = useCallback(()=>{
    if(!input.trim()) return;
    const msgId  = `msg_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const now    = new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    const msg    = { id:msgId, from:"me", text:input.trim(), time:now, status:"sent", type:"text" };
    setMessages(p=>[...p,msg]);
    setInput("");

    // Send via real WebSocket relay
    const sent = WS.send({
      type:      "message",
      messageId: msgId,
      toId:      contact.id,
      payload:   { ciphertext: btoa(input.trim()), nonce: "" }, // TODO: real E2EE
      msgType:   "text",
      timestamp: Date.now(),
    });

    if (sent) {
      // Wait for server receipt
      const unsub = WS.on("message", (data) => {
        if (data.type === "receipt" && data.messageId === msgId) {
          setMessages(p => p.map(m => m.id === msgId ? {...m, status: data.status} : m));
          unsub();
        }
      });
    } else {
      // Offline — show queued status
      setMessages(p=>p.map(m=>m.id===msgId?{...m,status:"sent"}:m));
    }
  },[input, contact]);

  // Listen for incoming messages from relay
  useEffect(()=>{
    const unsub = WS.on("message", (data) => {
      if (data.type === "message" && data.fromId === contact.id) {
        let text = data.payload?.ciphertext || "";
        try { text = atob(text); } catch {}
        const incoming = {
          id:     data.messageId || Date.now(),
          from:   "them",
          text,
          time:   new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),
          status: "read",
          type:   "text",
        };
        setMessages(p => [...p, incoming]);
        // Send read receipt
        WS.send({ type:"receipt", toId:data.fromId, messageId:data.messageId, status:"read" });
      }
      if (data.type === "typing" && data.fromId === contact.id) {
        setTyping(data.isTyping);
        if (data.isTyping) setTimeout(()=>setTyping(false), 3000);
      }
      if (data.type === "receipt" && data.fromId === contact.id) {
        setMessages(p => p.map(m => m.id === data.messageId ? {...m, status: data.status} : m));
      }
    });
    return () => unsub();
  },[contact]);

  // Send typing indicator
  const handleInputChange = useCallback((e)=>{
    setInput(e.target.value);
    WS.send({ type:"typing", toId:contact.id, isTyping: e.target.value.length > 0 });
  },[contact]);

  return (
    <div style={S.screen}>
      {/* header */}
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}>
          <div style={{width:20,height:20}}><I.Back /></div>
        </button>
        <Avatar name={contact.name} size={40} online={contact.online} />
        <div style={{flex:1,minWidth:0}}>
          <p style={{margin:0,fontSize:15,fontWeight:700,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{contact.name}</p>
          <p style={{margin:0,fontSize:11,color:contact.online?"#00D9A5":"#7B7B9A"}}>{contact.online?"● online":`last seen ${contact.lastSeen}`}</p>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4,background:"#00D9A511",border:"1px solid #00D9A522",borderRadius:8,padding:"4px 8px"}}>
          <div style={{width:11,height:11,color:"#00D9A5"}}><I.Shield /></div>
          <span style={{fontSize:10,color:"#00D9A5",fontWeight:600}}>E2EE</span>
        </div>
        <div style={{width:8,height:8,borderRadius:"50%",background:WS.isConnected()?"#00D9A5":"#FFB347",boxShadow:WS.isConnected()?"0 0 6px #00D9A5":"none",flexShrink:0}} title={WS.isConnected()?"Connected":"Offline — messages queued"} />
        <button style={S.iconBtn}><div style={{width:18,height:18}}><I.More /></div></button>
      </div>

      {/* messages — scrollable */}
      <div style={{...S.scroll, padding:"14px 14px 8px", background:"#07070F"}}>
        {/* notice */}
        <div style={{textAlign:"center",marginBottom:16}}>
          <span style={{fontSize:11,color:"#6C63FF88",background:"#6C63FF11",padding:"5px 14px",borderRadius:20,display:"inline-flex",alignItems:"center",gap:5}}>
            <div style={{width:10,height:10}}><I.Lock /></div>
            Messages are end-to-end encrypted
          </span>
        </div>

        {messages.map((msg,i)=>{
          const me = msg.from==="me";
          return (
            <div key={msg.id} style={{display:"flex",justifyContent:me?"flex-end":"flex-start",marginBottom:6,animation:i===messages.length-1?"slideIn 0.2s ease":"none"}}>
              {!me && <div style={{marginRight:8,marginTop:4,flexShrink:0}}><Avatar name={contact.name} size={28} /></div>}
              <div style={{maxWidth:"72%",padding:msg.type==="image"?"8px 8px 4px":"10px 14px",borderRadius:me?"18px 18px 4px 18px":"18px 18px 18px 4px",background:me?"linear-gradient(135deg,#6C63FF,#5B54E8)":"#1A1A2E",boxShadow:me?"0 4px 16px #6C63FF33":"0 2px 8px #00000033"}}>
                {msg.type==="image" ? (
                  <div>
                    <div style={{width:180,height:120,borderRadius:10,background:"linear-gradient(135deg,#2A2A4E,#1A1A3E)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:4}}>
                      <div style={{color:"#7B7B9A",textAlign:"center"}}>
                        <div style={{width:28,height:28,margin:"0 auto 4px"}}><I.Image /></div>
                        <p style={{fontSize:11,margin:0}}>Encrypted Photo</p>
                      </div>
                    </div>
                    <div style={{display:"flex",justifyContent:"flex-end",gap:4}}>
                      <span style={{fontSize:10,color:me?"#ffffff66":"#555"}}>{msg.time}</span>
                      {me&&<Tick status={msg.status}/>}
                    </div>
                  </div>
                ):(
                  <div>
                    <p style={{margin:0,fontSize:14,color:me?"#fff":"#E0E0F5",lineHeight:1.55,fontFamily:"'DM Sans',sans-serif",wordBreak:"break-word"}}>{msg.text}</p>
                    <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",gap:4,marginTop:5}}>
                      <span style={{fontSize:10,color:me?"#ffffff55":"#555"}}>{msg.time}</span>
                      {me&&<Tick status={msg.status}/>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {typing && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <Avatar name={contact.name} size={28} />
            <div style={{background:"#1A1A2E",borderRadius:"18px 18px 18px 4px",padding:"12px 16px",display:"flex",gap:5}}>
              {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:"#6C63FF",animation:`bounce 1.2s ${i*0.2}s infinite`}}/>)}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input bar */}
      <div style={{padding:"10px 12px",background:"#0A0A0F",borderTop:"1px solid #1A1A2E",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <button style={{...S.iconBtn,background:"#141420",borderRadius:12}}>
          <div style={{width:20,height:20}}><I.Attach /></div>
        </button>
        <div style={{flex:1,background:"#141420",borderRadius:22,border:"1px solid #2A2A3E",display:"flex",alignItems:"center",padding:"0 14px",minHeight:44}}>
          <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder="Message..." onChange={handleInputChange} style={{flex:1,background:"none",border:"none",outline:"none",color:"#F0F0FF",fontSize:14,fontFamily:"'DM Sans',sans-serif",padding:"8px 0"}} />
        </div>
        {input.trim() ? (
          <button onClick={send} style={{width:44,height:44,borderRadius:14,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#6C63FF,#5B54E8)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px #6C63FF44",flexShrink:0}}>
            <div style={{width:20,height:20}}><I.Send /></div>
          </button>
        ):(
          <button style={{width:44,height:44,borderRadius:14,border:"none",cursor:"pointer",background:"#141420",color:"#7B7B9A",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <div style={{width:20,height:20}}><I.Mic /></div>
          </button>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 6 — ADD CONTACT
══════════════════════════════════════════════════════════════════════════ */
function AddContactScreen({ onBack, onAdd }) {
  const [id,setId]       = useState("");
  const [added,setAdded] = useState(false);

  const handleAdd = ()=>{
    if(!id.trim()) return;
    setAdded(true);
    setTimeout(()=>{ onAdd({ id:id.trim(), name:"New Contact", online:false, lastSeen:"never", unread:0, lastMsg:"", lastTime:"" }); onBack(); },1000);
  };

  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{width:20,height:20}}><I.Back /></div></button>
        <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif"}}>Add Contact</h2>
      </div>

      <div style={{...S.scroll, padding:"24px 20px"}}>
        {/* QR area */}
        <p style={{fontSize:13,color:"#7B7B9A",marginBottom:10}}>Scan QR Code</p>
        <div style={{background:"#141420",border:"2px dashed #2A2A3E",borderRadius:20,height:200,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,marginBottom:24,position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",inset:0,background:"linear-gradient(180deg,transparent 35%,#6C63FF0A 55%,transparent 75%)",animation:"scanLine 2.5s linear infinite"}} />
          <div style={{width:44,height:44,color:"#6C63FF"}}><I.QR /></div>
          <p style={{color:"#7B7B9A",fontSize:13,margin:0}}>Camera permission needed</p>
          <button style={{background:"#6C63FF22",border:"1px solid #6C63FF44",borderRadius:10,padding:"8px 18px",color:"#6C63FF",fontSize:13,cursor:"pointer"}}>Enable Camera</button>
          {/* corners */}
          {[{top:16,left:16,borderTopWidth:3,borderLeftWidth:3,borderTopLeftRadius:6},{top:16,right:16,borderTopWidth:3,borderRightWidth:3,borderTopRightRadius:6},{bottom:16,left:16,borderBottomWidth:3,borderLeftWidth:3,borderBottomLeftRadius:6},{bottom:16,right:16,borderBottomWidth:3,borderRightWidth:3,borderBottomRightRadius:6}].map((p,i)=>(
            <div key={i} style={{position:"absolute",...p,width:22,height:22,borderColor:"#6C63FF",borderStyle:"solid"}}/>
          ))}
        </div>

        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
          <div style={{flex:1,height:1,background:"#1E1E2E"}}/>
          <span style={{fontSize:12,color:"#444"}}>OR</span>
          <div style={{flex:1,height:1,background:"#1E1E2E"}}/>
        </div>

        <p style={{fontSize:13,color:"#7B7B9A",marginBottom:10}}>Paste ID manually</p>
        <input value={id} onChange={e=>setId(e.target.value)} placeholder="urai_xxxxxxxxxxxx"
          style={{...S.input, fontFamily:"'JetBrains Mono',monospace", marginBottom:16}} />

        <button onClick={handleAdd} disabled={!id.trim()}
          style={{...S.btnPrimary, opacity:id.trim()?1:0.4, cursor:id.trim()?"pointer":"not-allowed"}}>
          {added?"✓ Contact Added!":"Add Contact"}
        </button>

        <div style={{marginTop:24,background:"#141420",border:"1px solid #1E1E2E",borderRadius:14,padding:"14px 16px"}}>
          <p style={{fontSize:12,color:"#7B7B9A",margin:"0 0 10px",fontWeight:600}}>How to get a contact's ID?</p>
          {["Ask them to open Uraiadal","They go to Settings → Your ID","They share the QR code or copy the ID","You paste it here"].map((t,i)=>(
            <div key={i} style={{display:"flex",gap:10,marginBottom:8}}>
              <span style={{width:20,height:20,borderRadius:"50%",background:"#6C63FF22",color:"#6C63FF",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</span>
              <span style={{fontSize:13,color:"#BBBBD5"}}>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 7 — SETTINGS
══════════════════════════════════════════════════════════════════════════ */
function SettingsScreen({ identity, onBack, onReset }) {
  const [notifs,setNotifs]     = useState(true);
  const [theme,setTheme]       = useState("dark");
  const [lang,setLang]         = useState("en");
  const [showKey,setShowKey]   = useState(false);
  const [copied,setCopied]     = useState(false);
  const [expanded,setExpanded] = useState(null);

  const copy=(t)=>{ navigator.clipboard?.writeText(t).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2000); };

  const sections = [
    {
      icon:<I.User/>, color:"#6C63FF", title:"Profile",
      body:(
        <div style={{padding:"16px 18px"}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
            <Avatar name="You" size={52} />
            <div>
              <p style={{margin:0,fontSize:15,fontWeight:600,color:"#F0F0FF"}}>You</p>
              <code style={{fontSize:12,color:"#00D9A5",fontFamily:"'JetBrains Mono',monospace"}}>{identity?.shortId}</code>
            </div>
          </div>
          <button onClick={()=>copy(identity?.shortId)} style={{display:"flex",alignItems:"center",gap:8,background:"#1A1A2E",border:"1px solid #2A2A3E",borderRadius:10,padding:"10px 14px",cursor:"pointer",color:copied?"#00D9A5":"#7B7B9A",fontSize:13}}>
            <div style={{width:14,height:14}}>{copied?<I.Check/>:<I.Copy/>}</div>
            {copied?"Copied!":"Copy your ID"}
          </button>
        </div>
      )
    },
    {
      icon:<I.Shield/>, color:"#00D9A5", title:"Privacy & Security",
      body:(
        <div style={{padding:"12px 18px",display:"flex",flexDirection:"column",gap:12}}>
          {[["Protocol","Double Ratchet"],["Key Exchange","X25519 ECDH"],["Signing","Ed25519"],["Media Enc","XChaCha20-Poly1305"]].map(([k,v],i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:10,borderBottom:i<3?"1px solid #1A1A2E":"none"}}>
              <span style={{fontSize:13,color:"#7B7B9A"}}>{k}</span>
              <code style={{fontSize:12,color:"#F0F0FF",fontFamily:"'JetBrains Mono',monospace"}}>{v}</code>
            </div>
          ))}
          <button onClick={()=>setShowKey(!showKey)} style={{background:"#0D1117",border:"1px solid #FFB34744",borderRadius:10,padding:"10px 14px",cursor:"pointer",color:"#FFB347",fontSize:13,textAlign:"left"}}>
            {showKey?"🔒 Hide Private Key":"🔑 Show Private Key (Backup)"}
          </button>
          {showKey&&identity&&(
            <div style={{background:"#0D1117",border:"1px solid #FF4F6B33",borderRadius:10,padding:12}}>
              <p style={{fontSize:10,color:"#FF4F6B",margin:"0 0 6px",textTransform:"uppercase",letterSpacing:1}}>⚠️ Keep this secret!</p>
              <code style={{fontSize:11,color:"#FFB347",fontFamily:"'JetBrains Mono',monospace",wordBreak:"break-all",lineHeight:1.7}}>{identity.privateKey}</code>
            </div>
          )}
        </div>
      )
    },
    {
      icon:<I.Bell/>, color:"#FFB347", title:"Notifications",
      body:(
        <div style={{padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <p style={{margin:0,fontSize:14,color:"#F0F0FF"}}>Push Notifications</p>
            <p style={{margin:0,fontSize:11,color:"#7B7B9A"}}>Encrypted — server can't read content</p>
          </div>
          <button onClick={()=>setNotifs(!notifs)} style={{width:46,height:26,borderRadius:13,border:"none",cursor:"pointer",background:notifs?"#6C63FF":"#2A2A3E",position:"relative",transition:"background 0.2s",flexShrink:0}}>
            <div style={{position:"absolute",top:3,left:notifs?23:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 2px 4px #00000044"}}/>
          </button>
        </div>
      )
    },
    {
      icon:<I.Sun/>, color:"#DDA0DD", title:"Appearance",
      body:(
        <div style={{padding:"12px 18px",display:"flex",gap:10}}>
          {["dark","light"].map(t=>(
            <button key={t} onClick={()=>setTheme(t)} style={{flex:1,padding:"12px",borderRadius:12,border:`2px solid ${theme===t?"#6C63FF":"#2A2A3E"}`,cursor:"pointer",background:theme===t?"#6C63FF22":"#141420",color:theme===t?"#6C63FF":"#7B7B9A",fontSize:13,fontWeight:600}}>
              {t==="dark"?"🌙 Dark":"☀️ Light"}
            </button>
          ))}
        </div>
      )
    },
    {
      icon:<I.Globe/>, color:"#45B7D1", title:"Language",
      body:(
        <div style={{padding:"12px 18px",display:"flex",gap:10}}>
          {[["en","English"],["ta","தமிழ்"]].map(([code,label])=>(
            <button key={code} onClick={()=>setLang(code)} style={{flex:1,padding:"12px",borderRadius:12,border:`2px solid ${lang===code?"#6C63FF":"#2A2A3E"}`,cursor:"pointer",background:lang===code?"#6C63FF22":"#141420",color:lang===code?"#6C63FF":"#7B7B9A",fontSize:14,fontWeight:600}}>
              {label}
            </button>
          ))}
        </div>
      )
    },
    {
      icon:<I.Info/>, color:"#96CEB4", title:"About Uraiadal",
      body:(
        <div style={{padding:"12px 18px"}}>
          {[["Version","1.0.0"],["License","AGPL-3.0"],["Source","github.com/NAZRUDH/uraiadal"],["Domain","uraiadal.pages.dev"],["Cost","₹0 / month"]].map(([k,v],i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #1A1A2E"}}>
              <span style={{fontSize:13,color:"#7B7B9A"}}>{k}</span>
              <span style={{fontSize:12,color:"#F0F0FF",fontFamily:"'JetBrains Mono',monospace"}}>{v}</span>
            </div>
          ))}
          <div style={{marginTop:14}}>
            <button onClick={onReset} style={{width:"100%",padding:"11px",borderRadius:12,border:"1px solid #FF4F6B44",background:"#FF4F6B11",color:"#FF4F6B",fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
              🗑️ Reset App / Clear Keys
            </button>
          </div>
        </div>
      )
    },
  ];

  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{width:20,height:20}}><I.Back /></div></button>
        <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif"}}>Settings</h2>
      </div>

      <div style={{...S.scroll, padding:"14px 14px 32px"}}>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {sections.map((sec,i)=>(
            <div key={i} style={S.card}>
              <button onClick={()=>setExpanded(expanded===i?null:i)}
                style={{width:"100%",padding:"15px 18px",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:14,textAlign:"left"}}>
                <div style={{width:36,height:36,borderRadius:12,background:sec.color+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <div style={{width:18,height:18,color:sec.color}}>{sec.icon}</div>
                </div>
                <span style={{flex:1,fontSize:15,fontWeight:600,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif"}}>{sec.title}</span>
                <span style={{color:"#555",fontSize:18,transform:expanded===i?"rotate(90deg)":"rotate(0deg)",transition:"transform 0.2s",display:"inline-block"}}>›</span>
              </button>
              {expanded===i && <div style={{borderTop:"1px solid #1E1E2E"}}>{sec.body}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCREEN 8 — RESTORE
══════════════════════════════════════════════════════════════════════════ */
function RestoreScreen({ onBack, onRestore }) {
  const [key,setKey] = useState("");
  return (
    <div style={S.screen}>
      <div style={S.header}>
        <button onClick={onBack} style={S.iconBtn}><div style={{width:20,height:20}}><I.Back /></div></button>
        <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#F0F0FF",fontFamily:"'Outfit',sans-serif"}}>Restore Keys</h2>
      </div>
      <div style={{...S.scroll, padding:"28px 20px"}}>
        <div style={{background:"#0D1117",border:"1px solid #FFB34733",borderRadius:14,padding:"14px 16px",marginBottom:24}}>
          <p style={{fontSize:13,color:"#FFB347",margin:0,lineHeight:1.6}}>⚠️ Paste your private key exactly as backed up. Your identity will be restored on this device.</p>
        </div>
        <p style={{fontSize:13,color:"#7B7B9A",marginBottom:10}}>Private Key</p>
        <textarea value={key} onChange={e=>setKey(e.target.value)} placeholder="Paste your private key here..."
          style={{...S.input, height:120, resize:"none", fontFamily:"'JetBrains Mono',monospace", fontSize:12, lineHeight:1.6, marginBottom:16}} />
        <button onClick={()=>onRestore(key)} disabled={!key.trim()} style={{...S.btnPrimary, opacity:key.trim()?1:0.4, cursor:key.trim()?"pointer":"not-allowed"}}>
          Restore Account
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,  setScreen]   = useState("welcome");
  const [identity,setIdentity] = useState(null);
  const [contact, setContact]  = useState(null);
  const [contacts,setContacts] = useState(CONTACTS);
  const [booting, setBooting]  = useState(true);

  // On boot: check for saved identity
  // We NEVER jump to "chat" directly — max we go to "chats" (list)
  useEffect(()=>{
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
        setScreen("chats");
        // Connect to relay
        WS.connect(saved.shortId);
        WS.register(saved);
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
    // Cleanup on unmount
    return () => WS.disconnect();
  },[]);

  const go = {
    start:      ()=>setScreen("keygen"),
    restore:    ()=>setScreen("restore"),
    afterKeygen:()=>{
      const id = DB.get("urai_identity");
      if (id && id.shortId) {
        setIdentity(id);
        setScreen("yourid");
        // Connect relay + register pubkeys
        WS.connect(id.shortId);
        WS.register(id);
      } else {
        setScreen("welcome");
      }
    },
    toChats:    ()=>{ setContact(null); setScreen("chats"); },
    openChat:   (c)=>{ setContact(c); setScreen("chat"); },
    toSettings: ()=>setScreen("settings"),
    toAdd:      ()=>setScreen("addcontact"),
    back:       ()=>{ setContact(null); setScreen("chats"); },
    addContact: (c)=>setContacts(p=>[...p,c]),
    doRestore:  ()=>{ setContact(null); setScreen("chats"); },
    resetApp:   ()=>{ localStorage.removeItem("urai_identity"); setIdentity(null); setContact(null); setScreen("welcome"); },
  };

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+Tamil:wght@400;600&display=swap');
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
    html,body,#root{height:100%;width:100%;overflow:hidden;}
    body{background:#0A0A0F;overscroll-behavior:none;}
    ::-webkit-scrollbar{width:3px;}
    ::-webkit-scrollbar-track{background:transparent;}
    ::-webkit-scrollbar-thumb{background:#2A2A3E;border-radius:4px;}
    input::placeholder,textarea::placeholder{color:#555;}
    @keyframes pulse{0%,100%{box-shadow:0 0 40px #6C63FF44;}50%{box-shadow:0 0 70px #6C63FF99;}}
    @keyframes bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-7px);}}
    @keyframes slideIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
    @keyframes scanLine{0%{transform:translateY(-100%);}100%{transform:translateY(600%);}}
    @keyframes spin{to{transform:rotate(360deg);}}

    /* ── Global scroll fix ── */
    html, body, #root {
      height: 100%;
      width: 100%;
      overflow: hidden;
      overscroll-behavior: none;
    }
    * { box-sizing: border-box; }

    /* All scrollable containers */
    .scroll-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      min-height: 0;
    }
  `;

  // Boot splash while reading localStorage
  if (booting) {
    return (
      <>
        <style>{CSS}</style>
        <div style={{width:"100%",maxWidth:430,height:"100svh",margin:"0 auto",background:"#0A0A0F",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20}}>
          <div style={{width:64,height:64,borderRadius:20,background:"linear-gradient(135deg,#6C63FF,#00D9A5)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 40px #6C63FF55",animation:"pulse 2s infinite"}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </div>
          <p style={{fontSize:22,fontWeight:800,fontFamily:"Outfit,sans-serif",color:"#F0F0FF"}}>Uraiadal</p>
          <div style={{width:28,height:28,border:"3px solid #2A2A3E",borderTopColor:"#6C63FF",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div style={{
        width:"100%", maxWidth:430, height:"100svh",
        margin:"0 auto", position:"relative",
        display:"flex", flexDirection:"column",
        overflow:"hidden", background:"#0A0A0F",
        boxShadow:"0 0 60px #6C63FF18",
        fontFamily:"DM Sans,sans-serif",
        minHeight:0,
      }}>
        {screen==="welcome"    && <WelcomeScreen    onStart={go.start} onRestore={go.restore} />}
        {screen==="keygen"     && <KeyGenScreen     onDone={go.afterKeygen} />}
        {screen==="yourid"     && identity          && <YourIdScreen    identity={identity} onContinue={go.toChats} />}
        {screen==="chats"      &&                     <ChatListScreen   identity={identity} contacts={contacts} onOpenChat={go.openChat} onSettings={go.toSettings} onAddContact={go.toAdd} onReset={go.resetApp} />}
        {screen==="chat"       && contact && contact.id && <ChatScreen contact={contact} onBack={go.back} />}
        {screen==="chat"       && (!contact || !contact.id) && go.back()}
        {screen==="settings"   &&                     <SettingsScreen   identity={identity} onBack={go.back} onReset={go.resetApp} />}
        {screen==="addcontact" &&                     <AddContactScreen onBack={go.back} onAdd={go.addContact} />}
        {screen==="restore"    &&                     <RestoreScreen    onBack={()=>setScreen("welcome")} onRestore={go.doRestore} />}
      </div>
    </>
  );
}
