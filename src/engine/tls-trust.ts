import tls from 'node:tls';

type CaType = 'default' | 'system' | 'bundled' | 'extra';
export type TlsCaSource = {
  getCACertificates?: (type?: CaType) => string[];
};

/**
 * Builds the CA list used for verified HTTPS connections.
 *
 * Node only trusts its bundled Mozilla roots by default, while browsers also
 * trust the operating system store. Antivirus HTTPS scanning, corporate
 * proxies and private CAs install their root there, so without this a download
 * that works in the browser fails here with a certificate chain error.
 *
 * Returns undefined when the runtime cannot expose the system store, which
 * keeps Node's default behaviour (including NODE_EXTRA_CA_CERTS).
 */
export function buildTrustedCAs(source: TlsCaSource = tls as unknown as TlsCaSource): string[] | undefined {
  const get = source.getCACertificates;
  if (typeof get !== 'function') return undefined;
  try {
    const system = get.call(source, 'system');
    if (!Array.isArray(system) || system.length === 0) return undefined;
    // An explicit `ca` replaces Node's defaults, so re-add the bundled roots
    // and anything from NODE_EXTRA_CA_CERTS alongside the system certificates.
    const merged = new Set<string>(get.call(source, 'default'));
    for (const cert of get.call(source, 'extra')) merged.add(cert);
    for (const cert of system) merged.add(cert);
    return [...merged];
  } catch {
    return undefined;
  }
}

let cached: string[] | undefined | null = null;

/** Cached for the process lifetime; restart after installing a new root CA. */
export function getTrustedCAs(): string[] | undefined {
  if (process.env.MDM_DISABLE_SYSTEM_CA === '1') return undefined;
  if (cached === null) cached = buildTrustedCAs();
  return cached;
}
