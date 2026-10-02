# Trustline Stellar Vault App

> Part of the Trustline Stellar / Soroban stack, developed with support from the [Stellar Community Fund](https://communityfund.stellar.org) (**SCF #44**).

Web app to **deploy and operate** Trustline’s reference [SEP-56](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0056.md) vault
([stellar-vault](https://github.com/TrustLine-id/stellar-vault)) on Stellar, with
Trustline checking every sensitive call. Static React + Vite; talks to the Stellar RPC and,
for Trustline, only to the WebSDK ([`@trustline.id/websdk`](https://www.npmjs.com/package/@trustline.id/websdk)).

## Security

Testnet only; the reference vault and this UI have **not been externally audited**. Do not use with
real value without your own review. Report vulnerabilities privately to security@trustline.id.

## Features

- **Deploy a vault** — dedicated Validation Engine, reference adapter (`dummy-adapter`), fees, timelock, quick setup or roles bootstrap
- **Investor flows** — `deposit` / `mint` / `withdraw` / `redeem`, withdrawal queue, position and fee preview
- **Management** — allocate / deallocate, curator timelock (`submit` → execute), caps, fees, queue manager, sentinels
- **Trustline gate** — WebSDK `validate`, then on-chain intent-id check before Freighter signs
- **Watch-only** — connect Freighter or browse any account read-only

## Pages

- **Vaults**: the vaults this browser knows, deploy a new one, add one by its address.
- **Deploy a vault**: asset (XLM, USDC or any token), name and share symbol (shares carry the
  asset's decimals + 6, the vault's 10⁶ virtual shares), fees, initial timelock, a dedicated
  Validation Engine with Trustline on or off for testing, the reference vault's own adapter
  (`dummy-adapter`, which holds what is allocated to it), and either a quick setup (you as curator,
  queue manager and allocator, the adapter registered as liquidity adapter) or a roles step. With
  Trustline on, the vault is registered on Trustline's dashboard
  ([onboarding.trustline.id](https://onboarding.trustline.id)) before its first checked call. Last, a dead
  deposit of 1 unit by the owner, so the vault never starts from zero shares (donation attack).
- **Overview**: total assets, share price, total shares; the link and bookmark; allocation; every
  role with what it may do, the Trustline owner (the engine's admin) included; the vault's parameters.
- **Investor**: your position; **Invest** (deposit, mint) and **Sell** (withdraw, redeem, your
  waiting requests, processing the queue); the adapters and their caps; the fees and what they
  cost your holding. Each call can also be tried without Trustline, to see the refusal.
- **Management**: **Allocation** (allocate, deallocate, liquidity adapter), **Curator** (pending
  timelocked operations, submit, delays, caps, fees, queue manager), **Admin** (the owner's,
  sentinels' and queue manager's actions; Trustline protection: the engine, its admin, what is
  checked, the policies; the Trustline switch and the engine's hand-over, for the Trustline owner).

## Quick start

```bash
git clone https://github.com/TrustLine-id/stellar-vault-app.git
cd stellar-vault-app

cp .env.example .env.local   # optional; defaults target Stellar testnet
npm install
npm run dev                  # http://localhost:5173
```

Connect **Freighter** on **Testnet** (or watch an account read-only). Build-time settings are
documented in [`.env.example`](.env.example) (`VITE_WASM_*`, registry, Trustline client id, chain id).

```bash
npm run build
npm test                     # structured intents, timelock ops, fees, amounts
npx tsx scripts/vault-e2e.ts # optional headless testnet flow (Trustline check off)
```

With Trustline on, register each new vault on [onboarding.trustline.id](https://onboarding.trustline.id) before
the first checked call, or `validate` will refuse the address.

## How a checked call goes

1. The app describes the call with explicit types (`src/lib/structured.ts`) and the same sender /
   value the contract passes to `require_trustline`.
2. `@trustline.id/websdk` `validate` runs the policy (email OTP when required) and publishes the
   approval on the vault’s Validation Engine.
3. The app compares the returned intent id with `compute_intent_id` on-chain (`checkIntentId`).
4. Freighter signs; the vault consumes the one-shot approval.

## Layout

```text
src/
  pages/           # Welcome, Vaults, CreateVault, VaultView
  lib/             # vault client, Trustline WebSDK, structured intents, chain, fees, engine
  components/      # UI, fees forms, seed deposit, risk notice
  styles.css
tests/             # node:test (intents, ops, fees, amounts)
scripts/
  vault-e2e.ts     # headless testnet deploy + flow
```

## Related repositories

| Repo | Role |
|------|------|
| [stellar-vault](https://github.com/TrustLine-id/stellar-vault) | SEP-56 vault + dummy adapter (WASM this app deploys) |
| [stellar-validation-engine](https://github.com/TrustLine-id/stellar-validation-engine) | Validation Engine, registry; published [`deployments.json`](https://github.com/TrustLine-id/stellar-validation-engine/blob/master/deployments.json) |
| [stellar-sdk](https://github.com/TrustLine-id/stellar-sdk) | `trustline-sdk` (`require_trustline`) |
| [stellar-demo-app](https://github.com/TrustLine-id/stellar-demo-app) | General Trustline integration demo |

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "Freighter is not installed or not available" | No wallet extension | Install Freighter, select **Testnet**, and reload. |
| "Contract code … is not on this network (or has expired)" | The vault, adapter or engine code is not on the selected network | Use testnet. A build of your own must first be uploaded (stellar-vault README, Deploy). |
| The call fails before Freighter opens, with a Trustline refusal | The vault is not registered with Trustline, or the policy refused the call | Register the vault and map its functions on onboarding.trustline.id, then retry. |
| "Refused: no valid Trustline approval for this exact call (engine error 5)." | No approval for this exact call: not requested, refused, expired, or already used | Run the call again from the app: it asks Trustline for a fresh approval each time. |
| "Refused: the engine's sanctions screening refused an address (engine error 6)." | Sanctions screening flagged an address of the call | Use other addresses, or ask the engine's administrator. |
| "Trustline asks for a manual approval of this call; this app does not wait for one" | The policy needs other validators | Have the validators approve it, then run the call again. |
| "Trustline approved other bytes than this contract checks (intent id mismatch): do not sign." | The approved intent differs from the call | Do not sign; report it to Trustline. |
| "Refused: the operation is not due yet (timelock)." | Its delay has not passed | Wait until the time shown on the Curator page. |
| "Refused: the operation was not submitted first." | Executed without `submit` | Submit it from the Curator page first. |
| "Refused: this account is not authorized for this call." | The connected account does not hold the role | Connect the account shown for that role on the Overview page. |
| "Refused by the vault: min withdrawal shares." | Below the 1,000 share-unit minimum | Sell more, or your whole balance. |
| A withdrawal waits in the queue instead of paying out | Not enough liquid assets right now | An allocator deallocates, then anyone processes the queue (Investor → Sell). |
| "Transaction … was not confirmed while the app waited" | The network was slow | Check it in the explorer before trying again. |
| "The quick setup needs a timelock of 0" | A delay was chosen at deployment | Set the roles and the adapter from the Management pages. |

## Known limitations of the reference vault

Known limitations of [stellar-vault](https://github.com/TrustLine-id/stellar-vault) (commit pinned in
`src/lib/config.ts` as `REFERENCE_VAULT.commit`):

- The Validation Engine is fixed at deployment: the vault has no operation to replace it. If Trustline is unavailable, the Trustline owner (the engine's admin) switches its check off.
- One adapter whose valuation fails blocks every operation, withdrawals of idle assets included, and it cannot be removed while it does.
- The withdrawal queue is first in, first out: a request the liquidity cannot pay holds back the smaller ones behind it, until it is paid or cancelled (its owner or the queue manager).
- A waiting request whose receiver can no longer receive the asset fails at settlement and blocks the queue the same way, whatever the liquidity, until it is cancelled.
- The performance fee is paid to the fee receiver by a transfer inside the sale: a receiver that cannot receive the asset blocks every sale with a performance fee until the fees are changed.
- An adapter that lost assets keeps an allocation on the books once emptied, so it can never be removed.
- The minimum withdrawal request, 1,000 share units, is worth less than the asset's smallest unit: such a request burns the shares and pays nothing.
- With an adapter that trades, an investor's entry and exit costs are paid by the other holders: shares are priced before the adapter invests or sells.
- A sentinel's deallocation needs a Trustline approval, so a sentinel cannot reduce risk while Trustline refuses.
- Adding or removing an adapter does not accrue the management fee first. Harmless since only empty adapters can be added or removed: the next accrual is right.
- The share token publishes no SEP-41 transfer / approve / mint / burn events, ignores approval expiry, and has no burn.
- The Trustline value is the assets for deposit / withdraw / allocate / deallocate and the shares for mint / redeem.
- Timelock error numbers (1–6) overlap the Validation Engine's: #5 is "invalid duration" on a timelock call, "no approval" elsewhere.

## License

Copyright (c) 2026 [Trustline Digital Asset Ltd.](https://www.trustline.id). GNU GPL v2 (or later) — see [LICENSE](LICENSE).

## Links

- **Homepage:** https://www.trustline.id
- **Repository:** https://github.com/TrustLine-id/stellar-vault-app
- **Vault contracts:** https://github.com/TrustLine-id/stellar-vault
- **Issues:** https://github.com/TrustLine-id/stellar-vault-app/issues
