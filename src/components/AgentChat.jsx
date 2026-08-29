import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { X, Send, MessageCircle, Minimize2 } from "lucide-react";

const WS_BASE = import.meta.env.VITE_AGENT_WS_URL || "ws://localhost:8000/chat";

function getOrCreateSessionId() {
  const stored = sessionStorage.getItem("ga_session_id");
  if (stored) return stored;
  const id = `ga_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sessionStorage.setItem("ga_session_id", id);
  return id;
}

// Known external links — map keywords to their URLs and labels
const KNOWN_LINKS = [
  { pattern: /phantom\.app/gi,      url: "https://phantom.app",       label: "👻 Get Phantom Wallet →" },
  { pattern: /solflare/gi,          url: "https://solflare.com",      label: "☀️ Solflare Wallet →" },
  { pattern: /coinbase/gi,          url: "https://www.coinbase.com",  label: "🪙 Coinbase →" },
];

// Internal route mappings
const INTERNAL_ROUTES = [
  // { pattern: /\/crypto-wallet-setup-guide/g, to: "/crypto-wallet-setup-guide", label: "📖 Wallet Setup Guide →" },
  { pattern: /\/cart/g,                      to: "/cart",                      label: "👀 See Live Demo →" },
  { pattern: /\/contact-us/g,               to: "/contact-us",               label: "✉️ Contact Us →" },
];

function MessageContent({ content }) {
  // Build a combined regex that captures all linkable tokens
  const allPatterns = [
    // Full URLs (calendly, etc.)
    { regex: /(https?:\/\/[^\s),]+)/g, type: "url" },
    // Internal routes
    ...INTERNAL_ROUTES.map(r => ({ regex: r.pattern, type: "internal", ...r })),
    // Known external sites
    ...KNOWN_LINKS.map(l => ({ regex: l.pattern, type: "external", ...l })),
  ];

  // Find all matches with their positions
  const matches = [];
  for (const p of allPatterns) {
    const re = new RegExp(p.regex.source, p.regex.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], ...p });
    }
  }

  // Sort by position, remove overlaps
  matches.sort((a, b) => a.start - b.start);
  const filtered = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  if (filtered.length === 0) return <span>{content}</span>;

  // Build elements
  const elements = [];
  let cursor = 0;

  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];

    // Text before this match
    if (m.start > cursor) {
      elements.push(<span key={`t${i}`}>{content.slice(cursor, m.start)}</span>);
    }

    if (m.type === "url") {
      // Calendly or other full URLs
      const isCalendly = m.text.includes("calendly");
      elements.push(
        <a
          key={`l${i}`}
          href={m.text}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-2 px-3 py-1.5 bg-[#4b6bff] text-white text-xs font-medium rounded-lg hover:bg-[#3d62ea] transition-colors"
        >
          {isCalendly ? "📅 Book a Call →" : "🔗 Learn More →"}
        </a>
      );
    } else if (m.type === "internal") {
      elements.push(
        <Link
          key={`l${i}`}
          to={m.to}
          className="inline-block mt-1 px-3 py-1.5 bg-[#4b6bff] text-white text-xs font-medium rounded-lg hover:bg-[#3d62ea] transition-colors"
        >
          {m.label}
        </Link>
      );
    } else if (m.type === "external") {
      elements.push(
        <a
          key={`l${i}`}
          href={m.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-1 px-3 py-1.5 bg-slate-700 text-white text-xs font-medium rounded-lg hover:bg-slate-800 transition-colors"
        >
          {m.label}
        </a>
      );
    }

    cursor = m.end;
  }

  // Remaining text after last match
  if (cursor < content.length) {
    elements.push(<span key="tail">{content.slice(cursor)}</span>);
  }

  return <span>{elements}</span>;
}

export default function AgentChat() {
  const [isOpen, setIsOpen]     = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [status, setStatus]     = useState("disconnected"); // connecting | connected | disconnected | error
  const [isTyping, setIsTyping] = useState(false);
  const [unread, setUnread]     = useState(0);

  const wsRef          = useRef(null);
  const sessionId      = useRef(getOrCreateSessionId());
  const bottomRef      = useRef(null);
  const inputRef       = useRef(null);

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setUnread(0);
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  const retryCount = useRef(0);
  const retryTimer = useRef(null);
  const MAX_RETRIES = 3;

  const connect = useCallback(() => {
    // Don't connect if already open or currently connecting
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    setStatus("connecting");
    const ws = new WebSocket(`${WS_BASE}/${sessionId.current}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      retryCount.current = 0; // reset on success
      setMessages(prev => {
        if (prev.length === 0) {
          return [{
            id: "welcome",
            role: "bot",
            content: "Hey! 👋 I'm the GeniusAct assistant. Ask me anything about crypto payments, fees, or how to get started!",
            ts: new Date(),
          }];
        }
        return prev;
      });
    };

    ws.onmessage = (e) => {
      setIsTyping(false);
      try {
        const data = JSON.parse(e.data);
        const newMsg = {
          id: `bot_${Date.now()}`,
          role: "bot",
          content: data.content,
          ts: new Date(),
        };
        setMessages(prev => [...prev, newMsg]);
        if (!isOpen) setUnread(u => u + 1);
      } catch {
        // fallback for plain text
        setMessages(prev => [...prev, {
          id: `bot_${Date.now()}`,
          role: "bot",
          content: e.data,
          ts: new Date(),
        }]);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      // Auto-retry if chat is open and we haven't exceeded retries
      if (retryCount.current < MAX_RETRIES) {
        retryCount.current += 1;
        const delay = Math.min(1000 * retryCount.current, 3000); // 1s, 2s, 3s
        retryTimer.current = setTimeout(() => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) {
            connect();
          }
        }, delay);
      }
    };

    ws.onerror = () => {
      // onerror is always followed by onclose, so let onclose handle retry
      setStatus("error");
    };
  }, []); // stable — no deps that change

  useEffect(() => {
    if (isOpen) connect();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [isOpen, connect]);

  const send = () => {
    const text = input.trim();
    if (!text || status !== "connected") return;

    setMessages(prev => [...prev, {
      id: `user_${Date.now()}`,
      role: "user",
      content: text,
      ts: new Date(),
    }]);
    setInput("");
    setIsTyping(true);
    wsRef.current?.send(text);
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const statusColor = {
    connected:    "bg-green-400",
    connecting:   "bg-yellow-400 animate-pulse",
    disconnected: "bg-slate-400",
    error:        "bg-red-400",
  }[status];

  const statusText = {
    connected:    "Online",
    connecting:   "Connecting...",
    disconnected: "Offline",
    error:        "Connection error",
  }[status];

  // Quick reply suggestions shown before first user message
  const suggestions = [
    "How does crypto checkout work?",
    "How much can I save on fees?",
    "I'm a business — how do I integrate?",
    "I'm a shopper — how do I pay with crypto?",
    "Show me a demo",
    "Book a call",
  ];
  const showSuggestions = messages.length <= 1 && status === "connected";

  return (
    <>
      {/* ── CHAT WINDOW ── */}
      {isOpen && (
        <div
          className="fixed bottom-24 right-4 sm:right-6 z-50 flex flex-col"
          style={{
            width: "min(360px, calc(100vw - 32px))",
            height: "min(520px, calc(100vh - 120px))",
            borderRadius: "16px",
            boxShadow: "0 24px 64px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)",
            background: "#fff",
            animation: "gaSlideUp 0.25s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{
              background: "linear-gradient(135deg, #4b6bff, #6b8aff)",
              borderRadius: "16px 16px 0 0",
            }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg">
                ⚡
              </div>
              <div>
                <p className="text-white font-semibold text-sm leading-tight">GeniusAct</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                  <span className="text-white/75 text-xs">{statusText}</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/70 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#e2e8f0 transparent" }}
          >
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[82%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "text-white rounded-br-sm"
                      : "bg-slate-100 text-slate-800 rounded-bl-sm"
                  }`}
                  style={msg.role === "user" ? {
                    background: "linear-gradient(135deg, #4b6bff, #6b8aff)"
                  } : {}}
                >
                  {msg.role === "bot"
                    ? <MessageContent content={msg.content} />
                    : msg.content
                  }
                </div>
              </div>
            ))}

            {/* Quick suggestions */}
            {showSuggestions && (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map(s => (
                  <button
                    key={s}
                    onClick={() => {
                      setMessages(prev => [...prev, {
                        id: `user_${Date.now()}`, role: "user", content: s, ts: new Date()
                      }]);
                      setIsTyping(true);
                      wsRef.current?.send(s);
                    }}
                    className="text-xs px-3 py-1.5 rounded-full border border-[#4b6bff] text-[#4b6bff] hover:bg-[#4b6bff] hover:text-white transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Typing indicator */}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-slate-100 px-4 py-3 rounded-2xl rounded-bl-sm flex gap-1 items-center">
                  {[0, 0.2, 0.4].map((delay, i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 bg-slate-400 rounded-full"
                      style={{ animation: `gaBounce 1.2s ${delay}s infinite` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Reconnect prompt */}
            {(status === "disconnected" || status === "error") && messages.length > 0 && (
              <div className="text-center text-xs text-slate-400 py-1">
                Connection lost.{" "}
                <button onClick={connect} className="text-[#4b6bff] underline">
                  Reconnect
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="flex-shrink-0 px-3 pb-3 pt-2 border-t border-slate-100">
            <div className="flex gap-2 items-center bg-slate-50 rounded-xl px-3 py-2 border border-slate-200 focus-within:border-[#4b6bff] transition-colors">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder={status === "connected" ? "Ask anything..." : "Connecting..."}
                disabled={status !== "connected"}
                maxLength={500}
                className="flex-1 bg-transparent text-sm text-slate-800 placeholder-slate-400 outline-none disabled:opacity-50"
              />
              <button
                onClick={send}
                disabled={!input.trim() || status !== "connected"}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: "linear-gradient(135deg, #4b6bff, #6b8aff)" }}
              >
                <Send size={13} className="text-white" />
              </button>
            </div>
            <p className="text-center text-[10px] text-slate-300 mt-1.5">Powered by GeniusAct AI</p>
          </div>
        </div>
      )}

      {/* ── BUBBLE BUTTON ── */}
      <button
        onClick={() => setIsOpen(o => !o)}
        className="fixed bottom-5 right-4 sm:right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ background: "linear-gradient(135deg, #4b6bff, #6b8aff)" }}
        aria-label={isOpen ? "Close chat" : "Open chat"}
      >
        {isOpen
          ? <X size={22} className="text-white" />
          : <MessageCircle size={22} className="text-white" />
        }
        {/* Unread badge */}
        {!isOpen && unread > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
            {unread}
          </span>
        )}
      </button>

      {/* ── KEYFRAMES ── */}
      <style>{`
        @keyframes gaSlideUp {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes gaBounce {
          0%, 60%, 100% { transform: translateY(0); }
          30%            { transform: translateY(-5px); }
        }
      `}</style>
    </>
  );
}