// Vaults: Trustline's reference SEP-56 vault (TrustLine-id/stellar-vault), with Morpho V2-style
// roles, curator timelock, yield adapters and fees. List of the vaults known in this browser.
import { useEffect, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { useApp, useAction } from "../state";
import { cfg, REFERENCE_VAULT } from "../lib/config";
import { readVault } from "../lib/vault";
import { forgetVault, listVaults, saveVault, type VaultRecord } from "../lib/store";
import { vaultStatus, loadVault, type VaultState } from "../useVault";
import { CopyText, fmtAmount, Identicon, Modal, short } from "../components/ui";

export default function Vaults() {
  const { me, go } = useApp();
  const [vaults, setVaults] = useState<VaultRecord[]>(listVaults);
  const [states, setStates] = useState<Record<string, VaultState | "error">>({});
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    for (const r of vaults) loadVault(r.vault, me?.address).then((s) => setStates((m) => ({ ...m, [r.vault]: s }))).catch(() => setStates((m) => ({ ...m, [r.vault]: "error" })));
  }, [vaults, me?.address]);
  return (
    <div className="body full">
      <main className="main">
        <div className="pagehead">
          <div>
            <h1>Vaults</h1>
            <div className="muted">Trustline's reference SEP-56 vault: roles, curator timelock, yield adapters and fees, each sensitive call checked by Trustline.</div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setAdding(true)}>Add existing vault</button>
            <button className="btn primary" disabled={!!me?.readOnly} title={me?.readOnly ? "Watch-only: connect Freighter to deploy" : undefined} onClick={() => go("vault/new")}>+ Deploy a vault</button>
          </div>
        </div>
        <div className="banner info" style={{ marginBottom: 16 }}>
          The vault contract is <a href={`https://github.com/${REFERENCE_VAULT.repo}`} target="_blank" rel="noreferrer" className="mono">{REFERENCE_VAULT.repo}</a>, deployed here from commit <span className="mono">{REFERENCE_VAULT.commit}</span>. Testnet only, not audited.
        </div>
        {vaults.length === 0 && <div className="card muted">No vault in this browser yet. Deploy one, or add one by its address.</div>}
        <div className="cards">
          {vaults.map((r) => {
            const s = states[r.vault];
            const v = s && s !== "error" ? s : null;
            const st = vaultStatus(v);
            return (
              <div key={r.vault} className="card vaultrow">
                <Identicon address={r.vault} size={44} />
                <div style={{ minWidth: 0 }}>
                  <a href={`#/vault/${r.vault}`} style={{ fontWeight: 600, color: "inherit" }}>{v?.info.name ?? r.name}</a>
                  <div><CopyText text={r.vault} className="mono muted small">{short(r.vault, 8)}</CopyText></div>
                </div>
                <div className="mono">{v ? `${fmtAmount(v.info.totalAssets, v.asset.decimals, 2)} ${v.asset.symbol}` : s === "error" ? <span className="bad">unreadable</span> : "…"}</div>
                <span className="pill" title="Adapters">{v ? `${v.info.adapters.length} adapter${v.info.adapters.length === 1 ? "" : "s"}` : "…"}</span>
                <span className="row">
                  <span className={`pill ${st.cls}`}><span className="dot" />{st.text}</span>
                  <button className="btn sm" onClick={() => { forgetVault(r.vault); setVaults(listVaults()); }}>Remove</button>
                </span>
              </div>
            );
          })}
        </div>
        {adding && <AddVault onClose={() => setAdding(false)} onAdded={(v) => { setAdding(false); setVaults(listVaults()); go(`vault/${v}`); }} />}
      </main>
    </div>
  );
}

function AddVault({ onClose, onAdded }: { onClose: () => void; onAdded: (vault: string) => void }) {
  const [addr, setAddr] = useState("");
  const { busy, run } = useAction();
  const add = run("Add vault", async () => {
    const vault = addr.trim();
    if (!StrKey.isValidContract(vault)) throw new Error("Enter the vault's contract address (C…)");
    const info = await readVault(cfg, vault).catch(() => { throw new Error("Not a Trustline vault: its functions could not be read"); });
    saveVault({ vault, name: info.name, createdAt: new Date().toISOString() });
    onAdded(vault);
  });
  return (
    <Modal onClose={onClose} label="Add an existing vault">
      <div className="stack">
        <h2>Add an existing vault</h2>
        <label className="field">Vault address<input className="mono" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="C…" /></label>
        <p className="small muted">For example a vault deployed elsewhere, from the vault repository's deploy script. The app reads its roles, adapters, timelock and fees from the chain and shows its code hash.</p>
        <div className="row"><button className="btn primary" disabled={!!busy} onClick={add}>{busy ? "Checking…" : "Add vault"}</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}
