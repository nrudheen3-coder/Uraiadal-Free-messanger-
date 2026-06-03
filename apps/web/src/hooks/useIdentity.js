import { useState, useEffect } from "react";
import { generateIdentity, initCrypto } from "../crypto/index.js";
import { getIdentity, saveIdentity, initSettings } from "../db/index.js";

export function useIdentity() {
  const [identity, setIdentity]   = useState(null);
  const [loading,  setLoading]    = useState(true);
  const [error,    setError]      = useState(null);

  useEffect(() => {
    (async () => {
      try {
        await initCrypto();
        await initSettings();
        const saved = await getIdentity();
        if (saved) setIdentity(saved);
      } catch (e) {
        console.error("[useIdentity]", e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const createIdentity = async () => {
    setLoading(true);
    try {
      const id = await generateIdentity();
      await saveIdentity(id);
      setIdentity(id);
      return id;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  };

  const restoreIdentity = async (privateKeyData) => {
    // TODO: restore from exported key backup
    throw new Error("Restore not yet implemented");
  };

  const clearIdentity = async () => {
    // Nuclear option — wipes everything
    const { db } = await import("../db/index.js");
    await db.delete();
    setIdentity(null);
  };

  return { identity, loading, error, createIdentity, restoreIdentity, clearIdentity };
}
