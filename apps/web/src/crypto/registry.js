/**
 * Uraiadal Registry Client
 * Cloudflare Worker D1 pubkey registry
 */

const REGISTRY_URL = import.meta.env.VITE_REGISTRY_URL || "https://api.uraiadal.workers.dev";

/** Register your public keys on the relay */
export async function registerIdentity(identity) {
  const res = await fetch(`${REGISTRY_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shortId:          identity.shortId,
      signingPubKey:    identity.signing.publicKey,
      exchangePubKey:   identity.exchange.publicKey,
    }),
  });
  if (!res.ok) throw new Error("Registration failed: " + res.statusText);
  return res.json();
}

/** Lookup a contact's public keys by shortId */
export async function lookupIdentity(shortId) {
  const res = await fetch(`${REGISTRY_URL}/lookup/${shortId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Lookup failed: " + res.statusText);
  return res.json(); // { shortId, signingPubKey, exchangePubKey, lastSeen }
}

/** Update last seen timestamp */
export async function updatePresence(shortId, authToken) {
  await fetch(`${REGISTRY_URL}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({ shortId }),
  }).catch(() => {});
}

/** Upload encrypted media blob to R2 */
export async function uploadMedia(encryptedBlob, mimeType) {
  const formData = new FormData();
  formData.append("file", new Blob([encryptedBlob], { type: "application/octet-stream" }));
  formData.append("mime", mimeType);

  const res = await fetch(`${REGISTRY_URL}/media/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error("Upload failed");
  return res.json(); // { url, mediaId, expiresAt }
}

/** Download encrypted media blob from R2 */
export async function downloadMedia(mediaId) {
  const res = await fetch(`${REGISTRY_URL}/media/${mediaId}`);
  if (!res.ok) throw new Error("Download failed");
  return res.arrayBuffer();
}
