# Hyperfaucet

A proof-of-work faucet for the Hyperliquid testnet, forked from
[PoWFaucet](https://github.com/pk910/PoWFaucet). Mining in the browser
rate-limits requests, so there is testnet HYPE left for everyone.

What this fork adds:

- **hyperliquid-stake** module: reward multipliers from delegated mainnet HYPE,
  using configurable value tiers and optional validator filtering.
- **dynamic-outflow** module: a drain governor that continuously retargets the
  global reward rate to `wallet balance / target drain time`, so the faucet
  survives any demand level and never cliffs to zero.
- A restyled client.

## Running it

```bash
npm ci
cd faucet-client && npm ci && node build-client.js && cd ..
cp faucet-config.example.yaml faucet-config.yaml   # then edit
npm start
```

The example config targets HyperEVM testnet (chain 998, native HYPE) with
stake lookups against the mainnet info API. Set a fresh wallet key, distinct
random `faucetSecret` and `pseudonymKey` values, fund the wallet with testnet
HYPE, and configure a captcha key before public deployment. When deploying
behind a reverse proxy, block direct access to the backend port before setting
`httpProxyCount` to the exact trusted hop count. A reachable origin that trusts
forwarded headers lets clients spoof their IP and bypass per-IP limits.

See [the operator setup guide](docs/webserver-setup.md) before exposing the
service. The [PoWFaucet operator wiki](https://github.com/pk910/PoWFaucet/wiki)
still covers inherited database and module options.

Run one active backend for each faucet database and payout wallet. Do not use
active-active replicas that share either resource.

## License

AGPL-3.0, same as upstream. See LICENSE.
