pragma circom 2.2.3;
include "./primitives.circom";

template Operation() {
    signal input domain;
    signal input chainId; signal input vault; signal input ruba; signal input usdt;
    signal input accountRoot;
    signal input oldAccount[9]; signal input newAccount[9]; signal input path[4];
    signal input oldPool[6]; signal input newPool[6];
    signal input params[4]; signal input recoveryKey;
    signal input metadata[8];
    signal input newLeaf; signal input ciphertext[7];
    signal input cursor; signal input tradeId; signal input receiptSalt;
    signal input quotients[6]; signal input remainders[6];
    signal input sqrtFloor; signal input addDirection;
    signal output nextAccountRoot; signal output nextCursor; signal output nextTradeId;
    signal output isSwap; signal output active; signal output receiptLeaf;

    component kinds[9]; signal kind[9];
    var kindSum=0;
    for (var i=0; i<9; i++) {
        kinds[i]=IsEqual(); kinds[i].in[0] <== metadata[0]; kinds[i].in[1] <== i;
        kind[i] <== kinds[i].out; kindSum += kind[i];
    }
    kindSum === 1;
    active <== 1-kind[0]; isSwap <== kind[3];
    component slotRange=Range(4); slotRange.in <== metadata[1];
    component ownerRange=Range(160); ownerRange.in <== metadata[2];
    component ownerZero=IsZero(); ownerZero.in <== metadata[2]; active*ownerZero.out === 0;
    component eventRange=Range(64); eventRange.in <== metadata[4];
    component tokenRange=Range(1); tokenRange.in <== metadata[5];
    component amountRange=Range(96); amountRange.in <== metadata[6];
    component referenceRange=Range(64); referenceRange.in <== metadata[7];
    for (var i=0; i<8; i++) kind[0]*metadata[i] === 0;
    for (var i=0; i<4; i++) { kind[0]*params[i] === 0; kind[0]*path[i] === 0; }
    for (var i=0; i<9; i++) { kind[0]*oldAccount[i] === 0; kind[0]*newAccount[i] === 0; }
    kind[0]*recoveryKey === 0;
    kind[0]*newLeaf === 0;
    for (var i=0; i<7; i++) kind[0]*ciphertext[i] === 0;
    (1-kind[3])*receiptSalt === 0;

    component oldBounds=AccountBounds(); component newBounds=AccountBounds();
    for (var i=0; i<9; i++) { oldBounds.account[i] <== oldAccount[i]; newBounds.account[i] <== newAccount[i]; }
    component oldPoolBounds=PoolBounds(); component newPoolBounds=PoolBounds();
    for (var i=0; i<6; i++) { oldPoolBounds.pool[i] <== oldPool[i]; newPoolBounds.pool[i] <== newPool[i]; }
    (active-kind[1])*(oldAccount[0]-metadata[2]) === 0;
    active*(newAccount[0]-metadata[2]) === 0;
    (active-kind[1])*(newAccount[7]-oldAccount[7]) === 0;
    for (var i=0; i<9; i++) kind[1]*oldAccount[i] === 0;
    kind[1]*(newAccount[7]-params[0]) === 0;
    for (var i=1; i<4; i++) kind[1]*params[i] === 0;
    kind[1]*newAccount[1] === 0; kind[1]*newAccount[2] === 0; kind[1]*newAccount[3] === 0;
    kind[1]*newAccount[5] === 0; kind[1]*newAccount[6] === 0;
    signal incrementsNonce; incrementsNonce <== kind[1]+kind[3]+kind[4]+kind[5]+kind[6];
    newAccount[4] === oldAccount[4]+incrementsNonce;
    component saltUnchanged=IsZero(); saltUnchanged.in <== newAccount[8]-oldAccount[8];
    active*saltUnchanged.out === 0;

    signal bridge; bridge <== kind[2]+kind[7];
    for (var i=4; i<8; i++) (1-bridge)*metadata[i] === 0;
    bridge*(params[0]-metadata[5]) === 0;
    bridge*(params[1]-metadata[6]) === 0;
    bridge*(params[2]-metadata[4]) === 0;
    bridge*(params[3]-metadata[7]) === 0;
    bridge*(metadata[4]-cursor-1) === 0;
    nextCursor <== cursor+bridge;
    nextTradeId <== tradeId+kind[3];
    for (var i=0; i<4; i++) {
        if (i==3) (kind[3]+kind[5]+kind[6]+kind[8])*params[i] === 0;
    }

    signal tokenKind; tokenKind <== kind[2]+kind[3]+kind[6]+kind[7]+kind[8];
    component token0=IsZero(); component token1=IsEqual();
    token0.in <== params[0]; token1.in[0] <== params[0]; token1.in[1] <== 1;
    tokenKind*(1-token0.out-token1.out) === 0;
    signal tokenRuba; signal tokenUsdt;
    tokenRuba <== tokenKind*token0.out; tokenUsdt <== tokenKind*token1.out;
    component paramRanges[4];
    for (var i=0; i<4; i++) {
        paramRanges[i]=Range(96);
        if (i==0) paramRanges[i].in <== (kind[4]+kind[5])*params[i];
        else if (i==1) paramRanges[i].in <== (active-kind[1])*params[i];
        else if (i==2) paramRanges[i].in <== (kind[3]+kind[4]+kind[5])*params[i];
        else paramRanges[i].in <== kind[4]*params[i];
    }
    component nonceParams[2];
    nonceParams[0]=Range(64); nonceParams[0].in <== (kind[6]+kind[8])*params[2];
    nonceParams[1]=Range(64); nonceParams[1].in <== (kind[2]+kind[7])*params[3];
    component amountZero=IsZero(); amountZero.in <== params[1];
    (kind[2]+kind[3]+kind[4]+kind[6]+kind[7]+kind[8])*amountZero.out === 0;
    component firstParamZero=IsZero(); firstParamZero.in <== params[0];
    (kind[4]+kind[5])*firstParamZero.out === 0;

    component opCommit=Fold(10,105);
    opCommit.values[0] <== domain; opCommit.values[1] <== metadata[0];
    opCommit.values[2] <== metadata[1]; opCommit.values[3] <== metadata[2];
    opCommit.values[4] <== oldAccount[4];
    for (var i=0; i<4; i++) opCommit.values[i+5] <== params[i];
    opCommit.values[9] <== newAccount[8];
    active*(metadata[3]-opCommit.out) === 0;

    component oldHash=AccountHash(); component newHash=AccountHash();
    oldHash.slot <== metadata[1]; newHash.slot <== metadata[1];
    for (var i=0; i<9; i++) { oldHash.account[i] <== oldAccount[i]; newHash.account[i] <== newAccount[i]; }
    component oldPath=AccountPath(); component newPath=AccountPath();
    oldPath.slot <== metadata[1]; newPath.slot <== metadata[1];
    oldPath.leaf <== oldHash.out; newPath.leaf <== newHash.out;
    for (var i=0; i<4; i++) { oldPath.siblings[i] <== path[i]; newPath.siblings[i] <== path[i]; }
    active*(oldPath.root-accountRoot) === 0;
    nextAccountRoot <== accountRoot+active*(newPath.root-accountRoot);
    active*(newLeaf-newHash.out) === 0;
    component keyHash=Poseidon(2); keyHash.inputs[0] <== 109; keyHash.inputs[1] <== recoveryKey;
    active*(newAccount[7]-keyHash.out) === 0;
    component encrypt=EncryptFields(7); encrypt.key <== recoveryKey; encrypt.nonce <== newLeaf;
    encrypt.plaintext[0] <== newAccount[1]; encrypt.plaintext[1] <== newAccount[2];
    encrypt.plaintext[2] <== newAccount[3]; encrypt.plaintext[3] <== newAccount[4];
    encrypt.plaintext[4] <== newAccount[5]; encrypt.plaintext[5] <== newAccount[6];
    encrypt.plaintext[6] <== newAccount[8];
    for (var i=0; i<7; i++) active*(ciphertext[i]-encrypt.ciphertext[i]) === 0;

    // All arithmetic denominators are one in unused branches. Hints there must be zero.
    signal numerators[6]; signal denominators[6]; signal enabled[6];
    signal reserveIn; signal reserveOut;
    reserveIn <== oldPool[0]+token1.out*(oldPool[1]-oldPool[0]);
    reserveOut <== oldPool[1]+token1.out*(oldPool[0]-oldPool[1]);
    signal swapNumerator; signal swapDenominator;
    swapNumerator <== params[1]*997*reserveOut;
    swapDenominator <== reserveIn*1000+params[1]*997;
    enabled[0] <== kind[3];
    numerators[0] <== kind[3]*swapNumerator;
    denominators[0] <== 1+kind[3]*(swapDenominator-1);
    component reserveInZero=IsZero(); reserveInZero.in <== reserveIn;
    component reserveOutZero=IsZero(); reserveOutZero.in <== reserveOut;
    kind[3]*reserveInZero.out === 0; kind[3]*reserveOutZero.out === 0;
    component swapOutZero=IsZero(); swapOutZero.in <== quotients[0]; kind[3]*swapOutZero.out === 0;
    component swapMin=LessEqThan(96); swapMin.in[0] <== kind[3]*params[2]; swapMin.in[1] <== quotients[0]; swapMin.out === 1;

    component initialSupply=IsZero(); initialSupply.in <== oldPool[2];
    signal initialAdd; signal laterAdd;
    initialAdd <== kind[4]*initialSupply.out; laterAdd <== kind[4]*(1-initialSupply.out);
    addDirection*(addDirection-1) === 0;
    (1-laterAdd)*addDirection === 0;
    signal quoteNumerator; signal quoteDenominator;
    signal quoteNumRuba; signal quoteNumUsdt;
    quoteNumRuba <== params[0]*oldPool[1]; quoteNumUsdt <== params[1]*oldPool[0];
    quoteNumerator <== quoteNumUsdt+addDirection*(quoteNumRuba-quoteNumUsdt);
    quoteDenominator <== oldPool[1]+addDirection*(oldPool[0]-oldPool[1]);
    enabled[1] <== laterAdd;
    numerators[1] <== laterAdd*quoteNumerator;
    denominators[1] <== 1+laterAdd*(quoteDenominator-1);
    signal branchNumerator; signal branchLimit;
    branchNumerator <== laterAdd*quoteNumRuba;
    signal limitProduct; limitProduct <== (params[1]+1)*oldPool[0];
    branchLimit <== laterAdd*limitProduct;
    component bnRange=Range(193); bnRange.in <== branchNumerator;
    component blRange=Range(193); blRange.in <== branchLimit;
    component branch=LessThan(193); branch.in[0] <== branchNumerator; branch.in[1] <== branchLimit;
    laterAdd*(addDirection-branch.out) === 0;
    signal addRuba; signal addUsdt;
    signal laterRuba; signal laterUsdt;
    laterRuba <== quotients[1]+addDirection*(params[0]-quotients[1]);
    laterUsdt <== params[1]+addDirection*(quotients[1]-params[1]);
    signal initialRuba; signal initialUsdt;
    initialRuba <== initialAdd*params[0]; initialUsdt <== initialAdd*params[1];
    addRuba <== initialRuba+laterAdd*laterRuba;
    addUsdt <== initialUsdt+laterAdd*laterUsdt;
    enabled[2] <== laterAdd; enabled[3] <== laterAdd;
    signal mintNumeratorRuba; signal mintNumeratorUsdt;
    mintNumeratorRuba <== addRuba*oldPool[2]; mintNumeratorUsdt <== addUsdt*oldPool[2];
    numerators[2] <== laterAdd*mintNumeratorRuba; numerators[3] <== laterAdd*mintNumeratorUsdt;
    denominators[2] <== 1+laterAdd*(oldPool[0]-1); denominators[3] <== 1+laterAdd*(oldPool[1]-1);
    component mintLess=LessThan(96); mintLess.in[0] <== quotients[2]; mintLess.in[1] <== quotients[3];
    signal laterMint; laterMint <== quotients[3]+mintLess.out*(quotients[2]-quotients[3]);
    component sqrtRange=Range(96); sqrtRange.in <== sqrtFloor;
    (1-initialAdd)*sqrtFloor === 0;
    signal square; signal nextSquare; signal initialProduct; signal initialMintProduct;
    square <== sqrtFloor*sqrtFloor; nextSquare <== (sqrtFloor+1)*(sqrtFloor+1);
    initialMintProduct <== params[0]*params[1];
    initialProduct <== initialAdd*initialMintProduct;
    component sqrtLower=LessEqThan(193); sqrtLower.in[0] <== square; sqrtLower.in[1] <== initialProduct;
    component sqrtUpper=LessThan(193); sqrtUpper.in[0] <== initialProduct; sqrtUpper.in[1] <== nextSquare;
    initialAdd*(1-sqrtLower.out) === 0; initialAdd*(1-sqrtUpper.out) === 0;
    signal mint; signal firstMint;
    firstMint <== initialAdd*(sqrtFloor-1000);
    mint <== firstMint+laterAdd*laterMint;
    component mintRange=Range(96); mintRange.in <== mint;
    component mintZero=IsZero(); mintZero.in <== mint; kind[4]*mintZero.out === 0;
    component addMinR=LessEqThan(96); addMinR.in[0] <== kind[4]*params[2]; addMinR.in[1] <== addRuba; addMinR.out === 1;
    component addMinU=LessEqThan(96); addMinU.in[0] <== kind[4]*params[3]; addMinU.in[1] <== addUsdt; addMinU.out === 1;

    enabled[4] <== kind[5]; enabled[5] <== kind[5];
    signal removeNumeratorRuba; signal removeNumeratorUsdt;
    removeNumeratorRuba <== params[0]*oldPool[0]; removeNumeratorUsdt <== params[0]*oldPool[1];
    numerators[4] <== kind[5]*removeNumeratorRuba; numerators[5] <== kind[5]*removeNumeratorUsdt;
    denominators[4] <== 1+kind[5]*(oldPool[2]-1); denominators[5] <== 1+kind[5]*(oldPool[2]-1);
    component removeMinR=LessEqThan(96); removeMinR.in[0] <== kind[5]*params[1]; removeMinR.in[1] <== quotients[4]; removeMinR.out === 1;
    component removeMinU=LessEqThan(96); removeMinU.in[0] <== kind[5]*params[2]; removeMinU.in[1] <== quotients[5]; removeMinU.out === 1;
    component removeZeroR=IsZero(); removeZeroR.in <== quotients[4]; kind[5]*removeZeroR.out === 0;
    component removeZeroU=IsZero(); removeZeroU.in <== quotients[5]; kind[5]*removeZeroU.out === 0;
    component division[6];
    for (var i=0; i<6; i++) {
        division[i]=IntegerDivision();
        division[i].numerator <== numerators[i]; division[i].denominator <== denominators[i];
        division[i].quotient <== quotients[i]; division[i].remainder <== remainders[i];
    }

    // Per-kind linear state rules. All candidate values are range checked above.
    signal tokenAmountRuba; signal tokenAmountUsdt;
    tokenAmountRuba <== tokenRuba*params[1]; tokenAmountUsdt <== tokenUsdt*params[1];
    signal swapRuba; signal swapUsdt;
    swapRuba <== quotients[0]+token0.out*(-params[1]-quotients[0]);
    swapUsdt <== -params[1]+token0.out*(quotients[0]+params[1]);
    for (var k=0; k<9; k++) {
        if (k!=1) {
            for (var a=1; a<7; a++) {
                if (a!=4) {
                    if (k==2 && a==1) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountRuba) === 0;
                    else if (k==2 && a==2) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountUsdt) === 0;
                    else if (k==3 && a==1) kind[k]*(newAccount[a]-oldAccount[a]-swapRuba) === 0;
                    else if (k==3 && a==2) kind[k]*(newAccount[a]-oldAccount[a]-swapUsdt) === 0;
                    else if (k==4 && a==1) kind[k]*(newAccount[a]-oldAccount[a]+addRuba) === 0;
                    else if (k==4 && a==2) kind[k]*(newAccount[a]-oldAccount[a]+addUsdt) === 0;
                    else if (k==4 && a==3) kind[k]*(newAccount[a]-oldAccount[a]-mint) === 0;
                    else if (k==5 && a==1) kind[k]*(newAccount[a]-oldAccount[a]-quotients[4]) === 0;
                    else if (k==5 && a==2) kind[k]*(newAccount[a]-oldAccount[a]-quotients[5]) === 0;
                    else if (k==5 && a==3) kind[k]*(newAccount[a]-oldAccount[a]+params[0]) === 0;
                    else if (k==6 && a==1) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountRuba) === 0;
                    else if (k==6 && a==2) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountUsdt) === 0;
                    else if (k==6 && a==5) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountRuba) === 0;
                    else if (k==6 && a==6) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountUsdt) === 0;
                    else if (k==7 && a==5) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountRuba) === 0;
                    else if (k==7 && a==6) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountUsdt) === 0;
                    else if (k==8 && a==1) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountRuba) === 0;
                    else if (k==8 && a==2) kind[k]*(newAccount[a]-oldAccount[a]-tokenAmountUsdt) === 0;
                    else if (k==8 && a==5) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountRuba) === 0;
                    else if (k==8 && a==6) kind[k]*(newAccount[a]-oldAccount[a]+tokenAmountUsdt) === 0;
                    else kind[k]*(newAccount[a]-oldAccount[a]) === 0;
                }
            }
        }
        for (var p=0; p<6; p++) {
            if (k==2 && p==4) kind[k]*(newPool[p]-oldPool[p]-tokenAmountRuba) === 0;
            else if (k==2 && p==5) kind[k]*(newPool[p]-oldPool[p]-tokenAmountUsdt) === 0;
            else if (k==3 && p==0) kind[k]*(newPool[p]-oldPool[p]+swapRuba) === 0;
            else if (k==3 && p==1) kind[k]*(newPool[p]-oldPool[p]+swapUsdt) === 0;
            else if (k==4 && p==0) kind[k]*(newPool[p]-oldPool[p]-addRuba) === 0;
            else if (k==4 && p==1) kind[k]*(newPool[p]-oldPool[p]-addUsdt) === 0;
            else if (k==4 && p==2) kind[k]*(newPool[p]-oldPool[p]-mint-1000*initialAdd) === 0;
            else if (k==4 && p==3) kind[k]*(newPool[p]-oldPool[p]-1000*initialAdd) === 0;
            else if (k==5 && p==0) kind[k]*(newPool[p]-oldPool[p]+quotients[4]) === 0;
            else if (k==5 && p==1) kind[k]*(newPool[p]-oldPool[p]+quotients[5]) === 0;
            else if (k==5 && p==2) kind[k]*(newPool[p]-oldPool[p]+params[0]) === 0;
            else if (k==7 && p==4) kind[k]*(newPool[p]-oldPool[p]+tokenAmountRuba) === 0;
            else if (k==7 && p==5) kind[k]*(newPool[p]-oldPool[p]+tokenAmountUsdt) === 0;
            else kind[k]*(newPool[p]-oldPool[p]) === 0;
        }
    }

    component receipt=Fold(16,108);
    receipt.values[0] <== 2; receipt.values[1] <== chainId; receipt.values[2] <== vault;
    receipt.values[3] <== tradeId; receipt.values[4] <== metadata[2];
    signal tokenIn; signal tokenOut;
    tokenIn <== usdt+token0.out*(ruba-usdt); tokenOut <== ruba+token0.out*(usdt-ruba);
    receipt.values[5] <== tokenIn; receipt.values[6] <== tokenOut;
    receipt.values[7] <== params[1]; receipt.values[8] <== quotients[0];
    receipt.values[9] <== params[1]*3; receipt.values[10] <== 1000;
    receipt.values[11] <== oldPool[0]; receipt.values[12] <== oldPool[1];
    receipt.values[13] <== newPool[0]; receipt.values[14] <== newPool[1];
    receipt.values[15] <== receiptSalt;
    receiptLeaf <== kind[3]*receipt.out;
}
