/**
 * Build the clickable/copyable access URLs for the running server.
 *
 * Shared by the `kimi web` ready banner and `kimi web rotate-token` so both
 * show the same Local/Network links. When a token is known it rides in the
 * `#token=` fragment (never sent to the server, so never logged), letting a
 * user open the link on another device and be authenticated automatically.
 */

import { listNetworkAddresses, type NetworkAddress } from './networks';
import { serverOrigin } from './shared';

/**
 * Build a directly-openable server URL. When the token is known it is appended
 * as `#token=<token>`; otherwise the bare origin (with a trailing slash) is
 * returned.
 */
export function buildOpenableUrl(bareOrigin: string, token: string | undefined): string {
  const base = bareOrigin.endsWith('/') ? bareOrigin.slice(0, -1) : bareOrigin;
  return token === undefined ? `${base}/` : `${base}/#token=${token}`;
}

/**
 * Split a full URL into the part before `#token=` and the `#token=…` fragment
 * itself, so callers can render the fragment in a de-emphasized color. Returns
 * `[fullUrl, '']` when there is no token fragment.
 */
export function splitTokenFragment(fullUrl: string): [string, string] {
  const marker = '#token=';
  const idx = fullUrl.indexOf(marker);
  return idx < 0 ? [fullUrl, ''] : [fullUrl.slice(0, idx), fullUrl.slice(idx)];
}

export interface AccessUrlLine {
  /** Fixed-width label including trailing padding, e.g. `"Local:    "`. */
  label: string;
  /** Full URL, carrying `#token=` when a token is known. */
  url: string;
}

function isWildcard(host: string): boolean {
  return host === '' || host === '0.0.0.0' || host === '::';
}

/** True when `host` is a loopback address (this host only). */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Compute the access-URL lines for a bind host/port.
 *
 * - wildcard (`0.0.0.0` / `::` / empty): a `Local:` line (localhost) plus one
 *   `Network:` line per non-loopback interface.
 * - loopback: a single `Local:` line.
 * - specific host: a single `URL:` line.
 *
 * `includeIpv6` gates the interface hints only: an IPv6 bind chosen with
 * `--host` is printed either way, because that is where the server listens.
 */
export function accessUrlLines(
  host: string,
  port: number,
  token: string | undefined,
  networkAddresses?: NetworkAddress[],
  includeIpv6 = false,
): AccessUrlLine[] {
  if (isWildcard(host)) {
    const lines: AccessUrlLine[] = [
      { label: 'Local:    ', url: buildOpenableUrl(serverOrigin('localhost', port), token) },
    ];
    const addrs = (networkAddresses ?? listNetworkAddresses()).filter(
      (addr) => includeIpv6 || addr.family === 'IPv4',
    );
    for (const addr of addrs) {
      lines.push({
        label: 'Network:  ',
        url: buildOpenableUrl(serverOrigin(addr.address, port), token),
      });
    }
    return lines;
  }
  if (isLoopbackHost(host)) {
    return [{ label: 'Local:    ', url: buildOpenableUrl(serverOrigin(host, port), token) }];
  }
  return [{ label: 'URL:      ', url: buildOpenableUrl(serverOrigin(host, port), token) }];
}
