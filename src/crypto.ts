import { Credentials } from "./types";

const PREFIX_V1 = "DVS1.";
const PREFIX_V2 = "DVS2.";
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

async function checksum4(bytes: Uint8Array): Promise<Uint8Array> {
  const d = new Uint8Array(await requireCrypto().digest("SHA-256", bytes));
  return d.slice(0, 4);
}

// Removes spaces, line breaks, invisible characters and quote marks that
// messaging apps and phone keyboards sometimes add around a pasted code.
export function cleanCode(raw: string): string {
  return raw
    .replace(/[\s\u200b-\u200f\u2060\ufeff]+/g, "")
    .replace(/^[`"'“”‘’<(\[]+/, "")
    .replace(/[`"'“”‘’>)\]]+$/, "");
}

export function describeCode(raw: string): string {
  const c = cleanCode(raw);
  if (!c) return "No code pasted.";
  return `Code length ${c.length}, starts "${c.slice(0, 5)}", ends "…${c.slice(-6)}". Compare these with the first device.`;
}

export async function createConnectionCode(cred: Credentials, passphrase: string): Promise<string> {
  const subtle = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(cred))));
  const packed = new Uint8Array(1 + 16 + 12 + ct.length);
  packed[0] = 2; // format version 2: ends with a 4-byte integrity check
  packed.set(salt, 1);
  packed.set(iv, 17);
  packed.set(ct, 29);
  const sum = await checksum4(packed);
  const full = new Uint8Array(packed.length + 4);
  full.set(packed, 0);
  full.set(sum, packed.length);
  return PREFIX_V2 + toB64(full);
}

function passphraseVariants(p: string): string[] {
  const list = [p, p.trim(), p.normalize("NFKC").trim()];
  return list.filter((v, i) => v.length > 0 && list.indexOf(v) === i);
}

export async function readConnectionCode(code: string, passphrase: string): Promise<Credentials> {
  const subtle = requireCrypto();
  const clean = cleanCode(code);
  if (!clean) throw new Error("Paste the connection code first.");
  if (!passphrase) throw new Error("Type the passphrase first.");

  const v2 = clean.startsWith(PREFIX_V2);
  if (!v2 && !clean.startsWith(PREFIX_V1)) {
    throw new Error(`This does not look like a connection code. It should start with DVS2. (you pasted something starting "${clean.slice(0, 6)}").`);
  }

  let packed: Uint8Array;
  try {
    packed = fromB64(clean.slice(5));
  } catch {
    throw new Error("The code is incomplete or has characters that were changed while copying. This is NOT a passphrase problem. Copy the whole code again from the first device.");
  }

  if (v2) {
    if (packed.length < 34) throw new Error("The code is incomplete. Copy the whole code again.");
    const body = packed.slice(0, packed.length - 4);
    const given = packed.slice(packed.length - 4);
    const expected = await checksum4(body);
    for (let i = 0; i < 4; i++) {
      if (given[i] !== expected[i]) {
        throw new Error("The code is incomplete or was changed while copying (the integrity check failed). This is NOT a passphrase problem. Copy the code again from the first device.");
      }
    }
    packed = body;
  }
  if (packed.length < 30 || packed[0] !== (v2 ? 2 : 1)) {
    throw new Error("This connection code is damaged or from a newer version.");
  }

  const salt = packed.slice(1, 17);
  const iv = packed.slice(17, 29);
  const ct = packed.slice(29);

  let text: string | null = null;
  for (const candidate of passphraseVariants(passphrase)) {
    const key = await deriveKey(candidate, salt);
    try {
      text = dec.decode(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
      break;
    } catch {
      // try the next variant (for example without stray spaces)
    }
  }
  if (text === null) {
    throw new Error(
      v2
        ? "The code is complete, but the passphrase is wrong. Check capital letters, spaces and the exact words. Use the Show button to read what you typed."
        : "Wrong passphrase, or this older-format code is incomplete. Create a new code on the first device (it will start with DVS2.) and try again."
    );
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
