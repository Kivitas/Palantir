import React, { useState } from 'react';
import { store } from '../store';
import { Case, ClearanceLevel, Entity, Incident, hasClearance } from '../types';
import { Search, Filter, Trash2, Lock, Upload } from 'lucide-react';
import { useConfirm } from '../ui/confirmContext';
import { useToast } from '../ui/toastContext';
import { CANCELLED_SUMMARY, enrichWithConfirm } from '../osiris/enrich';

interface ExplorerTabProps {
  onNavigate?: (tab: string) => void;
}

interface ExplorerItem {
  id: string;
  name: string;
  category: 'Entity' | 'Incident';
  type: string;
  clearance: ClearanceLevel;
  created_at: string;
  properties: Record<string, string>;
  original: Entity | Incident;
}

const collectItems = (activeCase: Case | null): ExplorerItem[] => {
  const items: ExplorerItem[] = [];
  if (!activeCase) return items;

  activeCase.entities.forEach(e => {
    items.push({
      id: e.id,
      name: e.name,
      category: 'Entity',
      type: e.type,
      clearance: e.clearance,
      created_at: e.created_at,
      properties: e.properties,
      original: e
    });
  });

  activeCase.incidents.forEach(i => {
    items.push({
      id: i.id,
      name: i.title,
      category: 'Incident',
      type: `Incident`,
      clearance: i.clearance,
      created_at: i.created_at,
      properties: { Severity: i.severity },
      original: i
    });
  });

  return items;
};

export const ExplorerTab: React.FC<ExplorerTabProps> = ({ onNavigate }) => {
  const activeCase = store.getActiveCase();
  const confirm = useConfirm();
  const toast = useToast();

  // All hooks run before the early return below (rules-of-hooks).
  const [search, setSearch] = useState('');
  const [selectedOntologyFilter, setSelectedOntologyFilter] = useState<string | 'ALL'>('ALL');
  const [sanctionsBusyId, setSanctionsBusyId] = useState<string | null>(null);

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Filter size={48} className="empty-icon" aria-hidden="true" />
        <h3>Explorer locked</h3>
        <p>Select or create a case to browse its objects.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  // Plain derivations rather than memos: the store mutates the case in place, so a memo
  // keyed on the case object would go stale. App re-renders on every store change.
  const ontologyTypes = activeCase.ontology_types || [];
  const allItems = collectItems(activeCase);
  const incidentCount = allItems.filter(i => i.category === 'Incident').length;

  const query = search.toLowerCase();
  const filteredItems = allItems.filter(item => {
    const matchesSearch =
      item.name.toLowerCase().includes(query) ||
      item.type.toLowerCase().includes(query) ||
      Object.values(item.properties).some(v => String(v).toLowerCase().includes(query));

    const matchesType =
      selectedOntologyFilter === 'ALL' ||
      item.type === selectedOntologyFilter;

    return matchesSearch && matchesType;
  });

  // Limit to top 5 properties for dense view
  const dynamicColumns = Array.from(
    new Set(filteredItems.flatMap(item => Object.keys(item.properties)))
  ).slice(0, 5);

  const userClearance = store.getCurrentUserClearance();

  const handleSelect = (item: ExplorerItem) => {
    store.selectObject(item.category.toLowerCase(), item.id);
  };

  const handleSanctionsCheck = async (item: ExplorerItem) => {
    setSanctionsBusyId(item.id);
    const result = await enrichWithConfirm(item.original as Entity, 'sanctions', confirm);
    setSanctionsBusyId(null);
    if (result.ok) toast.show(`${item.name}: ${result.summary}`, 'success');
    else if (result.summary === CANCELLED_SUMMARY) toast.show('Sanctions check cancelled.', 'info');
    else toast.show(`Sanctions check failed: ${result.error ?? result.summary}`, 'error');
  };

  const handleDeleteItem = async (item: ExplorerItem) => {
    const ok = await confirm({
      title: `Delete ${item.category.toLowerCase()}`,
      message: `Delete ${item.category} "${item.name}" from case containment? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    store.deleteObject(activeCase.id, item.category.toLowerCase(), item.id);
    if (store.data.selected_object?.id === item.id) store.selectObject(item.category.toLowerCase(), null);
    toast.show(`${item.category} deleted.`, 'success');
  };

  const filterButton = (key: string, label: React.ReactNode, count: number, color?: string) => {
    const selected = selectedOntologyFilter === key;
    return (
      <button
        key={key}
        type="button"
        className="explorer-filter-btn"
        aria-pressed={selected}
        onClick={() => setSelectedOntologyFilter(key)}
        style={selected && color ? { color } : undefined}
      >
        <span>{label}</span>
        <span className="explorer-filter-count">{count}</span>
      </button>
    );
  };

  return (
    <div className="explorer-v2-container">

      {/* Filters: a column on desktop, stacked above the grid on narrow screens */}
      <div className="explorer-filters">
        <h3 className="explorer-filters-title">Object Views</h3>

        <div className="explorer-filter-list">
          {filterButton('ALL', 'All Objects', allItems.length)}
          {filterButton('Incident', 'Incidents', incidentCount, 'var(--accent-orange)')}

          <div className="explorer-filter-divider" aria-hidden="true" />
          <div className="explorer-filter-heading">Ontology Types</div>

          {ontologyTypes.length === 0 && (
            <p className="explorer-filter-hint">No object types yet. Define them in the Ontology tab.</p>
          )}
          {ontologyTypes.map(t => filterButton(t.id, t.name, allItems.filter(i => i.type === t.id).length, t.color))}
        </div>
      </div>

      {/* Right Grid */}
      <div className="explorer-grid">
        <div className="explorer-search">
          <Search size={14} color="var(--text-muted)" className="explorer-search-icon" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search objects"
            placeholder="Search across all properties..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="premium-input explorer-search-input"
          />
        </div>

        <div className="premium-panel explorer-table-wrap">
          {allItems.length === 0 ? (
            <div className="explorer-cta">
              <h3>This case has no objects yet</h3>
              <p>Import records through the Pipeline, or add incidents from the Map.</p>
              <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('pipeline')}>
                <Upload size={14} aria-hidden="true" /> Open Data Pipeline
              </button>
            </div>
          ) : (
            <table className="premium-table">
              <thead>
                <tr>
                  <th scope="col">Object ID</th>
                  <th scope="col">Title / Name</th>
                  <th scope="col">Type</th>
                  {dynamicColumns.map(col => (
                    <th scope="col" key={col}>{col}</th>
                  ))}
                  <th scope="col" className="cell-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(item => {
                  const isCleared = hasClearance(userClearance, item.clearance);

                  if (!isCleared) {
                    return (
                      <tr key={item.id} className="redacted-overlay-container">
                        <td colSpan={4 + dynamicColumns.length} style={{ padding: 0 }}>
                          <div style={{ position: 'relative' }}>
                            <div className="redacted-row" style={{ display: 'flex', padding: '8px 12px' }}>
                              <div style={{ flex: 1 }}>{item.id}</div>
                              <div style={{ flex: 1 }}>REDACTED</div>
                              <div style={{ flex: 1 }}>REDACTED</div>
                              <div style={{ flex: 1 }}>REDACTED</div>
                            </div>
                            <div className="redacted-lock">
                              <Lock size={14} aria-hidden="true" /> REDACTED // {item.clearance} CLEARANCE REQUIRED
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  const isSelected = store.data.selected_object?.id === item.id;
                  const ontologyRef = ontologyTypes.find(t => t.id === item.type);
                  const typeLabel = ontologyRef ? ontologyRef.name : item.type;
                  const typeColor = ontologyRef ? ontologyRef.color : 'var(--text-secondary)';
                  const actions = activeCase.action_types?.filter(a => a.target_ontology_id === item.type) ?? [];

                  return (
                    <tr key={item.id} className={isSelected ? 'is-selected' : undefined}>
                      <td className="cell-mono">
                        {item.id}
                        {item.clearance !== 'UNCLASSIFIED' && (
                          <span className="clearance-tag">{item.clearance}</span>
                        )}
                      </td>
                      <td className="cell-strong">
                        <button
                          type="button"
                          className="explorer-row-btn"
                          onClick={() => handleSelect(item)}
                          aria-label={`Open details for ${item.name}`}
                        >
                          {item.name}
                        </button>
                      </td>
                      <td style={{ color: typeColor, fontWeight: 600 }}>{typeLabel}</td>
                      {dynamicColumns.map(col => (
                        <td key={col} className="cell-secondary">
                          {item.properties[col] || '-'}
                        </td>
                      ))}
                      <td className="cell-right">
                        <div className="explorer-row-actions">
                          {actions.length > 0 && (
                            <select
                              aria-label={`Run action on ${item.name}`}
                              className="explorer-action-select"
                              defaultValue=""
                              onChange={(e) => {
                                const actionId = e.target.value;
                                if (!actionId) return;
                                store.executeAction(activeCase.id, actionId, item.id);
                                e.target.value = '';
                                toast.show('Action executed and logged.', 'success');
                              }}
                            >
                              <option value="">Actions...</option>
                              {actions.map(a => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                          )}
                          {item.category === 'Entity' && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={sanctionsBusyId !== null}
                              onClick={() => handleSanctionsCheck(item)}
                              aria-label={`Sanctions check for ${item.name} (external lookup)`}
                              title="Sanctions check: sends the name to external sources via Osiris"
                            >
                              {sanctionsBusyId === item.id ? 'Checking...' : 'Sanctions'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="explorer-delete-btn"
                            onClick={() => handleDeleteItem(item)}
                            aria-label={`Delete ${item.name}`}
                            title="Delete"
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={4 + dynamicColumns.length} className="explorer-empty-row">
                      No objects match this search.{' '}
                      {(search || selectedOntologyFilter !== 'ALL') && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setSearch('');
                            setSelectedOntologyFilter('ALL');
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
