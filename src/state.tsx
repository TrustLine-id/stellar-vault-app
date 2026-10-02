// App-wide state: the connected Freighter account, signing, notifications, navigation.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { connectFreighter, signTransaction, type WalletState } from "./lib/wallet";
import { NETWORK } from "./lib/config";

type Toast = { id: number; text: string; kind: "ok" | "bad" | "info" };
type Me = WalletState & { readOnly?: boolean };
type Ctx = {
  me: Me | null;
  connect: () => Promise<void>;
  /** Read-only: browse as any account without Freighter (nothing can be signed). */
  watch: (address: string) => void;
  disconnect: () => void;
  sign: (xdr: string) => Promise<string>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  route: string[];
  go: (path: string) => void;
};
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const parse = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "").split("/").filter(Boolean);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [route, setRoute] = useState<string[]>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((p: string) => { location.hash = "#/" + p.replace(/^\//, ""); }, []);
  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "bad" ? 9000 : 5000);
  }, []);
  const connect = useCallback(async () => {
    const w = await connectFreighter();
    if (w.networkPassphrase !== NETWORK.passphrase) {
      throw new Error(`Freighter is on ${w.network}. Switch it to ${NETWORK.name} and connect again.`);
    }
    setMe(w);
    try { localStorage.setItem("tv.connected", "1"); } catch { /* ignore */ }
  }, []);
  const watch = useCallback((address: string) => setMe({ address, network: NETWORK.name, networkPassphrase: NETWORK.passphrase, readOnly: true }), []);
  const disconnect = useCallback(() => { setMe(null); try { localStorage.removeItem("tv.connected"); } catch { /* ignore */ } go(""); }, [go]);
  useEffect(() => {
    let wanted = false;
    try { wanted = localStorage.getItem("tv.connected") === "1"; } catch { /* ignore */ }
    if (wanted) connect().catch(() => undefined);
  }, [connect]);
  const sign = useCallback(async (xdr: string) => {
    if (!me) throw new Error("Connect Freighter first");
    if (me.readOnly) throw new Error("Watch-only: connect Freighter to sign");
    const r = await signTransaction(xdr, { networkPassphrase: NETWORK.passphrase, address: me.address });
    if (r.error) throw new Error(r.error.message ?? "Signing refused in Freighter");
    return r.signedTxXdr;
  }, [me]);
  return (
    <AppCtx.Provider value={{ me, connect, watch, disconnect, sign, toast, route, go }}>
      {children}
      <div className="toast" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={t.kind}>{t.text}</div>)}</div>
    </AppCtx.Provider>
  );
}

/** Run an async action with error reporting; returns a click handler. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string>("");
  const run = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(`${label}: ${(e as Error).message}`, "bad"); } finally { setBusy(""); }
  };
  return { busy, run };
}
