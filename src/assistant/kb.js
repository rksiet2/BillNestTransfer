// Browser-only entry point: loads the knowledge base markdown as raw text at
// build time (Vite `?raw` import bundles the file's contents into the app,
// so it works fully offline with no runtime file read) and parses it into
// Q&A entries the Assistant engine can score against.
import kbRaw from '../../docs/assistant-kb.md?raw';
import { parseKb } from './kbParser.js';

export const kbEntries = parseKb(kbRaw);
