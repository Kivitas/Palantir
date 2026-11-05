import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { store } from './store';
import { LoginScreen } from './components/LoginScreen';
import { DetailDrawer } from './ui/DetailDrawer';
import { useToast } from './ui/toastContext';
import {
  AppWindow, BarChart3, Brain, Clock, Compass, Database, FileText, LayoutDashboard, LogOut, Map as MapIcon,
  Globe, Network, Radio, ScrollText, Search, Settings, Sun, Upload,
  type LucideIcon,
} from 'lucide-react';

// Tabs are code-split so Leaflet and the graph engine only load when used.
const CommandCenter = lazy(() => import('./components/CommandCenter').then(m => ({ default: m.CommandCenter })));
const ExplorerTab = lazy(() => import('./components/ExplorerTab').then(m => ({ default: m.ExplorerTab })));
const GraphTab = lazy(() => import('./components/GraphTab').then(m => ({ default: m.GraphTab })));
const MapTab = lazy(() => import('./components/MapTab').then(m => ({ default: m.MapTab })));
const ChronologyTab = lazy(() => import('./components/ChronologyTab').then(m => ({ default: m.ChronologyTab })));
const OntologyTab = lazy(() => import('./components/OntologyTab').then(m => ({ default: m.OntologyTab })));
const SignalsTab = lazy(() => import('./components/SignalsTab').then(m => ({ default: m.SignalsTab })));
const PipelineTab = lazy(() => import('./components/PipelineTab').then(m => ({ default: m.PipelineTab })));
const AIReviewTab = lazy(() => import('./components/AIReviewTab').then(m => ({ default: m.AIReviewTab })));
const AnalyticsTab = lazy(() => import('./components/AnalyticsTab').then(m => ({ default: m.AnalyticsTab })));
const AuditTrailTab = lazy(() => import('./components/AuditTrailTab').then(m => ({ default: m.AuditTrailTab })));
const DossierTab = lazy(() => import('./components/DossierTab').then(m => ({ default: m.DossierTab })));
const GlobalOpsTab = lazy(() => import('./components/GlobalOpsTab').then(m => ({ default: m.GlobalOpsTab })));
const BrowserTab = lazy(() => import('./components/BrowserTab').then(m => ({ default: m.BrowserTab })));
const SettingsTab = lazy(() => import('./components/SettingsTab').then(m => ({ default: m.SettingsTab })));
const OmniSearch = lazy(() => import('./components/OmniSearch').then(m => ({ default: m.OmniSearch })));

type TabId =
  | 'command' | 'explorer' | 'graph' | 'map' | 'chronology' | 'ontology'
  | 'signals' | 'pipeline' | 'ai' | 'analytics' | 'audit' | 'dossier' | 'globalops' | 'browser' | 'settings';

interface TabDef {
  id: TabId;
  label: string;
  heading: string;
  /** Tabs that need an active case are shown as locked until one is selected. */
  needsCase: boolean;
  Icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: 'command', label: 'Command', heading: 'Command Center', needsCase: false, Icon: LayoutDashboard },
  { id: 'explorer', label: 'Explorer', heading: 'Explorer', needsCase: true, Icon: Compass },
  { id: 'graph', label: 'Graph', heading: 'Graph Visualization', needsCase: true, Icon: Network },
  { id: 'map', label: 'Map', heading: 'Geospatial Map', needsCase: true, Icon: MapIcon },
  { id: 'chronology', label: 'Timeline', heading: 'Chronology', needsCase: true, Icon: Clock },
  { id: 'ontology', label: 'Ontology', heading: 'Ontology Manager', needsCase: true, Icon: Database },
  { id: 'signals', label: 'Signals', heading: 'Signal Detection', needsCase: true, Icon: Radio },
  { id: 'pipeline', label: 'Pipeline', heading: 'Data Pipeline', needsCase: false, Icon: Upload },
  { id: 'ai', label: 'AI', heading: 'AI Analysis', needsCase: true, Icon: Brain },
  { id: 'analytics', label: 'Analytics', heading: 'Analytics', needsCase: true, Icon: BarChart3 },
  { id: 'audit', label: 'Audit', heading: 'Audit Trail', needsCase: false, Icon: ScrollText },
  { id: 'dossier', label: 'Dossier', heading: 'Dossier', needsCase: true, Icon: FileText },
  { id: 'globalops', label: 'Global Ops', heading: 'Global Ops', needsCase: false, Icon: Globe },
  { id: 'browser', label: 'Browser', heading: 'Browser', needsCase: false, Icon: AppWindow },
  { id: 'settings', label: 'Settings', heading: 'Settings & Backup', needsCase: false, Icon: Settings },
];

const LOCKED_HINT = 'Select or create a case first';

// Store version counter for useSyncExternalStore. store.subscribe fires on every mutation and
// notify(), so the counter is a cheap, stable snapshot. Module-level, since the store is a singleton.
let storeVersion = 0;
store.subscribe(() => {
  storeVersion += 1;
});
const subscribeToStore = store.subscribe;
const getStoreVersion = () => storeVersion;

function TabFallback() {
  return <div className="tab-loading" role="status">Loading...</div>;
}

/** Persistence errors from the store (e.g. storage quota). Read-only; the user can dismiss it. */
function StoreErrorBanner() {
  useSyncExternalStore(subscribeToStore, getStoreVersion);
  const error = store.lastError;
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!error || error === dismissed) return null;
  return (
    <div className="app-banner app-banner-error" role="alert">
      <span>Your latest changes could not be saved to this browser: {error}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(error)}>
        Dismiss
      </button>
    </div>
  );
}

export default function App() {
  useSyncExternalStore(subscribeToStore, getStoreVersion);
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<TabId>('command');
  const [omniOpen, setOmniOpen] = useState(false);

  const loggedIn = !!store.data.current_user;
  const activeCase = store.getActiveCase();
  const theme = store.data.settings.theme;

  // Ctrl/Cmd+K opens the omni search from anywhere once logged in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (!store.data.current_user) return;
        e.preventDefault();
        setOmniOpen(open => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = useCallback((tab: string) => {
    const target = TABS.find(t => t.id === tab);
    setActiveTab(target ? target.id : 'command');
  }, []);

  const closeOmni = useCallback(() => setOmniOpen(false), []);

  const selectIncident = useCallback((id: string | null) => {
    store.selectObject('incident', id);
  }, []);

  const selectGraphNode = useCallback((type: 'entity' | 'incident' | null, id: string | null) => {
    store.selectObject(type ?? 'entity', id);
  }, []);

  const handleNavClick = (tab: TabDef) => {
    if (tab.needsCase && !activeCase) {
      setActiveTab('command');
      toast.show(`${LOCKED_HINT}.`, 'info');
      return;
    }
    setActiveTab(tab.id);
  };

  if (!loggedIn) {
    return (
      <>
        <StoreErrorBanner />
        <LoginScreen onSuccess={() => setActiveTab('command')} />
      </>
    );
  }

  const activeDef = TABS.find(t => t.id === activeTab) ?? TABS[0]!;

  const renderTab = (tab: TabId): ReactNode => {
    switch (tab) {
      case 'command': return <CommandCenter />;
      case 'explorer': return <ExplorerTab onNavigate={navigate} />;
      case 'graph': return <GraphTab onNodeSelect={selectGraphNode} onNavigate={navigate} />;
      case 'map': return <MapTab onIncidentSelect={selectIncident} />;
      case 'chronology': return <ChronologyTab onIncidentSelect={selectIncident} onNavigate={navigate} />;
      case 'ontology': return <OntologyTab onNavigate={navigate} />;
      case 'signals': return <SignalsTab onNavigate={navigate} />;
      case 'pipeline': return <PipelineTab />;
      case 'ai': return <AIReviewTab onNavigate={navigate} />;
      case 'analytics': return <AnalyticsTab onNavigate={navigate} />;
      case 'audit': return <AuditTrailTab />;
      case 'dossier': return <DossierTab onNavigate={navigate} />;
      case 'globalops': return <GlobalOpsTab />;
      case 'browser': return <BrowserTab />;
      case 'settings': return <SettingsTab />;
    }
  };

  return (
    <div className={`app ${theme === 'light' ? 'theme-light' : ''}`}>
      <StoreErrorBanner />
      <div className="app-layout">
        {/* Sidebar (becomes a bottom bar on narrow screens) */}
        <div className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-logo" role="img" aria-label="Aegis Nexus">A</div>
          </div>

          <nav className="sidebar-nav" aria-label="Main">
            {TABS.map(tab => {
              const locked = tab.needsCase && !activeCase;
              const isActive = activeTab === tab.id;
              const { Icon } = tab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`nav-item ${isActive ? 'active' : ''} ${locked ? 'is-locked' : ''}`}
                  onClick={() => handleNavClick(tab)}
                  aria-disabled={locked || undefined}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={locked ? `${tab.label} (${LOCKED_HINT})` : tab.label}
                  title={locked ? LOCKED_HINT : tab.label}
                >
                  <Icon size={24} aria-hidden="true" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => store.toggleTheme()}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              <Sun size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => {
                store.logout();
                setActiveTab('command');
              }}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut size={20} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="main-content">
          <div className="content-header">
            <h2>{activeDef.heading}</h2>
            <div className="content-header-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm omni-trigger"
                onClick={() => setOmniOpen(true)}
                aria-keyshortcuts="Control+K Meta+K"
                title="Search (Ctrl+K)"
              >
                <Search size={14} aria-hidden="true" /> <span>Search</span> <kbd>Ctrl K</kbd>
              </button>
              <div className="badge badge-primary">
                Clearance: {store.getCurrentUserClearance()}
              </div>
            </div>
          </div>
          <div className="content-body">
            <Suspense fallback={<TabFallback />}>
              {renderTab(activeTab)}
            </Suspense>
          </div>
        </div>

        <DetailDrawer />
      </div>

      {omniOpen && (
        <Suspense fallback={null}>
          <OmniSearch onClose={closeOmni} onNavigate={navigate} />
        </Suspense>
      )}
    </div>
  );
}
