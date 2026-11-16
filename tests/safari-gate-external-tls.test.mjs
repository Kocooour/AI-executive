import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafariGatePlatform, assertSafariGateExpectedSha,
  assertSinglePublicCertificatePem, parseSafariGateArguments,
  selectSafariGateTls, validateSafariGateExternalTls,
} from "../scripts/safari-gate-external-tls.mjs";

function openssl(...args) {
  execFileSync("openssl", args, { stdio: "ignore", timeout: 30000 });
}

function caFixture(folder, name) {
  const key = path.join(folder, name + "-key.pem");
  const cert = path.join(folder, name + ".pem");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", "/CN=" + name,
    "-addext", "basicConstraints=critical,CA:TRUE");
  chmodSync(key, 0o600);
  return { key, cert };
}

function leafFixture(folder, name, ca, san = "IP:127.0.0.1,DNS:localhost") {
  const key = path.join(folder, name + ".key");
  const cert = path.join(folder, name + ".crt");
  const csr = path.join(folder, name + ".csr");
  const config = path.join(folder, name + ".cnf");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", csr, "-subj", "/CN=127.0.0.1");
  writeFileSync(config, "basicConstraints = CA:FALSE\nsubjectAltName = " + san + "\n");
  openssl("x509", "-req", "-in", csr, "-CA", ca.cert, "-CAkey", ca.key,
    "-CAcreateserial", "-out", cert, "-days", "2", "-extfile", config);
  chmodSync(key, 0o600);
  return { key, cert };
}

function tlsFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-safari-tls-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ca = caFixture(root, "rootCA");
  const leaf = leafFixture(root, "loopback", ca);
  return { root, ca, leaf, options: { cert: leaf.cert, key: leaf.key, ca: ca.cert } };
}

test("Darwin and other non-Linux hosts fail closed before the launcher build", () => {
  assert.doesNotThrow(() => assertSafariGatePlatform("linux"));
  for (const platform of ["darwin", "win32", "freebsd"]) {
    assert.throws(() => assertSafariGatePlatform(platform), /requires Linux.*SSH tunnel/);
  }
});

test("external TLS options are all-or-none, require explicit tunnel port, and cannot be duplicated", () => {
  assert.deepEqual(parseSafariGateArguments([]),
    { requestedPort: null, expectedSha: null, externalTls: null });
  assert.deepEqual(parseSafariGateArguments(["--port", "3443"]),
    { requestedPort: 3443, expectedSha: null, externalTls: null });
  assert.deepEqual(parseSafariGateArguments([
    "--tls-cert", "/tmp/leaf.crt", "--port", "3443",
    "--tls-key", "/tmp/leaf.key", "--tls-ca", "/tmp/rootCA.pem",
    "--expected-sha", "A".repeat(40),
  ]), { requestedPort: 3443, expectedSha: "a".repeat(40), externalTls: {
    cert: "/tmp/leaf.crt", key: "/tmp/leaf.key", ca: "/tmp/rootCA.pem",
  } });
  for (const args of [
    ["--tls-cert", "/tmp/cert"],
    ["--port", "3443", "--tls-cert", "/tmp/cert", "--tls-key", "/tmp/key"],
  ]) assert.throws(() => parseSafariGateArguments(args), /must all be provided together/);
  assert.throws(() => parseSafariGateArguments([
    "--tls-cert", "cert", "--tls-key", "key", "--tls-ca", "ca",
  ]), /--port is required/);
  assert.throws(() => parseSafariGateArguments([
    "--port", "3443", "--tls-cert", "/tmp/c", "--tls-key", "/tmp/k", "--tls-ca", "/tmp/a",
  ]), /--expected-sha is mandatory/);
  assert.throws(() => parseSafariGateArguments([
    "--port", "3443", "--expected-sha", "short",
  ]), /exact 40-character/);
  assert.throws(() => parseSafariGateArguments(["--port", "80"]), /--port/);
  assert.throws(() => parseSafariGateArguments(["--port", "3443", "--port", "3444"]), /usage/);
  assert.throws(() => parseSafariGateArguments(["--something", "value"]), /usage/);
});

test("valid Mac-issued loopback TLS uses the supplied CA and never calls mkcert", t => {
  const { options } = tlsFixture(t);
  let madeLocalCert = false;
  const material = selectSafariGateTls({ externalTls: options,
    makeLocalTls() { madeLocalCert = true; throw new Error("mkcert must not run"); },
  });
  assert.equal(madeLocalCert, false);
  assert.equal(material.cert, options.cert);
  assert.equal(material.key, options.key);
  assert.deepEqual(material.ca, readFileSync(options.ca));
  assert.equal(selectSafariGateTls({ externalTls: null,
    makeLocalTls() { return "local-mkcert"; },
  }), "local-mkcert");
});

test("external TLS rejects lax key permissions, symlinks and missing files", t => {
  const { root, options } = tlsFixture(t);
  chmodSync(options.key, 0o644);
  assert.throws(() => validateSafariGateExternalTls(options), /permissions 0600/);
  chmodSync(options.key, 0o600);
  const link = path.join(root, "alias.key");
  symlinkSync(options.key, link);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: link }), /ordinary file/);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: root }), /ordinary file/);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: path.join(root, "missing.key") }), /ENOENT/);
});

test("external TLS refuses untrusted CA, missing IP SAN and CA private keys", t => {
  const { root, ca, options } = tlsFixture(t);
  const otherCa = caFixture(root, "untrustedCA");
  assert.throws(() => validateSafariGateExternalTls({ ...options, ca: otherCa.cert }),
    /not signed by the supplied CA/);
  const dnsOnly = leafFixture(root, "dns-only", ca, "DNS:localhost");
  assert.throws(() => validateSafariGateExternalTls({ ...options,
    cert: dnsOnly.cert, key: dnsOnly.key,
  }), /127\.0\.0\.1/);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: ca.key }),
    /CA private key/);
  const hiddenCaKey = path.join(root, "renamed.key");
  copyFileSync(ca.key, hiddenCaKey);
  chmodSync(hiddenCaKey, 0o600);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: hiddenCaKey }),
    /CA private key is prohibited/);
  assert.throws(() => validateSafariGateExternalTls({ ...options, key: otherCa.key }),
    /does not match/);
});

test("intended release SHA mismatch fails closed independent of a clean checkout", () => {
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => assertSafariGateExpectedSha(sha, sha));
  assert.doesNotThrow(() => assertSafariGateExpectedSha(sha, null)); // local mkcert mode
  assert.throws(() => assertSafariGateExpectedSha("b".repeat(40), sha), /does not match/);
  assert.throws(() => assertSafariGateExpectedSha(sha, "invalid"), /does not match/);
});

test("PEM input contains only one public certificate, never appended CA keys", t => {
  const { root, ca, options } = tlsFixture(t);
  const originalCa = readFileSync(options.ca);
  assert.deepEqual(assertSinglePublicCertificatePem(originalCa, "CA"), originalCa);
  const concatenatedCa = path.join(root, "root-with-key.pem");
  writeFileSync(concatenatedCa, Buffer.concat([
    originalCa, Buffer.from("\n"), readFileSync(ca.key),
  ]));
  assert.throws(() => validateSafariGateExternalTls({ ...options, ca: concatenatedCa }),
    /exactly one public PEM certificate/);
  const combinedLeaf = path.join(root, "leaf-with-ca-key.crt");
  writeFileSync(combinedLeaf, Buffer.concat([
    readFileSync(options.cert), Buffer.from("\n"), readFileSync(ca.key),
  ]));
  assert.throws(() => validateSafariGateExternalTls({ ...options, cert: combinedLeaf }),
    /exactly one public PEM certificate/);
  const extraCert = path.join(root, "root-with-another-cert.pem");
  writeFileSync(extraCert, Buffer.concat([
    originalCa, Buffer.from("\n"), readFileSync(options.cert),
  ]));
  assert.throws(() => validateSafariGateExternalTls({ ...options, ca: extraCert }),
    /exactly one public PEM certificate/);
  const trailingComment = path.join(root, "root-with-extra-text.pem");
  writeFileSync(trailingComment, Buffer.concat([originalCa, Buffer.from("\nextra text\n")]));
  assert.throws(() => validateSafariGateExternalTls({ ...options, ca: trailingComment }),
    /exactly one public PEM certificate/);
});
