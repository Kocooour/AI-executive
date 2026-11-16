// C28 — validate operator-supplied loopback TLS material for the Linux-only
// Safari gate. No CA private key or production credential may be imported.
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export function assertSafariGatePlatform(platform = process.platform) {
  if (platform !== "linux") {
    throw new Error("target store requires Linux; run the isolated instance on Linux via an SSH tunnel (see R4 cutover runbook section 3)");
  }
}

const TLS_OPTIONS = ["--tls-cert", "--tls-key", "--tls-ca"];
const USAGE = "usage: node scripts/safari-gate-instance.mjs [--port 3210] [--tls-cert <file> --tls-key <file> --tls-ca <rootCA.pem> --expected-sha <40-hex-SHA>]";

export function parseSafariGateArguments(args) {
  if (!Array.isArray(args) || args.length % 2 !== 0) throw new Error(USAGE);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!["--port", "--expected-sha", ...TLS_OPTIONS].includes(key) || values.has(key) ||
        typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  let requestedPort = null;
  if (values.has("--port")) {
    const raw = values.get("--port");
    const port = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("--port must be an integer from 1024 through 65535");
    }
    requestedPort = port;
  }
  const supplied = TLS_OPTIONS.filter(option => values.has(option));
  if (supplied.length && supplied.length !== TLS_OPTIONS.length) {
    throw new Error("--tls-cert, --tls-key and --tls-ca must all be provided together");
  }
  if (supplied.length && requestedPort === null) {
    throw new Error("--port is required for external TLS and the SSH tunnel");
  }
  const expectedSha = values.get("--expected-sha") ?? null;
  if (expectedSha !== null && !/^[a-f0-9]{40}$/i.test(expectedSha)) {
    throw new Error("--expected-sha must be an exact 40-character commit SHA");
  }
  if (supplied.length && expectedSha === null) {
    throw new Error("--expected-sha is mandatory for external TLS and the SSH release gate");
  }
  return {
    requestedPort,
    expectedSha: expectedSha?.toLowerCase() ?? null,
    externalTls: supplied.length ? {
      cert: values.get("--tls-cert"),
      key: values.get("--tls-key"),
      ca: values.get("--tls-ca"),
    } : null,
  };
}

// Never trust git checkout's current HEAD as evidence of the intended release SHA.
export function assertSafariGateExpectedSha(actualSha, expectedSha) {
  if (expectedSha !== null && (typeof expectedSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(expectedSha) || actualSha !== expectedSha)) {
    throw new Error("checkout SHA does not match --expected-sha; Safari gate refused");
  }
}

function assertOperatorOwnedRegularFile(file, label, requireMode = null) {
  if (typeof file !== "string" || !path.isAbsolute(file) ||
      path.normalize(file) !== file) {
    throw new Error(label + " must be a normalized absolute path");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(label + " must be an ordinary file, not a symlink");
  }
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
    throw new Error(label + " must be owned by the effective operator");
  }
  if (requireMode !== null && (stat.mode & 0o7777) !== requireMode) {
    throw new Error(label + " must have permissions 0600");
  }
  // Reject symlinks in ancestor directories as well as the final component.
  if (realpathSync(file) !== file) {
    throw new Error(label + " must not traverse a symlink");
  }
  return readFileSync(file);
}

// X509Certificate accepts the first PEM object and can ignore trailing blocks.
 // The CA/leaf inputs must be *only* a single public certificate; in particular
 // never allow a CA private key concatenated after rootCA.pem to be transferred.
export function assertSinglePublicCertificatePem(bytes, label) {
  const pem = bytes.toString("utf8").trim();
  if (!/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----$/.test(pem)) {
    throw new Error(label + " must contain exactly one public PEM certificate, without private keys or extra objects");
  }
  return bytes;
}

function publicKeyBytes(key) {
  return key.export({ format: "der", type: "spki" });
}

export function validateSafariGateExternalTls({ cert, key, ca }) {
  if (path.basename(key || "").toLowerCase() === "rootca-key.pem") {
    throw new Error("CA private key (rootCA-key.pem) must never be used by the Safari gate");
  }
  const distinct = [cert, key, ca];
  if (new Set(distinct).size !== 3) {
    throw new Error("TLS certificate, key and CA must be three distinct files");
  }
  const certPem = assertSinglePublicCertificatePem(
    assertOperatorOwnedRegularFile(cert, "TLS certificate"), "TLS certificate");
  const keyPem = assertOperatorOwnedRegularFile(key, "TLS private key", 0o600);
  const caPem = assertSinglePublicCertificatePem(
    assertOperatorOwnedRegularFile(ca, "TLS root CA certificate"), "TLS root CA certificate");
  let leaf;
  let authority;
  let privateKey;
  try {
    leaf = new X509Certificate(certPem);
    authority = new X509Certificate(caPem);
    privateKey = createPrivateKey(keyPem);
  } catch {
    throw new Error("invalid TLS certificate, root CA or private key");
  }
  if (!authority.ca || leaf.ca ||
      !leaf.checkIP("127.0.0.1", { subject: "never" })) {
    throw new Error("TLS certificate must be an end-entity certificate for 127.0.0.1 and the supplied CA must be a CA");
  }
  if (leaf.issuer !== authority.subject || !leaf.verify(authority.publicKey)) {
    throw new Error("TLS certificate is not signed by the supplied CA");
  }
  const now = Date.now();
  if (![leaf, authority].every(c => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo))) {
    throw new Error("TLS certificate or root CA is outside its validity window");
  }
  const keyPub = publicKeyBytes(createPublicKey(privateKey));
  if (keyPub.equals(publicKeyBytes(authority.publicKey))) {
    throw new Error("CA private key is prohibited, regardless of filename");
  }
  if (!keyPub.equals(publicKeyBytes(leaf.publicKey))) {
    throw new Error("TLS private key does not match the loopback certificate");
  }
  return { cert, key, ca: caPem };
}

// Dependency-injected selector: the external path must never invoke mkcert.
export function selectSafariGateTls({ externalTls, makeLocalTls }) {
  return externalTls ? validateSafariGateExternalTls(externalTls) : makeLocalTls();
}
