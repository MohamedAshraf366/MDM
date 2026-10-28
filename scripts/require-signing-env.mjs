import fsp from 'node:fs/promises';
import path from 'node:path';

const link = process.env.CSC_LINK?.trim() || process.env.WIN_CSC_LINK?.trim() || '';
if (!link) {
  console.error(
    [
      'Signed packaging needs a code-signing certificate.',
      '',
      'Set CSC_LINK or WIN_CSC_LINK to a .pfx file path (or a base64-encoded certificate),',
      'and set CSC_KEY_PASSWORD or WIN_CSC_KEY_PASSWORD when the certificate has a password.',
      '',
      'Then run: npm run package:signed'
    ].join('\n')
  );
  process.exit(1);
}

const looksLikePath = !/^[A-Za-z0-9+/=\r\n]+$/.test(link) || /^[A-Za-z]:[\\/]/.test(link) || link.startsWith('.');
if (looksLikePath) {
  const certificatePath = path.resolve(link);
  try {
    await fsp.access(certificatePath);
  } catch {
    console.error(`The code-signing certificate was not found: ${certificatePath}`);
    process.exit(1);
  }
}

if (!process.env.CSC_KEY_PASSWORD?.trim() && !process.env.WIN_CSC_KEY_PASSWORD?.trim()) {
  console.warn('No CSC_KEY_PASSWORD/WIN_CSC_KEY_PASSWORD is set; assuming the certificate has an empty password.');
}

console.log('Code-signing credentials found; starting the signed build.');
