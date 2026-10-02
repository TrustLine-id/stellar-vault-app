// Everything the vault pages show, read from the chain.
import { useCallback, useEffect, useRef, useState } from "react";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { cfg, REFERENCE_VAULT } from "./lib/config";
import { opFromNative, pendingOps, readPosition, readVault, type VaultPosition, type VaultInfo, type PendingOp } from "./lib/vault";
import { vaultSubmitted } from "./lib/store";
import { tokenInfo } from "./lib/tokens";

export type VaultState = {
  info: VaultInfo;
  asset: { symbol: string; name: string; decimals: number };
  /** The build this app deploys (commit REFERENCE_VAULT.commit), or another one. */
  knownCode: boolean;
  position: VaultPosition | null;
  pending: { op: PendingOp; eta: Date }[];
  /** False when the vault's events could not all be read: `pending` then holds only what this browser submitted. */
  pendingComplete: boolean;
};

const localOps = (vault: string): PendingOp[] =>
  vaultSubmitted(vault).map((x) => { try { return opFromNative(scValToNative(xdr.ScVal.fromXDR(x, "base64"))); } catch { return null; } }).filter((o): o is PendingOp => !!o);

export async function loadVault(id: string, viewer?: string): Promise<VaultState> {
  const info = await readVault(cfg, id);
  const [asset, position, pending] = await Promise.all([
    tokenInfo(info.asset),
    viewer ? readPosition(cfg, info, viewer) : null,
    pendingOps(cfg, info, localOps(id)),
  ]);
  return { info, asset, knownCode: info.codeHash === REFERENCE_VAULT.vault, position, pending: pending.ops, pendingComplete: pending.complete };
}

export function useVault(id: string, viewer?: string) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState("");
  // Loads overlap (the 30 s tick, a refresh after an action, a viewer change): only the latest one counts.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const s = await loadVault(id, viewer);
      if (n === seq.current) { setState(s); setError(""); }
    } catch (e) { if (n === seq.current) setError((e as Error).message); }
  }, [id, viewer]);
  useEffect(() => { setState(null); setError(""); refresh(); const t = setInterval(refresh, 30_000); return () => { clearInterval(t); seq.current++; }; }, [refresh]);
  return { state, error, refresh };
}

export function vaultStatus(v: VaultState | null): { cls: string; text: string } {
  if (!v) return { cls: "", text: "Trustline …" };
  if (v.info.trustlineOn === false) return { cls: "warn", text: "Trustline off (testing)" };
  if (v.info.trustlineOn) return { cls: "ok", text: "Trustline on" };
  return { cls: "", text: "Trustline" };
}
