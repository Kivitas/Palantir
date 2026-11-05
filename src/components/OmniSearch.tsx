import React, { useState, useEffect, useRef } from 'react';
import { store } from '../store';
import { Search, Folder, User as UserIcon, AlertTriangle } from 'lucide-react';

interface OmniSearchProps {
  onClose: () => void;
  onNavigate: (tab: string, caseId?: string, objType?: string, objId?: string) => void;
}

export const OmniSearch: React.FC<OmniSearchProps> = ({ onClose, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Aggregate all search results
  const results: Array<{ id: string, title: string, type: string, caseId: string, icon: React.ReactNode, action: () => void }> = [];
  
  const q = query.toLowerCase();
  
  if (q.length > 0) {
    store.data.cases.forEach(c => {
      if (c.name.toLowerCase().includes(q)) {
        results.push({
          id: c.id,
          title: `Case: ${c.name}`,
          type: 'Case',
          caseId: c.id,
          icon: <Folder size={14} />,
          action: () => {
            store.selectCase(c.id);
            onNavigate('dashboard');
          }
        });
      }
      
      c.entities.forEach(e => {
        if (e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)) {
          results.push({
            id: e.id,
            title: `Entity: ${e.name}`,
            type: e.type,
            caseId: c.id,
            icon: <UserIcon size={14} />,
            action: () => {
              store.selectCase(c.id);
              store.selectObject('entity', e.id);
              onNavigate('explorer');
            }
          });
        }
      });

      c.incidents.forEach(i => {
        if (i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) {
          results.push({
            id: i.id,
            title: `Incident: ${i.title}`,
            type: 'Incident',
            caseId: c.id,
            icon: <AlertTriangle size={14} />,
            action: () => {
              store.selectCase(c.id);
              store.selectObject('incident', i.id);
              onNavigate('map');
            }
          });
        }
      });
    });
  }

  // Limit to top 15 results
  const topResults = results.slice(0, 15);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < topResults.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (topResults.length > 0 && topResults[selectedIndex]) {
        topResults[selectedIndex].action();
        onClose();
      }
    }
  };

  return (
    <div className="omni-search-backdrop" onClick={onClose}>
      <div className="omni-search-modal" role="dialog" aria-modal="true" aria-label="Search" onClick={e => e.stopPropagation()}>
        <div className="omni-search-input-wrapper">
          <Search size={18} className="omni-search-icon" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search cases, entities and incidents"
            placeholder="Search entities, cases, or incidents (Ctrl+K)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        {q.length > 0 && topResults.length === 0 && (
          <div className="omni-search-empty" role="status">No matches for this search.</div>
        )}
        {topResults.length > 0 && (
          <div className="omni-search-results" role="listbox" aria-label="Search results">
            {topResults.map((r, i) => (
              <div 
                key={r.id} 
                className={`omni-search-item ${i === selectedIndex ? 'selected' : ''}`}
                role="option"
                aria-selected={i === selectedIndex}
                tabIndex={-1}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => {
                  r.action();
                  onClose();
                }}
              >
                <div className="omni-item-icon">{r.icon}</div>
                <div className="omni-item-details">
                  <div className="omni-item-title">{r.title}</div>
                  <div className="omni-item-meta">{r.type}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
