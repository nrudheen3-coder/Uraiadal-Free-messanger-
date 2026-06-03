# Uraiadal — உரையாடல்

> **Private. Encrypted. No accounts needed.**
> தனியார். குறியாக்கப்பட்டது. கணக்கு தேவையில்லை.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-ready-green.svg)](https://uraiadal.pages.dev)
[![E2EE](https://img.shields.io/badge/E2EE-Double%20Ratchet-purple.svg)](#)

---

## What is Uraiadal?

Uraiadal (உரையாடல் — Tamil for "Conversation") is a fully **open-source, end-to-end encrypted** messenger where your identity is a cryptographic keypair — not a phone number or email address.

No registration. No surveillance. No metadata. Just private conversations.

---

## Features

- 🔐 **End-to-end encrypted** — Double Ratchet protocol (like Signal)
- 📵 **No phone number or email** — Your identity = your keypair
- 📱 **PWA** — Install on Android, iOS, or desktop from the browser
- 🌐 **Self-hostable** — Run your own relay on Cloudflare Workers (free)
- 🖼️ **E2EE media** — Images, videos, files all encrypted before upload
- 🇮🇳 **India-first** — Tamil + English language support
- ⚡ **Zero cost** — Runs entirely on Cloudflare free tier
- 📖 **Open source** — AGPL-3.0 license

---

## Tech Stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Frontend    | React 19 + Vite 6                 |
| PWA         | vite-plugin-pwa + Workbox         |
| Crypto      | libsodium-wrappers (WASM)         |
| Local DB    | Dexie.js (IndexedDB)              |
| Relay       | Cloudflare Workers (Durable Objects) |
| Database    | Cloudflare D1 (SQLite at edge)    |
| Storage     | Cloudflare R2                     |
| Deploy      | Cloudflare Pages                  |
| Domain      | uraiadal.pages.dev (free)         |

---

## Getting Started

### Run locally (from Termux or any terminal)

```bash
# Clone
git clone https://github.com/NAZRUDH/uraiadal
cd uraiadal

# Install dependencies
cd apps/web
npm install

# Copy env template
cp .env.example .env.local

# Run dev server
npm run dev
# → Open http://localhost:5173
```

### Deploy to Cloudflare Pages

```bash
# 1. Push to GitHub
git add .
git commit -m "feat: initial release"
git push origin main

# 2. Connect repo on cloudflare.com/pages
# 3. Build command: cd apps/web && npm run build
# 4. Output dir: apps/web/dist
# 5. Auto-deploys on every push ✓
```

---

## Project Structure

```
uraiadal/
├── apps/
│   └── web/                  ← React 19 PWA
│       ├── src/
│       │   ├── App.jsx        ← All screens + UI
│       │   ├── index.css      ← Design system
│       │   ├── crypto/        ← libsodium E2EE
│       │   ├── db/            ← IndexedDB (Dexie)
│       │   └── hooks/         ← React hooks
│       ├── public/icons/      ← PWA icons
│       ├── vite.config.js     ← Vite + PWA config
│       └── index.html
├── workers/                   ← Cloudflare Workers (coming soon)
│   ├── relay/                 ← WebSocket relay
│   ├── registry/              ← Pubkey D1 store
│   └── media/                 ← R2 media upload
├── docs/
│   └── PROTOCOL.md            ← E2EE spec
├── .gitignore
└── README.md
```

---

## Encryption Protocol

```
Identity    : Ed25519 keypair (signing)
Key Exchange: X25519 ECDH
Encryption  : XSalsa20-Poly1305 (crypto_box)
Media       : XChaCha20-Poly1305 (secretstream)
Library     : libsodium (audited, WASM)
Forward Sec : Double Ratchet (coming in v1.1)
```

Your private key **never leaves your device**.

---

## Privacy Guarantees

- ❌ No phone number collected
- ❌ No email address collected
- ❌ No real name required
- ❌ Server cannot read messages (E2EE)
- ❌ No message content stored on server
- ❌ No IP address logging
- ✅ Media auto-deleted after 7 days
- ✅ EXIF data stripped before upload
- ✅ All traffic over TLS

---

## Roadmap

- [x] v1.0 — PWA, keypair identity, E2EE text, media
- [ ] v1.1 — Group chats, voice messages, Double Ratchet
- [ ] v1.2 — Voice/video calls (WebRTC)
- [ ] v1.3 — Disappearing messages, reactions
- [ ] v2.0 — Bot API, channels

---

## Contributing

PRs welcome! Please read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first.

---

## License

[AGPL-3.0](LICENSE) — All forks must remain open source.

---

*Built with ❤️ for privacy — உரையாடல்*
