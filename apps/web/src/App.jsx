import { useState, useEffect, useRef, useCallback } from "react";

// ── Tiny crypto helpers (simulated Double Ratchet for demo) ──────────────────
function generateKeyPair() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const pub = rand(16);
  const priv = rand(48);
  return { publicKey: pub, privateKey: priv };
}

function deriveShortId(pubKey) {
  return "urai_" + pubKey.slice(0, 10);
}

function encryptMsg(text) {
  return btoa(encodeURIComponent(text));
}

function decryptMsg(cipher) {
  try { return decodeURIComponent(atob(cipher)); } catch { return cipher; }
}

// ── Persistent storage ──────────────────────────────────────────────────────
const DB = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── Sample data ──────────────────────────────────────────────────────────────
const DEMO_CONTACTS = [
  { id: "urai_Rk9mXpQ2Lz", name: "Ravi Kumar", online: true, lastSeen: "now", unread: 2, lastMsg: "Da safe ah irukka?", lastTime: "10:42" },
  { id: "urai_Px7nBwM4Ys", name: "Priya S", online: false, lastSeen: "2h ago", unread: 0, lastMsg: "📷 Photo", lastTime: "09:15" },
  { id: "urai_Qz3tFvC8Dn", name: "Karthik Dev", online: true, lastSeen: "now", unread: 5, lastMsg: "Bro code push pannunga", lastTime: "Yesterday" },
  { id: "urai_Hn6wRjE1Ks", name: "Meera M", online: false, lastSeen: "1d ago", unread: 0, lastMsg: "Ok noted 👍", lastTime: "Mon" },
];

const DEMO_MESSAGES = {
  "urai_Rk9mXpQ2Lz": [
    { id: 1, from: "them", text: "Da safe ah irukka?", time: "10:40", status: "read", type: "text" },
    { id: 2, from: "me", text: "Yes da! Uraiadal works perfectly 🔐", time: "10:41", status: "read", type: "text" },
    { id: 3, from: "them", text: "E2EE working ah?", time: "10:41", status: "read", type: "text" },
    { id: 4, from: "me", text: "Full encryption da. Double Ratchet protocol ✓✓", time: "10:42", status: "delivered", type: "text" },
    { id: 5, from: "them", text: "Da safe ah irukka?", time: "10:42", status: "read", type: "text" },
  ],
  "urai_Px7nBwM4Ys": [
    { id: 1, from: "them", text: "Anna share pannunga the app link", time: "09:10", status: "read", type: "text" },
    { id: 2, from: "me", text: "uraiadal.pages.dev — install panniko!", time: "09:12", status: "read", type: "text" },
    { id: 3, from: "them", text: "📷 Photo", time: "09:15", status: "read", type: "image" },
  ],
  "urai_Qz3tFvC8Dn": [
    { id: 1, from: "them", text: "Bro code push pannunga", time: "Yesterday", status: "read", type: "text" },
    { id: 2, from: "them", text: "PR ready ah?", time: "Yesterday", status: "read", type: "text" },
    { id: 3, from: "them", text: "LGTM da merge pannunga", time: "Yesterday", status: "read", type: "text" },
    { id: 4, from: "them", text: "Deploy successful!", time: "Yesterday", status: "read", type: "text" },
    { id: 5, from: "them", text: "Bro code push pannunga", time: "Yesterday", status: "read", type: "text" },
  ],
};

// ── Icons ────────────────────────────────────────────────────────────────────
const Icon = {
  Lock: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  Send: () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  Search: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  Settings: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Back: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>,
  Plus: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  QR: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM17 17h3v3h-3zM14 20h3"/></svg>,
  Copy: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  Check: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>,
  CheckDouble: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L7 17l-5-5"/><path d="M23 6L12 17"/></svg>,
  Mic: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg>,
  Attach: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
  More: () => <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  Shield: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Key: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3"/></svg>,
  Bell: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
  Sun: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  Globe: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  Info: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  Image: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>,
  User: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Sparkle: () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>,
};

// ── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ name, size = 40, online }) {
  const colors = ["#6C63FF","#00D9A5","#FF6B9D","#FFB347","#4ECDC4","#45B7D1","#96CEB4","#DDA0DD"];
  const color = colors[name.charCodeAt(0) % colors.length];
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${color}cc, ${color}66)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.36, fontWeight: 700, color: "#fff",
        fontFamily: "'Outfit', sans-serif", border: `2px solid ${color}44`,
        boxShadow: `0 0 0 1px ${color}33`
      }}>{initials}</div>
      {online !== undefined && (
        <div style={{
          position: "absolute", bottom: 1, right: 1,
          width: size * 0.28, height: size * 0.28,
          borderRadius: "50%", border: "2px solid #0A0A0F",
          background: online ? "#00D9A5" : "#555",
          boxShadow: online ? "0 0 6px #00D9A5" : "none"
        }} />
      )}
    </div>
  );
}

// ── QR Code (CSS art) ────────────────────────────────────────────────────────
function QRCode({ value }) {
  const size = 7;
  const seed = value.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const grid = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      if ((r < 3 && c < 3) || (r < 3 && c >= size - 3) || (r >= size - 3 && c < 3)) return true;
      return ((seed * (r * size + c + 1)) % 7) > 2;
    })
  );
  return (
    <div style={{ background: "#fff", padding: 16, borderRadius: 12, display: "inline-block" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${size}, 1fr)`, gap: 2 }}>
        {grid.flat().map((on, i) => (
          <div key={i} style={{ width: 24, height: 24, borderRadius: 3, background: on ? "#0A0A0F" : "#fff" }} />
        ))}
      </div>
    </div>
  );
}

// ── Tick status ──────────────────────────────────────────────────────────────
function Tick({ status }) {
  if (status === "sent") return <span style={{ color: "#7B7B9A", fontSize: 11 }}>✓</span>;
  if (status === "delivered") return <span style={{ color: "#7B7B9A", fontSize: 11 }}>✓✓</span>;
  if (status === "read") return <span style={{ color: "#00D9A5", fontSize: 11 }}>✓✓</span>;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════════════════

// ── Welcome ──────────────────────────────────────────────────────────────────
function WelcomeScreen({ onStart, onRestore }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 32px", position: "relative", overflow: "hidden" }}>
      {/* bg glow */}
      <div style={{ position: "absolute", top: "15%", left: "50%", transform: "translateX(-50%)", width: 280, height: 280, borderRadius: "50%", background: "radial-gradient(circle, #6C63FF22 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: "20%", right: "-20%", width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle, #00D9A522 0%, transparent 70%)", pointerEvents: "none" }} />

      <div style={{ animation: "floatUp 0.8s ease forwards", opacity: 0, animationDelay: "0.1s" }}>
        <div style={{ width: 88, height: 88, borderRadius: 28, background: "linear-gradient(135deg, #6C63FF, #00D9A5)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 28px", boxShadow: "0 0 40px #6C63FF55, 0 0 80px #6C63FF22" }}>
          <div style={{ width: 40, height: 40, color: "#fff" }}><Icon.Lock /></div>
        </div>
      </div>

      <div style={{ animation: "floatUp 0.8s ease forwards", opacity: 0, animationDelay: "0.2s", textAlign: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 42, fontWeight: 800, fontFamily: "'Outfit', sans-serif", background: "linear-gradient(135deg, #fff 30%, #6C63FF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", lineHeight: 1, margin: 0 }}>Uraiadal</h1>
        <p style={{ fontSize: 16, color: "#7B7B9A", margin: "6px 0 0", fontFamily: "'Noto Sans Tamil', sans-serif", letterSpacing: 2 }}>உரையாடல்</p>
      </div>

      <div style={{ animation: "floatUp 0.8s ease forwards", opacity: 0, animationDelay: "0.35s", textAlign: "center", marginBottom: 56 }}>
        <p style={{ fontSize: 15, color: "#9999BB", lineHeight: 1.6, maxWidth: 280 }}>
          Private. Encrypted. No accounts needed.<br />
          <span style={{ color: "#6C63FF88", fontSize: 13 }}>Your identity is your keypair.</span>
        </p>
      </div>

      <div style={{ animation: "floatUp 0.8s ease forwards", opacity: 0, animationDelay: "0.5s", width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 12 }}>
        {[
          { icon: "🔐", text: "End-to-end encrypted" },
          { icon: "📵", text: "No phone or email" },
          { icon: "🌐", text: "Self-hostable & open source" },
        ].map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, background: "#141420", borderRadius: 12, padding: "12px 16px", border: "1px solid #1E1E2E" }}>
            <span style={{ fontSize: 20 }}>{f.icon}</span>
            <span style={{ fontSize: 13, color: "#BBBBD5", fontFamily: "'DM Sans', sans-serif" }}>{f.text}</span>
          </div>
        ))}
      </div>

      <div style={{ animation: "floatUp 0.8s ease forwards", opacity: 0, animationDelay: "0.65s", width: "100%", maxWidth: 320, marginTop: 32, display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={onStart} style={{ width: "100%", padding: "16px 0", borderRadius: 16, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #6C63FF, #5B54E8)", color: "#fff", fontSize: 16, fontWeight: 700, fontFamily: "'Outfit', sans-serif", boxShadow: "0 8px 32px #6C63FF44", transition: "transform 0.15s, box-shadow 0.15s" }}
          onMouseDown={e => e.currentTarget.style.transform = "scale(0.97)"}
          onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
        >Get Started →</button>
        <button onClick={onRestore} style={{ width: "100%", padding: "14px 0", borderRadius: 16, border: "1px solid #2A2A3E", cursor: "pointer", background: "transparent", color: "#7B7B9A", fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>
          Already have keys? Restore
        </button>
      </div>
    </div>
  );
}

// ── Key Gen ──────────────────────────────────────────────────────────────────
function KeyGenScreen({ onDone }) {
  const [step, setStep] = useState(0);
  const steps = ["Generating keypair...", "Creating identity...", "Securing keys...", "Ready! 🎉"];

  useEffect(() => {
    const kp = generateKeyPair();
    const id = deriveShortId(kp.publicKey);
    DB.set("urai_identity", { ...kp, shortId: id, displayName: "You" });
    const t1 = setTimeout(() => setStep(1), 600);
    const t2 = setTimeout(() => setStep(2), 1200);
    const t3 = setTimeout(() => setStep(3), 1900);
    const t4 = setTimeout(() => onDone(), 2600);
    return () => [t1,t2,t3,t4].forEach(clearTimeout);
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: 72, height: 72, borderRadius: 22, background: "linear-gradient(135deg,#6C63FF,#00D9A5)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 32, boxShadow: "0 0 40px #6C63FF44", animation: "pulse 2s infinite" }}>
        <div style={{ width: 32, height: 32, color: "#fff" }}><Icon.Key /></div>
      </div>
      <h2 style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Outfit', sans-serif", color: "#F0F0FF", marginBottom: 8 }}>Creating your identity</h2>
      <p style={{ fontSize: 13, color: "#7B7B9A", marginBottom: 40, textAlign: "center" }}>Your keys never leave this device. Ever.</p>

      <div style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 14 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, opacity: step >= i ? 1 : 0.3, transition: "opacity 0.4s" }}>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: step > i ? "#00D9A5" : step === i ? "#6C63FF" : "#1E1E2E", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.4s", boxShadow: step >= i ? "0 0 12px #6C63FF55" : "none" }}>
              {step > i ? <span style={{ color: "#fff", fontSize: 11 }}>✓</span> : <span style={{ color: "#fff", fontSize: 9 }}>{i + 1}</span>}
            </div>
            <span style={{ fontSize: 14, color: step >= i ? "#F0F0FF" : "#555", fontFamily: "'DM Sans', sans-serif", transition: "color 0.4s" }}>{s}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 40, width: "100%", maxWidth: 280, height: 4, borderRadius: 4, background: "#1E1E2E", overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 4, background: "linear-gradient(90deg,#6C63FF,#00D9A5)", width: `${(step / (steps.length - 1)) * 100}%`, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

// ── Your ID ──────────────────────────────────────────────────────────────────
function YourIdScreen({ identity, onContinue }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(identity.shortId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "32px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ width: 48, height: 48, borderRadius: 16, background: "linear-gradient(135deg,#6C63FF,#00D9A5)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 0 24px #6C63FF44" }}>
          <div style={{ width: 22, height: 22, color: "#fff" }}><Icon.QR /></div>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Outfit', sans-serif", color: "#F0F0FF", margin: 0 }}>Your Uraiadal ID</h2>
        <p style={{ fontSize: 13, color: "#7B7B9A", marginTop: 6 }}>Share this with friends to connect</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, flex: 1 }}>
        <div style={{ background: "#fff", padding: 20, borderRadius: 20, boxShadow: "0 0 40px #6C63FF33" }}>
          <QRCode value={identity.shortId} />
        </div>

        <div style={{ background: "#141420", border: "1px solid #2A2A3E", borderRadius: 14, padding: "14px 20px", width: "100%", maxWidth: 300 }}>
          <p style={{ fontSize: 11, color: "#7B7B9A", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Your ID</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
            <code style={{ fontSize: 14, color: "#00D9A5", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all" }}>{identity.shortId}</code>
            <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "#00D9A5" : "#7B7B9A", padding: 4, flexShrink: 0 }}>
              <div style={{ width: 18, height: 18 }}>{copied ? <Icon.Check /> : <Icon.Copy />}</div>
            </button>
          </div>
        </div>

        <div style={{ background: "#0D1117", border: "1px solid #FFB34733", borderRadius: 12, padding: "12px 16px", width: "100%", maxWidth: 300 }}>
          <p style={{ fontSize: 12, color: "#FFB347", margin: 0, lineHeight: 1.5 }}>⚠️ Save your keys! Go to Settings → Backup after setup.</p>
        </div>
      </div>

      <button onClick={onContinue} style={{ width: "100%", padding: "16px 0", borderRadius: 16, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C63FF,#5B54E8)", color: "#fff", fontSize: 16, fontWeight: 700, fontFamily: "'Outfit', sans-serif", marginTop: 20, boxShadow: "0 8px 24px #6C63FF44" }}>
        Go to Chats →
      </button>
    </div>
  );
}

// ── Chat List ────────────────────────────────────────────────────────────────
function ChatListScreen({ identity, onOpenChat, onSettings, onAddContact }) {
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const contacts = DEMO_CONTACTS.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) || c.id.includes(search)
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px 12px", background: "#0A0A0F", borderBottom: "1px solid #1A1A2E" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: showSearch ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg,#6C63FF,#00D9A5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 16, height: 16, color: "#fff" }}><Icon.Lock /></div>
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: "#F0F0FF", margin: 0, lineHeight: 1 }}>Uraiadal</h1>
              <p style={{ fontSize: 10, color: "#6C63FF", margin: 0, fontFamily: "'DM Sans', sans-serif" }}>உரையாடல்</p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setShowSearch(!showSearch)} style={{ width: 38, height: 38, borderRadius: 12, border: "none", cursor: "pointer", background: showSearch ? "#6C63FF22" : "transparent", color: showSearch ? "#6C63FF" : "#7B7B9A", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 18, height: 18 }}><Icon.Search /></div>
            </button>
            <button onClick={onSettings} style={{ width: 38, height: 38, borderRadius: 12, border: "none", cursor: "pointer", background: "transparent", color: "#7B7B9A", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 18, height: 18 }}><Icon.Settings /></div>
            </button>
          </div>
        </div>
        {showSearch && (
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search chats..." autoFocus
            style={{ width: "100%", background: "#141420", border: "1px solid #2A2A3E", borderRadius: 12, padding: "10px 14px", color: "#F0F0FF", fontSize: 14, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box" }} />
        )}
      </div>

      {/* Encrypted badge */}
      <div style={{ padding: "8px 20px", background: "#0D1117", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid #1A1A2E" }}>
        <div style={{ width: 12, height: 12, color: "#00D9A5" }}><Icon.Shield /></div>
        <span style={{ fontSize: 11, color: "#00D9A5", fontFamily: "'DM Sans', sans-serif" }}>All messages end-to-end encrypted</span>
      </div>

      {/* Contact list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {contacts.length === 0 && (
          <div style={{ padding: 40, textAlign: "center" }}>
            <p style={{ color: "#7B7B9A", fontSize: 14 }}>No chats found</p>
          </div>
        )}
        {contacts.map((c, i) => (
          <button key={c.id} onClick={() => onOpenChat(c)}
            style={{ width: "100%", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid #0F0F1A", transition: "background 0.15s", textAlign: "left" }}
            onMouseEnter={e => e.currentTarget.style.background = "#141420"}
            onMouseLeave={e => e.currentTarget.style.background = "none"}
          >
            <Avatar name={c.name} size={50} online={c.online} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#F0F0FF", fontFamily: "'Outfit', sans-serif" }}>{c.name}</span>
                <span style={{ fontSize: 11, color: c.unread > 0 ? "#6C63FF" : "#555" }}>{c.lastTime}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#7B7B9A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "80%", fontFamily: "'DM Sans', sans-serif" }}>{c.lastMsg}</span>
                {c.unread > 0 && (
                  <div style={{ minWidth: 20, height: 20, borderRadius: 10, background: "#6C63FF", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 6px" }}>
                    <span style={{ fontSize: 11, color: "#fff", fontWeight: 700 }}>{c.unread}</span>
                  </div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* FAB */}
      <button onClick={onAddContact} style={{ position: "absolute", bottom: 24, right: 24, width: 56, height: 56, borderRadius: 18, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C63FF,#5B54E8)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 24px #6C63FF55", transition: "transform 0.2s, box-shadow 0.2s" }}
        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; e.currentTarget.style.boxShadow = "0 12px 32px #6C63FF66"; }}
        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 8px 24px #6C63FF55"; }}
      >
        <div style={{ width: 24, height: 24 }}><Icon.Plus /></div>
      </button>
    </div>
  );
}

// ── Chat Screen ───────────────────────────────────────────────────────────────
function ChatScreen({ contact, identity, onBack }) {
  const [messages, setMessages] = useState(DEMO_MESSAGES[contact.id] || []);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = useCallback(() => {
    if (!input.trim()) return;
    const msg = { id: Date.now(), from: "me", text: input.trim(), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), status: "sent", type: "text" };
    setMessages(prev => [...prev, msg]);
    setInput("");
    // Simulate delivery
    setTimeout(() => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: "delivered" } : m)), 800);
    // Simulate typing + reply
    setTimeout(() => setIsTyping(true), 1200);
    setTimeout(() => {
      setIsTyping(false);
      setMessages(prev => [...prev, { id: Date.now() + 1, from: "them", text: "✓ Received! Message encrypted 🔐", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), status: "read", type: "text" }]);
    }, 3000);
  }, [input]);

  const handleKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", background: "#0A0A0F", borderBottom: "1px solid #1A1A2E", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "#7B7B9A", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10 }}>
          <div style={{ width: 20, height: 20 }}><Icon.Back /></div>
        </button>
        <Avatar name={contact.name} size={40} online={contact.online} />
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#F0F0FF", fontFamily: "'Outfit', sans-serif" }}>{contact.name}</p>
          <p style={{ margin: 0, fontSize: 11, color: contact.online ? "#00D9A5" : "#7B7B9A" }}>
            {contact.online ? "● online" : `last seen ${contact.lastSeen}`}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 12, height: 12, color: "#00D9A5" }}><Icon.Shield /></div>
          <span style={{ fontSize: 10, color: "#00D9A5" }}>E2EE</span>
        </div>
        <button style={{ background: "none", border: "none", cursor: "pointer", color: "#7B7B9A", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 18, height: 18 }}><Icon.More /></div>
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 4, background: "#07070F" }}>
        {/* Encrypted notice */}
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: "#6C63FF88", background: "#6C63FF11", padding: "4px 12px", borderRadius: 20, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 10 }}><Icon.Lock /></div>
            Messages are end-to-end encrypted
          </span>
        </div>

        {messages.map((msg, i) => {
          const isMe = msg.from === "me";
          return (
            <div key={msg.id} style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", marginBottom: 2, animation: i === messages.length - 1 ? "slideIn 0.2s ease" : "none" }}>
              {!isMe && <div style={{ marginRight: 8, marginTop: 4 }}><Avatar name={contact.name} size={28} /></div>}
              <div style={{
                maxWidth: "72%", padding: msg.type === "image" ? "8px 8px 4px" : "10px 14px",
                borderRadius: isMe ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                background: isMe ? "linear-gradient(135deg,#6C63FF,#5B54E8)" : "#1A1A2E",
                boxShadow: isMe ? "0 4px 16px #6C63FF33" : "0 2px 8px #00000033",
              }}>
                {msg.type === "image" ? (
                  <div>
                    <div style={{ width: 180, height: 120, borderRadius: 10, background: "linear-gradient(135deg,#2A2A4E,#1A1A3E)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
                      <div style={{ color: "#7B7B9A", textAlign: "center" }}>
                        <div style={{ width: 32, height: 32, margin: "0 auto 6px" }}><Icon.Image /></div>
                        <p style={{ fontSize: 11, margin: 0 }}>Encrypted Photo</p>
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 10, color: isMe ? "#FFFFFF88" : "#7B7B9A" }}>{msg.time}</span>
                      {isMe && <Tick status={msg.status} />}
                    </div>
                  </div>
                ) : (
                  <div>
                    <p style={{ margin: 0, fontSize: 14, color: isMe ? "#fff" : "#E0E0F5", lineHeight: 1.5, fontFamily: "'DM Sans', sans-serif", wordBreak: "break-word" }}>{msg.text}</p>
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: isMe ? "#FFFFFF66" : "#555" }}>{msg.time}</span>
                      {isMe && <Tick status={msg.status} />}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
            <Avatar name={contact.name} size={28} />
            <div style={{ background: "#1A1A2E", borderRadius: "18px 18px 18px 4px", padding: "12px 16px", display: "flex", gap: 4 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#6C63FF", animation: `bounce 1.2s ${i * 0.2}s infinite` }} />)}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "10px 12px", background: "#0A0A0F", borderTop: "1px solid #1A1A2E", display: "flex", alignItems: "center", gap: 10 }}>
        <button style={{ width: 36, height: 36, borderRadius: 12, border: "none", cursor: "pointer", background: "transparent", color: "#7B7B9A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 20, height: 20 }}><Icon.Attach /></div>
        </button>
        <div style={{ flex: 1, background: "#141420", borderRadius: 20, border: "1px solid #2A2A3E", display: "flex", alignItems: "center", padding: "0 14px", minHeight: 44 }}>
          <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
            placeholder="Message..." style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#F0F0FF", fontSize: 14, fontFamily: "'DM Sans', sans-serif", padding: "8px 0" }} />
        </div>
        {input.trim() ? (
          <button onClick={send} style={{ width: 44, height: 44, borderRadius: 14, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C63FF,#5B54E8)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 16px #6C63FF44", transition: "transform 0.15s" }}
            onMouseDown={e => e.currentTarget.style.transform = "scale(0.92)"}
            onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
          >
            <div style={{ width: 20, height: 20 }}><Icon.Send /></div>
          </button>
        ) : (
          <button style={{ width: 44, height: 44, borderRadius: 14, border: "none", cursor: "pointer", background: "#141420", color: "#7B7B9A", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 20, height: 20 }}><Icon.Mic /></div>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Add Contact ───────────────────────────────────────────────────────────────
function AddContactScreen({ onBack, onAdd }) {
  const [pasteId, setPasteId] = useState("");
  const [added, setAdded] = useState(false);
  const [scanning, setScanning] = useState(true);

  const handleAdd = () => {
    if (!pasteId.trim()) return;
    setAdded(true);
    setTimeout(() => { onAdd({ id: pasteId.trim(), name: pasteId.trim().slice(0, 12), online: false, lastSeen: "never", unread: 0, lastMsg: "", lastTime: "" }); onBack(); }, 1200);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px", background: "#0A0A0F", borderBottom: "1px solid #1A1A2E", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "#7B7B9A", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10 }}>
          <div style={{ width: 20, height: 20 }}><Icon.Back /></div>
        </button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#F0F0FF", fontFamily: "'Outfit', sans-serif" }}>Add Contact</h2>
      </div>

      <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>
        {/* QR Scanner mockup */}
        <div>
          <p style={{ fontSize: 13, color: "#7B7B9A", marginBottom: 12 }}>Scan QR Code</p>
          <div style={{ background: "#141420", border: "2px dashed #2A2A3E", borderRadius: 20, height: 220, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 40%, #6C63FF11 60%, transparent 80%)", animation: "scanLine 2s linear infinite" }} />
            <div style={{ width: 48, height: 48, color: "#6C63FF" }}><Icon.QR /></div>
            <p style={{ color: "#7B7B9A", fontSize: 13, margin: 0 }}>Camera permission needed</p>
            <button style={{ background: "#6C63FF22", border: "1px solid #6C63FF44", borderRadius: 10, padding: "8px 16px", color: "#6C63FF", fontSize: 13, cursor: "pointer" }}>Enable Camera</button>
            {/* Corner guides */}
            {[{top:20,left:20},{top:20,right:20},{bottom:20,left:20},{bottom:20,right:20}].map((pos,i)=>
              <div key={i} style={{ position:"absolute", ...pos, width:24, height:24, borderColor:"#6C63FF", borderStyle:"solid", borderWidth:0, ...(i===0?{borderTopWidth:3,borderLeftWidth:3,borderTopLeftRadius:6}:{}), ...(i===1?{borderTopWidth:3,borderRightWidth:3,borderTopRightRadius:6}:{}), ...(i===2?{borderBottomWidth:3,borderLeftWidth:3,borderBottomLeftRadius:6}:{}), ...(i===3?{borderBottomWidth:3,borderRightWidth:3,borderBottomRightRadius:6}:{}) }} />
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, height: 1, background: "#1E1E2E" }} />
          <span style={{ fontSize: 12, color: "#555" }}>OR</span>
          <div style={{ flex: 1, height: 1, background: "#1E1E2E" }} />
        </div>

        <div>
          <p style={{ fontSize: 13, color: "#7B7B9A", marginBottom: 10 }}>Paste ID manually</p>
          <input value={pasteId} onChange={e => setPasteId(e.target.value)} placeholder="urai_xxxxxxxxxxxxx"
            style={{ width: "100%", background: "#141420", border: "1px solid #2A2A3E", borderRadius: 14, padding: "14px 16px", color: "#F0F0FF", fontSize: 14, fontFamily: "'JetBrains Mono', monospace", outline: "none", boxSizing: "border-box" }} />
        </div>

        <button onClick={handleAdd} disabled={!pasteId.trim()} style={{ width: "100%", padding: "16px", borderRadius: 16, border: "none", cursor: pasteId.trim() ? "pointer" : "not-allowed", background: pasteId.trim() ? "linear-gradient(135deg,#6C63FF,#5B54E8)" : "#1E1E2E", color: pasteId.trim() ? "#fff" : "#555", fontSize: 15, fontWeight: 700, fontFamily: "'Outfit', sans-serif", transition: "background 0.2s" }}>
          {added ? "✓ Contact Added!" : "Add Contact"}
        </button>
      </div>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
function SettingsScreen({ identity, onBack }) {
  const [theme, setTheme] = useState("dark");
  const [lang, setLang] = useState("en");
  const [notifications, setNotifications] = useState(true);
  const [showKeys, setShowKeys] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = (text) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sections = [
    {
      title: "Profile",
      icon: <Icon.User />,
      color: "#6C63FF",
      content: (
        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
            <Avatar name="You" size={56} />
            <div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#F0F0FF" }}>You</p>
              <code style={{ fontSize: 12, color: "#00D9A5", fontFamily: "'JetBrains Mono', monospace" }}>{identity?.shortId}</code>
            </div>
          </div>
          <button onClick={() => copy(identity?.shortId)} style={{ display: "flex", alignItems: "center", gap: 8, background: "#1A1A2E", border: "1px solid #2A2A3E", borderRadius: 10, padding: "10px 14px", cursor: "pointer", color: copied ? "#00D9A5" : "#7B7B9A", fontSize: 13 }}>
            <div style={{ width: 14, height: 14 }}>{copied ? <Icon.Check /> : <Icon.Copy />}</div>
            {copied ? "Copied!" : "Copy your ID"}
          </button>
        </div>
      )
    },
    {
      title: "Privacy & Security",
      icon: <Icon.Shield />,
      color: "#00D9A5",
      content: (
        <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            { label: "E2EE Protocol", value: "Double Ratchet", badge: "✓" },
            { label: "Key Exchange", value: "X25519 ECDH", badge: "✓" },
            { label: "Message Signing", value: "Ed25519", badge: "✓" },
            { label: "Media Encryption", value: "AES-256-GCM", badge: "✓" },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ margin: 0, fontSize: 13, color: "#F0F0FF" }}>{item.label}</p>
                <p style={{ margin: 0, fontSize: 11, color: "#7B7B9A", fontFamily: "'JetBrains Mono', monospace" }}>{item.value}</p>
              </div>
              <span style={{ color: "#00D9A5", fontSize: 13 }}>{item.badge}</span>
            </div>
          ))}
          <button onClick={() => setShowKeys(!showKeys)} style={{ background: "#0D1117", border: "1px solid #FFB34733", borderRadius: 10, padding: "10px 14px", cursor: "pointer", color: "#FFB347", fontSize: 13, textAlign: "left" }}>
            {showKeys ? "Hide" : "Show"} Private Key (Backup)
          </button>
          {showKeys && identity && (
            <div style={{ background: "#0D1117", borderRadius: 10, padding: 12 }}>
              <p style={{ fontSize: 10, color: "#7B7B9A", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Private Key — Keep Secret!</p>
              <code style={{ fontSize: 11, color: "#FFB347", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all", lineHeight: 1.6 }}>{identity.privateKey}</code>
            </div>
          )}
        </div>
      )
    },
    {
      title: "Notifications",
      icon: <Icon.Bell />,
      color: "#FFB347",
      content: (
        <div style={{ padding: "12px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ margin: 0, fontSize: 14, color: "#F0F0FF" }}>Push Notifications</p>
              <p style={{ margin: 0, fontSize: 11, color: "#7B7B9A" }}>Encrypted content hidden</p>
            </div>
            <button onClick={() => setNotifications(!notifications)} style={{ width: 46, height: 26, borderRadius: 13, border: "none", cursor: "pointer", background: notifications ? "#6C63FF" : "#2A2A3E", position: "relative", transition: "background 0.2s" }}>
              <div style={{ position: "absolute", top: 3, left: notifications ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 2px 4px #00000044" }} />
            </button>
          </div>
        </div>
      )
    },
    {
      title: "Appearance",
      icon: <Icon.Sun />,
      color: "#DDA0DD",
      content: (
        <div style={{ padding: "12px 20px", display: "flex", gap: 10 }}>
          {["dark", "light"].map(t => (
            <button key={t} onClick={() => setTheme(t)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${theme === t ? "#6C63FF" : "#2A2A3E"}`, cursor: "pointer", background: theme === t ? "#6C63FF22" : "#141420", color: theme === t ? "#6C63FF" : "#7B7B9A", fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>
              {t === "dark" ? "🌙 Dark" : "☀️ Light"}
            </button>
          ))}
        </div>
      )
    },
    {
      title: "Language",
      icon: <Icon.Globe />,
      color: "#45B7D1",
      content: (
        <div style={{ padding: "12px 20px", display: "flex", gap: 10 }}>
          {[{ code: "en", label: "English" }, { code: "ta", label: "தமிழ்" }].map(l => (
            <button key={l.code} onClick={() => setLang(l.code)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${lang === l.code ? "#6C63FF" : "#2A2A3E"}`, cursor: "pointer", background: lang === l.code ? "#6C63FF22" : "#141420", color: lang === l.code ? "#6C63FF" : "#7B7B9A", fontSize: 14, fontWeight: 600 }}>
              {l.label}
            </button>
          ))}
        </div>
      )
    },
    {
      title: "About Uraiadal",
      icon: <Icon.Info />,
      color: "#96CEB4",
      content: (
        <div style={{ padding: "12px 20px" }}>
          {[
            { label: "Version", value: "1.0.0" },
            { label: "License", value: "AGPL-3.0" },
            { label: "Protocol", value: "Double Ratchet E2EE" },
            { label: "Source", value: "github.com/NAZRUDH/uraiadal" },
            { label: "Domain", value: "uraiadal.pages.dev" },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < 4 ? "1px solid #1A1A2E" : "none" }}>
              <span style={{ fontSize: 13, color: "#7B7B9A" }}>{item.label}</span>
              <span style={{ fontSize: 13, color: "#F0F0FF", fontFamily: i > 2 ? "'JetBrains Mono', monospace" : "'DM Sans', sans-serif", fontSize: 12 }}>{item.value}</span>
            </div>
          ))}
        </div>
      )
    },
  ];

  const [expanded, setExpanded] = useState(null);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px", background: "#0A0A0F", borderBottom: "1px solid #1A1A2E", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "#7B7B9A", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10 }}>
          <div style={{ width: 20, height: 20 }}><Icon.Back /></div>
        </button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#F0F0FF", fontFamily: "'Outfit', sans-serif" }}>Settings</h2>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sections.map((sec, i) => (
            <div key={i} style={{ background: "#141420", borderRadius: 16, border: "1px solid #1E1E2E", overflow: "hidden" }}>
              <button onClick={() => setExpanded(expanded === i ? null : i)} style={{ width: "100%", padding: "16px 20px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, textAlign: "left" }}>
                <div style={{ width: 36, height: 36, borderRadius: 12, background: sec.color + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <div style={{ width: 18, height: 18, color: sec.color }}>{sec.icon}</div>
                </div>
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: "#F0F0FF", fontFamily: "'Outfit', sans-serif" }}>{sec.title}</span>
                <span style={{ color: "#555", fontSize: 16, transform: expanded === i ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>›</span>
              </button>
              {expanded === i && (
                <div style={{ borderTop: "1px solid #1E1E2E" }}>{sec.content}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function Uraiadal() {
  const [screen, setScreen] = useState("welcome");
  const [identity, setIdentity] = useState(null);
  const [activeContact, setActiveContact] = useState(null);
  const [contacts, setContacts] = useState(DEMO_CONTACTS);

  useEffect(() => {
    const saved = DB.get("urai_identity");
    if (saved) { setIdentity(saved); setScreen("chats"); }
  }, []);

  const nav = {
    toKeyGen: () => setScreen("keygen"),
    toRestore: () => setScreen("restore"),
    onKeyGenDone: () => { setIdentity(DB.get("urai_identity")); setScreen("yourid"); },
    toChats: () => setScreen("chats"),
    openChat: (c) => { setActiveContact(c); setScreen("chat"); },
    toSettings: () => setScreen("settings"),
    toAddContact: () => setScreen("addcontact"),
    back: () => setScreen("chats"),
    addContact: (c) => setContacts(prev => [...prev, c]),
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+Tamil:wght@400;600&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { background: #0A0A0F; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2A2A3E; border-radius: 4px; }
        @keyframes floatUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { box-shadow: 0 0 40px #6C63FF44; } 50% { box-shadow: 0 0 60px #6C63FF88; } }
        @keyframes bounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes scanLine { 0% { transform: translateY(-100%); } 100% { transform: translateY(400%); } }
        input::placeholder { color: #555; }
      `}</style>

      <div style={{
        width: "100%", maxWidth: 420, height: "100svh", margin: "0 auto",
        background: "#0A0A0F", display: "flex", flexDirection: "column",
        fontFamily: "'DM Sans', sans-serif", position: "relative", overflow: "hidden",
        boxShadow: "0 0 80px #6C63FF22"
      }}>
        {screen === "welcome" && <WelcomeScreen onStart={nav.toKeyGen} onRestore={nav.toRestore} />}
        {screen === "keygen" && <KeyGenScreen onDone={nav.onKeyGenDone} />}
        {screen === "yourid" && identity && <YourIdScreen identity={identity} onContinue={nav.toChats} />}
        {screen === "chats" && <ChatListScreen identity={identity} onOpenChat={nav.openChat} onSettings={nav.toSettings} onAddContact={nav.toAddContact} contacts={contacts} />}
        {screen === "chat" && activeContact && <ChatScreen contact={activeContact} identity={identity} onBack={nav.back} />}
        {screen === "settings" && <SettingsScreen identity={identity} onBack={nav.back} />}
        {screen === "addcontact" && <AddContactScreen onBack={nav.back} onAdd={nav.addContact} />}
        {screen === "restore" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32 }}>
            <h2 style={{ color: "#F0F0FF", fontFamily: "'Outfit',sans-serif", marginBottom: 16 }}>Restore Keys</h2>
            <textarea placeholder="Paste your private key here..." style={{ width: "100%", height: 120, background: "#141420", border: "1px solid #2A2A3E", borderRadius: 14, padding: 14, color: "#F0F0FF", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", outline: "none", resize: "none" }} />
            <button onClick={nav.toChats} style={{ width: "100%", marginTop: 16, padding: "14px", borderRadius: 14, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C63FF,#5B54E8)", color: "#fff", fontSize: 15, fontWeight: 700 }}>Restore Account</button>
            <button onClick={() => setScreen("welcome")} style={{ marginTop: 10, background: "none", border: "none", color: "#7B7B9A", cursor: "pointer", fontSize: 14 }}>← Back</button>
          </div>
        )}
      </div>
    </>
  );
}
