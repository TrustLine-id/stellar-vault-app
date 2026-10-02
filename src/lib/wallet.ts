// Freighter (the browser extension): the connected account and the signing of transactions.
// Keys never leave the extension; the app only hands it transaction envelopes to sign.
import {
  isConnected,
  isAllowed,
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction,
} from "@stellar/freighter-api";

export type WalletState = {
  address: string;
  network: string;
  networkPassphrase: string;
};

export async function connectFreighter(): Promise<WalletState> {
  const connected = await isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error("Freighter is not installed or not available");
  }

  const allowed = await isAllowed();
  if (allowed.error || !allowed.isAllowed) {
    const access = await requestAccess();
    if (access.error || !access.address) {
      throw new Error(access.error?.message ?? "Freighter access denied");
    }
  }

  const addr = await getAddress();
  if (addr.error || !addr.address) {
    throw new Error(addr.error?.message ?? "Could not read Freighter address");
  }

  const net = await getNetwork();
  if (net.error) {
    throw new Error(net.error.message ?? "Could not read Freighter network");
  }

  return {
    address: addr.address,
    network: net.network,
    networkPassphrase: net.networkPassphrase,
  };
}

export { signTransaction };
