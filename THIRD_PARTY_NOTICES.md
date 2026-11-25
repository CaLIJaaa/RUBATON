# Сторонние лицензии

Наш код (контракты, сервер, интерфейс, скрипты) идёт под MIT, текст в [LICENSE](LICENSE). Ниже то, что мы берём у других, и под какими лицензиями

| Что | Лицензия | Как используем |
| --- | --- | --- |
| OpenZeppelin Contracts 5.0.2 | MIT | `lib/openzeppelin-contracts`, импортируем в контракты |
| forge-std | MIT / Apache-2.0 | `lib/forge-std`, только тесты |
| Uniswap v2-core 1.0.1 | GPL-3.0 | `lib/uniswap-v2-core`, только эталонный тест формулы, байткод в продукт не входит |
| ethers 6, web3-onboard | MIT | сервер и интерфейс |
| circomlib 2.0.5 | GPL-3.0 | шаблоны Poseidon и сравнений подключены в `zk/circuits/primitives.circom` |
| circom2, snarkjs 0.7.6 | GPL-3.0 | сборка схемы, ключей, verifier и доказательства на сервере |
| circomlibjs | GPL-3.0 | хеши Poseidon в тестах и скриптах |
| solc, esbuild, TypeScript | MIT / Apache-2.0 | сборка |

Схема включает шаблоны circomlib, а verifier собирается по шаблону snarkjs. Поэтому файлы схемы и собранные из неё артефакты (`zk/circuits`, `zk/artifacts`) нужно распространять по правилам GPL-3.0. Лицензии каждой библиотеки лежат рядом с её исходниками в `lib/` и `node_modules/`
