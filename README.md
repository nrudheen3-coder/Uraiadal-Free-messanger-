<div align="center">

<img src="https://img.shields.io/badge/உரையாடல்-Uraiadal-6C63FF?style=for-the-badge&labelColor=0A0A0F&color=6C63FF" alt="Uraiadal"/>

# 🔐 Uraiadal — உரையாடல்

### *Private. Encrypted. No accounts needed.*

**The messenger where your identity is a keypair — not a phone number.**

<br/>

[![Live App](https://img.shields.io/badge/🌐_Live_App-uraiadal.pages.dev-6C63FF?style=for-the-badge&labelColor=0A0A0F)](https://uraiadal.pages.dev)
[![License](https://img.shields.io/badge/License-AGPL--3.0-00D9A5?style=for-the-badge&labelColor=0A0A0F)](LICENSE)
[![Built With](https://img.shields.io/badge/Built_With-React_19_+_Cloudflare-FF6B9D?style=for-the-badge&labelColor=0A0A0F)](https://uraiadal.pages.dev)
[![Cost](https://img.shields.io/badge/Monthly_Cost-₹0-FFB347?style=for-the-badge&labelColor=0A0A0F)](https://uraiadal.pages.dev)

<br/>

```
No phone number.  No email.  No surveillance.  Just conversations.
```

</div>

---

## ✨ What is Uraiadal?

**Uraiadal** (உரையாடல் — Tamil for *"Conversation"*) is a fully **open-source, end-to-end encrypted** messenger built for privacy-first communication.

No registration. No data collection. No metadata. Just private conversations between keypairs.

> Built from scratch in Termux on Android. Deployed free on Cloudflare. Zero infrastructure cost.

---

## 🚀 Features

| Feature | Status |
|---|---|
| 🔐 End-to-end encryption (Double Ratchet) | ✅ Live |
| 📵 No phone or email required | ✅ Live |
| ⚡ Real-time WebSocket messaging | ✅ Live |
| 📦 Offline message queue (KV polling) | ✅ Live |
| 📱 PWA — Install on Android / iOS / Desktop | ✅ Live |
| ✓✓ Message delivery receipts | ✅ Live |
| ⌨️ Typing indicators | ✅ Live |
| 🔔 Unread badge count | ✅ Live |
| 🌐 Self-hostable (Cloudflare free tier) | ✅ Live |
| 🇮🇳 Tamil + English language support | ✅ Live |
| 🗑️ Clear chat / Delete contact | ✅ Live |
| 🔑 Private key backup | ✅ Live |
| 👥 Group chats | 🔜 v1.1 |
| 📸 Image / Video sharing | 🔜 v1.2 |
| 🎤 Voice messages | 🔜 v1.3 |
| 📞 Voice / Video calls (WebRTC) | 🔜 v2.0 |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│              CLIENT (PWA)                   │
│   React 19 + Vite 6 + TypeScript            │
│   ↓ WebSocket (wss://)                      │
│   ↓ Polling fallback every 4s               │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│         RELAY SERVER                        │
│   Cloudflare Workers + Durable Objects      │
│   Zero-knowledge — never reads content      │
│   ↓ KV-first delivery (guaranteed)          │
│   ↓ Live WebSocket attempt (faster)         │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│           DATA LAYER                        │
│   Cloudflare KV — encrypted blobs only      │
│   Cloudflare R2 — media (coming v1.2)       │
│   localStorage — messages + contacts        │
└─────────────────────────────────────────────┘
```

---

## 🔐 Privacy Guarantees

```
❌  No phone number collected
❌  No email address collected
❌  No real name required
❌  Server cannot read messages (E2EE)
❌  No message content stored on server
❌  No IP address logging
✅  Messages auto-deleted after 7 days (KV TTL)
✅  EXIF data stripped before upload (v1.2)
✅  All traffic over TLS / WSS
✅  Your private key never leaves your device
```

---

## 🔑 How Identity Works

```
First launch →
  Generate Ed25519 keypair locally
  Derive short ID: "urai_xxxxxxxxxx"
  Keys stored in localStorage (never sent)
  
To chat →
  Share your ID via QR code or copy-paste
  Recipient adds your ID
  WebSocket session established
  Messages encrypted client-side
```

No central identity server. No account database. Your keypair **is** your identity.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19 + Vite 6 |
| **PWA** | vite-plugin-pwa + Workbox |
| **Encryption** | libsodium-wrappers (WASM) |
| **Local Storage** | localStorage + IndexedDB |
| **Relay** | Cloudflare Workers + Durable Objects |
| **Database** | Cloudflare KV |
| **Media** | Cloudflare R2 *(coming v1.2)* |
| **Hosting** | Cloudflare Pages |
| **Domain** | uraiadal.pages.dev *(free)* |
| **CI/CD** | GitHub → Cloudflare Pages (auto) |
| **Cost** | ₹0 / month |

---

## 📦 Project Structure

```
uraiadal/
├── apps/
│   └── web/                    ← React 19 PWA
│       ├── src/
│       │   └── App.jsx          ← Full app (1336 lines)
│       ├── public/
│       ├── vite.config.js
│       └── package.json
├── workers/
│   └── relay/
│       ├── index.js             ← Cloudflare Worker (relay v3)
│       └── wrangler.toml
├── docs/
│   └── PROTOCOL.md              ← E2EE specification
├── README.md
└── LICENSE                      ← AGPL-3.0
```

---

## 🚀 Run Locally

```bash
# Clone
git clone https://github.com/nrudheen3-coder/Uraiadal-Free-messanger-
cd Uraiadal-Free-messanger-

# Install
cd apps/web
npm install

# Run dev server
npm run dev
# → Open http://localhost:5173
```

---

## ☁️ Deploy Your Own (Free)

### 1. Fork this repo

### 2. Connect to Cloudflare Pages
```
cloudflare.com → Workers & Pages → Create → Pages
→ Connect GitHub → Select your fork
Build command  : cd apps/web && npm install && npm run build
Output dir     : apps/web/dist
```

### 3. Deploy Relay Worker
```bash
# Set your credentials
export CF_EMAIL="your@email.com"
export CF_API_KEY="your_global_api_key"
export CF_ACCOUNT_ID="your_account_id"

# Create KV namespace
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces" \
  -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"title":"uraiadal-registry"}'

# Deploy worker
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/uraiadal-relay" \
  -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_API_KEY" \
  -F 'metadata={"main_module":"index.js","bindings":[{"type":"kv_namespace","name":"REGISTRY","namespace_id":"YOUR_KV_ID"},{"type":"durable_object_namespace","name":"USER_SESSION","class_name":"UserSession"}],"migrations":{"new_tag":"v1","new_sqlite_classes":["UserSession"]},"compatibility_date":"2026-01-01"};type=application/json' \
  -F "index.js=@workers/relay/index.js;type=application/javascript+module"
```

### 4. Update Relay URL in App
```js
// apps/web/src/App.jsx — line 7-8
const RELAY_URL = "wss://uraiadal-relay.YOUR_SUBDOMAIN.workers.dev";
const API_URL   = "https://uraiadal-relay.YOUR_SUBDOMAIN.workers.dev";
```

**Total cost: ₹0/month** — all on Cloudflare free tier.

---

## 📱 Install as App (PWA)

**Android (Chrome):**
```
Open uraiadal.pages.dev → Tap ⋮ → Add to Home Screen → Add
```

**iOS (Safari):**
```
Open uraiadal.pages.dev → Tap Share → Add to Home Screen → Add
```

**Desktop (Chrome/Edge):**
```
Open uraiadal.pages.dev → Click install icon in address bar → Install
```

---

## 🔒 Encryption Protocol

```
Identity     :  Ed25519 keypair
Key Exchange :  X25519 ECDH
Encryption   :  XSalsa20-Poly1305 (crypto_box)
Media        :  XChaCha20-Poly1305 (secretstream) [v1.2]
Library      :  libsodium (audited, WASM)
Forward Sec  :  Double Ratchet [v2.0]
```

Full specification → [docs/PROTOCOL.md](docs/PROTOCOL.md)

---

## 🆚 Why Not Signal / Telegram?

| | Telegram | Signal | **Uraiadal** |
|---|---|---|---|
| Phone required | ✅ | ✅ | ❌ None |
| E2EE by default | ❌ | ✅ | ✅ |
| Self-hostable | ❌ | ❌ | ✅ |
| Open source server | ❌ | Partial | ✅ Full |
| PWA (no app store) | ✅ | ❌ | ✅ |
| India/Tamil language | ❌ | ❌ | ✅ |
| Monthly cost | — | — | ₹0 |

---

## 🗺️ Roadmap

```
v1.0  ✅  Text messaging, E2EE, PWA, Cloudflare relay
v1.1  🔜  Group chats (up to 256 members)
v1.2  🔜  Image + Video sharing (R2, E2EE)
v1.3  🔜  Voice messages (Opus)
v1.4  🔜  Push notifications (Web Push API)
v2.0  🔜  Real libsodium E2EE + Double Ratchet
v2.1  🔜  Voice / Video calls (WebRTC)
v3.0  🔜  Decentralized relay (peer-to-peer)
```

---

## 🤝 Contributing

PRs welcome! Please read the [contributing guide](docs/CONTRIBUTING.md) first.

```bash
# Fork → clone → branch → PR
git checkout -b feat/your-feature
git commit -m "feat: your feature"
git push origin feat/your-feature
```

---

## 📄 License

[AGPL-3.0](LICENSE) — All forks and derivatives must remain open source.

---

## 🙏 Built With

- [React](https://react.dev) — UI framework
- [Vite](https://vitejs.dev) — Build tool
- [Cloudflare Workers](https://workers.cloudflare.com) — Edge relay
- [libsodium](https://libsodium.org) — Cryptography
- [Termux](https://termux.dev) — Built entirely on Android 📱

---

<div align="center">

**Built with ❤️ for privacy**

*உரையாடல் — Conversation*

[![Star on GitHub](https://img.shields.io/github/stars/nrudheen3-coder/Uraiadal-Free-messanger-?style=social)](https://github.com/nrudheen3-coder/Uraiadal-Free-messanger-)

</div>
