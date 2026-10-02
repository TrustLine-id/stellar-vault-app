import type { ReactElement } from "react";
import { useApp } from "./state";
import { NETWORK } from "./lib/config";
import { Addr } from "./components/ui";
import Welcome from "./pages/Welcome";
import Vaults from "./pages/Vaults";
import CreateVault from "./pages/CreateVault";
import VaultView from "./pages/VaultView";

/** Routes: #/vaults, #/vault/new, #/vault/<id>/<page>. */
export default function App() {
  const { me, route, go, connect, disconnect, toast } = useApp();
  const [section, id, page = "overview"] = route;

  let content: ReactElement;
  if (!me) content = <Welcome />;
  else if (section === "vault" && id === "new") content = <CreateVault onCreated={(vault) => go(`vault/${vault}`)} />;
  else if (section === "vault" && id) content = <VaultView key={id} id={id} page={page} />;
  else content = <Vaults />;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/vaults"><img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" /><b>Trustline Vault</b></a>
        <span className="pill">{NETWORK.name}</span>
        <span className="spacer" />
        {me ? (
          <span className="row">
            {me.readOnly && <span className="pill warn">Watch-only</span>}
            <Addr a={me.address} size={26} />
            <button className="btn sm" onClick={disconnect}>Disconnect</button>
          </span>
        ) : (
          <button className="btn primary sm" onClick={() => connect().catch((e) => toast((e as Error).message, "bad"))}>Connect Freighter</button>
        )}
      </header>
      {content}
      <footer className="footer">
        <span>Trustline Vault · an SEP-56 vault on Stellar guarded by Trustline</span>
        <span className="spacer" />
        <span className="row"><span>Built on</span><img src={`${import.meta.env.BASE_URL}stellar-logo.png`} alt="Stellar" /></span>
        <span style={{ flexBasis: "100%" }}>
          “Stellar” is a trademark of the Stellar Development Foundation. All rights reserved. This is independent software, not affiliated with,
          sponsored or endorsed by the Stellar Development Foundation.{NETWORK.isTestnet ? " Testnet: tokens have no value." : ""}
        </span>
      </footer>
    </div>
  );
}
