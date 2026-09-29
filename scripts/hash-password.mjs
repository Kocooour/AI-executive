import { randomBytes, scrypt } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
const password = await new Promise((resolve) => readline.question("", resolve));
readline.close();
if (password.length < 12) {
  console.error("Password must contain at least 12 characters.");
  process.exit(1);
}
const salt = randomBytes(16);
const derived = await promisify(scrypt)(password, salt, 64, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
process.stdout.write(`scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}\n`);
