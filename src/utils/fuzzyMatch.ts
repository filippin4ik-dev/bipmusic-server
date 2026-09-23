/**
 * Нечёткое сравнение названий из тегов/имён файлов с каталогом.
 *
 * Задача: «Легендарная пыль» в каталоге должна найтись по «legendarnaja pyl'»,
 * «Legendarnaya Pyl», «Skriptonit» ↔ «Скриптонит», «Kasta» ↔ «Каста» и т.п.
 *
 * Как: обе строки приводим к «скелету» — нижний регистр, ё→е, кириллица
 * транслитерируется в латиницу, затем разные схемы транслита схлопываются в
 * одну (ja/ia→ya, kh→h, shch/sch→sh, ts/tz→c, ch→c, zh→j, w→v, ph→f, q/ck→k,
 * удвоенные буквы → одна, апострофы/мягкие знаки выбрасываются). После этого
 * считаем похожесть (расстояние Левенштейна + сравнение по словам).
 */

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
  // украинские / белорусские / казахские буквы, встречаются в тегах
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
};

const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'feat', 'ft', 'featuring', 'prod', 'remix', 'edit', 'version',
  'deluxe', 'edition', 'explicit', 'clean', 'single', 'ep', 'lp', 'album', 'official',
  'и', 'в', 'на', 'с', 'из', 'при', 'уч',
]);

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Кириллица → латиница одной фиксированной схемой. */
export function transliterate(input: string): string {
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    out += lower in CYR ? CYR[lower] : ch;
  }
  return out;
}

/** Схлопывает варианты транслита в единый вид. Вход — уже латиница в нижнем регистре. */
function foldLatin(s: string): string {
  return s
    .replace(/shch|sch/g, 'sh')
    .replace(/zh/g, 'j')
    .replace(/kh/g, 'h')
    .replace(/ts|tz/g, 'c')
    .replace(/ch/g, 'c')
    .replace(/ph/g, 'f')
    .replace(/ck|q/g, 'k')
    .replace(/x+/g, 'ks')
    .replace(/w/g, 'v')
    // латинская c читается как k перед a/o/u и согласными («Cosmos»), как s перед e/i/y («Scriptonite»)
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/ja|ia|iya/g, 'ya')
    .replace(/ju|iu|iyu/g, 'yu')
    .replace(/jo|io|yo/g, 'e')
    .replace(/je/g, 'e')
    .replace(/j(?=[aeiouy])/g, 'y')
    .replace(/(?<=[a-z])j\b/g, 'y')
    .replace(/(iy|ij|yj|yy|ii)\b/g, 'y')
    .replace(/([a-z])\1+/g, '$1');
}

/** Ключ для сравнения: нормализованная, транслитерированная, схлопнутая строка. */
export function skeleton(raw: string | null | undefined): string {
  if (!raw) return '';
  // Сначала транслит, потом снятие диакритики: иначе NFD разложит «й» на «и»+бреве.
  let s = String(raw).toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[’'`ʼ´]/g, '');
  s = stripDiacritics(transliterate(s));
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  s = s
    .split(' ')
    .map((w) => foldLatin(w))
    .filter(Boolean)
    .join(' ');
  return s;
}

/** Скелет без «шумовых» слов и скобок — для второго, более мягкого сравнения. */
export function skeletonCore(raw: string | null | undefined): string {
  if (!raw) return '';
  const noBrackets = String(raw).replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ');
  const words = skeleton(noBrackets).split(' ').filter((w) => w && !NOISE_WORDS.has(w));
  return words.join(' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function ratio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/** Похожесть по множеству слов: порядок и лишние слова почти не мешают. */
function tokenRatio(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hits = 0;
  for (const w of ta) {
    if (tb.has(w)) {
      hits += 1;
      continue;
    }
    // слово с опечаткой/другим окончанием — только для длинных слов,
    // иначе «Баста» и «Каста» станут одним артистом
    for (const v of tb) {
      if (w.length >= 6 && v.length >= 6 && ratio(w, v) >= 0.8) {
        hits += 0.85;
        break;
      }
    }
  }
  const base = hits / Math.max(ta.size, tb.size);
  // Одна строка целиком входит в другую («Пыль» ↔ «Легендарная пыль»): не ноль, но и не совпадение.
  const contained = hits / Math.min(ta.size, tb.size);
  return Math.max(base, contained * 0.75);
}

/**
 * Похожесть двух названий: 1 — одно и то же, 0 — ничего общего.
 * Учитывает транслит, схемы транслита, порядок слов, опечатки, скобки и шумовые слова.
 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const full = ratio(sa, sb);
  const ca = skeletonCore(a);
  const cb = skeletonCore(b);
  const core = ca && cb ? (ca === cb ? 0.98 : ratio(ca, cb)) : 0;
  const tokens = Math.max(tokenRatio(sa, sb), tokenRatio(ca, cb) * 0.98);
  let score = Math.max(full, core, tokens);
  // Короткие имена: одна другая буква — уже другой артист («Баста»/«Каста»).
  // Не режем совсем, но опускаем до «спроси человека».
  const shortest = Math.min(sa.length, sb.length);
  if (shortest <= 6 && sa !== sb && ca !== cb) score = Math.min(score, 0.7);
  return score;
}

export type Scored<T> = { item: T; score: number };

/**
 * Лучшие кандидаты из списка по похожести имени. Возвращает отсортированный
 * список (сильнее — первее), отрезая явно чужие.
 */
export function rankByName<T>(
  query: string | null | undefined,
  items: T[],
  nameOf: (item: T) => string,
  { limit = 5, floor = 0.45 }: { limit?: number; floor?: number } = {}
): Scored<T>[] {
  if (!query) return [];
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const score = similarity(query, nameOf(item));
    if (score >= floor) scored.push({ item, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

/** Пороги решения: ≥ AUTO — берём сами, ≥ ASK — предлагаем, но просим подтвердить. */
export const MATCH_AUTO = 0.86;
export const MATCH_ASK = 0.6;
