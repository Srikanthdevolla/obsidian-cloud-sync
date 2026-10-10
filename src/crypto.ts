import { Credentials } from "./types";

const PREFIX = "DVS1.";
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function requireCrypto(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("This device does not support the encryption this plugin needs.");
  }
  return crypto.subtle;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = requireCrypto();
  const base = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createConnectionCode(cred: Credentials, passphrase: string): Promise<string> {
  const subtle = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(cred))));
  const packed = new Uint8Array(1 + 16 + 12 + ct.length);
  packed[0] = 1; // format version
  packed.set(salt, 1);
  packed.set(iv, 17);
  packed.set(ct, 29);
  return PREFIX + toB64(packed);
}

export async function readConnectionCode(code: string, passphrase: string): Promise<Credentials> {
  const subtle = requireCrypto();
  const clean = code.replace(/\s+/g, "");
  if (!clean.startsWith(PREFIX)) throw new Error("This is not a valid connection code.");
  let packed: Uint8Array;
  try {
    packed = fromB64(clean.slice(PREFIX.length));
  } catch {
    throw new Error("This connection code is damaged. Copy it again.");
  }
  if (packed.length < 30 || packed[0] !== 1) throw new Error("This connection code is damaged or from a newer version.");

  const salt = packed.slice(1, 17);
  const iv = packed.slice(17, 29);
  const ct = packed.slice(29);
  const key = await deriveKey(passphrase, salt);

  let text: string;
  try {
    text = dec.decode(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  } catch {
    throw new Error("Wrong passphrase, or the code was changed.");
  }

  const c = JSON.parse(text) as Credentials;
  const ok =
    typeof c.clientId === "string" && c.clientId.length > 0 &&
    typeof c.clientSecret === "string" && c.clientSecret.length > 0 &&
    typeof c.refreshToken === "string" && c.refreshToken.length > 0 &&
    typeof c.folderName === "string" &&
    typeof c.folderId === "string" && /^[A-Za-z0-9_-]+$/.test(c.folderId);
  if (!ok) throw new Error("The connection code has missing or invalid details.");
  return c;
}
