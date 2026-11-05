import React, { useState } from 'react';
import { store } from '../store';
import { ShieldAlert, Download, Search } from 'lucide-react';
import { useToast } from '../ui/toastContext';

export const AuditTrailTab: React.FC = () => {
  const toast = useToast();
  const [filterQuery, setFilterQuery] = useState('');
  const logs = store.data.logs;

  const filteredLogs = logs.filter(l => 
    l.action.toLowerCase().includes(filterQuery.toLowerCase()) ||
    l.details.toLowerCase().includes(filterQuery.toLowerCase()) ||
    l.username.toLowerCase().includes(filterQuery.toLowerCase())
  );

  const handleExportLogs = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', 'aegis_nexus_audit_logs.json');
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    toast.show(`Exported ${logs.length} audit entries.`, 'success');
  };

  return (
    <div id="AuditTrailPanel" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '16px', padding: '16px' }}>
      <div className="premium-panel" style={{ flexDirection: 'row', justifyContent: 'space-between', padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', position: 'relative', width: '400px' }}>
          <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '12px' }} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search audit trail"
            className="premium-input"
            style={{ width: '100%', paddingLeft: '36px' }}
            placeholder="Search audit trail by user, action, or details..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
        <button type="button" className="premium-button" onClick={handleExportLogs}>
          <Download size={14} aria-hidden="true" /> Export Logs
        </button>
      </div>

      <div className="premium-panel" style={{ flex: 1, padding: 0, overflow: 'auto' }}>
        {filteredLogs.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: '16px' }}>
            <ShieldAlert size={32} aria-hidden="true" />
            <p>{logs.length === 0 ? 'No activity recorded yet. Actions you take will appear here.' : 'No matching action records in the containment log.'}</p>
          </div>
        ) : (
          <table className="premium-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Timestamp</th>
                <th scope="col">User</th>
                <th scope="col">Action</th>
                <th scope="col">Log Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr key={log.id}>
                  <td style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{log.id}</td>
                  <td>{new Date(log.timestamp).toLocaleString()}</td>
                  <td style={{ fontWeight: 600 }}>{log.username}</td>
                  <td>
                    <span style={{ fontSize: '10px', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-active)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontWeight: 700 }}>
                      {log.action}
                    </span>
                  </td>
                  <td>{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
