// Turns raw OCR text from a photographed/uploaded menu into a best-effort
// list of candidate food items (name + price), with a guessed category
// taken from short, price-less "heading" lines that appear above them
// (e.g. "STARTERS", "Main Course", "Beverages"). This is intentionally a
// simple heuristic, not a full menu-layout parser — messy/decorative menus
// will need manual correction in the review step the UI shows afterwards.

// Matches a trailing price at the end of a line, optionally preceded by a
// currency symbol/word and any amount of dotted/dashed "leader" characters
// commonly used in printed menus (e.g. "Paneer Tikka .......... 180").
const PRICE_RE = /[₹Rs.]*\s*(\d{1,5}(?:\.\d{1,2})?)\s*\/?-?\s*$/i;
const LEADER_RE = /[\s.\-–—_]{2,}$/;

function stripLeaders(text) {
  return text.replace(LEADER_RE, '').trim();
}

// Heuristic for "this line is a category heading, not a menu item": short,
// has no price, and is mostly uppercase or title-cased words only.
function looksLikeHeading(line) {
  if (!line || line.length > 28) return false;
  if (/\d/.test(line)) return false;
  const letters = line.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 3) return false;
  const upperRatio = (line.match(/[A-Z]/g) || []).length / letters.length;
  return upperRatio > 0.6 || /^[A-Z][a-z]+(\s[A-Z][a-z]+)*$/.test(line);
}

// categories: existing category rows [{id, name}] used to match a guessed
// heading like "Starters" to an existing category (case-insensitive),
// leaving categoryId null (and categoryGuess set) when there's no match so
// the review UI can offer to create it.
export function parseMenuText(text, categories = []) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const items = [];
  let currentHeading = '';

  for (const rawLine of lines) {
    const priceMatch = rawLine.match(PRICE_RE);
    if (!priceMatch) {
      if (looksLikeHeading(rawLine)) currentHeading = rawLine;
      continue;
    }
    const price = parseFloat(priceMatch[1]);
    if (!Number.isFinite(price) || price <= 0 || price > 50000) continue;

    let name = stripLeaders(rawLine.slice(0, priceMatch.index));
    // Drop a stray leading bullet/number like "1." or "-" some menus use.
    name = name.replace(/^[\s•\-–—]*\d*[.)]?\s*/, '').trim();
    if (name.length < 2) continue;

    const guess = currentHeading;
    items.push({
      name,
      price,
      categoryGuess: guess || '',
      categoryId: guess ? (byName.get(guess.trim().toLowerCase()) ?? null) : null,
    });
  }

  return items;
}
