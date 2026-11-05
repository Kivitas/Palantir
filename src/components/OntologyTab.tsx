import React, { useRef, useState } from 'react';
import { store } from '../store';
import { PropertyType } from '../types';
import { Database, Plus, Trash2, Settings2, Hash, Type, Calendar, ToggleLeft } from 'lucide-react';
import { useConfirm } from '../ui/confirmContext';
import { useToast } from '../ui/toastContext';

interface OntologyTabProps {
  onNavigate?: (tab: string) => void;
}

export const OntologyTab: React.FC<OntologyTabProps> = ({ onNavigate }) => {
  const activeCase = store.getActiveCase();
  const confirm = useConfirm();
  const toast = useToast();
  const typeInputRef = useRef<HTMLInputElement | null>(null);

  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeIcon] = useState('Database');
  const [newTypeColor] = useState('#00f0ff');

  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);

  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('string');

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Database size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>Object types belong to a case. Select or create one first.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  const ontologyTypes = activeCase.ontology_types || [];
  const selectedType = ontologyTypes.find(t => t.id === selectedTypeId);

  const handleAddType = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTypeName.trim()) return;
    store.addOntologyType(activeCase.id, newTypeName, newTypeIcon, newTypeColor);
    toast.show(`Object type "${newTypeName.trim()}" created.`, 'success');
    setNewTypeName('');
  };

  const handleAddProperty = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedType || !newPropName.trim()) return;
    store.addOntologyProperty(activeCase.id, selectedType.id, newPropName, newPropType);
    setNewPropName('');
  };

  const handleDeleteType = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Delete object type',
      message: `Delete the "${name}" type definition? Existing objects keep their data but lose schema context (their type label and property list).`,
      confirmLabel: 'Delete type',
      tone: 'danger',
    });
    if (!ok) return;
    store.deleteOntologyType(activeCase.id, id);
    if (selectedTypeId === id) setSelectedTypeId(null);
    toast.show('Object type deleted.', 'success');
  };

  const getPropIcon = (type: PropertyType) => {
    switch (type) {
      case 'string': return <Type size={14} aria-hidden="true" />;
      case 'number': return <Hash size={14} aria-hidden="true" />;
      case 'date': return <Calendar size={14} aria-hidden="true" />;
      case 'boolean': return <ToggleLeft size={14} aria-hidden="true" />;
      default: return <Database size={14} aria-hidden="true" />;
    }
  };

  const actionsForType = (typeId: string) =>
    (activeCase.action_types ?? []).filter(a => a.target_ontology_id === typeId);

  return (
    <div className="ontology-tab-container">
      {/* Left: Ontology Types List */}
      <div className="premium-panel ontology-types-panel">
        <div className="premium-panel-header">
          <h3 className="premium-panel-title ontology-panel-title">
            <Database size={16} color="var(--accent-cyan)" aria-hidden="true" />
            Schema Definitions
          </h3>
        </div>

        <form onSubmit={handleAddType} className="ontology-add-type">
          <input
            ref={typeInputRef}
            type="text"
            className="premium-input"
            aria-label="New object type name"
            placeholder="New object type..."
            value={newTypeName}
            onChange={e => setNewTypeName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="premium-button primary ontology-add-btn" aria-label="Add object type" disabled={!newTypeName.trim()}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </form>

        {ontologyTypes.length === 0 ? (
          <div className="explorer-cta">
            <h3>No object types yet</h3>
            <p>Types describe the kinds of things you track, such as people, vehicles or accounts.</p>
            <button type="button" className="btn btn-primary" onClick={() => typeInputRef.current?.focus()}>
              <Plus size={14} aria-hidden="true" /> Create your first type
            </button>
          </div>
        ) : (
          <ul className="ontology-type-list">
            {ontologyTypes.map(t => {
              const selected = selectedTypeId === t.id;
              return (
                <li key={t.id} className={`ontology-type-row ${selected ? 'is-selected' : ''}`}>
                  <button
                    type="button"
                    className="ontology-type-select"
                    aria-pressed={selected}
                    onClick={() => setSelectedTypeId(t.id)}
                  >
                    <span className="ontology-type-dot" style={{ backgroundColor: t.color }} aria-hidden="true" />
                    <span className="ontology-type-name">{t.name}</span>
                  </button>
                  <button
                    type="button"
                    className="ontology-type-delete"
                    aria-label={`Delete object type ${t.name}`}
                    title="Delete type"
                    onClick={() => handleDeleteType(t.id, t.name)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Right: Type Details & Properties */}
      <div className="ontology-details">
        {!selectedType ? (
          <div className="ontology-details-empty">
            {ontologyTypes.length === 0
              ? 'Create an object type to start defining its properties.'
              : 'Select an object type to configure its schema.'}
          </div>
        ) : (
          <div className="ontology-details-inner">
            <div className="ontology-details-heading">
              <div className="ontology-details-swatch" style={{ backgroundColor: selectedType.color }} aria-hidden="true" />
              <h2>{selectedType.name} Schema</h2>
            </div>

            <div className="premium-panel">
              <div className="premium-panel-header">
                <h4 className="premium-panel-title">
                  <Settings2 size={14} className="inline-icon" aria-hidden="true" />
                  Properties Map
                </h4>
              </div>

              <div className="table-scroll">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th scope="col">Property Name</th>
                      <th scope="col">Data Type</th>
                      <th scope="col">Prop ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedType.properties.map(p => (
                      <tr key={p.id}>
                        <td className="cell-strong">{p.name}</td>
                        <td>
                          <span className="type-chip">
                            {getPropIcon(p.type)} {p.type}
                          </span>
                        </td>
                        <td className="cell-mono cell-muted">{p.id}</td>
                      </tr>
                    ))}
                    {selectedType.properties.length === 0 && (
                      <tr>
                        <td colSpan={3} className="explorer-empty-row">No properties defined yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <form onSubmit={handleAddProperty} className="ontology-inline-form">
                <input
                  type="text"
                  className="premium-input"
                  aria-label="New property name"
                  placeholder="Property name (e.g. Passport Number)"
                  value={newPropName}
                  onChange={e => setNewPropName(e.target.value)}
                  style={{ flex: 2 }}
                />
                <select
                  className="premium-input"
                  aria-label="Property data type"
                  value={newPropType}
                  onChange={e => setNewPropType(e.target.value as PropertyType)}
                  style={{ flex: 1 }}
                >
                  <option value="string">String (Text)</option>
                  <option value="number">Number</option>
                  <option value="date">Date / Time</option>
                  <option value="boolean">Boolean (True/False)</option>
                </select>
                <button type="submit" className="premium-button" disabled={!newPropName.trim()}>Add property</button>
              </form>
            </div>

            {/* ACTION TYPES SECTION */}
            <div className="premium-panel">
              <div className="premium-panel-header">
                <h4 className="premium-panel-title">
                  <Settings2 size={14} className="inline-icon" aria-hidden="true" />
                  Action Types
                </h4>
              </div>

              <div className="table-scroll">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th scope="col">Action Name</th>
                      <th scope="col">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionsForType(selectedType.id).map(a => (
                      <tr key={a.id}>
                        <td className="cell-strong">{a.name}</td>
                        <td>{a.description}</td>
                      </tr>
                    ))}
                    {actionsForType(selectedType.id).length === 0 && (
                      <tr>
                        <td colSpan={2} className="explorer-empty-row">No actions defined.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <form
                className="ontology-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const fd = new FormData(form);
                  const name = String(fd.get('actionName') ?? '').trim();
                  const desc = String(fd.get('actionDesc') ?? '');
                  if (!name) return;
                  store.addActionType(activeCase.id, selectedType.id, name, desc);
                  toast.show(`Action "${name}" created.`, 'success');
                  form.reset();
                }}
              >
                <input
                  type="text"
                  name="actionName"
                  aria-label="New action name"
                  className="premium-input"
                  placeholder="Action name (e.g. Freeze Asset)"
                  style={{ flex: 1 }}
                />
                <input
                  type="text"
                  name="actionDesc"
                  aria-label="Action description"
                  className="premium-input"
                  placeholder="Description..."
                  style={{ flex: 2 }}
                />
                <button type="submit" className="premium-button">Create action</button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
