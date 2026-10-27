import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../src/shared/validation';

describe('sanitizeFileName spoofing defenses', () => {
  it('removes bidi overrides so the real extension stays visible', () => {
    expect(sanitizeFileName('invoice\u202Etxt.exe')).toBe('invoicetxt.exe');
    expect(sanitizeFileName('photo\u2066.jpg\u2069.exe')).toBe('photo.jpg.exe');
  });

  it('removes zero-width and invisible characters', () => {
    expect(sanitizeFileName('report\u200B.exe')).toBe('report.exe');
    expect(sanitizeFileName('\uFEFFnotes\u2060.txt')).toBe('notes.txt');
  });

  it('keeps neutralizing traversal, stream names and reserved device names', () => {
    expect(sanitizeFileName('../../x')).toBe('_.._x');
    expect(sanitizeFileName('file.txt:evil.exe')).toBe('file.txt_evil.exe');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
  });
});
