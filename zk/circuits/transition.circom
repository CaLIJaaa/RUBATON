pragma circom 2.2.3;
include "./operation.circom";

template Transition() {
    // Declaration and main-public order deliberately match zk/schema.ts and Vault.
    signal input domain;
    signal input stateVersion;
    signal input mode;
    signal input previousRoot;
    signal input newRoot;
    signal input previousInboxCursor;
    signal input newInboxCursor;
    signal input previousTradeId;
    signal input newTradeId;
    signal input receiptsRoot;
    signal input authDigest;
    signal input daDigest;
    signal input poolKeyCommit;

    signal input chainId; signal input vault; signal input ruba; signal input usdt;
    signal input startingAccountsRoot;
    signal input pools[9][6];
    signal input oldAccounts[8][9]; signal input newAccounts[8][9];
    signal input accountPaths[8][4]; signal input params[8][4]; signal input recoveryKeys[8];
    signal input metadata[8][8]; signal input newLeaves[8]; signal input accountCiphertexts[8][7];
    signal input poolRecoveryKey; signal input finalPoolHash; signal input poolCiphertext[6];
    signal input receiptSalts[8]; signal input quotients[8][6]; signal input remainders[8][6];
    signal input sqrtFloors[8]; signal input addDirections[8];

    component chainRange=Range(64); chainRange.in <== chainId;
    component addressRange[3];
    addressRange[0]=Range(160); addressRange[0].in <== vault;
    addressRange[1]=Range(160); addressRange[1].in <== ruba;
    addressRange[2]=Range(160); addressRange[2].in <== usdt;
    component domainHash=Fold(6,101);
    domainHash.values[0] <== 2; domainHash.values[1] <== chainId;
    domainHash.values[2] <== vault; domainHash.values[3] <== ruba;
    domainHash.values[4] <== usdt; domainHash.values[5] <== poolKeyCommit;
    domainHash.out === domain;
    component poolKeyHash=Poseidon(2); poolKeyHash.inputs[0] <== 109; poolKeyHash.inputs[1] <== poolRecoveryKey;
    poolKeyHash.out === poolKeyCommit;
    component versionRange=Range(64); versionRange.in <== stateVersion;
    component versionZero=IsZero(); versionZero.in <== stateVersion; versionZero.out === 0;
    mode*(mode-1) === 0;

    component initialPoolHash=PoolHash(); component endingPoolHash=PoolHash();
    for (var j=0; j<6; j++) {
        initialPoolHash.pool[j] <== pools[0][j]; endingPoolHash.pool[j] <== pools[8][j];
    }
    endingPoolHash.out === finalPoolHash;
    component initialState=StateHash(); component endingState=StateHash();
    initialState.domain <== domain; initialState.accountsRoot <== startingAccountsRoot;
    initialState.poolHash <== initialPoolHash.out; initialState.inboxCursor <== previousInboxCursor;
    initialState.nextTradeId <== previousTradeId; initialState.poolKeyCommit <== poolKeyCommit;
    initialState.out === previousRoot;

    signal roots[9]; signal cursors[9]; signal tradeIds[9];
    roots[0] <== startingAccountsRoot; cursors[0] <== previousInboxCursor; tradeIds[0] <== previousTradeId;
    component cursorRanges[9]; component tradeRanges[9];
    component tradeZero=IsZero(); tradeZero.in <== previousTradeId; tradeZero.out === 0;
    component ops[8];
    var swapCount=0; var activeCount=0;
    for (var i=0; i<8; i++) {
        ops[i]=Operation();
        ops[i].domain <== domain; ops[i].chainId <== chainId; ops[i].vault <== vault;
        ops[i].ruba <== ruba; ops[i].usdt <== usdt; ops[i].accountRoot <== roots[i];
        for (var j=0; j<9; j++) { ops[i].oldAccount[j] <== oldAccounts[i][j]; ops[i].newAccount[j] <== newAccounts[i][j]; }
        for (var j=0; j<4; j++) { ops[i].path[j] <== accountPaths[i][j]; ops[i].params[j] <== params[i][j]; }
        for (var j=0; j<6; j++) {
            ops[i].oldPool[j] <== pools[i][j]; ops[i].newPool[j] <== pools[i+1][j];
            ops[i].quotients[j] <== quotients[i][j]; ops[i].remainders[j] <== remainders[i][j];
        }
        for (var j=0; j<8; j++) ops[i].metadata[j] <== metadata[i][j];
        ops[i].recoveryKey <== recoveryKeys[i]; ops[i].newLeaf <== newLeaves[i];
        for (var j=0; j<7; j++) ops[i].ciphertext[j] <== accountCiphertexts[i][j];
        ops[i].cursor <== cursors[i]; ops[i].tradeId <== tradeIds[i];
        ops[i].receiptSalt <== receiptSalts[i];
        ops[i].sqrtFloor <== sqrtFloors[i]; ops[i].addDirection <== addDirections[i];
        roots[i+1] <== ops[i].nextAccountRoot; cursors[i+1] <== ops[i].nextCursor; tradeIds[i+1] <== ops[i].nextTradeId;
        swapCount += ops[i].isSwap; activeCount += ops[i].active;
        if (i>0) ops[i].active*(1-ops[i-1].active) === 0;
    }
    // Control transitions contain no swaps; trade transitions contain 1..4.
    // Receipt positions not reached by a real swap remain zero below.
    component swapCountZero=IsZero(); swapCountZero.in <== swapCount;
    swapCountZero.out === 1-mode;
    component swapCountBound=LessEqThan(4);
    swapCountBound.in[0] <== swapCount; swapCountBound.in[1] <== 4;
    swapCountBound.out === 1;
    for (var i=0; i<9; i++) {
        cursorRanges[i]=Range(64); cursorRanges[i].in <== cursors[i];
        tradeRanges[i]=Range(64); tradeRanges[i].in <== tradeIds[i];
    }
    component emptyTransition=IsZero(); emptyTransition.in <== activeCount; emptyTransition.out === 0;
    cursors[8] === newInboxCursor; tradeIds[8] === newTradeId;
    endingState.domain <== domain; endingState.accountsRoot <== roots[8];
    endingState.poolHash <== endingPoolHash.out; endingState.inboxCursor <== newInboxCursor;
    endingState.nextTradeId <== newTradeId; endingState.poolKeyCommit <== poolKeyCommit;
    endingState.out === newRoot;

    component auth=Fold(66,106);
    auth.values[0] <== domain; auth.values[1] <== stateVersion;
    for (var i=0; i<8; i++) for (var j=0; j<8; j++) auth.values[2+i*8+j] <== metadata[i][j];
    auth.out === authDigest;
    component da=Fold(97,107);
    da.values[0] <== domain; da.values[1] <== stateVersion;
    for (var i=0; i<8; i++) {
        for (var j=0; j<3; j++) da.values[2+i*11+j] <== metadata[i][j];
        da.values[2+i*11+3] <== newLeaves[i];
        for (var j=0; j<7; j++) da.values[2+i*11+4+j] <== accountCiphertexts[i][j];
    }
    da.values[90] <== finalPoolHash;
    component poolEncryption=EncryptFields(6); poolEncryption.key <== poolRecoveryKey; poolEncryption.nonce <== finalPoolHash;
    for (var j=0; j<6; j++) poolEncryption.plaintext[j] <== pools[8][j];
    for (var j=0; j<6; j++) {
        poolEncryption.ciphertext[j] === poolCiphertext[j];
        da.values[91+j] <== poolCiphertext[j];
    }
    da.out === daDigest;

    component matches[4][8]; signal selected[4][8]; signal leaves[4];
    for (var j=0; j<4; j++) {
        var leafSum=0;
        for (var i=0; i<8; i++) {
            matches[j][i]=IsEqual(); matches[j][i].in[0] <== tradeIds[i]-previousTradeId; matches[j][i].in[1] <== j;
            selected[j][i] <== matches[j][i].out*ops[i].receiptLeaf;
            leafSum += selected[j][i];
        }
        leaves[j] <== leafSum;
    }
    component left=Poseidon(2); component right=Poseidon(2); component receiptTree=Poseidon(2);
    left.inputs[0] <== leaves[0]; left.inputs[1] <== leaves[1];
    right.inputs[0] <== leaves[2]; right.inputs[1] <== leaves[3];
    receiptTree.inputs[0] <== left.out; receiptTree.inputs[1] <== right.out;
    receiptsRoot === mode*receiptTree.out;
}

component main {public [domain,stateVersion,mode,previousRoot,newRoot,previousInboxCursor,newInboxCursor,
    previousTradeId,newTradeId,receiptsRoot,authDigest,daDigest,poolKeyCommit]} = Transition();
