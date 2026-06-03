import { useState, useEffect, useCallback } from "react";
import { getMessages, saveMessage, updateMessageStatus, markAsRead } from "../db/index.js";
import { sendMessage as relaySend, onRelayEvent } from "../crypto/relay.js";
import { encryptMessage, decryptMessage, generateToken } from "../crypto/index.js";

export function useMessages(chatId, identity, contact) {
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);

  // Load messages from IndexedDB on mount
  useEffect(() => {
    if (!chatId) return;
    (async () => {
      setLoading(true);
      const msgs = await getMessages(chatId, 50);
      setMessages(msgs);
      await markAsRead(chatId);
      setLoading(false);
    })();
  }, [chatId]);

  // Listen for incoming messages from relay
  useEffect(() => {
    if (!chatId || !identity) return;

    const unsub = onRelayEvent("message", async (data) => {
      if (data.fromId !== chatId) return;

      let text = data.payload;

      // Decrypt if we have contact's exchange key
      if (contact?.exchange?.publicKey) {
        text = await decryptMessage(
          data.payload.ciphertext,
          data.payload.nonce,
          contact.exchange.publicKey,
          identity.exchange.privateKey
        );
      }

      const msg = {
        id:        data.messageId,
        chatId,
        fromId:    data.fromId,
        text,
        type:      data.msgType || "text",
        timestamp: data.timestamp || Date.now(),
        status:    "read",
      };

      await saveMessage(msg);
      setMessages(prev => [...prev, msg]);
    });

    // Listen for delivery receipts
    const unsubReceipt = onRelayEvent("receipt", async (data) => {
      if (data.chatId !== chatId) return;
      await updateMessageStatus(data.messageId, data.status);
      setMessages(prev =>
        prev.map(m => m.id === data.messageId ? { ...m, status: data.status } : m)
      );
    });

    return () => { unsub(); unsubReceipt(); };
  }, [chatId, identity, contact]);

  const sendText = useCallback(async (text) => {
    if (!text.trim() || !identity) return;

    const msgId = generateToken(8);
    const now   = Date.now();

    let payload = { ciphertext: text, nonce: "" };

    // Encrypt if we have contact's exchange key
    if (contact?.exchange?.publicKey) {
      payload = await encryptMessage(
        text,
        contact.exchange.publicKey,
        identity.exchange.privateKey
      );
    }

    const msg = {
      id:        msgId,
      chatId,
      fromId:    "self",
      text,
      type:      "text",
      timestamp: now,
      status:    "sent",
    };

    // Optimistic UI — add locally first
    setMessages(prev => [...prev, msg]);
    await saveMessage(msg);

    // Send via relay
    const sent = relaySend({
      messageId: msgId,
      toId:      chatId,
      fromId:    identity.shortId,
      payload,
      msgType:   "text",
      timestamp: now,
    });

    if (sent) {
      setTimeout(async () => {
        await updateMessageStatus(msgId, "delivered");
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, status: "delivered" } : m));
      }, 600);
    }

    return msg;
  }, [chatId, identity, contact]);

  return { messages, loading, sendText };
}
