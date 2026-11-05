import React, { useCallback, useEffect, useRef, useState } from 'react';
import { store, MAX_RADIUS_KM, MAX_WATCH_RULES } from '../store';
import { SignalStatus, WatchRule } from '../types';
import { AlertCircle, AlertTriangle, ShieldAlert, Clock, BrainCircuit, Upload, Play, Plus, Trash2 } from 'lucide-react';
import { useToast } from '../ui/toastContext';
import { runWatchRules, type WatchRunSummary } from '../osiris/signals';
import { FEED_LAYER_IDS, type FeedLayerId } from '../osiris/types';
import { LAYER_META } from '../osiris/config';

/** Auto-run period while the tab is open (checkbox, off by default). */
const AUTO_RUN_MS = 5 * 60_000;

interface SignalsTabProps {
  onNavigate?: (tab: string) => void;
}

interface RuleForm {
  layer: FeedLayerId;
  minSeverity: string;
  keyword: string;
  radiusKm: string;
}

const EMPTY_FORM: RuleForm = { layer: 'earthquakes', minSeverity: '', keyword: '', radiusKm: '' };

const describeRule = (r: WatchRule): string => {
  const parts: string[] = [LAYER_META[r.layer].label];
  if (r.minSeverity !== undefined) parts.push(`severity >= ${r.minSeverity}`);
  if (r.keyword) parts.push(`keyword "${r.keyword}"`);
  if (r.withinIncidentRadiusKm !== undefined) parts.push(`within ${r.withinIncidentRadiusKm} km of an incident`);
  return parts.join(' | ');
};

/** Toast wording and tone for a finished run. */
const summarize = (s: WatchRunSummary): { tone: 'info' | 'success' | 'error'; message: string } => {
  if (s.error) return { tone: 'error', message: s.error };
  const failed = s.errors.length;
  if (failed > 0 && failed === s.layers) {
    return { tone: 'error', message: `All ${s.layers} feed(s) failed. First error: ${s.errors[0]?.error ?? 'unknown'}` };
  }
  const base = `${s.added} new signal(s), ${s.duplicates} already recorded, ${s.examined} feed items checked.`;
  if (failed > 0) return { tone: 'error', message: `${base} ${failed} feed(s) failed.` };
  return { tone: s.added > 0 ? 'success' : 'info', message: base };
};

export const SignalsTab: React.FC<SignalsTabProps> = ({ onNavigate }) => {
  // All hooks run before the no-case early return below.
  const toast = useToast();
  const activeCase = store.getActiveCase();
  const caseId = activeCase?.id ?? null;
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [lastRun, setLastRun] = useState<{ at: string; summary: WatchRunSummary } | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const runNow = useCallback(async (id: string, manual: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const summary = await runWatchRules(id);
      setLastRun({ at: new Date().toISOString(), summary });
      const { tone, message } = summarize(summary);
      // Auto runs stay quiet unless something was found or failed.
      if (manual || tone !== 'info' || summary.added > 0) toast.show(message, tone);
    } catch (err) {
      toast.show(`Watch run failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!autoRun || !caseId) return;
    const timer = window.setInterval(() => {
      const c = store.getCase(caseId);
      if (c?.watch_rules?.some(r => r.enabled)) void runNow(caseId, false);
    }, AUTO_RUN_MS);
    return () => window.clearInterval(timer);
  }, [autoRun, caseId, runNow]);

  if (!activeCase || caseId === null) {
    return (
      <div className="empty-state">
        <AlertCircle size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>Signals are tracked per case. Select or create a case to review its feeds.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  const signals = activeCase.signals || [];
  const selectedSignal = signals.find(s => s.id === selectedSignalId);
  const rules = activeCase.watch_rules ?? [];
  const hasEnabledRule = rules.some(r => r.enabled);

  const setField = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => {
    setForm(f => ({ ...f, [key]: value }));
  };

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    const minSeverity = form.minSeverity.trim() === '' ? undefined : Number(form.minSeverity);
    if (minSeverity !== undefined && !Number.isFinite(minSeverity)) {
      setFormError('Minimum severity must be a number.');
      return;
    }
    const radius = form.radiusKm.trim() === '' ? undefined : Number(form.radiusKm);
    if (radius !== undefined && !(radius > 0 && radius <= MAX_RADIUS_KM)) {
      setFormError(`Radius must be between 1 and ${MAX_RADIUS_KM} km.`);
      return;
    }
    const result = store.addWatchRule(caseId, {
      layer: form.layer,
      minSeverity,
      keyword: form.keyword.trim() || undefined,
      withinIncidentRadiusKm: radius,
    });
    if (!result.success) {
      setFormError(result.msg);
      return;
    }
    setFormError(null);
    setForm(f => ({ ...EMPTY_FORM, layer: f.layer }));
    toast.show('Watch rule added.', 'success');
  };

  const handleToggleRule = (ruleId: string) => {
    const result = store.toggleWatchRule(caseId, ruleId);
    if (!result.success) toast.show(result.msg, 'error');
  };

  const handleRemoveRule = (ruleId: string) => {
    const result = store.removeWatchRule(caseId, ruleId);
    if (!result.success) toast.show(result.msg, 'error');
  };

  const handleStatusChange = (id: string, status: SignalStatus) => {
    store.updateSignalStatus(caseId, id, status);
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'CRITICAL': return <ShieldAlert size={16} aria-hidden="true" />;
      case 'HIGH': return <AlertTriangle size={16} aria-hidden="true" />;
      case 'MEDIUM': return <AlertCircle size={16} aria-hidden="true" />;
      case 'LOW': return <Clock size={16} aria-hidden="true" />;
      default: return <AlertCircle size={16} aria-hidden="true" />;
    }
  };

  return (
    <div className="signals-tab-container">
      {/* Left List */}
      <div className="premium-panel signals-list-panel">
        <div className="premium-panel-header">
          <h3 className="premium-panel-title">Signal Intelligence Feeds</h3>
        </div>

        {/* Watch rules: run, auto-run, rule list, add form */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runNow(caseId, true)}
            disabled={running || !hasEnabledRule}
            aria-busy={running}
            title={hasEnabledRule ? undefined : 'Add and enable a watch rule first'}
          >
            <Play size={14} aria-hidden="true" /> {running ? 'Running...' : 'Run now'}
          </button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)} />
            Auto-run every 5 min while this tab is open
          </label>
        </div>

        {lastRun && (
          <div className="signal-body-text" style={{ marginBottom: 12 }}>
            <p>
              Last run {new Date(lastRun.at).toLocaleTimeString()}: {lastRun.summary.rules} rule(s) on {lastRun.summary.layers} layer(s),
              {' '}{lastRun.summary.examined} items checked, {lastRun.summary.matched} matched, {lastRun.summary.added} new.
            </p>
            {lastRun.summary.errors.length > 0 && (
              <ul role="alert" className="text-danger">
                {lastRun.summary.errors.map(e => (
                  <li key={e.layer}>{LAYER_META[e.layer].label} feed failed: {e.error}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <details open style={{ marginBottom: 16 }}>
          <summary className="signal-section-title">Watch rules ({rules.length}/{MAX_WATCH_RULES})</summary>
          {rules.length === 0 ? (
            <p className="signal-body-text">No rules yet. A rule raises a signal when a live feed item matches it.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0', display: 'grid', gap: 6 }}>
              {rules.map(r => (
                <li key={r.id} style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ opacity: r.enabled ? 1 : 0.5 }}>{describeRule(r)}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className={`premium-button ${r.enabled ? 'primary' : ''}`}
                      aria-pressed={r.enabled}
                      onClick={() => handleToggleRule(r.id)}
                    >
                      {r.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      type="button"
                      className="premium-button"
                      aria-label={`Remove rule: ${describeRule(r)}`}
                      onClick={() => handleRemoveRule(r.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={handleAddRule} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="watch-layer">Feed layer</label>
              <select
                id="watch-layer"
                className="form-select"
                value={form.layer}
                onChange={e => setField('layer', e.target.value as FeedLayerId)}
              >
                {FEED_LAYER_IDS.map(id => (
                  <option key={id} value={id}>{LAYER_META[id].label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="watch-min-severity">Min severity (optional)</label>
              <input
                id="watch-min-severity"
                className="premium-input"
                type="number"
                step="any"
                placeholder="Any"
                value={form.minSeverity}
                onChange={e => setField('minSeverity', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="watch-keyword">Keyword (optional)</label>
              <input
                id="watch-keyword"
                className="premium-input"
                type="text"
                maxLength={60}
                placeholder="Matches title or an entity name"
                value={form.keyword}
                onChange={e => setField('keyword', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="watch-radius">Radius from incidents, km (optional)</label>
              <input
                id="watch-radius"
                className="premium-input"
                type="number"
                min={1}
                max={MAX_RADIUS_KM}
                placeholder="Any distance"
                value={form.radiusKm}
                onChange={e => setField('radiusKm', e.target.value)}
              />
              <span className="signal-body-text">Needs incidents with coordinates in this case.</span>
            </div>
            {formError && <p role="alert" className="text-danger">{formError}</p>}
            <div>
              <button type="submit" className="btn btn-primary" disabled={rules.length >= MAX_WATCH_RULES}>
                <Plus size={14} aria-hidden="true" /> Add rule
              </button>
            </div>
          </form>
        </details>

        {signals.length === 0 ? (
          <div className="explorer-cta">
            <h3>No signals in this case</h3>
            <p>Signals are raised when feeds match what you track. Add a watch rule and run it, or import records first.</p>
            <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('pipeline')}>
              <Upload size={14} aria-hidden="true" /> Open Data Pipeline
            </button>
          </div>
        ) : (
          <ul className="signal-list">
            {signals.map(s => {
              const selected = s.id === selectedSignalId;
              const highSeverity = s.severity === 'CRITICAL' || s.severity === 'HIGH';
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={`signal-item ${selected ? 'active' : ''}`}
                    onClick={() => setSelectedSignalId(s.id)}
                  >
                    <span className="signal-item-head">
                      <span className={`signal-severity ${highSeverity ? 'is-high' : 'is-medium'}`}>
                        {getSeverityIcon(s.severity)}
                        <span>{s.severity}</span>
                      </span>
                      <span className="signal-time">{new Date(s.created_at).toLocaleTimeString()}</span>
                    </span>
                    <span className="signal-title">{s.title}</span>
                    <span className={`signal-status ${s.status === 'NEW' ? 'is-new' : ''}`}>STATUS: {s.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Right Details */}
      <div className="signal-details">
        {!selectedSignal ? (
          <div className="signal-details-empty">
            {signals.length === 0 ? 'Nothing to assess yet.' : 'Select a signal to view its intelligence assessment.'}
          </div>
        ) : (
          <div className="signal-details-inner">
            <div>
              <h2 className="signal-details-title">{selectedSignal.title}</h2>
              <div className="signal-meta-row">
                <span className="signal-meta-chip">
                  Severity: <strong className={selectedSignal.severity === 'CRITICAL' || selectedSignal.severity === 'HIGH' ? 'text-danger' : 'text-warning'}>{selectedSignal.severity}</strong>
                </span>
                <span className="signal-meta-chip">
                  Status: <strong className={selectedSignal.status === 'NEW' ? 'text-accent' : undefined}>{selectedSignal.status}</strong>
                </span>
                <span className="signal-meta-chip">
                  Detected: <strong>{new Date(selectedSignal.created_at).toLocaleString()}</strong>
                </span>
              </div>
            </div>

            <div className="premium-panel signal-section">
              <h4 className="signal-section-title">Signal Description</h4>
              <p className="signal-body-text">{selectedSignal.description}</p>
            </div>

            <div className="signal-assessment">
              <h4 className="signal-assessment-title">
                <BrainCircuit size={16} aria-hidden="true" /> AI Assessment
              </h4>
              <p className="signal-body-text">{selectedSignal.ai_assessment}</p>
            </div>

            <div className="premium-panel signal-section">
              <h4 className="signal-section-title">Triage Actions</h4>
              <div className="signal-triage">
                {(['ACKNOWLEDGED', 'ESCALATED', 'DISMISSED'] as const).map(status => (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={selectedSignal.status === status}
                    className={`premium-button ${selectedSignal.status === status ? 'primary' : ''}`}
                    onClick={() => handleStatusChange(selectedSignal.id, status)}
                  >
                    Mark {status.toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
