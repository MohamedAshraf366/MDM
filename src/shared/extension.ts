/**
 * Stable ID of the bundled Chrome/Edge extension.
 *
 * Chrome derives an unpacked extension's ID from the `key` field in
 * extension/manifest.json. Keeping the public key there means the ID does not
 * depend on the folder the extension was loaded from, so the bridge can hand
 * its token to this one extension instead of any installed extension.
 *
 * tests/extension-id.test.ts recomputes this value from the manifest, so the
 * two cannot drift apart silently. If the manifest key is ever replaced, update
 * this constant with the new ID at the same time.
 */
export const CHROMIUM_EXTENSION_ID = 'oojnafhedmcdiohlppogncampchpenjf';

export const CHROMIUM_EXTENSION_ORIGIN = `chrome-extension://${CHROMIUM_EXTENSION_ID}`;
