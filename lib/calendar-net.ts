import { lookup } from "node:dns/promises";
import net from "node:net";

// Network checks shared by the calendar fetchers (ICS feeds in lib/calendar.ts, iCloud CalDAV in lib/caldav.ts): a calendar
// request only goes to a public address, and the address that was checked is the one connected to (pinned lookup).
const publicIpv6 = new net.BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
const unsafeIpv6 = new net.BlockList();
unsafeIpv6.addSubnet("2001::", 23, "ipv6");
unsafeIpv6.addSubnet("2001:db8::", 32, "ipv6");
unsafeIpv6.addSubnet("2002::", 16, "ipv6");
unsafeIpv6.addSubnet("3fff::", 20, "ipv6");

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const value = address.toLowerCase();
  if (!net.isIPv6(value)) return false;
  if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
  return publicIpv6.check(value, "ipv6") && !unsafeIpv6.check(value, "ipv6");
}

/** The single public address a calendar request connects to; refuses anything but public HTTPS on port 443. */
export async function resolvedTarget(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("Calendar URL must use public HTTPS on port 443");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const allowed = addresses.filter((item) => isPublicAddress(item.address));
  if (!allowed.length || allowed.length !== addresses.length) throw new Error("Calendar host resolves to a private or unsafe address");
  return allowed[0];
}
