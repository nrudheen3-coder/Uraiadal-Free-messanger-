# Uraiadal Protocol Specification

Version: 1.0.0
Last updated: June 2026

---

## 1. Identity

Every user's identity is a cryptographic keypair generated locally on their device.

**Signing keypair (Ed25519)**
- Used to prove identity
- Public key shared with contacts and registry
- Private key never leaves device

**Exchange keypair (X25519)**
- Used for message encryption
- Public key shared with contacts and registry
- Private key never leaves device

**Short ID**
- Derived as `"urai_" + hex(signingPublicKey).slice(0, 12)`
- Human-shareable identifier
- Example: `urai_a3f9c1d2b4e6`

---

## 2. Key Exchange

When two users want to communicate:

1. Alice fetches Bob's `exchangePubKey` from registry
2. Alice generates ephemeral X25519 keypair
3. ECDH: `sharedSecret = X25519(alicePriv, bobPub)`
4. Messages encrypted with `crypto_box_easy` using sharedSecret

---

## 3. Message Encryption

```
encrypt(plaintext, recipientPubKey, senderPrivKey):
  nonce      = random(24 bytes)
  ciphertext = crypto_box_easy(plaintext, nonce, recipientPubKey, senderPrivKey)
  return { ciphertext: base64(ciphertext), nonce: base64(nonce) }

decrypt(ciphertext, nonce, senderPubKey, recipientPrivKey):
  plaintext = crypto_box_open_easy(ciphertext, nonce, senderPubKey, recipientPrivKey)
  return plaintext
```

Library: **libsodium** (audited, WASM)

---

## 4. Media Encryption

Each media file uses a unique symmetric key:

```
encrypt_media(file):
  key            = crypto_secretstream_keygen()
  (state, header) = crypto_secretstream_init_push(key)
  encrypted      = crypto_secretstream_push(state, file, TAG_FINAL)
  return { encrypted, key: base64(key), header: base64(header) }
```

The `key` is then encrypted with the recipient's exchange public key and sent as part of the message payload.

---

## 5. Wire Format

### Text Message
```json
{
  "type":      "message",
  "messageId": "a3f9c1d2b4e6f7a8",
  "toId":      "urai_b4e6f7a8c1d2",
  "fromId":    "urai_a3f9c1d2b4e6",
  "msgType":   "text",
  "timestamp": 1748951234567,
  "payload": {
    "ciphertext": "<base64>",
    "nonce":      "<base64>"
  }
}
```

### Media Message
```json
{
  "type":      "message",
  "messageId": "...",
  "toId":      "...",
  "fromId":    "...",
  "msgType":   "image",
  "timestamp": 1748951234567,
  "payload": {
    "ciphertext":   "<encrypted media key — base64>",
    "nonce":        "<base64>",
    "mediaId":      "r2-object-uuid",
    "mediaHeader":  "<secretstream header — base64>",
    "mimeType":     "image/jpeg",
    "size":         204800,
    "thumbCipher":  "<encrypted thumbnail — base64>",
    "expiresAt":    1749556034567
  }
}
```

### Receipt
```json
{
  "type":      "receipt",
  "messageId": "...",
  "fromId":    "...",
  "status":    "delivered" | "read"
}
```

### Typing
```json
{
  "type":     "typing",
  "fromId":   "...",
  "toId":     "...",
  "isTyping": true
}
```

---

## 6. Server Trust Model

The relay server is **zero-knowledge**:

- Sees only: `toId`, `fromId`, `messageId`, `timestamp`
- **Cannot** see: message content (E2EE), media content (E2EE)
- Does not store messages (ephemeral relay only)
- Media stored as random-UUID encrypted blobs on R2

---

## 7. Privacy Properties

| Property              | Guaranteed |
|-----------------------|------------|
| Message confidentiality | ✅ E2EE   |
| Message integrity       | ✅ Poly1305 MAC |
| Sender authentication   | ✅ Ed25519 signing |
| Forward secrecy         | 🔜 v1.1 (Double Ratchet) |
| Break-in recovery       | 🔜 v1.1 (Double Ratchet) |
| Metadata minimisation   | ✅ No personal data |
| Media privacy           | ✅ E2EE + EXIF strip |
