import React, { useState, useEffect } from 'react';
import { store } from '../store';
import { SeverityLevel } from '../types';
import { Shield, Activity, BarChart2, BookOpen, Trash2, Edit3 } from 'lucide-react';
import { useConfirm } from '../ui/confirmContext';
import { useToast } from '../ui/toastContext';

export const CommandCenter: React.FC = () => {
  const confirm = useConfirm();
  const toast = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [caseName, setCaseName] = useState('');
  const [caseDesc, setCaseDesc] = useState('');
  const [caseSeverity, setCaseSeverity] = useState<SeverityLevel>('LOW');

  const activeCase = store.getActiveCase();
  const logs = store.data.logs.slice(0, 10); // Show recent 10 actions

  // Update form state when case changes
  useEffect(() => {
    if (activeCase) {
      setCaseName(activeCase.name);
      setCaseDesc(activeCase.description);
      setCaseSeverity(activeCase.severity_level);
    }
  }, [activeCase]);

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Shield size={48} className="empty-icon" />
        <h3>No Case Selected</h3>
        <p>Select a case from the sidebar or create a new case container to get started.</p>
        <button className="btn btn-primary" onClick={() => store.addCase('New Case', 'Case description', 'LOW')}>
          Create New Case
        </button>
      </div>
    );
  }

  // Count items
  const entityCount = activeCase.entities.length;
  const incidentCount = activeCase.incidents.length;
  const relationCount = activeCase.relationships.length;

  const countClearance = (lvl: string) => {
    let count = 0;
    activeCase.entities.forEach(e => { if (e.clearance === lvl) count++; });
    activeCase.incidents.forEach(i => { if (i.clearance === lvl) count++; });
    activeCase.relationships.forEach(r => { if (r.clearance === lvl) count++; });
    return count;
  };

  const unclassifiedCount = countClearance('UNCLASSIFIED');
  const secretCount = countClearance('SECRET');
  const topSecretCount = countClearance('TOP_SECRET');

  const handleUpdateCase = (e: React.FormEvent) => {
    e.preventDefault();
    activeCase.name = caseName;
    activeCase.description = caseDesc;
    activeCase.severity_level = caseSeverity;
    store.logAction('CASE_UPDATE', `Modified metadata of case: ${caseName}`);
    store.save();
    setIsEditing(false);
    toast.show('Case details saved.', 'success');
  };

  const handleDeleteCase = async () => {
    const ok = await confirm({
      title: 'Delete case',
      message: `Permanently delete case "${activeCase.name}" and everything in it? This cannot be undone.`,
      confirmLabel: 'Delete case',
      tone: 'danger',
    });
    if (!ok) return;
    store.deleteCase(activeCase.id);
    toast.show('Case deleted.', 'success');
  };

  return (
    <div className="command-center">
      {/* Top Header Card */}
      <div className="card">
        {isEditing ? (
          <form onSubmit={handleUpdateCase} className="form-group">
            <div className="form-group">
              <label className="form-label">Case Name</label>
              <input
                className="form-input"
                type="text"
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-textarea"
                value={caseDesc}
                onChange={(e) => setCaseDesc(e.target.value)}
                rows={3}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Severity Level</label>
              <select
                className="form-select"
                value={caseSeverity}
                onChange={(e) => setCaseSeverity(e.target.value as SeverityLevel)}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
            <div className="flex gap-sm">
              <button type="submit" className="btn btn-primary">Save Changes</button>
              <button type="button" className="btn btn-secondary" onClick={() => setIsEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="card-header">
            <div>
              <div className="flex items-center gap-sm mb-sm">
                <h3 className="card-title">{activeCase.name}</h3>
                <span className={`badge badge-${activeCase.severity_level.toLowerCase()}`}>
                  {activeCase.severity_level}
                </span>
              </div>
              <p className="text-secondary text-sm mb-sm">{activeCase.description || 'No description provided.'}</p>
              <div className="text-muted text-xs">Created on {new Date(activeCase.created_at).toLocaleString()}</div>
            </div>
            <div className="flex gap-sm">
              <button className="btn btn-ghost btn-sm" onClick={() => {
                setCaseName(activeCase.name);
                setCaseDesc(activeCase.description);
                setCaseSeverity(activeCase.severity_level);
                setIsEditing(true);
              }}>
                <Edit3 size={14} /> Edit
              </button>
              <button className="btn btn-danger btn-sm" onClick={handleDeleteCase}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Grid of stats */}
      <div className="stats-grid">
        {/* Left Side: Stats and charts */}
        <div className="flex flex-col gap-lg">
          {/* Metrics Panel */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title flex items-center gap-sm">
                <BarChart2 size={16} /> Executive Briefing Metrics
              </h3>
            </div>
            <div className="metrics-grid">
              <div className="metric-box">
                <span className="metric-value">{entityCount}</span>
                <span className="metric-label">Entities</span>
              </div>
              <div className="metric-box">
                <span className="metric-value">{incidentCount}</span>
                <span className="metric-label">Incidents</span>
              </div>
              <div className="metric-box">
                <span className="metric-value text-danger">{activeCase.incidents.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH').length}</span>
                <span className="metric-label">High/Critical Signals</span>
              </div>
              <div className="metric-box">
                <span className="metric-value">{relationCount}</span>
                <span className="metric-label">Relationships</span>
              </div>
            </div>
          </div>

          {/* Cell Level Clearance Panel */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title flex items-center gap-sm">
                <Shield size={16} /> Cell-Level Security Distribution
              </h3>
            </div>
            <div className="clearance-bars">
              <div className="clearance-item">
                <div className="clearance-header">
                  <span>Top Secret</span>
                  <span>{topSecretCount} cells</span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill bar-danger"
                    style={{ width: `${(topSecretCount / (entityCount + incidentCount + relationCount || 1)) * 100}%` }}
                  />
                </div>
              </div>
              <div className="clearance-item">
                <div className="clearance-header">
                  <span>Secret</span>
                  <span>{secretCount} cells</span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill bar-warning"
                    style={{ width: `${(secretCount / (entityCount + incidentCount + relationCount || 1)) * 100}%` }}
                  />
                </div>
              </div>
              <div className="clearance-item">
                <div className="clearance-header">
                  <span>Unclassified</span>
                  <span>{unclassifiedCount} cells</span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill bar-success"
                    style={{ width: `${(unclassifiedCount / (entityCount + incidentCount + relationCount || 1)) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* AI Intelligence Briefing */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title flex items-center gap-sm">
                <BookOpen size={16} /> Autonomous Graph Briefing
              </h3>
            </div>
            <div className="ai-briefing-body">
              {entityCount === 0 && incidentCount === 0 ? (
                <p className="text-muted text-sm">Add intelligence entities and mapped incidents to automatically compile intelligence briefings.</p>
              ) : (
                <div className="briefing-text">
                  <p className="text-secondary">
                    Operational Case <strong>{activeCase.name}</strong> consists of <strong>{entityCount} nodes</strong> and <strong>{relationCount} directional links</strong>. 
                    Graph traversal algorithms indicate localized clustering of entities.
                  </p>
                  {incidentCount > 0 && (
                    <p className="text-secondary">
                      Geospatial plotting identifies <strong>{incidentCount} active threat clusters</strong>. Mapped severity score ranges indicate peak criticality vectors. Review chronological timelines to track potential risk propagations.
                    </p>
                  )}
                  <div className="ai-badge-row">
                    <span className="badge badge-success">Sentinels Active</span>
                    <span className="badge badge-primary">Provenance Verified</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Activity Log / Audit Trail */}
        <div className="flex flex-col">
          <div className="card h-full">
            <div className="card-header">
              <h3 className="card-title flex items-center gap-sm">
                <Activity size={16} /> Container Audit Trail
              </h3>
            </div>
            <div className="activity-feed-list">
              {logs.length === 0 ? (
                <p className="text-muted text-sm">No activity recorded yet.</p>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="feed-item">
                    <div className="feed-dot" />
                    <div className="feed-content">
                      <div className="feed-header-row">
                        <span className="feed-action">{log.action}</span>
                        <span className="feed-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="feed-desc">{log.details}</p>
                      <span className="feed-user">by {log.username}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
