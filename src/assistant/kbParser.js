// Parses the offline Assistant knowledge base (docs/assistant-kb.md) into
// structured Q&A entries. Pure string parsing, no imports — works the same
// whether the markdown text was loaded via Vite's `?raw` import (in the app)
// or via fs.readFileSync (in the plain-Node regression test).
//
// Format: a level-2 heading ("## question text") starts an entry; everything
// until the next "## " heading (or end of file) is that entry's answer.
// HTML comments (<!-- ... -->) are stripped before parsing so authoring notes
// at the top of the file don't leak into the assistant's answers.
export function parseKb(markdownText) {
  const cleaned = (markdownText || '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = cleaned.split('\n');
  const entries = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) entries.push(finalizeEntry(current));
      current = { question: headingMatch[1], answerLines: [] };
    } else if (current) {
      current.answerLines.push(line);
    }
  }
  if (current) entries.push(finalizeEntry(current));

  return entries;
}

function finalizeEntry(entry) {
  const answer = entry.answerLines.join('\n').trim();
  return {
    question: entry.question,
    answer,
    // Question-only keywords are the primary matching signal (precise,
    // small set); `keywords` also folds in the answer text as a broader
    // secondary signal used only to break ties between similarly-titled
    // entries — see engine.js's scoreKbEntry.
    questionKeywords: extractKeywords(entry.question),
    keywords: extractKeywords(`${entry.question} ${answer}`),
  };
}

// A small English stopword list so common words ("how", "do", "the", "a")
// don't dominate the keyword-overlap matching score — only the meaningful
// terms (e.g. "cancel", "booking", "advance", "payment") should count.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'i', 'to', 'of', 'in', 'on', 'or', 'and',
  'for', 'it', 'this', 'that', 'how', 'what', 'where', 'can', 'my', 'me', 'you', 'your',
  'app', 'with', 'from', 'at', 'be', 'have', 'has', 'if', 'so', 'not', 'go', 'used',
]);

export function extractKeywords(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w)
  );
}
