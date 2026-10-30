import fsp from 'node:fs/promises';
import path from 'node:path';

const link = process.env.CSC_LINK?.trim() || process.env.WIN_CSC_LINK?.trim() || '';
if (!link) {
  console.error(
    [
      'Signed packaging needs a code-signing certificate.',
      '',
      'Set CSC_LINK or WIN_CSC_LINK to a .pfx file path, an https:// URL that electron-builder can download,',
      'or a base64-encoded certificate. Set CSC_KEY_PASSWORD or WIN_CSC_KEY_PASSWORD when it has a password.',
      '',
      'Then run: npm run package:signed'
    ].join('\n')
  );
  process.exit(1);
}

const isCertificateUrl = /^https?:\/\//i.test(link);
if (isCertificateUrl) {
  let url;
  try {
    url = new URL(link);
  } catch {
    console.error(`The code-signing certificate URL is not valid: ${link}`);
    process.exit(1);
  }
  if (!/^https?:$/.test(url.protocol)) {
    console.error(`The code-signing certificate URL must use http or https: ${link}`);
    process.exit(1);
  }
} else {
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
}

if (!process.env.CSC_KEY_PASSWORD?.trim() && !process.env.WIN_CSC_KEY_PASSWORD?.trim()) {
  console.warn('No CSC_KEY_PASSWORD/WIN_CSC_KEY_PASSWORD is set; assuming the certificate has an empty password.');
}

console.log('Code-signing credentials found; starting the signed build.');
