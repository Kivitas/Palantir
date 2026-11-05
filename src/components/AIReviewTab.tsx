import React, { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { store } from '../store';
import { CLEARANCE_LEVELS, type AIProvider, type Case, type ClearanceLevel } from '../types';
import { Brain, Settings, AlertCircle, Save, Check } from 'lucide-react';
import { useConfirm } from '../ui/confirmContext';
import { useToast } from '../ui/toastContext';
import { PROVIDER_LABELS, DEFAULT_MODELS } from '../ai/providers';
import {
  ANALYSIS_TRANSMISSION_NOTICE,
  CASE_PAYLOAD_CHAR_LIMIT,
  CLEARANCE_ORDER,
  buildCasePayload,
  sendThroughGate,
  type CasePayload,
} from '../ai/gate';

interface AIReviewTabProps {
  onNavigate?: (tab: string) => void;
}

const DEFAULT_PROMPT = 'Analyze this case for hidden networks, threat clusters, and crucial pivot nodes.';

type ReportState = { mode: 'live' | 'demo'; provider: AIProvider; model: string; text: string };

/** Offline template used when no API key is stored. Built only from the case data, no model call. */
function buildDemoReport(activeCase: Case, provider: AIProvider, model: string): string {
  let response = `### DEMO INTEL BRIEFING: CASE ANALYSIS\n\n`;
  response += `**Target Workspace**: ${activeCase.name}\n`;
  response += `**Analysis Provider**: ${PROVIDER_LABELS[provider]} (${model}), not connected in demo mode\n\n`;

  if (activeCase.entities.length === 0) {
    response += `*No entity structures present inside the containment vault to traverse.*`;
    return response;
  }
  response += `#### 1. Identity Resolution & Clustered Networks\n`;
  response += `Key focal nodes identified:\n`;
  activeCase.entities.slice(0, 3).forEach(e => {
    response += `- **${e.name}** (${e.type}) - Cell clearance: ${e.clearance}.\n`;
  });

  response += `\n#### 2. Geospatial Anomaly Detection\n`;
  if (activeCase.incidents.length > 0) {
    response += `Plotting indicates incident clustering near the following coordinates:\n`;
    activeCase.incidents.slice(0, 2).forEach(i => {
      response += `- **${i.title}** (GPS: ${i.lat}, ${i.lon}) - Severity: ${i.severity}.\n`;
    });
  } else {
    response += `No geospatial coordinates plotted. Recommend placing incidents on the map to run proximity models.\n`;
  }

  response += `\n#### 3. Security Recommendations\n`;
  response += `- Enforce strict Cell-Level Security classification mappings for Top Secret cells.\n`;
  response += `- Monitor chronological threads connecting historical incident streams.\n`;
  return response;
}

/** Renders **bold** inline. Everything is a React text node, so no HTML is ever interpreted. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1
      ? <strong key={`${keyPrefix}-${i}`}>{part}</strong>
      : <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>,
  );
}

type MdBlock =
  | { kind: 'heading'; level: 3 | 4 | 5; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'para'; text: string };

/** Minimal markdown: headings, bullet and numbered lists, paragraphs, **bold**. No links, images or HTML. */
function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];

    if (!line.trim()) continue;
    if (heading) {
      const hashes = heading[1] ?? '#';
      const level = hashes.length <= 2 ? 3 : hashes.length === 3 ? 4 : 5;
      blocks.push({ kind: 'heading', level, text: heading[2] ?? '' });
    } else if (bullet || numbered) {
      const ordered = !bullet;
      const text = (bullet ? bullet[1] : numbered?.[1]) ?? '';
      if (last && last.kind === 'list' && last.ordered === ordered) {
        last.items.push(text);
      } else {
        blocks.push({ kind: 'list', ordered, items: [text] });
      }
    } else {
      blocks.push({ kind: 'para', text: line });
    }
  }
  return blocks;
}

function SafeMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="ai-markdown-report">
      {blocks.map((block, i) => {
        const key = `md-${i}`;
        if (block.kind === 'heading') {
          if (block.level === 3) return <h3 key={key}>{renderInline(block.text, key)}</h3>;
          if (block.level === 4) return <h4 key={key}>{renderInline(block.text, key)}</h4>;
          return <h5 key={key}>{renderInline(block.text, key)}</h5>;
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, j) => <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>);
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}

function PayloadPreview({ payload, provider }: { payload: CasePayload; provider: AIProvider }) {
  const row = (label: string, counts: { entities: number; incidents: number; relationships: number }) =>
    `${label}: ${counts.entities} entities, ${counts.incidents} incidents, ${counts.relationships} relationships`;
  return (
    <details className="ai-send-preview" open>
      <summary>What will be sent to {PROVIDER_LABELS[provider]} ({payload.charCount.toLocaleString()} of {CASE_PAYLOAD_CHAR_LIMIT.toLocaleString()} characters)</summary>
      <ul className="ai-payload-counts">
        <li>{row('Sent', payload.included)}</li>
        <li>{row('Eligible at ceiling', payload.eligible)}</li>
        <li>Excluded above clearance ceiling ({payload.ceiling}): {payload.excludedByClearance} (never sent)</li>
        {payload.omittedForLength > 0 && <li>Omitted to fit the size limit: {payload.omittedForLength}</li>}
      </ul>
      <pre
        className="ai-payload-preview"
        tabIndex={0}
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto', fontSize: 12, margin: '8px 0' }}
      >{payload.text}</pre>
    </details>
  );
}

export const AIReviewTab: React.FC<AIReviewTabProps> = ({ onNavigate }) => {
  const activeCase = store.getActiveCase();
  const userClearance = store.getCurrentUserClearance();
  const confirm = useConfirm();
  const toast = useToast();
  const providerId = useId();
  const modelId = useId();
  const keyId = useId();
  const promptId = useId();
  const clearanceId = useId();
  const ackId = useId();

  const [provider, setProvider] = useState<AIProvider>('anthropic');
  const [model, setModel] = useState<string>(DEFAULT_MODELS.anthropic);
  const [apiKey, setApiKey] = useState('');
  const [isSaved, setIsSaved] = useState(false);
  const [analysisPrompt, setAnalysisPrompt] = useState(DEFAULT_PROMPT);
  const [maxClearance, setMaxClearance] = useState<ClearanceLevel>('UNCLASSIFIED');
  const [acknowledged, setAcknowledged] = useState(false);
  const [report, setReport] = useState<ReportState | null>(null);
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight request when the tab unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const providerSettings = store.data.settings.ai[provider];
  const hasKey = !!providerSettings.apiKey;
  const payload = activeCase ? buildCasePayload(activeCase, userClearance, maxClearance) : null;
  const clearanceOptions = CLEARANCE_ORDER.filter(c => CLEARANCE_LEVELS[c] <= CLEARANCE_LEVELS[userClearance]);

  const changeProvider = (next: AIProvider) => {
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
    setAcknowledged(false);
    setError('');
  };

  const handleSaveKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    store.set_ai_key(provider, apiKey.trim());
    setApiKey('');
    setIsSaved(true);
    toast.show('API key saved for this browser session.', 'success');
    setTimeout(() => setIsSaved(false), 2000);
  };

  const handleClearKey = async () => {
    const ok = await confirm({
      title: 'Clear stored API keys',
      message: 'Remove every AI API key stored for this session? You will need to enter them again.',
      confirmLabel: 'Clear keys',
      tone: 'danger',
    });
    if (!ok) return;
    store.clear_ai_keys();
    setAcknowledged(false);
    toast.show('All stored API keys cleared.', 'success');
  };

  const runDemo = () => {
    if (!activeCase) return;
    setIsRunning(true);
    setError('');
    setReport(null);
    const snapshot = { provider, model: model.trim() || DEFAULT_MODELS[provider] };
    const caseName = activeCase.name;
    setTimeout(() => {
      const text = buildDemoReport(activeCase, snapshot.provider, snapshot.model);
      setReport({ mode: 'demo', provider: snapshot.provider, model: snapshot.model, text });
      setIsRunning(false);
      store.logAction(
        'AI_ANALYSIS',
        `mode=demo provider=${snapshot.provider} case=${caseName} entities=${activeCase.entities.length} incidents=${activeCase.incidents.length} relationships=${activeCase.relationships.length}`,
      );
    }, 800);
  };

  const runLive = async () => {
    if (!activeCase || !payload) return;
    if (!acknowledged) {
      setError('Tick the box confirming that the case data may be sent to this provider.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const usedModel = model.trim();
    setIsRunning(true);
    setError('');
    setReport(null);

    let status: 'ok' | 'failed' | 'cancelled' = 'ok';
    try {
      const text = await sendThroughGate({
        provider,
        apiKey: providerSettings.apiKey ?? '',
        model: usedModel,
        analysisPrompt,
        payload,
        acknowledged,
        signal: controller.signal,
      });
      setReport({ mode: 'live', provider, model: usedModel, text });
    } catch (err) {
      if (controller.signal.aborted) {
        status = 'cancelled';
        setError('Analysis cancelled.');
      } else {
        status = 'failed';
        setError(err instanceof Error ? err.message : 'The analysis failed for an unknown reason.');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsRunning(false);
      // Audit records the transmission and its counts only, never the content.
      store.logAction(
        'AI_ANALYSIS',
        `mode=live provider=${provider} model=${usedModel} status=${status} ceiling=${payload.ceiling} entities=${payload.included.entities} incidents=${payload.included.incidents} relationships=${payload.included.relationships} excluded=${payload.excludedByClearance} chars=${payload.charCount}`,
      );
    }
  };

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Brain size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>The AI review works on one case at a time. Select or create a case to run a review.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  return (
    <div id="AIReviewPanel" className="ai-review-container">
      {hasKey ? (
        <p className="demo-notice" role="note">
          Live mode: a key is stored for {PROVIDER_LABELS[provider]}. Only case data at or below the chosen clearance is sent, shown in the preview before you send.
        </p>
      ) : (
        <p className="demo-notice" role="note">
          Demo (offline): no API key is stored for {PROVIDER_LABELS[provider]}. The report is built from a fixed template and no model is called.
        </p>
      )}
      <div className="ai-review-grid">
        {/* Left side: provider, key, clearance, prompt */}
        <div className="ai-review-side">
          <div className="premium-panel ai-panel">
            <div className="premium-panel-header">
              <h3 className="premium-panel-title">
                <Settings size={14} className="inline-icon" aria-hidden="true" />
                Intelligence Model Configuration
              </h3>
            </div>

            <div className="form-group">
              <label htmlFor={providerId} className="form-label">Provider</label>
              <select
                id={providerId}
                className="premium-input ai-full-width"
                value={provider}
                onChange={(e) => changeProvider(e.target.value as AIProvider)}
              >
                {(Object.keys(PROVIDER_LABELS) as AIProvider[]).map(p => (
                  <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor={modelId} className="form-label">Model</label>
              <input
                id={modelId}
                type="text"
                className="premium-input ai-full-width"
                value={model}
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setModel(e.target.value)}
              />
              <small className="text-muted">Default: {DEFAULT_MODELS[provider]}. Edit to use another model name.</small>
            </div>

            <form onSubmit={handleSaveKey} className="form-group">
              <label htmlFor={keyId} className="form-label">
                API Key {hasKey && <span className="text-accent">(Stored)</span>}
              </label>
              <div className="ai-key-row">
                <input
                  id={keyId}
                  type="password"
                  autoComplete="off"
                  className="premium-input"
                  placeholder={hasKey ? '••••••••••••••••' : 'Enter API key...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="submit"
                  className="premium-button primary ai-key-save"
                  aria-label={isSaved ? 'API key saved' : 'Save API key'}
                  disabled={!apiKey.trim()}
                >
                  {isSaved ? <Check size={14} aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                </button>
              </div>
            </form>

            <button type="button" className="premium-button ai-full-width" onClick={handleClearKey}>
              Clear all stored keys
            </button>
          </div>

          <div className="premium-panel ai-panel">
            <div className="premium-panel-header">
              <h3 className="premium-panel-title">
                <Brain size={14} className="inline-icon" aria-hidden="true" />
                Data Sent to Provider
              </h3>
            </div>
            <div className="form-group">
              <label htmlFor={clearanceId} className="form-label">Maximum clearance to send</label>
              <select
                id={clearanceId}
                className="premium-input ai-full-width"
                value={maxClearance}
                onChange={(e) => {
                  setMaxClearance(e.target.value as ClearanceLevel);
                  setAcknowledged(false);
                }}
              >
                {clearanceOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <small className="text-muted">Items above this level are never sent. Your clearance: {userClearance}.</small>
            </div>

            <label htmlFor={promptId} className="form-label">Analysis prompt</label>
            <textarea
              id={promptId}
              className="premium-input ai-full-width ai-prompt"
              value={analysisPrompt}
              maxLength={2000}
              onChange={(e) => setAnalysisPrompt(e.target.value)}
              rows={4}
            />

            {payload && <PayloadPreview payload={payload} provider={provider} />}

            {hasKey && (
              <div className="form-group">
                <label htmlFor={ackId} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                  <input
                    id={ackId}
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>{ANALYSIS_TRANSMISSION_NOTICE}</span>
                </label>
              </div>
            )}

            {error && <p role="alert" style={{ color: 'var(--danger, #f87171)', fontSize: 13 }}><AlertCircle size={14} aria-hidden="true" /> {error}</p>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {hasKey && (
                isRunning ? (
                  <button type="button" className="premium-button ai-run-btn" onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="premium-button primary ai-run-btn"
                    disabled={!acknowledged || !model.trim()}
                    onClick={runLive}
                  >
                    Send to {PROVIDER_LABELS[provider]}
                  </button>
                )
              )}
              <button
                type="button"
                className={`premium-button ai-run-btn ${hasKey ? '' : 'primary'}`}
                disabled={isRunning}
                onClick={runDemo}
              >
                {isRunning && !hasKey ? 'Analyzing graph...' : 'Run demo analysis (offline)'}
              </button>
            </div>
          </div>
        </div>

        {/* Right side: output */}
        <div className="ai-review-report">
          <div className="premium-panel ai-panel ai-panel-tall">
            <div className="premium-panel-header">
              <h3 className="premium-panel-title">
                <Brain size={14} className="inline-icon" aria-hidden="true" />
                Analysis Report Output
              </h3>
              {report && (
                <span className={`badge ${report.mode === 'live' ? 'badge-primary' : 'badge-warning'}`}>
                  {report.mode === 'live' ? `Live: ${PROVIDER_LABELS[report.provider]} (${report.model})` : 'Demo (offline)'}
                </span>
              )}
            </div>

            <div className="ai-report-scroll" aria-live="polite">
              {isRunning && hasKey ? (
                <div className="ai-loading">
                  <div className="ai-spinner" />
                  <p>Waiting for {PROVIDER_LABELS[provider]}...</p>
                </div>
              ) : isRunning ? (
                <div className="ai-loading">
                  <div className="ai-spinner" />
                  <p>Processing intelligence containment sub-graphs...</p>
                </div>
              ) : report ? (
                <SafeMarkdown source={report.text} />
              ) : (
                <div className="ai-placeholder">
                  <AlertCircle size={32} className="ai-placeholder-icon" aria-hidden="true" />
                  <p>{hasKey ? 'Review the data preview, tick the acknowledgement, then send.' : 'Run the demo analysis to generate a template review of the active case.'}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
