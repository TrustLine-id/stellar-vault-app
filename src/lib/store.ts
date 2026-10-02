// What this browser remembers: the vaults listed, the timelocked operations submitted from here,
// and the names given to addresses. All of it is public on-chain data.

const LS = { names: "tv.names", vaults: "tv.vaults", vaultOps: "tv.ops" };
// Keys of an earlier build of this app, read once and moved under the names above.
const OLD = { "ts.jcvaults": LS.vaults, "ts.jcops": LS.vaultOps };
for (const [old, key] of Object.entries(OLD)) {
  try { const v = localStorage.getItem(old); if (v !== null) { if (localStorage.getItem(key) === null) localStorage.setItem(key, v); localStorage.removeItem(old); } } catch { /* storage unavailable */ }
}
const read = <T,>(k: string, d: T): T => {
  try { const v = JSON.parse(localStorage.getItem(k) ?? "") as T; return v !== null && typeof v === typeof d && Array.isArray(v) === Array.isArray(d) ? v : d; } catch { return d; }
};
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };

// ---- vaults (this browser only; a vault page also opens from its link, read from the chain) ----
export type VaultRecord = { vault: string; name: string; createdAt: string };
export const listVaults = (): VaultRecord[] => read<VaultRecord[]>(LS.vaults, []);
export function saveVault(v: VaultRecord): void {
  write(LS.vaults, [v, ...listVaults().filter((x) => x.vault !== v.vault)]);
}
export function forgetVault(vault: string): void {
  write(LS.vaults, listVaults().filter((x) => x.vault !== vault));
}
// ---- the timelocked operations submitted from here ----
/** Operations submitted from this browser, as XDR, per vault (a fallback when events are unavailable). */
export const vaultSubmitted = (vault: string): string[] => read<Record<string, string[]>>(LS.vaultOps, {})[vault] ?? [];
export function rememberVaultOp(vault: string, opXdr: string): void {
  const all = read<Record<string, string[]>>(LS.vaultOps, {});
  all[vault] = [...new Set([...(all[vault] ?? []), opXdr])].slice(-50);
  write(LS.vaultOps, all);
}

// ---- address book ----
export const addressBook = (): Record<string, string> => read(LS.names, {});
export function nameAddress(address: string, name: string): void {
  const all = addressBook();
  if (name.trim()) all[address] = name.trim(); else delete all[address];
  write(LS.names, all);
}
