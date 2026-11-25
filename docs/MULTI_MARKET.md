# Three markets on Sepolia

We have four test ERC20 tokens, all clearly marked as demo: RUBA (18 decimals), USDT (6), WETH (18) and WBTC (8). On top of them run three independent markets: ruba-usdt, ruba-weth and weth-wbtc. Every market has its own ZkRubaVault, SQLite database, pool recovery key, balances, inbox, nonces, journal, proof cache, deposits and withdrawals. The verifier and Poseidon contracts are shared. We kept the v2 format with 13 public signals, but partial batches needed rebuilt Circom artifacts and a new verifier. Inside the code RUBA/USDT just mean token0/token1, and the real symbols and decimals come from public metadata. Our WETH does not wrap ETH, our WBTC has nothing to do with a BTC bridge, and our USDT is not real Tether

The current release uses new Vaults and a new verifier, with state in `data/sepolia-partial-v2-20261123`. Its checked public snapshot is in [deployments/sepolia-v2.json](../deployments/sepolia-v2.json). The older `deployments/sepolia.json` and the bot disclosure file belong to a previous release, so don't take token addresses or reserves from there

## Who can do what (updated 2026-11-25)

REGISTER, new deposits, SWAP and ADD_LP need the owner to be on the whitelist of that particular Vault. Market pause does not block REGISTER, but it does block deposits, SWAP and ADD_LP. REMOVE_LP, reserving a withdrawal, settling a payout and redeeming an accepted claim work without the whitelist. Deposits the Vault has already received must still be processed after the whitelist is revoked. Anyone can publish a proof: admission is checked for the owner of each REGISTER, SWAP or ADD_LP, not for whoever pays the gas

These checks live in the new Vault bytecode. Admission by itself did not need any Circom changes, it was partial batches that required new circuit artifacts and a new verifier. Updating the server or the UI cannot change the old Vaults, they are immutable. Their manifests, databases and balances are not reset or migrated

From 25 November, admission can be handled by a separate desk: the user signs consent and a KYC reference, the desk signs an approval, and the user sends `admit` to the Vault and pays gas. The Vault stores hashes of the KYC reference and consent. KYC verification is still a stub. The owner can grant access directly as before. Three pause guardians can stop a market or token payouts; resuming requires two approvals and the configured delay. The old Sepolia Vaults have not been updated. See [RISK_CONTROLS_RU.md](RISK_CONTROLS_RU.md)

## Server config

ServerConfig has optional marketId, marketLabel and tokenMetadata: `{RUBA:{symbol:string,decimals:number},USDT:{symbol:string,decimals:number}}`. Without metadata everything works as before, with RUBA at 18 decimals and USDT at 6. Symbols must match `/^[A-Z][A-Z0-9]{0,11}$/`, decimals must be between 0 and 18, and token addresses must differ. On startup the chain code checks the configured decimals against the real tokens over RPC. RubaApi.publicConfig includes token symbols only when metadata is set, same for marketId and marketLabel. Internal operation enums in the API did not change

RubaApi.handle is public now, so a market router can call it with a cleaned up URL. `execute(request, internalOptions?)` accepts optional synchronous `beforeApply()` and `onCommit(result)` hooks that run inside the same economic transaction. They exist only in code and never come from JSON. Anything written in onCommit rolls back together with the economic action. Don't call execute or sync recursively inside serial

`CHAIN_MODE=sepolia` is only accepted for chainId 11155111. In this demo we wait for a configurable number of confirmations (1 by default) instead of waiting about 15 minutes for finality at every bootstrap step. For mainnet and other modes finality works as before, and a reorg still stops everything. If a confirmed read happens before deploymentBlock, we report it as waiting instead of decoding it as a contract response. The Sepolia mode and its confirmation policy should be visible in config and docs

## Market catalog, routing and settings

Shared types are in server/market-types.ts. MarketRuntime is `{id,label,config,engine,chain,api}`, and id must match `[a-z0-9]+(?:-[a-z0-9]+)*`. Public asset metadata is `{symbol,decimals,address}`

GET /markets returns `{network:{chainId,name,explorerUrl},defaultMarketId,markets:[{id,label,chainId,vault,base,quote}],control:{admin,domain,types,nonce,revision,prices}}`

GET /markets/:id/dashboard returns `{marketId,pair,accepted,progress,referencePrices,settingsRevision,arbitrage}`. accepted is null until the first liquidity is accepted, after that it is `{stateVersion,root,blockNumber,reserve0,reserve1,spot,target,deviationBps,history}`. Each history entry is `{stateVersion,blockNumber,timestamp,spot,target,deviationBps}`, we keep at most 120 of them and only for accepted checkpoints. Integers go out as strings. Human readable prices are positive decimal strings with at most 18 decimal places. deviationBps can be negative, spot and target are quote units per one base unit. The public dashboard never shows pending reserves, user balances, keys, witnesses, the bot's private plan or receipts. Bot status can include stage, nextRunAt and error

Requests to /markets/:id/config, nonce, actions, publication and disclosure/batches/:n go to the RubaApi of that market. Old root paths can point to the default market. Static UI files are served through the same allowlist as before. Unknown markets are rejected before anything changes

## Admin commands

POST /admin/action takes `{command,nonce,deadline,signature}`. The EIP712 domain is `{name:'RubaMarketControl',version:'1',chainId,verifyingContract:defaultVault}` and the type is `ControlAction(bytes32 actionHash,uint256 nonce,uint256 deadline)`. actionHash = keccak256(UTF8 canonicalControlJson(command)). This control serializer is separate: it sorts object keys and allows plain integers for delaySeconds. The serializer for economic actions is unchanged. The signer must be exactly the admin, the control nonce is global and stored on disk, the deadline can be at most now + 600 seconds, and replays are rejected. Settings are saved atomically. Commands:

- `{kind:'prices',prices:{RUBA:'1',USDT:'1',WETH:'3000',WBTC:'90000'}}`, USDT is always 1
- `{kind:'arbitrage',marketId,enabled:boolean,delaySeconds:integer}`, delay from 5 to 3600
- `{kind:'monitor',marketId}` returns the current private price and reserves for the admin. This is not an accepted onchain snapshot, and it uses up a control nonce
- `{kind:'closeBatch',marketId}` closes a tail of 1-3 swaps in the selected market and starts preparing the publication. Same admin signature, nonce and deadline as other commands. It does not authorize onchain publication and does not spend server ETH
- `{kind:'rebuildQueue',marketId}` lets the admin rebuild a rejected pending queue from the last accepted checkpoint. The server drops invalid signed actions and later actions from the same account, then recalculates the remaining transition with the original signatures. Accepted on-chain events are not removed

Responses look like `{result,nonce,revision}`. For closeBatch the result has marketId, closedThroughStateVersion and publication. If the proof could not be prepared, the closed boundary and the used nonce stay, publication is null and preparationError explains why. The UI publishes only up to that boundary. closeBatch does not bump the settings revision

Prices and revision are global, bot settings are per pool. Bots are off by default with a 30 second delay. Target prices are demo references that the admin sets by hand, not live oracle prices. Public pool values can leak information about swaps, and batching accepted swaps does not make anyone anonymous

## Partial trade batches (updated 2026-11-23)

A trade transition has 1 to 4 real swaps. The fourth swap closes the batch automatically, REMOVE_LP and RESERVE_WITHDRAWAL also close the waiting tail. The admin can close it manually with closeBatch for a specific market. Closing an empty queue does nothing, closing again does not touch closed transitions, and publication keeps the existing root and version chain. Receipt trees still have four leaves padded with zeros, while tradeCount and the trade range only count real trades. Batch IDs count mode 1 transitions, not totalTrades/4

There is no timer, no plaintext reserves on chain and no automatic disclosure to a regulator. A regulator gets selected receipts and proofs separately. Publication still needs only a proof, anyone can do it, and the sending wallet pays. The old MIN_TRADES_PER_BATCH=4 is about the old path, the ZK path allows 1

What we assume: the admin, the prover and someone to pay gas are available. If pause or admission changes before publication, the server does not automatically rebuild an invalid tail and there is no onchain cancellation. The admin can request `rebuildQueue`, but this still depends on a working server. An operation that became forbidden can make the whole transition fail and block the ones after it. Smaller batches mix fewer users and don't guarantee anonymity. Autonomous emergency exit tickets are not done yet. Existing Sepolia contracts, manifests and databases are not migrated. More in [PARTIAL_BATCHES.md](PARTIAL_BATCHES.md)

## Bot

The code is in server/arbitrage.ts, price math can live in server/price-math.ts. ArbitrageSettings is `{enabled,delaySeconds,maxTradeBps,minDeviationBps}` with defaults maxTradeBps 2000 and minDeviationBps 40. So far the UI only lets you turn it on and set the delay. The target price of a pair is computed exactly as USD(base)/USD(quote) from the global USD references, taking real token decimals into account. We use exact BigInt V2 math with 997/1000 and rounding down, and find the correcting amount by binary search, limited by the bot's internal balance and a reserve cap. Four assets and three pairs is not triangular arbitrage: the bot is a market maker that follows an external price and has separate funds in each Vault

The monitoring bot in `server/monitor-bot.ts` is separate from the demo trading bot. With `MONITOR_PRIVATE_KEY` set, it checks token transfers, the configured sanctions list, coverage, roots and stuck transitions, plus price and volume, every 12 seconds by default. Failed transfers and insufficient coverage trigger a pause. Other problems are logged as alerts. The bot cannot resume a market. See [RISK_CONTROLS_RU.md](RISK_CONTROLS_RU.md)

The worker constructor takes `{markets,botSigner,transactionSigner,settings, transactionQueue,now?}`. The signer and queue are shared, so Ethereum nonces stay in order across all pools. settings() returns `{revision,prices,arbitrage}`. getStatus(id), runOnce(nowMs?), start(intervalMs?), stop() and drain() control the worker. The worker never changes the engine outside RubaApi.execute: it uses the internal hooks to check the prepared root and settings revision in beforeApply and to write `arb:<planId>:<stepId>` metadata in onCommit. Signed requests and plan state are saved before sending, and after a restart the worker picks up finished commitments and tradeIds before retrying. The bot signs only its own operations. No user keys, no moving balances around

The delay starts after a user swap or a change of the reference price. Half finished plans continue without redoing swaps. Four swaps is still the maximum and the automatic close threshold. The correcting volume is split into real positive swaps for the free slots, each integer result is simulated again, and the plan is rebuilt if a user traded in between. If the volume or output is too small or the balance is not enough, the bot says it is waiting and never makes zero or filler trades. When enabled, the bot publishes ready transitions with its own gas through proof only calls. After it is turned off no new bot operation starts. Only one proof is built at a time, the prover class has a queue for that

## Sepolia deploy and runtime

The code is in scripts/sepolia-*.ts and scripts/markets-dev.ts. The public manifest stores network, assets, roles, shared verifier, pools and deployment steps. Private keys, three different poolRecoveryKeys, database paths and RPC stay in `SEPOLIA_STATE_DIR` (folder 0700, secret files 0600) and never end up in the public manifest or in archives. On resume we check chainId 11155111, artifact identities and current receipts and bytecode. Intent, nonce and signed tx hash are saved before sending, so after a lost response we continue the same step. A taken nonce, a manifest or network mismatch or a missing live database stop the process. The deployer key is loaded from `<SEPOLIA_STATE_DIR>/deployer.json`, a fresh one can be generated locally. Keys are never printed. LP and bot keys can be generated separately and are saved before use. The admin is the deployer, the prover does not need the admin key. The test wallet can be set explicitly

Bootstrap deploys the shared contracts, 4 faucet tokens and 3 Vaults, allows LP, bot and the test wallet to REGISTER, deposit, SWAP and ADD_LP, registers LP and bot and publishes the registrations before any token deposits. Then it funds gas and token balances, seeds LP and bot separately in every Vault and publishes the accepted control transitions. Starting reserves are 3000 RUBA/3000 USDT, 3000 RUBA/1 WETH and 3 WETH/0.1 WBTC, and the bot gets enough in every market to make corrections. One bot signer and transaction queue is used for all markets. There is a factory that builds market runtimes, not only the CLI, for integration tests and the local demo. Local mode only uses a separate Anvil. Before sending anything to Sepolia we estimate gas and fees and check the deployer balance. If there is not enough, we leave a prepared plan that can be resumed and don't pretend anything was deployed

Commands: sepolia:prepare, sepolia:deploy, sepolia:start, markets:dev, test:markets:integration. Existing Tenderly deployments are left alone

## UI and disclosure

The UI has a market catalog, selector and cards, prefixes requests with the market, and shows balances, deposit, withdrawal, LP, receipts and publication for the selected pool. Switching the market drops the version and the old client and clears the quote, receipt, balances, forms and publication state. The wallet stays connected when possible, because changing the pool is not changing the wallet or network. The selector is locked while a wallet operation is in progress. Cache keys by chain, Vault and owner work as before. Real symbols and decimals are shown everywhere, LP units are kept separately. faucet() mints the selected demo ERC20 to the wallet, and then each Vault needs its own normal deposit

The dashboard polls accepted snapshots without wallet signatures and shows the AMM price against the target, the signed deviation and an SVG history. Your last swap receipt can draw your private provisional before and after prices on top, marked as not accepted yet. The admin can sign settings and request the current private monitor snapshot. Admin and bot keys are never exposed. There is a badge "Sepolia test tokens / manual reference price". Disclosure works with all symbols and decimals and picks the market by chainId and Vault from the receipt, not by marketId from the file. A reviewer can paste an exported receipt without a wallet or login. We check roots of the right market and reject receipts from another pool even if tradeId or batchId match

## Where things live

- `server/market-types.ts`, ServerConfig, API, chain metadata and finality, API hooks, prover queue and launch commands: the core
- `server/markets.ts`: settings storage, dashboard, routing, admin commands and their tests
- `scripts/sepolia-*.ts`, `scripts/markets-dev.ts`: Sepolia and local three market scripts, manifests, bootstrap and tests
- `server/arbitrage.ts`, `server/price-math.ts`: price math and the bot worker with tests
- `ui/`: client, disclosure page and UI tests
- `src/DemoToken.sol`: test tokens with Foundry tests
