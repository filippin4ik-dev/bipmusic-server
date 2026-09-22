/** «Track (Remix)» / «Song [Official]» → чистое название при загрузке. */
export function cleanTrackTitle(raw: unknown): string {
  let out = String(raw ?? '').trim();
  const original = out;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]/g, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out || original;
}

/**
 * Ключ для сравнения названий из тегов с каталогом: регистр, ё/е, скобки и
 * пунктуация не должны мешать «Скриптонит» найти «скриптонит (feat. …)».
 */
export function catalogKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s*[\(\[\{].*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * «Artist feat. Other», «A, B», «A & B», «A x B» → главный артист и остальные.
 * Главным считается первый; остальные пойдут соавторами, если найдутся в каталоге.
 */
export function splitArtistCredits(raw: string): { main: string; others: string[] } {
  const text = raw.replace(/[()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { main: '', others: [] };
  const parts = text
    .split(/\s*(?:,|;|\/|&)\s*|\s+(?:feat\.?|ft\.?|featuring|x|при уч\.?)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { main: text, others: [] };
  return { main: parts[0], others: parts.slice(1) };
}
