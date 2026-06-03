/**
 * Uraiadal Crypto Module
 * Uses libsodium-wrappers for real E2EE
 * Protocol: X25519 key exchange + XSalsa20-Poly1305 encryption
 * Identity: Ed25519 signing keys
 */

import _sodium from "libsodium-wrappers";

let sodium = null;

/** Initialize libsodium WASM — call once on app start */
export async function initCrypto() {
  await _sodium.ready;
  sodium = _sodium;
  console.log("[Uraiadal Crypto] libsodium ready ✓");
}

/** Generate a new Ed25519 + X25519 identity keypair */
export async function generateIdentity() {
  if (!sodium) await initCrypto();

  // Ed25519 for signing (identity)
  const signingKeys = sodium.crypto_sign_keypair();

  // X25519 for key exchange (encryption)
  const exchangeKeys = sodium.crypto_box_keypair();

  // Derive short human-readable ID from public key
  const pubHex = sodium.to_hex(signingKeys.publicKey);
  const shortId = "urai_" + pubHex.slice(0, 12);

  return {
    shortId,
    signing: {
      publicKey:  sodium.to_base64(signingKeys.publicKey),
      privateKey: sodium.to_base64(signingKeys.privateKey),
    },
    exchange: {
      publicKey:  sodium.to_base64(exchangeKeys.publicKey),
      privateKey: sodium.to_base64(exchangeKeys.privateKey),
    },
    createdAt: Date.now(),
  };
}

/**
 * Encrypt a message for a recipient
 * Uses X25519-XSalsa20-Poly1305 (crypto_box)
 */
export async function encryptMessage(plaintext, recipientExchangePubKey, senderExchangePrivKey) {
  if (!sodium) await initCrypto();

  const nonce     = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const message   = sodium.from_string(plaintext);
  const recPub    = sodium.from_base64(recipientExchangePubKey);
  const sendPriv  = sodium.from_base64(senderExchangePrivKey);

  const ciphertext = sodium.crypto_box_easy(message, nonce, recPub, sendPriv);

  return {
    ciphertext: sodium.to_base64(ciphertext),
    nonce:      sodium.to_base64(nonce),
  };
}

/**
 * Decrypt a message from a sender
 */
export async function decryptMessage(ciphertext, nonce, senderExchangePubKey, recipientExchangePrivKey) {
  if (!sodium) await initCrypto();

  try {
    const ct       = sodium.from_base64(ciphertext);
    const n        = sodium.from_base64(nonce);
    const sendPub  = sodium.from_base64(senderExchangePubKey);
    const recPriv  = sodium.from_base64(recipientExchangePrivKey);

    const plaintext = sodium.crypto_box_open_easy(ct, n, sendPub, recPriv);
    return sodium.to_string(plaintext);
  } catch {
    return "[Decryption failed]";
  }
}

/**
 * Encrypt media file (AES-256-GCM via secretstream)
 * Returns encrypted blob + key
 */
export async function encryptMedia(fileArrayBuffer) {
  if (!sodium) await initCrypto();

  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);

  const inputData = new Uint8Array(fileArrayBuffer);
  const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    inputData,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
  );

  return {
    encryptedData: encrypted,
    key:    sodium.to_base64(key),
    header: sodium.to_base64(header),
  };
}

/**
 * Decrypt media file
 */
export async function decryptMedia(encryptedData, keyBase64, headerBase64) {
  if (!sodium) await initCrypto();

  try {
    const key    = sodium.from_base64(keyBase64);
    const header = sodium.from_base64(headerBase64);
    const state  = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, encryptedData);
    return result ? result.message : null;
  } catch {
    return null;
  }
}

/**
 * Sign a message with Ed25519 private key
 */
export async function signMessage(message, signingPrivKey) {
  if (!sodium) await initCrypto();
  const priv = sodium.from_base64(signingPrivKey);
  const sig  = sodium.crypto_sign_detached(sodium.from_string(message), priv);
  return sodium.to_base64(sig);
}

/**
 * Verify a signature
 */
export async function verifySignature(message, signatureBase64, signingPubKey) {
  if (!sodium) await initCrypto();
  try {
    const sig = sodium.from_base64(signatureBase64);
    const pub = sodium.from_base64(signingPubKey);
    return sodium.crypto_sign_verify_detached(sig, sodium.from_string(message), pub);
  } catch {
    return false;
  }
}

/**
 * Strip EXIF from image before encryption
 * Simple approach: re-draw to canvas (removes all metadata)
 */
export async function stripExif(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: file.type })), file.type, 0.92);
    };
    img.src = url;
  });
}

/** Generate a random ID token */
export function generateToken(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
