import { describe, expect, it } from 'vitest';
import { buildTrustedCAs } from '../src/engine/tls-trust';

describe('buildTrustedCAs', () => {
  it('keeps Node defaults when the runtime cannot expose the system store', () => {
    expect(buildTrustedCAs({})).toBeUndefined();
  });

  it('keeps Node defaults when the system store is empty or unreadable', () => {
    expect(buildTrustedCAs({ getCACertificates: () => [] })).toBeUndefined();
    expect(
      buildTrustedCAs({
        getCACertificates: () => {
          throw new Error('unsupported');
        }
      })
    ).toBeUndefined();
  });

  it('merges default, extra and system roots without duplicates', () => {
    const store: Record<string, string[]> = {
      default: ['bundled-a', 'bundled-b'],
      extra: ['extra-a'],
      system: ['bundled-b', 'av-root']
    };
    const merged = buildTrustedCAs({ getCACertificates: (type) => store[type ?? 'default'] ?? [] });
    expect(merged).toEqual(['bundled-a', 'bundled-b', 'extra-a', 'av-root']);
  });
});
