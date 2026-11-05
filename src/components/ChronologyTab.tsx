import React, { useState } from 'react';
import { store } from '../store';
import { Calendar, Clock, Info, RotateCcw, Map as MapIcon } from 'lucide-react';

interface ChronologyTabProps {
  onIncidentSelect: (id: string) => void;
  onNavigate?: (tab: string) => void;
}

export const ChronologyTab: React.FC<ChronologyTabProps> = ({ onIncidentSelect, onNavigate }) => {
  const activeCase = store.getActiveCase();
  const [scrubberVal, setScrubberVal] = useState(100);

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Calendar size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>The timeline shows the incidents of one case. Select or create a case to start tracking.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  // Get date range bounds
  const getTimelineBounds = () => {
    if (activeCase.incidents.length === 0) {
      return { min: Date.now() - 86400000 * 30, max: Date.now() };
    }
    const times = activeCase.incidents.map(i => new Date(i.date + 'T' + (i.clock || '00:00:00')).getTime()).sort((a,b) => a-b);
    const min = times[0];
    const max = times[times.length - 1];
    if (!min || !max || min === max) {
      const defaultTime = Date.now();
      return { min: defaultTime - 86400000 * 7, max: defaultTime + 86400000 * 7 };
    }
    return { min, max };
  };

  const { min: minTime, max: maxTime } = getTimelineBounds();
  const activeCutoffTime = minTime + (maxTime - minTime) * (scrubberVal / 100);

  // Filter & Sort incidents by date & clock time
  const sortedIncidents = [...activeCase.incidents]
    .filter(inc => {
      const t = new Date(inc.date + 'T' + (inc.clock || '00:00:00')).getTime();
      return t <= activeCutoffTime;
    })
    .sort((a, b) => {
      const dtA = new Date(`${a.date}T${a.clock || '00:00:00'}`);
      const dtB = new Date(`${b.date}T${b.clock || '00:00:00'}`);
      return dtA.getTime() - dtB.getTime();
    });

  const getSeverityClass = (sev: string) => {
    return sev.toLowerCase();
  };

  const handleIncidentClick = (id: string) => {
    store.selectObject('incident', id);
    onIncidentSelect(id);
  };

  return (
    <div className="chronology-wrapper-panel">
      {/* Date filter scrubber header */}
      {activeCase.incidents.length > 0 && (
        <div className="premium-panel" style={{ padding: '16px', display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '24px' }}>
          <button
            type="button"
            className="premium-button"
            onClick={() => setScrubberVal(0)}
            style={{ padding: '8px' }}
            aria-label="Reset timeline filter"
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="range"
              aria-label="Timeline cutoff"
              min="0"
              max="100"
              value={scrubberVal}
              onChange={(e) => setScrubberVal(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Filter: Up to <strong style={{ color: 'var(--text-primary)' }}>{new Date(activeCutoffTime).toLocaleDateString()}</strong>
            </div>
          </div>
        </div>
      )}

      <div id="ChronologyCanvas" className="chronology-container">
        {sortedIncidents.length === 0 ? (
          <div className="empty-chronology">
            <Info size={32} className="muted-icon" aria-hidden="true" />
            {activeCase.incidents.length === 0 ? (
              <>
                <p>No incidents yet. Plot one on the Map to start a timeline.</p>
                <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('map')}>
                  <MapIcon size={14} aria-hidden="true" /> Open Map
                </button>
              </>
            ) : (
              <p>No incidents plotted up to this date limit.</p>
            )}
          </div>
        ) : (
          <div className="chronology-timeline">
            <div className="timeline-spine" />
            
            {sortedIncidents.map((inc, index) => (
              <div
                key={inc.id}
                className={`timeline-card-wrapper ${index % 2 === 0 ? 'left-align' : 'right-align'}`}
              >
                {/* Timeline Connector Dot */}
                <div className={`timeline-dot border-${getSeverityClass(inc.severity)}`} />

                {/* Incident card details */}
                <div className="premium-panel" style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '12px' }}>
                    <Calendar size={12} />
                    <span>{inc.date}</span>
                    <Clock size={12} style={{ marginLeft: '8px' }} />
                    <span>{inc.clock || '00:00'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--text-primary)', fontWeight: 700 }}>
                      <button
                        type="button"
                        className="timeline-title-btn"
                        onClick={() => handleIncidentClick(inc.id)}
                      >
                        {inc.title}
                      </button>
                    </h4>
                    <span className={`severity-badge ${getSeverityClass(inc.severity)}`}>
                      {inc.severity}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '16px' }}>{inc.description || 'No description provided.'}</p>
                  
                  {/* Lat/Lon coordinates */}
                  {(inc.lat || inc.lon) && (
                    <div style={{ fontSize: '10px', color: 'var(--accent-cyan)', fontFamily: 'monospace', marginBottom: '12px' }}>
                      <span>GPS: {parseFloat(inc.lat || '0').toFixed(5)}, {parseFloat(inc.lon || '0').toFixed(5)}</span>
                    </div>
                  )}
                  
                  {/* Security Badge */}
                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
                    <span className="clearance-pill">{inc.clearance}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
