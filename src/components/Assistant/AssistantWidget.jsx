import React, { useEffect, useRef, useState } from 'react';
import { kbEntries } from '../../assistant/kb';
import { answerQuestion } from '../../assistant/engine';
import { isBookingRequest, createBookingSession, processBookingStep } from '../../assistant/bookingWizard';
import { APP_NAME } from '../../constants/brand';

const GREETING = `Hi! I'm the ${APP_NAME} Assistant — fully offline, and I only know about this app. Ask me things like "how do I cancel a booking?" or "what's today's revenue?", or say "book a room" and I'll create a booking for you step by step.`;

// Floating chat button shown on every screen once logged in. Fully offline —
// answers come from the local knowledge base (docs/assistant-kb.md) or by
// reading the app's own data via window.api; nothing is ever sent to the
// internet, and out-of-scope questions get a fixed decline message instead
// of a guess.
export default function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{ role: 'assistant', text: GREETING }]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [bookingSession, setBookingSession] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  async function handleSend(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || thinking) return;
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setInput('');
    setThinking(true);
    try {
      if (bookingSession) {
        const { session, reply } = await processBookingStep(bookingSession, question, window.api);
        setBookingSession(session);
        setMessages((m) => [...m, { role: 'assistant', text: reply }]);
        return;
      }
      if (isBookingRequest(question)) {
        const session = createBookingSession();
        setBookingSession(session);
        setMessages((m) => [...m, { role: 'assistant', text: "Sure — let's create a booking. What's the guest's name? (type \"cancel\" anytime to stop)" }]);
        return;
      }
      const { text } = await answerQuestion(question, { kbEntries, api: window.api });
      setMessages((m) => [...m, { role: 'assistant', text }]);
    } finally {
      setThinking(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="assistant-fab"
        onClick={() => setOpen((v) => !v)}
        title={`${APP_NAME} Assistant`}
        aria-label={`Open ${APP_NAME} Assistant`}
      >
        🤖
      </button>

      {open && (
        <div className="assistant-panel">
          <div className="assistant-panel-header">
            <span>🤖 {APP_NAME} Assistant</span>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close assistant">✕</button>
          </div>
          <div className="assistant-messages" ref={listRef}>
            {messages.map((m, i) => (
              <div key={i} className={`assistant-msg ${m.role}`}>{m.text}</div>
            ))}
            {thinking && <div className="assistant-msg assistant thinking">Thinking…</div>}
          </div>
          <form className="assistant-input-row" onSubmit={handleSend}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about ${APP_NAME}…`}
              disabled={thinking}
            />
            <button type="submit" className="btn btn-primary" disabled={thinking || !input.trim()}>Send</button>
          </form>
        </div>
      )}
    </>
  );
}
