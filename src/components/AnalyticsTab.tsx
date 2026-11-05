import React, { useState } from 'react';
import { store } from '../store';
import { BarChart3, Filter, Plus, Trash2, ArrowDown, Database } from 'lucide-react';
import type { Entity, OntologyObjectType, OntologyProperty } from '../types';

type StepType = 'FILTER' | 'CHART';

interface PipelineStep {
  id: string;
  type: StepType;
  propertyId: string;
  filterValue: string;
}

interface ChartResult {
  stepId: string;
  data: { label: string; value: number }[];
  propName: string;
}

const NO_TYPES: OntologyObjectType[] = [];
const NO_PROPERTIES: OntologyProperty[] = [];
let stepSeq = 0;

interface AnalyticsTabProps {
  onNavigate?: (tab: string) => void;
}

export const AnalyticsTab: React.FC<AnalyticsTabProps> = ({ onNavigate }) => {
  const activeCase = store.getActiveCase();

  // All hooks run before the early return below (rules-of-hooks).
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [steps, setSteps] = useState<PipelineStep[]>([]);

  const ontologyTypes = activeCase?.ontology_types ?? NO_TYPES;
  const selectedType = ontologyTypes.find(t => t.id === selectedTypeId);
  const properties = selectedType?.properties ?? NO_PROPERTIES;

  // Pipeline execution. Plain function, not a memo: the store mutates the case in place.
  const runPipeline = (): { finalData: Entity[]; charts: ChartResult[] } => {
    if (!activeCase || !selectedType) return { finalData: [], charts: [] };

    let currentData = activeCase.entities.filter(e => e.type === selectedTypeId);
    const charts: ChartResult[] = [];

    for (const step of steps) {
      const prop = properties.find(p => p.id === step.propertyId);
      if (!prop) continue;

      if (step.type === 'FILTER' && step.filterValue) {
        currentData = currentData.filter(e => {
          const val = String(e.properties[prop.name] || '').toLowerCase();
          return val.includes(step.filterValue.toLowerCase());
        });
      } else if (step.type === 'CHART') {
        const counts: Record<string, number> = {};
        currentData.forEach(e => {
          const val = String(e.properties[prop.name] || 'Unknown');
          counts[val] = (counts[val] || 0) + 1;
        });
        const data = Object.entries(counts).map(([label, value]) => ({ label, value }));
        data.sort((a, b) => b.value - a.value);
        charts.push({ stepId: step.id, data, propName: prop.name });
      }
    }

    return { finalData: currentData, charts };
  };

  if (!activeCase) {
    return (
      <div className="empty-state">
        <BarChart3 size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>Analytics runs on the objects of one case. Select or create a case first.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  const executionResults = runPipeline();

  const addStep = (type: StepType) => {
    stepSeq += 1;
    setSteps([...steps, { id: `step-${stepSeq}`, type, propertyId: '', filterValue: '' }]);
  };

  const updateStep = (id: string, field: keyof PipelineStep, value: string) => {
    setSteps(steps.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const removeStep = (id: string) => {
    setSteps(steps.filter(s => s.id !== id));
  };

  return (
    <div className="analytics-tab-container" style={{ display: 'flex', height: '100%', gap: '16px' }}>
      
      {/* Left Configuration Sidebar */}
      <div className="analytics-sidebar" style={{ width: '320px', flexShrink: 0, borderRight: '1px solid var(--border-color)', paddingRight: '16px', display: 'flex', flexDirection: 'column', gap: '20px', overflowY: 'auto' }}>
        <h3 style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={16} color="var(--accent-cyan)" />
          Contour Pipeline
        </h3>

        <div className="premium-panel" style={{ padding: '16px' }}>
          <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>1. Base Dataset</label>
          <select 
            className="premium-input"
            value={selectedTypeId} 
            onChange={(e) => {
              setSelectedTypeId(e.target.value);
              setSteps([]); // Reset pipeline on dataset change
            }}
            style={{ width: '100%', padding: '8px', fontSize: '12px' }}
          >
            <option value="">-- Select Ontology --</option>
            {ontologyTypes.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {ontologyTypes.length === 0 && (
            <button type="button" className="btn btn-ghost btn-sm analytics-cta" onClick={() => onNavigate?.('ontology')}>
              <Database size={12} aria-hidden="true" /> Define an object type first
            </button>
          )}
          {selectedType && (
            <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)' }}>
              Rows entering pipeline: {activeCase.entities.filter(e => e.type === selectedTypeId).length}
            </div>
          )}
        </div>

        {selectedType && steps.map((step, idx) => (
          <React.Fragment key={step.id}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <ArrowDown size={16} color="var(--border-color)" />
            </div>
            
            <div className="premium-panel" style={{ backgroundColor: step.type === 'FILTER' ? 'rgba(41, 211, 194, 0.05)' : 'rgba(251, 146, 60, 0.05)', border: `1px solid ${step.type === 'FILTER' ? 'rgba(41, 211, 194, 0.2)' : 'rgba(251, 146, 60, 0.2)'}`, position: 'relative', padding: '16px' }}>
              <button 
                type="button" aria-label="Remove step" onClick={() => removeStep(step.id)}
                style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <Trash2 size={12} />
              </button>
              <label style={{ fontSize: '11px', fontWeight: 700, color: step.type === 'FILTER' ? 'var(--accent-cyan)' : 'var(--accent-orange)', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
                {idx + 2}. {step.type === 'FILTER' ? 'Filter Data' : 'Bar Chart'}
              </label>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <select 
                  className="premium-input"
                  value={step.propertyId} 
                  onChange={(e) => updateStep(step.id, 'propertyId', e.target.value)}
                  style={{ width: '100%', padding: '8px', fontSize: '12px' }}
                >
                  <option value="">-- Select Property --</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>

                {step.type === 'FILTER' && step.propertyId && (
                  <input
                    type="text"
                    className="premium-input"
                    placeholder="Contains value..."
                    value={step.filterValue}
                    onChange={(e) => updateStep(step.id, 'filterValue', e.target.value)}
                    style={{ width: '100%', padding: '8px', fontSize: '12px' }}
                  />
                )}
              </div>
            </div>
          </React.Fragment>
        ))}

        {selectedType && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <ArrowDown size={16} color="var(--border-color)" />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => addStep('FILTER')} style={{ flex: 1, padding: '8px', backgroundColor: 'var(--bg-secondary)', border: '1px dashed var(--border-color)', color: 'var(--text-primary)', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                <Plus size={12} /> Add Filter
              </button>
              <button type="button" onClick={() => addStep('CHART')} style={{ flex: 1, padding: '8px', backgroundColor: 'var(--bg-secondary)', border: '1px dashed var(--border-color)', color: 'var(--text-primary)', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                <BarChart3 size={12} /> Add Chart
              </button>
            </div>
          </>
        )}
      </div>

      {/* Right Visualization Area */}
      <div className="analytics-visualization" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
        
        {/* Top Summary */}
        <div className="premium-panel" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Pipeline Results
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Rows matching current filters: <strong style={{ color: 'var(--text-primary)' }}>{executionResults.finalData.length}</strong>
            </div>
          </div>
        </div>

        {/* Charts */}
        {executionResults.charts.map(chart => {
          const maxVal = chart.data.length > 0 ? Math.max(...chart.data.map(d => d.value)) : 0;
          return (
            <div key={chart.stepId} className="premium-panel" style={{ padding: '24px' }}>
              <div className="premium-panel-header">
                <h4 className="premium-panel-title">
                  Distribution by {chart.propName}
                </h4>
              </div>
              
              {chart.data.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: '12px', textAlign: 'center', padding: '20px' }}>No data matching pipeline.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {chart.data.map((d, i) => {
                    const percentage = (d.value / maxVal) * 100;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{ width: '140px', flexShrink: 0, textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {d.label}
                        </div>
                        <div style={{ flex: 1, height: '24px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
                          <div 
                            style={{ 
                              width: `${percentage}%`, 
                              backgroundColor: 'var(--accent-orange)', 
                              height: '100%',
                              transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
                            }} 
                          />
                        </div>
                        <div style={{ width: '40px', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {d.value}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {executionResults.charts.length === 0 && selectedType && (
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            Add a "Chart" step to the pipeline to visualize data.
          </div>
        )}

      </div>
    </div>
  );
};
