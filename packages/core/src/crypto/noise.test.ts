import { describe, test, expect } from "bun:test";
import {
  createInitiator,
  createResponder,
  generateX25519KeyPair,
} from "./noise";

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();

function textBytes(s: string): Uint8Array {
  return enc.encode(s);
}

describe("Noise_NK_25519_ChaChaPoly_SHA256", () => {
  test("round-trip: handshake completes and transport messages work", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = textBytes("orka-v1");

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    // Message 1: initiator -> responder
    const msg1 = initiator.writeMessage1();
    const { payload: p1 } = responder.readMessage1(msg1);
    expect(p1.length).toBe(0); // no payload

    // Message 2: responder -> initiator
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { payload: p2, result: clientResult } = initiator.readMessage2(msg2);
    expect(p2.length).toBe(0); // no payload

    // Transport: client -> server
    const plaintext = textBytes("hello from client");
    const ciphertext = clientResult.sendCipher.encrypt(plaintext);
    const decrypted = serverResult.recvCipher.decrypt(ciphertext);
    expect(dec.decode(decrypted)).toBe("hello from client");

    // Transport: server -> client
    const plaintext2 = textBytes("hello from server");
    const ciphertext2 = serverResult.sendCipher.encrypt(plaintext2);
    const decrypted2 = clientResult.recvCipher.decrypt(ciphertext2);
    expect(dec.decode(decrypted2)).toBe("hello from server");
  });

  test("handshake with payloads in both messages", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    // Message 1 with payload
    const msg1 = initiator.writeMessage1(textBytes("client-hello-payload"));
    const { payload: p1 } = responder.readMessage1(msg1);
    expect(dec.decode(p1)).toBe("client-hello-payload");

    // Message 2 with payload
    const { msg: msg2, result: serverResult } = responder.writeMessage2(
      textBytes("server-hello-payload"),
    );
    const { payload: p2, result: clientResult } = initiator.readMessage2(msg2);
    expect(dec.decode(p2)).toBe("server-hello-payload");

    // Verify transport still works
    const ct = clientResult.sendCipher.encrypt(textBytes("test"));
    expect(dec.decode(serverResult.recvCipher.decrypt(ct))).toBe("test");
  });

  test("prologue binding: different prologues cause handshake failure", () => {
    const serverKP = generateX25519KeyPair();

    const initiator = createInitiator(textBytes("prologue-A"), serverKP.publicKey);
    const responder = createResponder(textBytes("prologue-B"), serverKP);

    const msg1 = initiator.writeMessage1();
    // Message 1 will fail to decrypt payload because the handshake hashes
    // diverge due to different prologues. Since message 1 payload is empty
    // and encrypted under the mixed key, decryption should fail.
    expect(() => responder.readMessage1(msg1)).toThrow();
  });

  test("wrong server key: initiator with wrong pubkey causes failure", () => {
    const serverKP = generateX25519KeyPair();
    const wrongKP = generateX25519KeyPair();

    // Initiator thinks server has wrongKP's public key
    const initiator = createInitiator(EMPTY, wrongKP.publicKey);
    const responder = createResponder(EMPTY, serverKP);

    const msg1 = initiator.writeMessage1();
    // The responder will compute DH(s, re) with its real static key,
    // but the initiator computed DH(e, wrong_rs). The symmetric states
    // will diverge, so decryption of the msg1 payload should fail.
    expect(() => responder.readMessage1(msg1)).toThrow();
  });

  test("transport message ordering: nonces increment correctly", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Send multiple messages client -> server
    const messages = [
      "message-0",
      "message-1",
      "message-2",
      "message-3",
      "message-4",
    ];

    const ciphertexts = messages.map((m) =>
      clientResult.sendCipher.encrypt(textBytes(m)),
    );

    // All ciphertexts should be different (different nonces)
    for (let i = 0; i < ciphertexts.length; i++) {
      for (let j = i + 1; j < ciphertexts.length; j++) {
        const iHex = Buffer.from(ciphertexts[i]!).toString("hex");
        const jHex = Buffer.from(ciphertexts[j]!).toString("hex");
        expect(iHex).not.toBe(jHex);
      }
    }

    // Decrypt in order
    for (let i = 0; i < messages.length; i++) {
      const decrypted = serverResult.recvCipher.decrypt(ciphertexts[i]!);
      expect(dec.decode(decrypted)).toBe(messages[i]!);
    }
  });

  test("transport: out-of-order decryption fails", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    const ct1 = clientResult.sendCipher.encrypt(textBytes("msg-1"));

    // Try to decrypt ct1 first (nonce mismatch)
    expect(() => serverResult.recvCipher.decrypt(ct1)).toThrow();
  });

  test("bidirectional: both sides send and receive", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = textBytes("bidirectional-test");

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Interleaved bidirectional communication
    // Client -> Server
    const c2s1 = clientResult.sendCipher.encrypt(textBytes("c2s-1"));
    expect(dec.decode(serverResult.recvCipher.decrypt(c2s1))).toBe("c2s-1");

    // Server -> Client
    const s2c1 = serverResult.sendCipher.encrypt(textBytes("s2c-1"));
    expect(dec.decode(clientResult.recvCipher.decrypt(s2c1))).toBe("s2c-1");

    // Client -> Server again
    const c2s2 = clientResult.sendCipher.encrypt(textBytes("c2s-2"));
    expect(dec.decode(serverResult.recvCipher.decrypt(c2s2))).toBe("c2s-2");

    // Server -> Client again
    const s2c2 = serverResult.sendCipher.encrypt(textBytes("s2c-2"));
    expect(dec.decode(clientResult.recvCipher.decrypt(s2c2))).toBe("s2c-2");

    // Multiple server -> client without interleaving
    const s2c3 = serverResult.sendCipher.encrypt(textBytes("s2c-3"));
    const s2c4 = serverResult.sendCipher.encrypt(textBytes("s2c-4"));
    expect(dec.decode(clientResult.recvCipher.decrypt(s2c3))).toBe("s2c-3");
    expect(dec.decode(clientResult.recvCipher.decrypt(s2c4))).toBe("s2c-4");
  });

  test("handshakeHash: both sides produce the same hash", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = textBytes("hash-binding-test");

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Handshake hashes must match
    expect(Buffer.from(clientResult.handshakeHash).toString("hex")).toBe(
      Buffer.from(serverResult.handshakeHash).toString("hex"),
    );

    // Hash should be 32 bytes (SHA-256)
    expect(clientResult.handshakeHash.length).toBe(32);

    // Hash should not be all zeros
    const allZero = clientResult.handshakeHash.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  test("key generation: generates valid X25519 keypairs", () => {
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();

    // Keys should be 32 bytes
    expect(kp1.publicKey.length).toBe(32);
    expect(kp1.privateKey.length).toBe(32);
    expect(kp2.publicKey.length).toBe(32);
    expect(kp2.privateKey.length).toBe(32);

    // Different keypairs should have different keys
    expect(Buffer.from(kp1.publicKey).toString("hex")).not.toBe(
      Buffer.from(kp2.publicKey).toString("hex"),
    );
    expect(Buffer.from(kp1.privateKey).toString("hex")).not.toBe(
      Buffer.from(kp2.privateKey).toString("hex"),
    );
  });

  test("different sessions produce different handshake hashes", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    // Session 1
    const i1 = createInitiator(prologue, serverKP.publicKey);
    const r1 = createResponder(prologue, serverKP);
    const m1a = i1.writeMessage1();
    r1.readMessage1(m1a);
    const { msg: m1b, result: res1s } = r1.writeMessage2();
    const { result: res1c } = i1.readMessage2(m1b);

    // Session 2
    const i2 = createInitiator(prologue, serverKP.publicKey);
    const r2 = createResponder(prologue, serverKP);
    const m2a = i2.writeMessage1();
    r2.readMessage1(m2a);
    const { msg: m2b, result: res2s } = r2.writeMessage2();
    const { result: res2c } = i2.readMessage2(m2b);

    // Within each session, hashes match
    expect(Buffer.from(res1c.handshakeHash).toString("hex")).toBe(
      Buffer.from(res1s.handshakeHash).toString("hex"),
    );
    expect(Buffer.from(res2c.handshakeHash).toString("hex")).toBe(
      Buffer.from(res2s.handshakeHash).toString("hex"),
    );

    // Between sessions, hashes differ (ephemeral keys are random)
    expect(Buffer.from(res1c.handshakeHash).toString("hex")).not.toBe(
      Buffer.from(res2c.handshakeHash).toString("hex"),
    );
  });

  test("transport with associated data (AD)", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Encrypt with AD
    const ad = textBytes("channel-id:12345");
    const ct = clientResult.sendCipher.encrypt(textBytes("secret"), ad);

    // Decrypt with same AD succeeds
    const pt = serverResult.recvCipher.decrypt(ct, ad);
    expect(dec.decode(pt)).toBe("secret");
  });

  test("transport with wrong AD fails", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Encrypt with AD
    const ct = clientResult.sendCipher.encrypt(
      textBytes("secret"),
      textBytes("correct-ad"),
    );

    // Decrypt with wrong AD fails
    expect(() =>
      serverResult.recvCipher.decrypt(ct, textBytes("wrong-ad")),
    ).toThrow();
  });

  test("calling readMessage2 before writeMessage1 throws", () => {
    const serverKP = generateX25519KeyPair();
    const initiator = createInitiator(EMPTY, serverKP.publicKey);
    expect(() => initiator.readMessage2(new Uint8Array(64))).toThrow(
      "must call writeMessage1",
    );
  });

  test("calling writeMessage2 before readMessage1 throws", () => {
    const serverKP = generateX25519KeyPair();
    const responder = createResponder(EMPTY, serverKP);
    expect(() => responder.writeMessage2()).toThrow(
      "must call readMessage1",
    );
  });

  test("tampered message 1 causes failure", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();

    // Tamper with the ephemeral key portion
    const tampered = new Uint8Array(msg1);
    tampered[0]! ^= 0xff;

    // Responder should fail to process tampered message
    expect(() => responder.readMessage1(tampered)).toThrow();
  });

  test("tampered message 2 causes failure", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2 } = responder.writeMessage2();

    // Tamper with the message
    const tampered = new Uint8Array(msg2);
    tampered[tampered.length - 1]! ^= 0xff;

    expect(() => initiator.readMessage2(tampered)).toThrow();
  });

  test("empty transport messages work", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // Encrypt empty message
    const ct = clientResult.sendCipher.encrypt(EMPTY);
    const pt = serverResult.recvCipher.decrypt(ct);
    expect(pt.length).toBe(0);
  });

  test("large transport messages work", () => {
    const serverKP = generateX25519KeyPair();
    const prologue = EMPTY;

    const initiator = createInitiator(prologue, serverKP.publicKey);
    const responder = createResponder(prologue, serverKP);

    const msg1 = initiator.writeMessage1();
    responder.readMessage1(msg1);
    const { msg: msg2, result: serverResult } = responder.writeMessage2();
    const { result: clientResult } = initiator.readMessage2(msg2);

    // 64 KiB message
    const large = new Uint8Array(65536);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;

    const ct = clientResult.sendCipher.encrypt(large);
    const pt = serverResult.recvCipher.decrypt(ct);
    expect(Buffer.from(pt).toString("hex")).toBe(
      Buffer.from(large).toString("hex"),
    );
  });
});
