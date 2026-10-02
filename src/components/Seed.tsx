// The dead deposit, asked right after creation: 1 unit of the asset deposited by the owner, whose
// shares are kept until the vault closes. The vault then never starts from zero shares, which
// is what the donation attack needs (a tiny first deposit, then a direct transfer that inflates
// the share price so the next deposits round down).
import { useState } from "react";
import { toBaseUnits } from "../lib/chain";

export default function Seed({ symbol, decimals, blocked, seed, onDone }: {
  symbol: string; decimals: number; blocked?: string;
  /** Deposit `units` of the asset from the connected account; returns the transaction hash. */
  seed: (units: bigint) => Promise<string>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true); setError("");
    try { await seed(toBaseUnits("1", decimals)); onDone(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">Deposit 1 {symbol} now, so the vault never starts empty (donation attack) and one share is worth exactly 1 {symbol}. Keep these shares until the vault closes.</div>
      <div className="row"><button className="btn primary" disabled={busy || !!blocked} onClick={go}>{busy ? "Depositing…" : `Deposit 1 ${symbol}`}</button></div>
      {blocked && <div className="small warn">{blocked}</div>}
      {error && <div className="banner bad">{error}</div>}
    </div>
  );
}
