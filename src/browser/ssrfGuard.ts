/**
 * Target-URL policy for the Browser proxy (functions/browse/[[path]].ts).
 *
 * Pure module with no DOM or Workers APIs, so the function and a Node test script can both use it.
 *
 * Every URL the proxy fetches is checked here: the initial URL and every redirect hop.
 * Checks run on the URL as the WHATWG parser normalises it, so tricks such as decimal,
 * hex and octal IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1, 127.1) are reduced to
 * canonical dotted form before the range checks run.
 *
 * Limits of a string check: it cannot see DNS. A public-looking name that resolves to a
 * private address is not caught here. The platform (Cloudflare Workers egress) is the
 * backstop for that; see the report in the change notes.
 */

export const MAX_URL_LENGTH = 2048;

export type TargetCheck = { ok: true; url: URL } | { ok: false; reason: string };

export interface TargetCheckOptions {
  /** Base for resolving relative redirect Location headers. */
  base?: URL;
  /** The proxy's own origin. Requests back into the proxy are refused. */
  selfOrigin?: string;
}

/** Hostnames refused by name, in addition to the suffix list. */
const BLOCKED_NAMES: ReadonlySet<string> = new Set(['localhost', 'metadata', 'metadata.google.internal']);

/** Internal-only suffixes (mDNS, service discovery, private TLDs). Matched on the full label boundary. */
const BLOCKED_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
  '.intranet',
  '.corp',
  '.private',
];

/** Ports allowed for http and https. Implicit defaults normalise to an empty port string. */
const ALLOWED_PORTS: ReadonlySet<string> = new Set(['', '80', '443']);

const HOST_CHARS_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * IPv4 ranges that must never be fetched: loopback, private, link-local (cloud metadata lives
 * at 169.254.169.254), carrier-grade NAT, documentation, benchmarking, multicast and reserved.
 */
export function isBlockedIPv4(o: readonly number[]): boolean {
  const a = o[0] ?? -1;
  const b = o[1] ?? -1;
  const c = o[2] ?? -1;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local and metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * Validates a URL for fetching. Returns the parsed URL on success, or a short machine-readable
 * reason (never echoes the input) on failure.
 */
export function checkTargetUrl(raw: unknown, opts: TargetCheckOptions = {}): TargetCheck {
  if (typeof raw !== 'string') return fail('not_a_string');
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return fail('bad_length');
  // Control characters, whitespace and backslashes are refused outright. Backslashes are treated
  // as slashes by WHATWG for special schemes, which is a parser-differential risk.
  if (hasControlOrSpace(text)) return fail('control_or_space');
  // Userinfo in the authority (user@host, user:pass@host) is never allowed.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(text)) return fail('userinfo');

  let url: URL;
  try {
    url = opts.base ? new URL(text, opts.base) : new URL(text);
  } catch {
    return fail('unparseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('scheme');
  if (url.username !== '' || url.password !== '') return fail('userinfo');
  if (!ALLOWED_PORTS.has(url.port)) return fail('port');
  if (opts.selfOrigin !== undefined && url.origin === opts.selfOrigin) return fail('self');

  const host = url.hostname;
  if (host === '') return fail('no_host');
  if (host.startsWith('[')) return fail('ipv6_literal'); // IPv6 literals are refused entirely

  // A single trailing dot names the same host, so strip it before the name checks.
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!HOST_CHARS_RE.test(name)) return fail('host_chars');

  const ipv4 = IPV4_RE.exec(name);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return fail('bad_ipv4');
    if (isBlockedIPv4(octets)) return fail('private_ipv4');
    return { ok: true, url };
  }

  // After canonicalisation, a host whose last label is still numeric is a malformed or unusual IP form.
  const lastLabel = name.slice(name.lastIndexOf('.') + 1);
  if (/^[0-9]+$/.test(lastLabel) || /^0x[0-9a-f]*$/i.test(lastLabel)) return fail('numeric_host');

  if (!name.includes('.')) return fail('single_label');
  if (BLOCKED_NAMES.has(name) || BLOCKED_SUFFIXES.some((s) => name.endsWith(s))) return fail('internal_name');

  return { ok: true, url };
}

function fail(reason: string): TargetCheck {
  return { ok: false, reason };
}

/** True for C0 controls, space, DEL and backslash. Checked by code point, not regex. */
function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}
