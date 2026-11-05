import React, { useEffect, useReducer, useRef, useState } from 'react';
import { store } from '../store';
import { escapeHtml } from '../utils/html';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, Navigation, Play, Pause, RotateCcw } from 'lucide-react';
import type { Incident, SeverityLevel } from '../types';
import { ALL_LAYERS, LAYER_META } from '../osiris/config';
import { useOsirisHealth, type FeedLayerHandle } from '../osiris/hooks';
import type { BBox, FeedItem, FeedLayerId } from '../osiris/types';
import { FeedLayerProbe } from './feeds/FeedLayerProbe';
import { FeedsPanel } from './feeds/FeedsPanel';

// Fix Leaflet's default marker icon paths in bundle
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIconRetina from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIconRetina,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28],
  shadowSize: [41, 41]
});

L.Marker.prototype.options.icon = DefaultIcon;

type BaseLayer = 'osm' | 'terrain' | 'satellite';

const TILE_URLS: Record<BaseLayer, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  terrain: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

const TILE_ATTRIBUTION: Record<BaseLayer, string> = {
  osm: '© OpenStreetMap contributors',
  terrain: '© OpenTopoMap contributors',
  satellite: 'Tiles © Esri'
};

const DAY_MS = 86_400_000;
/** Max feed markers plotted per layer. */
const FEED_PLOT_CAP = 500;
/** Grid cell size in CSS px used for simple clustering of feed markers. */
const CLUSTER_PX = 48;

const NO_INCIDENTS: Incident[] = [];
const NO_ENABLED: Record<FeedLayerId, boolean> = {
  earthquakes: false, flights: false, fires: false, weather: false, gdelt: false, news: false, satellites: false
};

const getSeverityColor = (sev: string) => {
  if (sev === 'CRITICAL' || sev === 'HIGH') return '#ef5f63';
  if (sev === 'MEDIUM') return '#fb923c';
  return '#29d3c2';
};

/** Local-time parse of an incident's date and clock. Null when the date is unusable. */
function incidentTime(inc: Incident): number | null {
  const t = new Date(`${inc.date}T${inc.clock || '00:00:00'}`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Timeline bounds from valid incident dates only. Invalid dates are ignored, never NaN. */
function computeTimelineBounds(incidents: Incident[], now: number): { min: number; max: number } {
  const times = incidents.map(incidentTime).filter((t): t is number => t !== null);
  if (times.length === 0) return { min: now - DAY_MS * 30, max: now };
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (min === max) return { min: min - DAY_MS * 7, max: max + DAY_MS * 7 };
  return { min, max };
}

/** Cheap content fingerprint so the marker effect reruns on in-place edits. */
function incidentsSignature(incidents: Incident[]): string {
  return incidents
    .map((i) => [i.id, i.title, i.description, i.date, i.clock, i.lat, i.lon, i.severity].join('\u001f'))
    .join('\u001e');
}

/**
 * The store mutates the active case in place, so its `incidents` array keeps the same
 * reference after an add or edit. Subscribing and forcing a render makes the tab see it.
 */
function useActiveCase() {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(forceRender), []);
  return store.getActiveCase();
}

function readBbox(map: L.Map): BBox {
  const b = map.getBounds();
  return {
    minLat: Math.max(-90, b.getSouth()),
    minLon: Math.max(-180, b.getWest()),
    maxLat: Math.min(90, b.getNorth()),
    maxLon: Math.min(180, b.getEast()),
  };
}

type Plottable = FeedItem & { lat: number; lon: number };

function hasCoords(item: FeedItem): item is Plottable {
  return typeof item.lat === 'number' && typeof item.lon === 'number';
}

interface PlottedCluster {
  lat: number;
  lon: number;
  items: Plottable[];
}

/** Grid clustering. Cell size shrinks as zoom increases, so clusters split apart when zoomed in. */
function clusterItems(items: Plottable[], zoom: number): PlottedCluster[] {
  const cell = (360 / Math.pow(2, zoom)) * (CLUSTER_PX / 256);
  const buckets = new Map<string, Plottable[]>();
  for (const item of items) {
    const key = `${Math.floor((item.lat + 90) / cell)}:${Math.floor((item.lon + 180) / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.values()].map((group) => ({
    lat: group.reduce((s, i) => s + i.lat, 0) / group.length,
    lon: group.reduce((s, i) => s + i.lon, 0) / group.length,
    items: group,
  }));
}

/** Popup for one feed item. Every upstream value goes through escapeHtml. */
function feedPopupHtml(item: FeedItem): string {
  const meta = LAYER_META[item.layer];
  const when = item.time ? new Date(item.time).toLocaleString() : 'time not provided by source';
  const severity = item.severity !== undefined
    ? `<div style="font-size:10px;color:#64748b;">Severity: ${escapeHtml(item.severity)}</div>`
    : '';
  const link = item.url
    ? `<div style="font-size:11px;margin-bottom:6px;"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Source link</a></div>`
    : '';
  return `
    <div style="font-family: system-ui; padding: 4px; min-width: 160px; color: #1e293b;">
      <div style="font-size:10px;color:#64748b;text-transform:uppercase;">${escapeHtml(meta.label)} · Osiris/${escapeHtml(item.layer)}</div>
      <div style="font-weight:bold;margin:2px 0;">${escapeHtml(item.title)}</div>
      ${severity}
      <div style="font-size:10px;color:#94a3b8;margin-bottom:6px;">${escapeHtml(when)}</div>
      ${link}
      <button type="button" class="feed-promote" style="background:#0f766e;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;">Promote to case</button>
    </div>`;
}

/** Hooks the popup's promote button once, dispatching the feed item as a window event. */
function wirePromoteButton(el: HTMLElement | undefined, item: FeedItem) {
  const btn = el?.querySelector<HTMLButtonElement>('button.feed-promote');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent<FeedItem>('feed:promote', { detail: item }));
  });
}

const FEED_SEVERITY: Record<string, SeverityLevel> = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

/** Numeric severity uses a rough 0-10 scale. Anything unrecognised becomes LOW. */
function severityForFeed(v: FeedItem['severity']): SeverityLevel {
  if (typeof v === 'number') return v >= 7 ? 'CRITICAL' : v >= 5 ? 'HIGH' : v >= 3 ? 'MEDIUM' : 'LOW';
  return FEED_SEVERITY[(v ?? '').toString().toUpperCase()] ?? 'LOW';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Creates an incident in the active case from a feed item. Feed items are otherwise never
 * stored. Returns a status message for the UI.
 */
function promoteFeedItem(item: FeedItem): string {
  const ac = store.getActiveCase();
  if (!ac) return 'Open a case before promoting a feed item.';
  if (item.lat === undefined || item.lon === undefined) return 'This feed item has no coordinates.';

  const when = item.time ? new Date(item.time) : new Date();
  const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  const clock = `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`;

  const description = [
    `Promoted from Live Feeds. Source: Osiris/${item.layer}`,
    `Source URL: ${item.url ?? 'none provided'}`,
    `Event time: ${item.time ?? 'not provided by source (promotion time used)'}`,
    `Feed item id: ${item.id}`,
    item.severity !== undefined ? `Upstream severity: ${item.severity}` : '',
  ].filter(Boolean).join('\n');

  store.addIncident(
    ac.id,
    item.title,
    description,
    String(item.lat),
    String(item.lon),
    date,
    clock,
    severityForFeed(item.severity),
    'UNCLASSIFIED',
  );
  return `Promoted "${item.title}" to the active case.`;
}

interface MapTabProps {
  onIncidentSelect: (id: string | null) => void;
}

export const MapTab: React.FC<MapTabProps> = ({ onIncidentSelect }) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const activeCase = useActiveCase();
  const hasCase = activeCase !== null;
  const caseId = activeCase?.id;
  const incidents = activeCase?.incidents ?? NO_INCIDENTS;
  const incidentsKey = incidentsSignature(incidents);

  // The Leaflet instance lives in state so effects that depend on it re-run when it is (re)created.
  const [map, setMap] = useState<L.Map | null>(null);
  const onIncidentSelectRef = useRef(onIncidentSelect);

  const [activeLayer, setActiveLayer] = useState<BaseLayer>('osm');
  const [tileError, setTileError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(2);
  const [latLonText, setLatLonText] = useState('0.000000, 0.000000');
  const [anchorNow] = useState(() => Date.now());

  // Live feeds
  const [enabledFeeds, setEnabledFeeds] = useState<Record<FeedLayerId, boolean>>(NO_ENABLED);
  const [feedStates, setFeedStates] = useState<Partial<Record<FeedLayerId, FeedLayerHandle>>>({});
  const [viewBbox, setViewBbox] = useState<BBox | null>(null);
  const [promoteNotice, setPromoteNotice] = useState<string | null>(null);
  const health = useOsirisHealth();

  // Temporal Playback Scrubber States
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrubberVal, setScrubberVal] = useState(100); // 0 to 100%

  const { min: minTime, max: maxTime } = computeTimelineBounds(incidents, anchorNow);
  const activeCutoffTime = minTime + (maxTime - minTime) * (scrubberVal / 100);

  // Keep the latest callback without re-running the marker effect when its identity changes.
  useEffect(() => {
    onIncidentSelectRef.current = onIncidentSelect;
  }, [onIncidentSelect]);

  // Auto playback loop
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setScrubberVal((prev) => Math.min(100, prev + 1));
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying]);

  // Stop at the end of the timeline.
  useEffect(() => {
    if (scrubberVal >= 100) setIsPlaying(false);
  }, [scrubberVal]);

  // Window listener for promote requests from feed popups.
  useEffect(() => {
    const onPromote = (e: Event) => {
      const item = (e as CustomEvent<FeedItem>).detail;
      if (!item) return;
      setPromoteNotice(promoteFeedItem(item));
    };
    window.addEventListener('feed:promote', onPromote);
    return () => window.removeEventListener('feed:promote', onPromote);
  }, []);

  // Clear the promote notice after a few seconds.
  useEffect(() => {
    if (!promoteNotice) return;
    const t = window.setTimeout(() => setPromoteNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [promoteNotice]);

  // 1. Create the map while a case is open. Recreated if the case state flips.
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!hasCase || !container) return;

    const instance = L.map(container, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false
    });
    L.control.zoom({ position: 'topright' }).addTo(instance);

    const onMove = () => {
      const center = instance.getCenter();
      setLatLonText(`${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}`);
    };
    const onZoomEnd = () => setZoomLevel(instance.getZoom());

    // Debounced viewport bbox for feed fetches.
    let bboxTimer: number | undefined;
    const onMoveEnd = () => {
      window.clearTimeout(bboxTimer);
      bboxTimer = window.setTimeout(() => setViewBbox(readBbox(instance)), 500);
    };

    instance.on('move', onMove);
    instance.on('zoomend', onZoomEnd);
    instance.on('moveend', onMoveEnd);
    setViewBbox(readBbox(instance));

    const resizeTimer = window.setTimeout(() => instance.invalidateSize(), 250);
    const handleResize = () => instance.invalidateSize();
    window.addEventListener('resize', handleResize);

    setMap(instance);
    return () => {
      window.clearTimeout(resizeTimer);
      window.clearTimeout(bboxTimer);
      window.removeEventListener('resize', handleResize);
      instance.off();
      instance.remove();
      setMap(null);
    };
  }, [hasCase]);

  // Re-measure when the case changes (the container may have been resized).
  useEffect(() => {
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize(), 300);
    return () => window.clearTimeout(t);
  }, [map, caseId]);

  // 2. Base tile layer. Adds the layer, removes it on change, and reports tile failures.
  useEffect(() => {
    if (!map) return;
    setTileError(false);
    const tiles = L.tileLayer(TILE_URLS[activeLayer], {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION[activeLayer]
    });
    tiles.on('tileerror', () => setTileError(true));
    tiles.on('tileload', () => setTileError(false));
    tiles.addTo(map);
    return () => {
      tiles.remove();
    };
  }, [map, activeLayer]);

  // 3. Case incident markers, filtered by the temporal cutoff. Rebuilt when incident content changes.
  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup().addTo(map);

    incidents.forEach((inc) => {
      const lat = parseFloat(inc.lat);
      const lon = parseFloat(inc.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      // Incidents with unusable dates cannot be placed in time, so they are always shown.
      const t = incidentTime(inc);
      if (t !== null && t > activeCutoffTime) return;

      // Every user-supplied value below goes through escapeHtml: titles and descriptions
      // can come from pipeline ingest and must not run as markup.
      const color = getSeverityColor(inc.severity);
      const customHtmlIcon = L.divIcon({
        className: 'custom-map-icon',
        html: `<div style="
          background-color: ${color};
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid white;
          box-shadow: 0 0 8px ${color};
        "></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      const marker = L.marker([lat, lon], { icon: customHtmlIcon });

      const popupHtml = `
        <div style="font-family: system-ui; padding: 4px; min-width: 140px; color: #1e293b;">
          <div style="font-weight: bold; margin-bottom: 2px;">${escapeHtml(inc.title)}</div>
          <div style="font-size: 10px; color: #64748b; margin-bottom: 6px;">Severity: ${escapeHtml(inc.severity)}</div>
          <div style="font-size: 11px; margin-bottom: 6px;">${escapeHtml(inc.description || 'No description.')}</div>
          <div style="font-size: 9px; color: #94a3b8;">${escapeHtml(inc.date)} ${escapeHtml(inc.clock)}</div>
        </div>
      `;
      marker.bindPopup(popupHtml);

      marker.on('click', () => {
        store.selectObject('incident', inc.id);
        onIncidentSelectRef.current(inc.id);
      });

      marker.addTo(group);
    });

    return () => {
      group.remove();
    };
  }, [map, incidents, incidentsKey, activeCutoffTime]);

  // 4. Live feed markers. One group per run, cleared on every change.
  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup().addTo(map);

    for (const layer of ALL_LAYERS) {
      if (!enabledFeeds[layer]) continue;
      const color = LAYER_META[layer].color;
      const plottable = (feedStates[layer]?.items ?? []).filter(hasCoords).slice(0, FEED_PLOT_CAP);

      for (const cluster of clusterItems(plottable, zoomLevel)) {
        const [only] = cluster.items;
        if (cluster.items.length === 1 && only) {
          const marker = L.circleMarker([only.lat, only.lon], {
            radius: 6,
            color: '#ffffff',
            weight: 1,
            fillColor: color,
            fillOpacity: 0.9
          });
          marker.bindPopup(feedPopupHtml(only));
          marker.on('popupopen', (e: L.PopupEvent) => wirePromoteButton(e.popup.getElement(), only));
          marker.addTo(group);
        } else {
          const points = cluster.items.map((i) => [i.lat, i.lon] as L.LatLngTuple);
          const marker = L.marker([cluster.lat, cluster.lon], {
            icon: L.divIcon({
              className: 'feed-cluster-icon',
              html: `<div style="background:${color};color:#0f172a;font-weight:700;font-size:11px;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 0 6px ${color};">${cluster.items.length}</div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15]
            })
          });
          marker.bindTooltip(`${cluster.items.length} ${escapeHtml(LAYER_META[layer].label)} (click to zoom in)`);
          marker.on('click', () => {
            map.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: Math.min(map.getZoom() + 3, 12) });
          });
          marker.addTo(group);
        }
      }
    }

    return () => {
      group.remove();
    };
  }, [map, feedStates, enabledFeeds, zoomLevel]);

  // Auto-zoom fit when the case changes.
  useEffect(() => {
    if (!map) return;
    const ac = store.getActiveCase();
    if (!ac || ac.incidents.length === 0) return;
    const coords = ac.incidents
      .map(i => [parseFloat(i.lat), parseFloat(i.lon)] as [number, number])
      .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));

    if (coords.length > 0) {
      map.fitBounds(L.latLngBounds(coords), { padding: [40, 40] });
    }
  }, [map, caseId]);

  const handleGeocodeSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery || isGeocoding || !map) return;

    setIsGeocoding(true);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`, {
        headers: { 'User-Agent': 'AegisNexus/1.0.0' }
      });
      const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;

      const first = data[0];
      if (first) {
        const lat = parseFloat(first.lat);
        const lon = parseFloat(first.lon);

        map.setView([lat, lon], 12);

        L.popup()
          .setLatLng([lat, lon])
          .setContent(`<div style="color:#0f172a; font-weight:bold; padding:4px;">${escapeHtml(first.display_name)}</div>`)
          .openOn(map);
      } else {
        alert('Location not found.');
      }
    } catch (e) {
      console.error('Geocoding error:', e);
      alert('Geocoding service unavailable.');
    } finally {
      setIsGeocoding(false);
    }
  };

  const handleFeedProbe = React.useCallback((layer: FeedLayerId, handle: FeedLayerHandle) => {
    setFeedStates((prev) => (prev[layer] === handle ? prev : { ...prev, [layer]: handle }));
  }, []);

  const handleFeedToggle = React.useCallback((layer: FeedLayerId, on: boolean) => {
    setEnabledFeeds((prev) => ({ ...prev, [layer]: on }));
  }, []);

  const handlePlayToggle = () => {
    if (!isPlaying && scrubberVal >= 100) setScrubberVal(0);
    setIsPlaying(!isPlaying);
  };

  if (!activeCase) {
    return (
      <div className="empty-panel">
        <Navigation size={48} className="muted-icon" />
        <h3>Geospatial Map Empty</h3>
        <p>Plot case incidents to track risk parameters across coordinates.</p>
      </div>
    );
  }

  return (
    <div className="map-panel-container">
      {/* Map Search input */}
      <div className="premium-panel" style={{ padding: '12px', marginBottom: '16px', display: 'flex', flexDirection: 'row' }}>
        <form onSubmit={handleGeocodeSearch} style={{ display: 'flex', width: '100%', gap: '8px' }}>
          <input
            className="premium-input"
            type="text"
            placeholder="Geocode location search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="premium-button primary" type="submit" disabled={isGeocoding} style={{ padding: '8px 12px' }}>
            {isGeocoding ? '...' : <Search size={14} />}
          </button>
        </form>
      </div>

      {(tileError || promoteNotice) && (
        <div style={{ marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
          {tileError && (
            <div role="alert" className="premium-panel" style={{ padding: '8px 12px', color: '#fbbf24' }}>
              Map tiles failed to load for this layer. Check your connection or switch layers.
            </div>
          )}
          {promoteNotice && (
            <div role="status" className="premium-panel" style={{ padding: '8px 12px' }}>
              {promoteNotice}
            </div>
          )}
        </div>
      )}

      {/* Map Frame Container */}
      <div className="map-view-wrapper" style={{ position: 'relative' }}>
        <div ref={mapContainerRef} className="leaflet-map-element" style={{ height: '410px', width: '100%', borderRadius: '10px' }} />

        {/* Live feed layer probes: render nothing, one fetch hook per layer. */}
        {ALL_LAYERS.map((layer) => (
          <FeedLayerProbe
            key={layer}
            layer={layer}
            enabled={enabledFeeds[layer]}
            bbox={viewBbox}
            onChange={handleFeedProbe}
          />
        ))}

        <FeedsPanel
          enabled={enabledFeeds}
          feeds={feedStates}
          onToggle={handleFeedToggle}
          health={health}
        />

        {/* Layer Controls */}
        <div className="premium-panel" style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', width: '100px' }}>
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Layers</span>
          <button
            className={`premium-button ${activeLayer === 'osm' ? 'primary' : ''}`}
            onClick={() => setActiveLayer('osm')}
            style={{ padding: '6px', fontSize: '11px' }}
          >
            Street
          </button>
          <button
            className={`premium-button ${activeLayer === 'terrain' ? 'primary' : ''}`}
            onClick={() => setActiveLayer('terrain')}
            style={{ padding: '6px', fontSize: '11px' }}
          >
            Terrain
          </button>
          <button
            className={`premium-button ${activeLayer === 'satellite' ? 'primary' : ''}`}
            onClick={() => setActiveLayer('satellite')}
            style={{ padding: '6px', fontSize: '11px' }}
          >
            Sat
          </button>

          <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '8px 0' }} />
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Zoom</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>{zoomLevel}x</span>
        </div>

        {/* Floating coordinates indicator hud */}
        <div id="MapPositionLabel" className="coordinates-hud">
          {latLonText}
        </div>
      </div>

      {/* Playback Date Scrubber Slider */}
      <div className="premium-panel" style={{ marginTop: '16px', padding: '16px', display: 'flex', gap: '16px', alignItems: 'center' }}>
        <button
          className="premium-button primary"
          onClick={handlePlayToggle}
          aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
          style={{ padding: '8px' }}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="premium-button"
          onClick={() => { setScrubberVal(0); setIsPlaying(false); }}
          aria-label="Reset playback"
          style={{ padding: '8px' }}
        >
          <RotateCcw size={14} />
        </button>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <input
            type="range"
            min="0"
            max="100"
            value={scrubberVal}
            onChange={(e) => {
              setScrubberVal(parseInt(e.target.value));
              setIsPlaying(false);
            }}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Scope: {new Date(minTime).toLocaleDateString()} to <strong style={{ color: 'var(--text-primary)' }}>{new Date(activeCutoffTime).toLocaleDateString()}</strong>
          </div>
        </div>
      </div>
    </div>
  );
};
