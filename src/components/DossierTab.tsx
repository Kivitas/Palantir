import React, { useState } from 'react';
import { store } from '../store';
import { Printer, FileText, User as UserIcon } from 'lucide-react';
import { hasClearance } from '../types';

interface DossierTabProps {
  onNavigate?: (tab: string) => void;
}

export const DossierTab: React.FC<DossierTabProps> = ({ onNavigate }) => {
  const activeCase = store.getActiveCase();
  const [analystNotes, setAnalystNotes] = useState('This dossier contains data and intelligence entities resolved during tactical network sweeps. Classified markings apply to containment cells.');
  const [targetEntityId, setTargetEntityId] = useState<string>('');

  if (!activeCase) {
    return (
      <div className="empty-state">
        <FileText size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>Dossiers are compiled from one case. Select or create a case first.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  // Only objects the viewer may see are offered as targets or shown as connections.
  const viewer = store.getCurrentUserClearance();
  const visibleEntities = activeCase.entities.filter(e => hasClearance(viewer, e.clearance));
  const visibleIncidents = activeCase.incidents.filter(i => hasClearance(viewer, i.clearance));

  if (visibleEntities.length === 0) {
    return (
      <div className="empty-state">
        <FileText size={48} className="empty-icon" aria-hidden="true" />
        <h3>No entities to profile</h3>
        <p>A dossier targets one entity. Add entities in the Explorer or import them through the Pipeline.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('explorer')}>
          Open Explorer
        </button>
      </div>
    );
  }

  const handlePrint = () => {
    window.print();
  };

  const targetEntity = visibleEntities.find(e => e.id === targetEntityId);

  // 1-hop links
  const linkedRelationships = targetEntity
    ? activeCase.relationships.filter(r => (r.src === targetEntityId || r.dst === targetEntityId) && hasClearance(viewer, r.clearance))
    : [];
  
  // Connected nodes
  const connectedNodes: { type: string, name: string, confidence: number }[] = [];
  linkedRelationships.forEach(r => {
    const otherId = r.src === targetEntityId ? r.dst : r.src;
    const isIncident = visibleIncidents.find(i => i.id === otherId);
    const isEntity = visibleEntities.find(e => e.id === otherId);
    if (isIncident) {
      connectedNodes.push({ type: 'Incident', name: isIncident.title, confidence: r.confidence });
    } else if (isEntity) {
      connectedNodes.push({ type: isEntity.type, name: isEntity.name, confidence: r.confidence });
    }
  });

  return (
    <div id="DossierBuilder" className="dossier-builder-container">
      {/* Configuration Controls */}
      <div className="dossier-config-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="premium-panel">
          <div className="premium-panel-header">
            <h3 className="premium-panel-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <UserIcon size={16} aria-hidden="true" /> Target Selection
            </h3>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '1px' }}>Select Target Entity</label>
            <select
              className="premium-input"
              value={targetEntityId}
              onChange={(e) => setTargetEntityId(e.target.value)}
            >
              <option value="">-- Select Target --</option>
              {visibleEntities.map(e => (
                <option key={e.id} value={e.id}>{e.name} ({e.type})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
            <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '1px' }}>Executive Analyst Notes</label>
            <textarea
              className="premium-input"
              value={analystNotes}
              onChange={(e) => setAnalystNotes(e.target.value)}
              rows={4}
              placeholder="Enter analysis briefing context..."
              style={{ resize: 'vertical' }}
            />
          </div>

          <button type="button" className="premium-button primary" onClick={handlePrint} disabled={!targetEntity} style={{ marginTop: '16px' }}>
            <Printer size={14} aria-hidden="true" /> Print / Export PDF
          </button>
        </div>
      </div>

      {/* Dossier Document Preview Sheet */}
      <div id="DossierDocument" className="dossier-document-preview">
        {targetEntity ? (
          <>
            <div className="dossier-print-header">
              <div className="classification-banner">
                --- NATIONAL SECURITY VAULT // RESTRICTED ACCESS ---
              </div>
              <div className="title-section">
                <h1>TARGET DOSSIER</h1>
                <h2>TARGET: {targetEntity.name.toUpperCase()}</h2>
              </div>
              <div className="metadata-row">
                <div><strong>Vault ID:</strong> {targetEntity.id}</div>
                <div><strong>Type:</strong> {targetEntity.type}</div>
                <div><strong>Clearance Scope:</strong> {targetEntity.clearance}</div>
                <div><strong>Generated:</strong> {new Date().toLocaleString()}</div>
              </div>
            </div>

            <div className="dossier-divider" />

            <div className="dossier-section">
              <h3>I. Executive Assessment</h3>
              <p className="dossier-text">{analystNotes}</p>
            </div>

            <div className="dossier-section">
              <h3>II. Known Properties</h3>
              <table className="dossier-table">
                <tbody>
                  {Object.entries(targetEntity.properties).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ width: '30%', fontWeight: 'bold' }}>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                  {Object.keys(targetEntity.properties).length === 0 && (
                    <tr><td colSpan={2}>No properties on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="dossier-section">
              <h3>III. First-Degree Connections</h3>
              <table className="dossier-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name / Title</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {connectedNodes.map((n, idx) => (
                    <tr key={idx}>
                      <td>{n.type}</td>
                      <td><strong>{n.name}</strong></td>
                      <td>{Math.round(n.confidence * 100)}%</td>
                    </tr>
                  ))}
                  {connectedNodes.length === 0 && (
                    <tr><td colSpan={3}>No known connections.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="dossier-print-footer">
              <div className="classification-banner">
                --- END OF DOSSIER // TOP SECRET SHREDDING ENFORCED ---
              </div>
            </div>
          </>
        ) : (
          <div className="dossier-empty-state">
            <p>Select a Target Entity on the left to generate their dossier.</p>
          </div>
        )}
      </div>
    </div>
  );
};
