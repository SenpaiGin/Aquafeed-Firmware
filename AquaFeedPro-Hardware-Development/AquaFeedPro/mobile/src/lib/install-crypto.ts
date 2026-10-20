import * as ExpoCrypto from "expo-crypto";

// Hermes has no Web Crypto global; request ids in src/lib need a secure source.
const target = globalThis as { crypto?: Partial<Crypto> };
target.crypto ??= {};
target.crypto.randomUUID ??= ExpoCrypto.randomUUID as Crypto["randomUUID"];
target.crypto.getRandomValues ??=
  ExpoCrypto.getRandomValues as Crypto["getRandomValues"];
