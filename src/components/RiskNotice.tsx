// First screen: the software is unaudited and in development, and used at the user's own risk.
// Nothing else is shown until the user ticks the box and clicks "I understand the risk". The
// answer is remembered in this browser only (it is asked again elsewhere, or when the notice
// changes version).
import { useState, type ReactNode } from "react";

const KEY = "trustline.riskNotice";
const VERSION = "2026-09-30";

function accepted(): boolean {
  try { return localStorage.getItem(KEY) === VERSION; } catch { return false; }
}

export default function RiskNotice({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(accepted);
  const [ticked, setTicked] = useState(false);
  if (ok) return <>{children}</>;
  const accept = () => {
    try { localStorage.setItem(KEY, VERSION); } catch { /* storage unavailable: asked again next time */ }
    setOk(true);
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card stack" style={{ maxWidth: 680, width: "100%" }} role="dialog" aria-modal="true" aria-labelledby="risk-title">
        <h2 id="risk-title" style={{ margin: 0 }}>Before you continue: important notice</h2>
        <div className="banner warn"><b>Experimental software, unaudited, in development.</b> Use it at your own risk.</div>
        <div className="small stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>
            This application and the smart contracts it deploys and operates (vaults, adapters,
            Validation Engines) are provided for <b>testing and evaluation on the Stellar Testnet</b>. They are under
            active development and <b>have not been audited</b> by an independent security firm. They may contain bugs or
            vulnerabilities, and they may change or stop working at any time without notice.
          </p>
          <p style={{ margin: 0 }}>
            <b>Do not use real funds or assets of value.</b> Testnet assets have no value, and the network can be reset.
            Transactions on a blockchain are irreversible: an error, a bug or a mistaken address can cause a permanent loss.
          </p>
          <p style={{ margin: 0 }}>
            You are solely responsible for your use of the application, for your wallet, keys and signatures, and for
            checking every transaction before you sign it. Trustline's checks (email codes, policies, sanctions screening)
            are provided to help, not as a guarantee: they may be unavailable, incomplete or wrong.
          </p>
          <p style={{ margin: 0 }}>
            The software is provided <b>"as is", without warranty of any kind</b>, express or implied, including
            merchantability, fitness for a particular purpose and non-infringement. To the fullest extent permitted by law,
            Trustline Digital Asset Ltd. and its contributors accept no liability for any loss or damage arising from its use.
          </p>
          <p style={{ margin: 0 }}>
            Nothing in this application is financial, investment, legal or tax advice, nor an offer or solicitation to buy or
            sell any asset or to invest in any vault. Fees, yields and prices shown are simulations on test networks.
          </p>
          <p style={{ margin: 0 }}>
            You confirm that you use the application in compliance with the laws that apply to you, and that you are not a
            person subject to sanctions or located in a sanctioned jurisdiction.
          </p>
        </div>
        <label className="row" style={{ color: "var(--ink)", alignItems: "flex-start" }}>
          <input type="checkbox" style={{ width: "auto", marginTop: 3 }} checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span>I have read this notice. I understand that this software is unaudited and in development, that I use it at my own risk, and that I must not use real funds.</span>
        </label>
        <div className="row"><button className="btn primary" disabled={!ticked} onClick={accept}>I understand the risk</button></div>
      </div>
    </div>
  );
}
