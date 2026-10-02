import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { useApp, useAction } from "../state";
import { NETWORK } from "../lib/config";

export default function Welcome() {
  const { connect, watch } = useApp();
  const [addr, setAddr] = useState("");
  const { busy, run } = useAction();
  return (
    <div className="body full">
      <main className="main">
        <div className="welcome">
          <div className="hero stack">
            <span className="pill gold" style={{ justifySelf: "start" }}>SEP-56 vault · {NETWORK.name}</span>
            <h1>A Stellar vault where <span className="hl-blue">every sensitive call</span> is verified by <span className="hl-gold">Trustline</span>.</h1>
            <ul>
              <li>Investors deposit and withdraw in an SEP-56 tokenized vault. Each deposit, withdrawal and redemption needs a Trustline approval for that exact call, consumed once on-chain.</li>
              <li>Managers too: roles, timelocked operations, allocations and the liquidity adapter, each under the policy the project chose (automatic approval, email code, or blocked).</li>
              <li>Yield comes from adapters behind one interface: the curator adds them under a timelock and caps what each may hold.</li>
              <li>Sanctions screening on-chain, and a switch for the Trustline owner if Trustline is ever unavailable.</li>
            </ul>
          </div>
          <div className="card stack">
            <h2>Connect your wallet</h2>
            <p className="muted">
              The app uses the Freighter browser extension to sign. Your keys never leave Freighter. Switch Freighter to <b>{NETWORK.name}</b> first.
            </p>
            <button className="btn primary" disabled={!!busy} onClick={run("Connect", connect)}>{busy ? "Connecting…" : "Connect Freighter"}</button>
            <p className="small muted">
              No Freighter yet? Install it from <a href="https://www.freighter.app" target="_blank" rel="noreferrer">freighter.app</a>.
              {NETWORK.isTestnet && " On testnet, fund your account from Freighter (Fund with Friendbot)."}
            </p>
            <hr />
            <div className="small muted">Or look around without signing: watch an account</div>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input className="mono" aria-label="Account to watch" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="G…" />
              <button className="btn" disabled={!StrKey.isValidEd25519PublicKey(addr.trim())} onClick={() => watch(addr.trim())}>Watch</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
