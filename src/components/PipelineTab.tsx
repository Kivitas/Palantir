import React, { useState } from 'react';
import { store } from '../store';
import { Database, Play, FileText, CheckCircle2 } from 'lucide-react';
import { ClearanceLevel } from '../types';

type Row = Record<string, unknown>;

const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

const parsesAsJson = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

/** Splits one CSV line, honouring double-quoted fields and "" escapes. */
const splitCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
};

/**
 * Turns the raw payload into rows. Modes, in order:
 * - CSV: no line parses as JSON, and the first two lines both contain commas. Line 1 is the header.
 * - JSONL / text: each line is a JSON object when it parses, otherwise a raw text record.
 */
const parseIngest = (raw: string): Row[] => {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  const anyJson = lines.some(parsesAsJson);
  if (!anyJson && lines.length >= 2 && lines[0]!.includes(',') && lines[1]!.includes(',')) {
    const header = splitCsvLine(lines[0]!).map((h, i) => h || `column_${i + 1}`);
    return lines.slice(1).map((line, i) => {
      const cells = splitCsvLine(line);
      const row: Row = {};
      header.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
      const name = row.name || row.title || row.id || cells[0] || `Row_${i + 1}`;
      return { ...row, name: String(name) };
    });
  }

  return lines.map((line, idx) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      const name = parsed.name || parsed.title || parsed.id || line.substring(0, 40);
      return { ...parsed, name: String(name) };
    }
    const firstCell = line.split(',')[0]?.trim();
    return { name: firstCell || `Parsed_Entity_${idx + 1}`, raw_data: line };
  });
};

export const PipelineTab: React.FC = () => {
  const activeCase = store.getActiveCase();

  const [rawData, setRawData] = useState('');
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [clearance, setClearance] = useState<ClearanceLevel>('UNCLASSIFIED');
  const [status, setStatus] = useState<{ type: 'idle' | 'success' | 'error', msg: string }>({ type: 'idle', msg: '' });

  if (!activeCase) {
    return <div className="tab-empty-state">No active case container selected.</div>;
  }

  const ontologyTypes = activeCase.ontology_types || [];

  const handleIngest = () => {
    if (!rawData.trim()) {
      setStatus({ type: 'error', msg: 'No raw data provided.' });
      return;
    }
    const objType = ontologyTypes.find(t => t.id === selectedTypeId);
    if (!objType) {
      setStatus({ type: 'error', msg: 'Please select a target ontology type.' });
      return;
    }

    try {
      const items = parseIngest(rawData);
      const result = store.bulkAddEntities(activeCase.id, objType.id, items, clearance);
      if (result.added === 0) {
        setStatus({ type: 'error', msg: `Ingestion added 0 entities. ${result.error ?? ''}`.trim() });
        return;
      }
      setStatus({
        type: 'success',
        msg: `Ingested ${result.added} entities into ${objType.name} at ${clearance.replace('_', ' ')} classification.`
      });
      setRawData('');
    } catch (err: unknown) {
      setStatus({ type: 'error', msg: 'Ingestion failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
  };

  return (
    <div style={{ padding: '24px', height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '1000px', margin: '0 auto' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Database size={24} color="var(--accent-blue)" />
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>Data Ingest Pipeline</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Map raw semi-structured data to the ontology and bulk-insert into the active containment.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '24px' }}>
        {/* Left: Input */}
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FileText size={14} /> Raw Data Payload
          </label>
          <textarea
            className="premium-input"
            placeholder={'Paste JSONL (one JSON object per line), CSV (first line = header), or one raw record per line...'}
            value={rawData}
            onChange={e => setRawData(e.target.value)}
            style={{
              width: '100%',
              height: '300px',
              fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Right: Configuration */}
        <div className="premium-panel" style={{ flex: 1, gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Target Ontology Type</label>
            <select
              className="premium-input"
              value={selectedTypeId}
              onChange={e => setSelectedTypeId(e.target.value)}
            >
              <option value="">-- Select Type --</option>
              {ontologyTypes.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Classification Level</label>
            <select
              className="premium-input"
              value={clearance}
              onChange={e => setClearance(e.target.value as ClearanceLevel)}
            >
              <option value="UNCLASSIFIED">Unclassified</option>
              <option value="SECRET">Secret</option>
              <option value="TOP_SECRET">Top Secret</option>
            </select>
          </div>

          <div style={{ marginTop: 'auto' }}>
            {status.type !== 'idle' && (
              <div role="status" style={{
                marginBottom: '16px',
                padding: '12px',
                borderRadius: '4px',
                backgroundColor: status.type === 'success' ? 'rgba(0, 255, 128, 0.1)' : 'rgba(255, 0, 85, 0.1)',
                border: `1px solid ${status.type === 'success' ? 'rgba(0, 255, 128, 0.3)' : 'rgba(255, 0, 85, 0.3)'}`,
                color: status.type === 'success' ? '#00ff80' : '#ff0055',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                {status.type === 'success' && <CheckCircle2 size={16} />}
                {status.msg}
              </div>
            )}

            <button
              className="premium-button primary"
              onClick={handleIngest}
              style={{
                width: '100%',
                padding: '12px',
                justifyContent: 'center',
                fontSize: '13px'
              }}
            >
              <Play size={16} fill="currentColor" />
              RUN PIPELINE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
