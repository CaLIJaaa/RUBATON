# Vendored dependencies

The OpenZeppelin and forge-std source trees are copied unchanged from clean local Git checkouts of the official repositories. Uniswap is the official published npm release, including its original source and bytecode artifacts. Their licenses are included beside the source. No Git submodule initialization is required

| Directory | Upstream | Version / commit |
| --- | --- | --- |
| `openzeppelin-contracts` | https://github.com/OpenZeppelin/openzeppelin-contracts | v5.0.2 / `c1637088fcba41107c3b0f2050513a40038eb90a` |
| `forge-std` | https://github.com/foundry-rs/forge-std | `8bbcf6e3f8f62f419e5429a0bd89331c85c37824` |
| `uniswap-v2-core` | https://github.com/Uniswap/v2-core | npm `@uniswap/v2-core@1.0.1`, release gitHead `4dd59067c76dea4a0e8e4bfdda41877a6b16dedc` |

The project compiler is the exact `solc` npm package pinned by `package-lock.json`. `tools/solcjs-wrapper.cjs` exposes its standard-JSON API to Forge without requiring a machine-specific native compiler installation

## Uniswap reference

The package tarball's SHA-512 was verified against its published npm integrity: `sha512-MtybtkUPSyysqLY2U210NBDeCHX+ltHt3oADGdjqoThZaFRDKwM6k1Nb3F0A3hk5hwuQvytFWhrWHOEq6nVJ8Q==`. Release metadata is retained in `uniswap-v2-core/UPSTREAM.json`. Its GPL-3.0 license is in `uniswap-v2-core/LICENSE`

The Solidity 0.5.16 sources remain unchanged. The Foundry reference tests deploy the published factory creation bytecode (which in turn deploys the genuine Pair), so they do not require a separate 0.5.16 compiler download. The creation bytecode hash is pinned in the reference test. These are upstream release artifacts; this build does not recompile the old core sources or claim a fresh 0.5.16 build. The custom custody vault is compiled using 0.8.26. No Router02 is required for the selected offchain execution model
