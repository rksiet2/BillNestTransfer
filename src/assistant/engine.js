// Offline matching engine for the in-app Assistant. No internet, no LLM —
// purely keyword-overlap scoring against (1) the static knowledge base
// (docs/assistant-kb.md) and (2) live-data intents that read the app's own
// database via window.api. Anything that doesn't clear the relevance
// threshold is treated as out-of-scope and gets a fixed decline message,
// so the assistant never tries to answer general-knowledge questions.
import { extractKeywords } from './kbParser.js';
import { liveDataIntents, scoreIntent } from './liveDataIntents.js';
import { APP_NAME } from '../constants/brand.js';

export const OUT_OF_SCOPE_MESSAGE =
  `I can only help with questions about ${APP_NAME} itself (billing, food menu, room bookings, reporting, settings, etc.) — I don't have access to anything outside the app.`;

const MATCH_THRESHOLD = 0.2;

function scoreKbEntry(inputKeywords, entry) {
  const inputSet = new Set(inputKeywords);
  // Primary signal: overlap against the question title only (small, precise
  // keyword set) — this avoids a short query accidentally scoring a perfect
  // match against a long, broad answer paragraph that happens to share a
  // couple of common words (e.g. "today"/"revenue" appearing in an unrelated
  // answer's prose). Falls back to the combined title+answer set only as a
  // small tie-breaking bonus.
  const qSet = new Set(entry.questionKeywords && entry.questionKeywords.length ? entry.questionKeywords : entry.keywords);
  let overlap = 0;
  for (const w of inputSet) if (qSet.has(w)) overlap += 1;
  if (!overlap) return 0;
  const primary = overlap / Math.max(inputSet.size, qSet.size);

  const fullSet = new Set(entry.keywords);
  let fullOverlap = 0;
  for (const w of inputSet) if (fullSet.has(w)) fullOverlap += 1;
  const bonus = fullOverlap / Math.max(inputSet.size, fullSet.size) * 0.15;

  return primary + bonus;
}

// `deps.kbEntries` — array from parseKb(kbMarkdownText)
// `deps.api` — window.api (or a mock in tests)
export async function answerQuestion(question, deps) {
  const { kbEntries = [], api } = deps;
  const trimmed = (question || '').trim();
  if (!trimmed) return { text: `Ask me anything about using ${APP_NAME} — e.g. "how do I cancel a booking?" or "what is today's revenue?".`, source: 'prompt' };

  const inputKeywords = extractKeywords(trimmed);
  if (!inputKeywords.length) return { text: OUT_OF_SCOPE_MESSAGE, source: 'out-of-scope' };

  let best = { score: 0 };

  for (const entry of kbEntries) {
    const score = scoreKbEntry(inputKeywords, entry);
    if (score > best.score) best = { score, type: 'kb', entry };
  }

  if (api) {
    for (const intent of liveDataIntents) {
      const score = scoreIntent(inputKeywords, intent);
      if (score > best.score) best = { score, type: 'intent', intent };
    }
  }

  if (best.score < MATCH_THRESHOLD) {
    return { text: OUT_OF_SCOPE_MESSAGE, source: 'out-of-scope' };
  }

  if (best.type === 'kb') {
    return { text: best.entry.answer, source: 'kb', question: best.entry.question };
  }

  try {
    const text = await best.intent.handler(api);
    return { text, source: 'live-data', intentId: best.intent.id };
  } catch (err) {
    return { text: `Sorry, I couldn't fetch that right now (${err.message}).`, source: 'error' };
  }
}
