import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Clipboard,
  Copy,
  Database,
  FileJson,
  FlaskConical,
  Loader2,
  RotateCcw,
  Send,
  ShieldAlert,
  Signal,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import "./styles.css";

const STORAGE_KEY = "queuestorm-case-lab-queue";
const MAX_QUEUE_ITEMS = 20;

const CHANNEL_OPTIONS = [
  { value: "app", label: "App" },
  { value: "sms", label: "SMS" },
  { value: "call_center", label: "Call center" },
  { value: "merchant_portal", label: "Merchant portal" },
];

const LOCALE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "bn", label: "Bangla" },
  { value: "mixed", label: "Mixed" },
];

const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const SAMPLE_TICKETS = [
  {
    id: "wrong-transfer",
    label: "Wrong transfer",
    icon: Send,
    request: {
      ticket_id: "T-014",
      channel: "app",
      locale: "en",
      message: "I sent 5000 taka to a wrong number by mistake. Please help me recover the money.",
    },
  },
  {
    id: "phishing",
    label: "Phishing alert",
    icon: ShieldAlert,
    request: {
      ticket_id: "T-022",
      channel: "sms",
      locale: "mixed",
      message:
        "A person called saying they are from support and asked for my OTP to unblock my wallet. I think this is fraud.",
    },
  },
  {
    id: "payment-failed",
    label: "Payment failed",
    icon: Activity,
    request: {
      ticket_id: "T-031",
      channel: "merchant_portal",
      locale: "en",
      message: "Customer payment failed at checkout but the balance appears deducted from their account.",
    },
  },
  {
    id: "refund",
    label: "Refund request",
    icon: RotateCcw,
    request: {
      ticket_id: "T-044",
      channel: "call_center",
      locale: "en",
      message: "Customer wants a refund for a duplicate mobile recharge made yesterday.",
    },
  },
];

const INITIAL_FORM = SAMPLE_TICKETS[0].request;

function humanize(value) {
  if (!value) return "Unknown";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return "now";
  }
}

function loadStoredQueue() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_QUEUE_ITEMS) : [];
  } catch {
    return [];
  }
}

function sortQueue(items) {
  return [...items].sort((a, b) => {
    const reviewDelta = Number(b.human_review_required) - Number(a.human_review_required);
    if (reviewDelta) return reviewDelta;
    const severityDelta = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (severityDelta) return severityDelta;
    const confidenceDelta = (a.confidence ?? 1) - (b.confidence ?? 1);
    if (confidenceDelta) return confidenceDelta;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

function buildQueueItem(result, request, latencyMs) {
  return {
    id: `${result.ticket_id}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    latencyMs,
    status: "classified",
    request,
    ...result,
  };
}

function validateForm(form) {
  const errors = {};
  if (!form.ticket_id.trim()) errors.ticket_id = "Ticket ID is required.";
  if (!form.message.trim()) errors.message = "Message is required.";
  return errors;
}

function App() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);
  const [queue, setQueue] = useState(() => loadStoredQueue());
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [health, setHealth] = useState({ state: "checking", detail: "Checking API", checkedAt: null });
  const [latencyMs, setLatencyMs] = useState(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [copyState, setCopyState] = useState("idle");

  const sortedQueue = useMemo(() => sortQueue(queue), [queue]);
  const latestJson = useMemo(() => {
    if (!result) return "";
    return JSON.stringify(result, null, 2);
  }, [result]);

  const reviewCount = useMemo(
    () => queue.filter((item) => item.human_review_required).length,
    [queue]
  );

  const criticalCount = useMemo(
    () => queue.filter((item) => item.severity === "critical").length,
    [queue]
  );

  const checkHealth = useCallback(async () => {
    const started = performance.now();
    try {
      const response = await fetch("/health", { headers: { accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      const measured = Math.round(performance.now() - started);
      if (!response.ok || body.status !== "ok") {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setHealth({
        state: "online",
        detail: `Online · ${measured}ms`,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      setHealth({
        state: "offline",
        detail: err?.message ? `Offline · ${err.message}` : "Offline",
        checkedAt: new Date().toISOString(),
      });
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = window.setInterval(checkHealth, 30000);
    return () => window.clearInterval(timer);
  }, [checkHealth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE_ITEMS)));
    } catch {
      // Storage can fail in private contexts; the in-memory queue still works.
    }
  }, [queue]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && jsonOpen) setJsonOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [jsonOpen]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function loadSample(sample) {
    setForm(sample.request);
    setErrors({});
    setApiError("");
  }

  async function submitTicket(event) {
    event.preventDefault();
    const nextErrors = validateForm(form);
    setErrors(nextErrors);
    setApiError("");
    if (Object.keys(nextErrors).length) return;

    const payload = {
      ticket_id: form.ticket_id.trim(),
      channel: form.channel,
      locale: form.locale,
      message: form.message.trim(),
    };

    setLoading(true);
    setCopyState("idle");
    const started = performance.now();

    try {
      const response = await fetch("/sort-ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || `Request failed with HTTP ${response.status}`);
      }
      if (!body || typeof body !== "object") {
        throw new Error("The API returned an empty or invalid JSON response.");
      }

      const measured = Math.round(performance.now() - started);
      setLatencyMs(measured);
      setResult(body);
      setJsonOpen(false);
      setQueue((current) => [buildQueueItem(body, payload, measured), ...current].slice(0, MAX_QUEUE_ITEMS));
    } catch (err) {
      setApiError(err?.message || "Unable to classify this ticket. Check the API and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyJson() {
    if (!latestJson) return;
    try {
      await navigator.clipboard.writeText(latestJson);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  function clearQueue() {
    setQueue([]);
  }

  return (
    <main className="case-lab-shell">
      <header className="top-rail" aria-label="Case Lab status">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <FlaskConical size={22} />
          </div>
          <div>
            <p className="eyebrow">QueueStorm</p>
            <h1>Case Lab</h1>
          </div>
        </div>

        <div className="top-rail-actions">
          <button
            className={`status-pill ${health.state}`}
            type="button"
            onClick={checkHealth}
            aria-label={`API health: ${health.detail}. Click to refresh.`}
          >
            {health.state === "offline" ? <WifiOff size={16} /> : <Signal size={16} />}
            <span>{health.detail}</span>
          </button>

          <div className="metric-pill" aria-label="Latest response latency">
            <Activity size={16} />
            <span>{latencyMs === null ? "No run yet" : `${latencyMs}ms latest`}</span>
          </div>

          <button
            className="icon-action"
            type="button"
            onClick={copyJson}
            disabled={!result}
            title="Copy latest JSON"
            aria-label="Copy latest JSON"
          >
            {copyState === "copied" ? <Check size={17} /> : <Copy size={17} />}
          </button>

          <button
            className="icon-action danger"
            type="button"
            onClick={clearQueue}
            disabled={!queue.length}
            title="Clear local queue"
            aria-label="Clear local queue"
          >
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      <section className="lab-grid" aria-label="QueueStorm Case Lab workspace">
        <aside className="intake-panel" aria-labelledby="intake-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live input</p>
              <h2 id="intake-title">Ticket intake</h2>
            </div>
            <span className="mode-chip">Real API</span>
          </div>

          <form className="ticket-form" onSubmit={submitTicket}>
            <label className="field">
              <span>Ticket ID</span>
              <input
                value={form.ticket_id}
                onChange={(event) => updateField("ticket_id", event.target.value)}
                placeholder="T-001"
                aria-invalid={Boolean(errors.ticket_id)}
                aria-describedby={errors.ticket_id ? "ticket-id-error" : undefined}
              />
              {errors.ticket_id ? (
                <small className="field-error" id="ticket-id-error">
                  {errors.ticket_id}
                </small>
              ) : null}
            </label>

            <div className="field-row">
              <label className="field">
                <span>Channel</span>
                <select
                  value={form.channel}
                  onChange={(event) => updateField("channel", event.target.value)}
                >
                  {CHANNEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Locale</span>
                <select
                  value={form.locale}
                  onChange={(event) => updateField("locale", event.target.value)}
                >
                  {LOCALE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              <span>Customer message</span>
              <textarea
                value={form.message}
                onChange={(event) => updateField("message", event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submitTicket(event);
                }}
                rows={4}
                placeholder="Paste the customer complaint here..."
                aria-invalid={Boolean(errors.message)}
                aria-describedby={errors.message ? "message-error" : "message-hint"}
              />
              {errors.message ? (
                <small className="field-error" id="message-error">
                  {errors.message}
                </small>
              ) : (
                <small id="message-hint">Press Ctrl+Enter to classify from this field.</small>
              )}
            </label>

            <button className="primary-action" type="submit" disabled={loading}>
              {loading ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
              <span>{loading ? "Classifying..." : "Sort ticket"}</span>
            </button>
          </form>

          <div className="sample-bank" aria-label="Sample tickets">
            <div className="sample-bank-title">
              <Database size={16} />
              <span>Samples</span>
            </div>
            <div className="sample-grid">
              {SAMPLE_TICKETS.map((sample) => {
                const Icon = sample.icon;
                return (
                  <button key={sample.id} type="button" onClick={() => loadSample(sample)}>
                    <Icon size={16} />
                    <span>{sample.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="verdict-panel" aria-live="polite" aria-labelledby="verdict-title">
          {loading ? (
            <LoadingVerdict />
          ) : result ? (
            <Verdict result={result} latencyMs={latencyMs} />
          ) : (
            <EmptyVerdict />
          )}

          {apiError ? (
            <div className="api-error" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>Classification failed</strong>
                <span>{apiError}</span>
              </div>
            </div>
          ) : null}

          <div className={`json-drawer ${jsonOpen ? "open" : ""}`}>
            <button
              className="drawer-toggle"
              type="button"
              onClick={() => setJsonOpen((current) => !current)}
              disabled={!result}
              aria-expanded={jsonOpen}
            >
              <FileJson size={17} />
              <span>Raw JSON</span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
            {jsonOpen && result ? (
              <div className="json-content">
                <pre>{latestJson}</pre>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="queue-panel" aria-labelledby="queue-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Local queue</p>
              <h2 id="queue-title">Review stack</h2>
            </div>
            <div className="queue-counts" aria-label={`${reviewCount} review items, ${criticalCount} critical`}>
              <span>{reviewCount} review</span>
              <span>{criticalCount} critical</span>
            </div>
          </div>

          {sortedQueue.length ? (
            <ol className="queue-list">
              {sortedQueue.map((item) => (
                <QueueItem key={item.id} item={item} />
              ))}
            </ol>
          ) : (
            <div className="empty-queue">
              <Clipboard size={28} />
              <p>Classified tickets will appear here, sorted by review urgency.</p>
            </div>
          )}
        </aside>
      </section>

      <div className="sr-status" role="status" aria-live="polite">
        {copyState === "copied" ? "JSON copied to clipboard." : ""}
        {copyState === "failed" ? "Unable to copy JSON." : ""}
      </div>
    </main>
  );
}

function EmptyVerdict() {
  return (
    <div className="empty-verdict">
      <div className="empty-icon" aria-hidden="true">
        <FlaskConical size={34} />
      </div>
      <p className="eyebrow">Verdict bench</p>
      <h2 id="verdict-title">Ready to classify the next ticket.</h2>
      <p>
        Choose a sample or paste a customer message. The lab will call the live
        QueueStorm sorting endpoint and show only fields returned by the API.
      </p>
    </div>
  );
}

function LoadingVerdict() {
  return (
    <div className="loading-verdict" aria-label="Classifying ticket">
      <div className="skeleton top"></div>
      <div className="skeleton headline"></div>
      <div className="skeleton line"></div>
      <div className="skeleton line short"></div>
      <div className="skeleton metrics"></div>
    </div>
  );
}

function Verdict({ result, latencyMs }) {
  const confidencePercent = Math.round(Number(result.confidence || 0) * 100);
  const confidenceBand =
    result.confidence >= 0.8 ? "High" : result.confidence >= 0.55 ? "Medium" : "Low";

  return (
    <article className={`verdict-card severity-${result.severity}`}>
      <div className="verdict-topline">
        <span className="ticket-number">{result.ticket_id}</span>
        <span className="severity-chip">
          {result.severity === "critical" ? <ShieldAlert size={16} /> : <Activity size={16} />}
          {humanize(result.severity)}
        </span>
      </div>

      <div className="verdict-main">
        <p className="eyebrow">Case type</p>
        <h2 id="verdict-title">{humanize(result.case_type)}</h2>
        <p>{result.agent_summary}</p>
      </div>

      <div className="verdict-meta-grid">
        <Metric label="Department" value={humanize(result.department)} />
        <Metric label="Human review" value={result.human_review_required ? "Required" : "Not required"} />
        <Metric label="Latency" value={latencyMs === null ? "—" : `${latencyMs}ms`} />
      </div>

      <div className="confidence-block" aria-label={`Confidence ${confidencePercent} percent, ${confidenceBand}`}>
        <div className="confidence-header">
          <span>Confidence</span>
          <strong>{confidencePercent}% · {confidenceBand}</strong>
        </div>
        <div className="confidence-track">
          <span style={{ width: `${confidencePercent}%` }}></span>
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QueueItem({ item }) {
  const confidencePercent = Math.round(Number(item.confidence || 0) * 100);
  return (
    <li className={`queue-item severity-${item.severity}`}>
      <div className="queue-item-top">
        <strong>{item.ticket_id}</strong>
        <span>{formatTime(item.createdAt)}</span>
      </div>
      <p>{humanize(item.case_type)}</p>
      <div className="queue-item-meta">
        <span>{humanize(item.severity)}</span>
        <span>{confidencePercent}%</span>
        <span>{item.human_review_required ? "Review" : "Auto"}</span>
      </div>
    </li>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
