import { useEffect, useState } from 'react';
import { store } from '../store';
import { hasClearance, type ClearanceLevel, type Case, type Entity } from '../types';
import { Trash2, X, Lock } from 'lucide-react';
import { useConfirm } from './confirmContext';
import { useToast } from './toastContext';
import {
  CANCELLED_SUMMARY,
  ENRICH_KINDS,
  ENRICH_LABELS,
  enrichWithConfirm,
  type EnrichKind,
  type EnrichResult,
} from '../osiris/enrich';

type Row = { label: string; value: string };

/** Human label for an id in the active case (entity or incident name). */
function nameFor(c: Case, id: string): string {
  return c.entities.find(e => e.id === id)?.name ?? c.incidents.find(i => i.id === id)?.title ?? id;
}

/**
 * Right-hand panel showing the object selected anywhere in the app (store.data.selected_object).
 * Mounted once in App. Closing clears the selection; delete asks for confirmation first.
 */
export function DetailDrawer() {
  const confirm = useConfirm();
  const toast = useToast();

  const sel = store.data.selected_object;
  const activeCase = store.getActiveCase();

  // Escape closes the drawer unless another modal (confirm dialog, omni search) is open.
  useEffect(() => {
    if (!sel) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.confirm-backdrop, .omni-search-backdrop')) return;
      store.selectObject(sel.type, null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sel]);

  if (!sel || !activeCase) return null;

  const viewer = store.getCurrentUserClearance();
  const ontology = activeCase.ontology_types ?? [];

  let kind = '';
  let title = '';
  let clearance: ClearanceLevel = 'UNCLASSIFIED';
  let rows: Row[] = [];
  let properties: Row[] = [];
  let links: Row[] = [];
  let enrichTarget: Entity | null = null;

  if (sel.type === 'entity') {
    const e = activeCase.entities.find(x => x.id === sel.id);
    if (!e) return null;
    enrichTarget = e;
    kind = ontology.find(t => t.id === e.type)?.name ?? e.type;
    title = e.name;
    clearance = e.clearance;
    rows = [
      { label: 'Object ID', value: e.id },
      { label: 'Created', value: new Date(e.created_at).toLocaleString() },
    ];
    properties = Object.entries(e.properties).map(([label, value]) => ({ label, value: String(value) }));
    links = activeCase.relationships
      .filter(r => r.src === e.id || r.dst === e.id)
      .map(r => {
        const other = r.src === e.id ? r.dst : r.src;
        return { label: r.type, value: nameFor(activeCase, other) };
      });
  } else if (sel.type === 'incident') {
    const i = activeCase.incidents.find(x => x.id === sel.id);
    if (!i) return null;
    kind = 'Incident';
    title = i.title;
    clearance = i.clearance;
    rows = [
      { label: 'Object ID', value: i.id },
      { label: 'Severity', value: i.severity },
      { label: 'Date', value: i.date || '-' },
      { label: 'Time', value: i.clock || '-' },
      { label: 'Location', value: i.lat && i.lon ? `${i.lat}, ${i.lon}` : '-' },
      { label: 'Created', value: new Date(i.created_at).toLocaleString() },
    ];
    properties = i.description ? [{ label: 'Description', value: i.description }] : [];
    links = activeCase.relationships
      .filter(r => r.src === i.id || r.dst === i.id)
      .map(r => {
        const other = r.src === i.id ? r.dst : r.src;
        return { label: r.type, value: nameFor(activeCase, other) };
      });
  } else if (sel.type === 'relationship') {
    const r = activeCase.relationships.find(x => x.id === sel.id);
    if (!r) return null;
    kind = 'Relationship';
    title = r.type;
    clearance = r.clearance;
    rows = [
      { label: 'From', value: nameFor(activeCase, r.src) },
      { label: 'To', value: nameFor(activeCase, r.dst) },
      { label: 'Confidence', value: `${Math.round(r.confidence * 100)}%` },
      { label: 'Created', value: new Date(r.created_at).toLocaleString() },
    ];
    properties = r.rationale ? [{ label: 'Rationale', value: r.rationale }] : [];
  } else {
    return null;
  }

  const cleared = hasClearance(viewer, clearance);
  const deletable = cleared && (sel.type === 'entity' || sel.type === 'incident');

  const close = () => store.selectObject(sel.type, null);

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete ${kind.toLowerCase()}`,
      message: `Delete "${title}" from case "${activeCase.name}"? Its relationships will also be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    store.deleteObject(activeCase.id, sel.type, sel.id);
    store.selectObject(sel.type, null);
    toast.show(`${kind} deleted.`, 'success');
  };

  return (
    <aside className="detail-drawer" aria-labelledby="detail-drawer-title">
      <header className="detail-drawer-header">
        <div className="detail-drawer-heading">
          <span className="detail-kind">{kind}</span>
          <h2 id="detail-drawer-title" className="detail-title">{cleared ? title : 'Redacted'}</h2>
          <span className={`badge ${clearance === 'UNCLASSIFIED' ? 'badge-success' : 'badge-warning'}`}>{clearance}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm detail-close" aria-label="Close details" onClick={close}>
          <X size={16} />
        </button>
      </header>

      {cleared ? (
        <div className="detail-body">
          <dl className="detail-fields">
            {rows.map(row => (
              <div key={row.label} className="detail-field">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          {properties.length > 0 && (
            <section className="detail-section" aria-label="Properties">
              <h3>Properties</h3>
              <dl className="detail-fields">
                {properties.map(p => (
                  <div key={p.label} className="detail-field">
                    <dt>{p.label}</dt>
                    <dd>{p.value || '-'}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {links.length > 0 && (
            <section className="detail-section" aria-label="Linked objects">
              <h3>Linked objects ({links.length})</h3>
              <ul className="detail-links">
                {links.map((l, idx) => (
                  <li key={`${l.label}-${idx}`}>
                    <span className="detail-link-type">{l.label}</span> {l.value}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {enrichTarget && <EnrichSection key={enrichTarget.id} entity={enrichTarget} />}
        </div>
      ) : (
        <div className="detail-body detail-redacted">
          <Lock size={16} /> Requires {clearance} clearance to view this object.
        </div>
      )}

      {deletable && (
        <footer className="detail-drawer-footer">
          <button type="button" className="btn btn-danger btn-sm" onClick={handleDelete}>
            <Trash2 size={14} /> Delete {kind.toLowerCase()}
          </button>
        </footer>
      )}
    </aside>
  );
}

/** Enrichment buttons for one entity. Lookups are external requests; the note below says so. */
function EnrichSection({ entity }: { entity: Entity }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<EnrichKind | null>(null);
  const [outcome, setOutcome] = useState<{ kind: EnrichKind; result: EnrichResult } | null>(null);

  const run = async (kind: EnrichKind) => {
    setBusy(kind);
    setOutcome(null);
    const result = await enrichWithConfirm(entity, kind, confirm);
    setBusy(null);
    setOutcome({ kind, result });
    if (result.ok) {
      toast.show(`${ENRICH_LABELS[kind]}: ${result.summary}`, 'success');
    } else if (result.summary === CANCELLED_SUMMARY) {
      toast.show(`${ENRICH_LABELS[kind]} cancelled.`, 'info');
    } else {
      toast.show(`${ENRICH_LABELS[kind]} failed: ${result.error ?? result.summary}`, 'error');
    }
  };

  return (
    <section className="detail-section" aria-label="Enrich">
      <h3>Enrich</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        External lookups: the entity name or identifier is sent to third-party sources through Osiris. Successful results are saved to this object's properties.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ENRICH_KINDS.map(k => (
          <button
            key={k}
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            aria-busy={busy === k}
            onClick={() => run(k)}
          >
            {busy === k ? 'Looking up...' : ENRICH_LABELS[k]}
          </button>
        ))}
      </div>
      <div role="status" aria-live="polite" style={{ marginTop: 8, fontSize: 13 }}>
        {busy && <span>Running {ENRICH_LABELS[busy]}...</span>}
        {!busy && outcome && (
          outcome.result.ok ? (
            <span>{ENRICH_LABELS[outcome.kind]}: {outcome.result.summary}</span>
          ) : (
            <span style={{ color: outcome.result.summary === CANCELLED_SUMMARY ? 'var(--text-muted)' : 'var(--accent-red)' }}>
              {outcome.result.error ?? outcome.result.summary}
            </span>
          )
        )}
      </div>
      {!busy && outcome?.result.ok && outcome.result.data !== undefined && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>Raw response</summary>
          <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {clipText(JSON.stringify(outcome.result.data, null, 2) ?? String(outcome.result.data), 4000)}
          </pre>
        </details>
      )}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
        Sanctions data: <a href="https://www.opensanctions.org" target="_blank" rel="noopener noreferrer">OpenSanctions</a> (CC BY 4.0)
      </p>
    </section>
  );
}

function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}
