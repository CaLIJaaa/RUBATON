pragma circom 2.2.3;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

template Range(n) {
    signal input in;
    component bits = Num2Bits(n);
    bits.in <== in;
}

template Fold(n, tag) {
    signal input values[n];
    signal output out;
    signal state[n+1];
    component h[n];
    state[0] <== tag;
    for (var i=0; i<n; i++) {
        h[i] = Poseidon(2);
        h[i].inputs[0] <== state[i];
        h[i].inputs[1] <== values[i];
        state[i+1] <== h[i].out;
    }
    out <== state[n];
}

template AccountHash() {
    signal input slot;
    signal input account[9];
    signal output out;
    component f = Fold(10,102);
    f.values[0] <== slot;
    for (var i=0; i<9; i++) f.values[i+1] <== account[i];
    out <== f.out;
}

template PoolHash() {
    signal input pool[6];
    signal output out;
    component f = Fold(6,103);
    for (var i=0; i<6; i++) f.values[i] <== pool[i];
    out <== f.out;
}

template StateHash() {
    signal input domain;
    signal input accountsRoot;
    signal input poolHash;
    signal input inboxCursor;
    signal input nextTradeId;
    signal input poolKeyCommit;
    signal output out;
    component f = Fold(6,104);
    f.values[0] <== domain;
    f.values[1] <== accountsRoot;
    f.values[2] <== poolHash;
    f.values[3] <== inboxCursor;
    f.values[4] <== nextTradeId;
    f.values[5] <== poolKeyCommit;
    out <== f.out;
}

template AccountBounds() {
    signal input account[9];
    component owner = Range(160); owner.in <== account[0];
    component nonce = Range(64); nonce.in <== account[4];
    component amounts[5];
    for (var i=0; i<5; i++) {
        amounts[i] = Range(96);
        if (i<3) amounts[i].in <== account[i+1];
        else amounts[i].in <== account[i+2];
    }
}

template PoolBounds() {
    signal input pool[6];
    component r[6];
    for (var i=0; i<6; i++) { r[i]=Range(96); r[i].in <== pool[i]; }
}

template AccountPath() {
    signal input slot;
    signal input leaf;
    signal input siblings[4];
    signal output root;
    component slotBits = Num2Bits(4); slotBits.in <== slot;
    signal nodes[5]; signal left[4]; signal right[4];
    component h[4]; nodes[0] <== leaf;
    for (var i=0; i<4; i++) {
        left[i] <== nodes[i] + slotBits.out[i]*(siblings[i]-nodes[i]);
        right[i] <== siblings[i] + slotBits.out[i]*(nodes[i]-siblings[i]);
        h[i] = Poseidon(2); h[i].inputs[0] <== left[i]; h[i].inputs[1] <== right[i];
        nodes[i+1] <== h[i].out;
    }
    root <== nodes[4];
}

// Denominator, quotient and remainder are integers, not field division hints.
// All products here are <2^203, strictly below BN254 Fr.
template IntegerDivision() {
    signal input numerator;
    signal input denominator;
    signal input quotient;
    signal input remainder;
    component n = Range(202); n.in <== numerator;
    component d = Range(107); d.in <== denominator;
    component q = Range(96); q.in <== quotient;
    component r = Range(107); r.in <== remainder;
    component nz = IsZero(); nz.in <== denominator; nz.out === 0;
    numerator === quotient*denominator + remainder;
    component lt = LessThan(107); lt.in[0] <== remainder; lt.in[1] <== denominator; lt.out === 1;
}

template EncryptFields(n) {
    signal input key;
    signal input nonce;
    signal input plaintext[n];
    signal output ciphertext[n];
    component prefixKey=Poseidon(2);
    prefixKey.inputs[0] <== 110; prefixKey.inputs[1] <== key;
    component prefixNonce=Poseidon(2);
    prefixNonce.inputs[0] <== prefixKey.out; prefixNonce.inputs[1] <== nonce;
    component stream[n];
    for (var i=0; i<n; i++) {
        stream[i]=Poseidon(2);
        stream[i].inputs[0] <== prefixNonce.out;
        stream[i].inputs[1] <== i;
        ciphertext[i] <== plaintext[i] + stream[i].out;
    }
}
