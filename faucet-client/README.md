# faucet-client

This is the client side code for the PoWFaucet.

This builds:
- /static/js/powfaucet.js  (entry src/main.ts)
- /static/js/powfaucet-worker-sc.js  (entry src/worker/worker-scrypt.ts)
- /static/js/powfaucet-worker-cn.js  (entry src/worker/worker-cryptonight.ts)
- /static/js/powfaucet-worker-a2.js  (entry src/worker/worker-argon2.ts)
- /static/css/powfaucet.css  (all css imports)

# How to build

Use Node.js 22.23.2 with npm 10.9.8.

`npm ci`

`node ./build-client.js`
