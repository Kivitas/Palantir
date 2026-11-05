import React, { useEffect, useRef, useState } from 'react';
import { store } from '../store';
import { Entity, Incident, Relationship } from '../types';
import { ZoomIn, ZoomOut, Maximize2, Compass, GitMerge, Sliders, Filter, Upload } from 'lucide-react';
import { useToast } from '../ui/toastContext';

interface GraphTabProps {
  onNodeSelect: (type: 'entity' | 'incident' | null, id: string | null) => void;
  onNavigate?: (tab: string) => void;
}

interface GraphNode {
  id: string;
  type: string; // 'incident' or ontology type id
  category: 'entity' | 'incident';
  label: string;
  subLabel: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
  radius: number;
  color: string;
  clearance: string;
  original: Entity | Incident;
}

interface GraphLink {
  id: string;
  type: string;
  source: string;
  target: string;
  confidence: number;
  color: string;
  original: Relationship;
}

type LayoutType = 'force' | 'hierarchical';

const CANVAS_W = 800;
const CANVAS_H = 480;
const GRAVITY = 0.015;
const SPRING_K = 0.06;
const NO_PATH: string[] = [];

// Map clearance to color
const getClearanceColor = (lvl: string) => {
  if (lvl === 'TOP_SECRET') return '#ef5f63';
  if (lvl === 'SECRET') return '#fb923c';
  return '#29d3c2';
};

const hitTest = (nodes: GraphNode[], x: number, y: number): GraphNode | undefined =>
  nodes.find(n => Math.hypot(n.x - x, n.y - y) < n.radius);

export const GraphTab: React.FC<GraphTabProps> = ({ onNodeSelect, onNavigate }) => {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Simulation state lives in refs: the physics loop mutates node objects every frame, so
  // React state only holds snapshots for drawing. Refs are exempt from effect dependency lists.
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const panOrigin = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);

  const activeCase = store.getActiveCase();
  // The store mutates the case in place, so object identity does not change when entities are
  // added or removed. This key changes whenever the graph's membership changes.
  const graphKey = activeCase
    ? [
        activeCase.id,
        activeCase.entities.length,
        activeCase.incidents.length,
        activeCase.relationships.length,
        activeCase.ontology_types.length,
      ].join('|')
    : '';

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);

  // Physics controls
  const [layout, setLayout] = useState<LayoutType>('force');
  const [repulsion, setRepulsion] = useState(1200);
  const [linkDistance, setLinkDistance] = useState(140);

  // Node visibility: types listed here are hidden. Everything else is shown.
  const [hiddenTypes, setHiddenTypes] = useState<Record<string, boolean>>({});

  // Pathfinder
  const [pathSource, setPathSource] = useState('');
  const [pathTarget, setPathTarget] = useState('');
  const activePathNodeIds = store.data.active_path.length > 0 ? store.data.active_path : NO_PATH;

  // Selection is global (store), so the graph highlights whatever the drawer shows.
  const selectedId = store.data.selected_object?.id ?? null;

  // 1. Build nodes and links from case data whenever the case or its visibility changes.
  useEffect(() => {
    if (!activeCase) {
      nodesRef.current = [];
      linksRef.current = [];
      setNodes([]);
      setLinks([]);
      return;
    }

    const graphNodes: GraphNode[] = [];

    activeCase.entities.forEach((e) => {
      if (hiddenTypes[e.type]) return;
      const typeRef = activeCase.ontology_types.find(t => t.id === e.type);
      graphNodes.push({
        id: e.id,
        category: 'entity',
        type: e.type,
        label: e.name,
        subLabel: typeRef ? typeRef.name : e.type,
        x: CANVAS_W / 2 + (Math.random() - 0.5) * 300,
        y: CANVAS_H / 2 + (Math.random() - 0.5) * 300,
        vx: 0,
        vy: 0,
        radius: 24,
        color: typeRef ? typeRef.color : getClearanceColor(e.clearance),
        clearance: e.clearance,
        original: e,
      });
    });

    if (!hiddenTypes['incident']) {
      activeCase.incidents.forEach((i) => {
        graphNodes.push({
          id: i.id,
          category: 'incident',
          type: 'incident',
          label: i.title,
          subLabel: `Incident (${i.severity})`,
          x: CANVAS_W / 2 + (Math.random() - 0.5) * 300,
          y: CANVAS_H / 2 + (Math.random() - 0.5) * 300,
          vx: 0,
          vy: 0,
          radius: 20,
          color: i.severity === 'CRITICAL' ? '#ef5f63' : getClearanceColor(i.clearance),
          clearance: i.clearance,
          original: i,
        });
      });
    }

    // Only links whose two ends are both visible are drawn.
    const visibleIds = new Set(graphNodes.map(n => n.id));
    const graphLinks: GraphLink[] = activeCase.relationships
      .filter(r => visibleIds.has(r.src) && visibleIds.has(r.dst))
      .map(r => ({
        id: r.id,
        type: r.type,
        source: r.src,
        target: r.dst,
        confidence: r.confidence,
        color: store.data.settings.theme === 'dark' ? '#1f2937' : '#cbd5e1',
        original: r,
      }));

    nodesRef.current = graphNodes;
    linksRef.current = graphLinks;
    setNodes(graphNodes);
    setLinks(graphLinks);
  }, [activeCase, graphKey, hiddenTypes]);

  // 2. Physics loop. Reads the refs each frame, so it only restarts when its parameters change.
  useEffect(() => {
    let animFrame = 0;

    const tick = () => {
      const currentNodes = nodesRef.current;
      const currentLinks = linksRef.current;

      if (currentNodes.length > 0) {
        if (layout === 'hierarchical') {
          // Hierarchical logic: arrange nodes by layer
          const nodeLevels: Record<string, number> = {};
          currentNodes.forEach(n => { nodeLevels[n.id] = 0; });

          let changed = true;
          let iter = 0;
          while (changed && iter < 10) {
            changed = false;
            currentLinks.forEach(l => {
              const sLvl = nodeLevels[l.source] || 0;
              const tLvl = nodeLevels[l.target] || 0;
              if (tLvl <= sLvl) {
                nodeLevels[l.target] = sLvl + 1;
                changed = true;
              }
            });
            iter++;
          }

          const levelCounts: Record<number, number> = {};
          const levelCurrent: Record<number, number> = {};
          currentNodes.forEach(n => {
            const lvl = nodeLevels[n.id] || 0;
            levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
            levelCurrent[lvl] = 0;
          });

          const numLevels = Object.keys(levelCounts).length;
          const levelHeight = CANVAS_H / (numLevels + 1);

          currentNodes.forEach(n => {
            if (n.id === draggedNodeId) return;
            const lvl = nodeLevels[n.id] || 0;
            const count = levelCounts[lvl] || 1;
            const curr = levelCurrent[lvl] || 0;
            levelCurrent[lvl] = curr + 1;

            const targetX = CANVAS_W * ((curr + 1) / (count + 1));
            const targetY = levelHeight * (lvl + 1);

            n.vx += (targetX - n.x) * 0.05;
            n.vy += (targetY - n.y) * 0.05;

            n.x += n.vx;
            n.y += n.vy;
            n.vx *= 0.7;
            n.vy *= 0.7;
          });
        } else {
          // Repulsion
          for (let i = 0; i < currentNodes.length; i++) {
            const nodeA = currentNodes[i];
            if (!nodeA) continue;
            for (let j = i + 1; j < currentNodes.length; j++) {
              const nodeB = currentNodes[j];
              if (!nodeB) continue;
              const dx = nodeB.x - nodeA.x || 1;
              const dy = nodeB.y - nodeA.y || 1;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;

              if (dist < linkDistance * 2) {
                const force = repulsion / (dist * dist);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;

                if (nodeA.id !== draggedNodeId) { nodeA.vx -= fx; nodeA.vy -= fy; }
                if (nodeB.id !== draggedNodeId) { nodeB.vx += fx; nodeB.vy += fy; }
              }
            }
          }

          // Springs
          const byId = new Map(currentNodes.map(n => [n.id, n] as const));
          currentLinks.forEach((link) => {
            const sourceNode = byId.get(link.source);
            const targetNode = byId.get(link.target);
            if (sourceNode && targetNode) {
              const dx = targetNode.x - sourceNode.x;
              const dy = targetNode.y - sourceNode.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const force = SPRING_K * (dist - linkDistance);

              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;

              if (sourceNode.id !== draggedNodeId) { sourceNode.vx += fx; sourceNode.vy += fy; }
              if (targetNode.id !== draggedNodeId) { targetNode.vx -= fx; targetNode.vy -= fy; }
            }
          });

          // Gravity
          currentNodes.forEach((node) => {
            if (node.id === draggedNodeId) return;
            node.vx += (CANVAS_W / 2 - node.x) * GRAVITY;
            node.vy += (CANVAS_H / 2 - node.y) * GRAVITY;

            node.x += node.vx;
            node.y += node.vy;
            node.vx *= 0.82;
            node.vy *= 0.82;
          });
        }

        // Enforce fixed positions
        currentNodes.forEach(node => {
          if (node.fx !== undefined && node.fy !== undefined) {
            node.x = node.fx;
            node.y = node.fy;
            node.vx = 0;
            node.vy = 0;
          }
        });

        setNodes([...currentNodes]);
      }

      animFrame = requestAnimationFrame(tick);
    };

    animFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame);
  }, [layout, repulsion, linkDistance, draggedNodeId]);

  // 3. Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const theme = store.data.settings.theme;
    const isDark = theme === 'dark';

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw Links
    links.forEach((link) => {
      const source = nodes.find(n => n.id === link.source);
      const target = nodes.find(n => n.id === link.target);
      if (source && target) {
        const isPathLink = activePathNodeIds.includes(link.source) && activePathNodeIds.includes(link.target) &&
          Math.abs(activePathNodeIds.indexOf(link.source) - activePathNodeIds.indexOf(link.target)) === 1;

        const isFaded = activePathNodeIds.length > 0 && !isPathLink;
        ctx.globalAlpha = isFaded ? 0.1 : 1.0;

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.lineWidth = isPathLink ? 4 : (link.confidence > 0.8 ? 2 : 1);
        ctx.strokeStyle = isPathLink ? '#00f0ff' : (isDark ? '#334155' : '#cbd5e1');
        ctx.stroke();

        if (zoom > 0.8) {
          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          ctx.font = 'bold 9px monospace';
          ctx.fillStyle = isPathLink ? '#00f0ff' : (isDark ? '#64748b' : '#94a3b8');
          ctx.textAlign = 'center';
          ctx.fillText(link.type, midX, midY - 6);
        }

        // Direction arrow
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        const arrowDist = target.radius + 6;
        const arrX = target.x - arrowDist * Math.cos(angle);
        const arrY = target.y - arrowDist * Math.sin(angle);

        ctx.beginPath();
        ctx.moveTo(arrX, arrY);
        ctx.lineTo(arrX - 8 * Math.cos(angle - Math.PI / 6), arrY - 8 * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(arrX - 8 * Math.cos(angle + Math.PI / 6), arrY - 8 * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = isPathLink ? '#00f0ff' : (isDark ? '#475569' : '#cbd5e1');
        ctx.fill();
      }
    });

    // Draw Nodes
    nodes.forEach((node) => {
      const isSelected = node.id === selectedId;
      const isPathNode = activePathNodeIds.includes(node.id);

      const isFaded = activePathNodeIds.length > 0 && !isPathNode;
      ctx.globalAlpha = isFaded ? 0.15 : 1.0;

      if (isPathNode || isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 8, 0, 2 * Math.PI);
        ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 240, 255, 0.2)';
        ctx.fill();
        ctx.strokeStyle = isSelected ? node.color : '#00f0ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
      ctx.shadowBlur = isSelected ? 20 : (isPathNode ? 20 : 0);
      ctx.shadowColor = isPathNode ? '#00f0ff' : node.color;
      ctx.fillStyle = isDark ? '#0b1329' : '#ffffff';
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = 2;
      ctx.strokeStyle = node.color;
      ctx.stroke();

      ctx.font = 'bold 11px system-ui';
      ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
      ctx.textAlign = 'center';
      const maxLen = zoom > 1.2 ? 20 : 10;
      ctx.fillText(node.label.length > maxLen ? node.label.substring(0, maxLen - 2) + '..' : node.label, node.x, node.y + 3);
    });

    ctx.globalAlpha = 1.0; // Reset global alpha
    ctx.restore();
  }, [nodes, links, zoom, pan, selectedId, activePathNodeIds]);

  // Input events. Canvas coordinates are converted with the current pan and zoom.
  const pointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (!p) return;
    const hit = hitTest(nodesRef.current, p.x, p.y);

    if (hit) {
      hit.fx = hit.x;
      hit.fy = hit.y;
      hit.vx = 0;
      hit.vy = 0;
      setDraggedNodeId(hit.id);
      onNodeSelect(hit.category, hit.id);
    } else {
      setDraggedNodeId(null);
      panOrigin.current = { clientX: e.clientX, clientY: e.clientY, panX: pan.x, panY: pan.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedNodeId) {
      const p = pointFromEvent(e);
      if (!p) return;
      const node = nodesRef.current.find(n => n.id === draggedNodeId);
      if (node) {
        node.fx = p.x;
        node.fy = p.y;
        node.x = p.x;
        node.y = p.y;
      }
    } else if (panOrigin.current) {
      const origin = panOrigin.current;
      setPan({
        x: origin.panX + (e.clientX - origin.clientX),
        y: origin.panY + (e.clientY - origin.clientY),
      });
    }
  };

  const handleMouseUp = () => {
    setDraggedNodeId(null);
    panOrigin.current = null;
  };

  // Double-click releases a pinned node back into the simulation.
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (!p) return;
    const hit = hitTest(nodesRef.current, p.x, p.y);
    if (hit) {
      hit.fx = undefined;
      hit.fy = undefined;
    }
  };

  const toggleTypeVisibility = (typeId: string) => {
    setHiddenTypes(prev => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  const tracePath = () => {
    if (!pathSource || !pathTarget) return;
    const path = store.findShortestPath(pathSource, pathTarget);
    store.data.active_path = path;
    store.save();
    if (path.length === 0) toast.show('No path found between those two nodes.', 'info');
  };

  const clearPath = () => {
    setPathSource('');
    setPathTarget('');
    store.data.active_path = [];
    store.save();
  };

  if (!activeCase) {
    return (
      <div className="empty-state">
        <Compass size={48} className="empty-icon" aria-hidden="true" />
        <h3>No case selected</h3>
        <p>The graph maps one case's entities and their relationships. Select or create a case first.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('command')}>
          Go to Command Center
        </button>
      </div>
    );
  }

  if (activeCase.entities.length === 0 && activeCase.incidents.length === 0) {
    return (
      <div className="empty-state">
        <Compass size={48} className="empty-icon" aria-hidden="true" />
        <h3>Nothing to graph yet</h3>
        <p>Add entities and incidents, then link them to build the network.</p>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('pipeline')}>
          <Upload size={14} aria-hidden="true" /> Open Data Pipeline
        </button>
      </div>
    );
  }

  const layoutButtonStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '6px',
    fontSize: '11px',
    fontWeight: 700,
    borderRadius: '4px',
    border: `1px solid ${active ? 'var(--accent-cyan)' : 'var(--border-color)'}`,
    backgroundColor: active ? 'rgba(0,240,255,0.1)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
  });

  return (
    <div className="graph-panel-container">
      {/* Left Sidebar for Controls */}
      <div className="premium-panel graph-controls-panel">

        {/* Layout & Physics */}
        <div style={{ marginBottom: '24px' }}>
          <div className="premium-panel-header" style={{ marginBottom: '12px', paddingBottom: '8px' }}>
            <h3 className="premium-panel-title">
              <Sliders size={14} className="text-accent" style={{ marginRight: '6px', verticalAlign: 'middle' }} aria-hidden="true" />
              Graph Layout
            </h3>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button type="button" aria-pressed={layout === 'force'} style={layoutButtonStyle(layout === 'force')} onClick={() => setLayout('force')}>
              FORCE DIRECTED
            </button>
            <button type="button" aria-pressed={layout === 'hierarchical'} style={layoutButtonStyle(layout === 'hierarchical')} onClick={() => setLayout('hierarchical')}>
              HIERARCHICAL
            </button>
          </div>

          {layout === 'force' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label htmlFor="graph-repulsion" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                  <span>Repulsion</span>
                  <span>{repulsion}</span>
                </label>
                <input id="graph-repulsion" type="range" min="100" max="3000" step="100" value={repulsion} onChange={e => setRepulsion(parseInt(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div>
                <label htmlFor="graph-link-distance" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                  <span>Link Distance</span>
                  <span>{linkDistance}</span>
                </label>
                <input id="graph-link-distance" type="range" min="40" max="400" step="10" value={linkDistance} onChange={e => setLinkDistance(parseInt(e.target.value))} style={{ width: '100%' }} />
              </div>
            </div>
          )}
        </div>

        {/* Node Filters */}
        <div style={{ marginBottom: '24px' }}>
          <div className="premium-panel-header" style={{ marginBottom: '12px', paddingBottom: '8px' }}>
            <h3 className="premium-panel-title">
              <Filter size={14} className="text-accent" style={{ marginRight: '6px', verticalAlign: 'middle' }} aria-hidden="true" />
              Node Visibility
            </h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={!hiddenTypes['incident']} onChange={() => toggleTypeVisibility('incident')} />
              Incidents
            </label>
            {activeCase.ontology_types.map(t => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                <input type="checkbox" checked={!hiddenTypes[t.id]} onChange={() => toggleTypeVisibility(t.id)} />
                <span style={{ color: t.color }}>{t.name}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Pathfinder */}
        <div>
          <div className="premium-panel-header" style={{ marginBottom: '12px', paddingBottom: '8px' }}>
            <h3 className="premium-panel-title">
              <GitMerge size={14} className="text-accent" style={{ marginRight: '6px', verticalAlign: 'middle' }} aria-hidden="true" />
              Pathfinder
            </h3>
          </div>

          <div className="form-group" style={{ marginBottom: '8px' }}>
            <label htmlFor="graph-path-source" className="sr-only">Path source</label>
            <select id="graph-path-source" className="premium-input" value={pathSource} onChange={(e) => setPathSource(e.target.value)} style={{ width: '100%', padding: '8px' }}>
              <option value="">-- Source node --</option>
              {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label htmlFor="graph-path-target" className="sr-only">Path target</label>
            <select id="graph-path-target" className="premium-input" value={pathTarget} onChange={(e) => setPathTarget(e.target.value)} style={{ width: '100%', padding: '8px' }}>
              <option value="">-- Target node --</option>
              {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="premium-button primary" style={{ flex: 2, padding: '8px' }} onClick={tracePath}>Trace path</button>
            <button type="button" className="premium-button" style={{ flex: 1, padding: '8px' }} onClick={clearPath}>Clear</button>
          </div>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div id="GraphCanvas" className="graph-canvas-wrapper flex-grow-1" style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={1200}
          height={800}
          role="img"
          aria-label={`Relationship graph of ${nodes.length} visible objects and ${links.length} links. Use the list controls to filter and trace paths.`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          className="node-canvas"
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {nodes.length === 0 && (
          <div className="graph-canvas-note">All object types are hidden. Tick a type in Node Visibility to show it.</div>
        )}
        <div className="graph-controls">
          <button type="button" onClick={() => setZoom(z => Math.min(z + 0.15, 3))} aria-label="Zoom in"><ZoomIn size={16} aria-hidden="true" /></button>
          <button type="button" onClick={() => setZoom(z => Math.max(z - 0.15, 0.4))} aria-label="Zoom out"><ZoomOut size={16} aria-hidden="true" /></button>
          <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset view"><Maximize2 size={15} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
};
