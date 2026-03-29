import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFbAuthStatus, deleteFbSession, getFeeds, createFeed, updateFeed, deleteFeed, clearFeedVehicles, syncFeed, syncFeedHtml, saveGmailConfig, getEmailStatus, getDealerContact, saveDealerContact } from '../api/client';
import { clearSyncState, getSyncState, onSyncStateChange, setSyncState } from '../lib/sync-state';
import {
  Settings as SettingsIcon,
  Facebook,
  Database,
  Info,
  ShieldCheck,
  RefreshCw,
  LogOut,
  Clock,
  Key,
  Activity,
  Link2,
  Save,
  Zap,
  CheckCircle,
  AlertCircle,
  Mail,
  MapPin,
  Phone,
  Bot
} from 'lucide-react';
import { motion } from 'framer-motion';
import Badge from '../components/Badge';
import AutoresponderToggle from '../components/AutoresponderToggle';

export default function Settings() {
  const navigate = useNavigate();
  const [fbStatus, setFbStatus] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Inventory Feed state
  const [feedUrl, setFeedUrl] = useState('');
  const [dealerName, setDealerName] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [feeds, setFeeds] = useState([]);
  const [activeFeed, setActiveFeed] = useState(null);
  const [feedSaving, setFeedSaving] = useState(false);
  const [feedSyncing, setFeedSyncing] = useState(false);
  const [feedMsg, setFeedMsg] = useState(null);
  const [currentSyncState, setCurrentSyncState] = useState(() => getSyncState());
  const manualSyncDismissRef = useRef(null);

  // Email config state
  const [emailStatus, setEmailStatus] = useState(null);
  const [emailMsg, setEmailMsg] = useState(null);
  const [gmailAddress, setGmailAddress] = useState('');
  const [gmailAppPassword, setGmailAppPassword] = useState('');
  const [gmailSaving, setGmailSaving] = useState(false);

  // Dealer contact state
  const [dealerAddress, setDealerAddress] = useState('');
  const [salesPhone, setSalesPhone] = useState('');
  const [contactSaving, setContactSaving] = useState(false);
  const [contactMsg, setContactMsg] = useState(null);

  const loadStatus = () => getFbAuthStatus().then(setFbStatus).catch(() => {});

  const loadFeeds = async () => {
    try {
      const res = await getFeeds();
      const list = res.feeds || [];
      const feed = list[0] || null;
      setFeeds(list);
      setActiveFeed(feed);
      if (feed) {
        setFeedUrl(feed.feedUrl || '');
        setDealerName(feed.name || '');
      }
      return feed;
    } catch {
      return null;
    }
  };

  const loadEmailStatus = () =>
    getEmailStatus()
      .then(s => {
        setEmailStatus(s);
        if (s.address && !gmailAddress) setGmailAddress(s.address);
      })
      .catch(() => {});

  const loadDealerContact = () =>
    getDealerContact()
      .then(c => {
        if (c.address) setDealerAddress(c.address);
        if (c.phone) setSalesPhone(c.phone);
      })
      .catch(() => {});

  // On mount
  useEffect(() => {
    loadStatus();
    loadFeeds();
    loadEmailStatus();
    loadDealerContact();
  }, []);

  useEffect(() => {
    const unsubscribe = onSyncStateChange((nextState) => {
      setCurrentSyncState(nextState);

      if (
        nextState?.event?.type === 'auto-sync-complete' ||
        nextState?.event?.type === 'image-fetch-complete' ||
        nextState?.event?.type === 'manual-sync-complete'
      ) {
        loadFeeds();
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (manualSyncDismissRef.current) {
        clearTimeout(manualSyncDismissRef.current);
        manualSyncDismissRef.current = null;
      }
    };
  }, []);

  const publishManualSyncState = (event, message, dismissMs = 0) => {
    if (manualSyncDismissRef.current) {
      clearTimeout(manualSyncDismissRef.current);
      manualSyncDismissRef.current = null;
    }

    const nextState = {
      id: `${Date.now()}-${Math.random()}`,
      source: 'manual-sync',
      event,
      message,
    };

    setSyncState(nextState);

    if (dismissMs > 0) {
      manualSyncDismissRef.current = setTimeout(() => {
        if (getSyncState()?.id === nextState.id) {
          clearSyncState();
        }
        manualSyncDismissRef.current = null;
      }, dismissMs);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Facebook Account? This will halt automated postings.')) return;
    setDisconnecting(true);
    try {
      await deleteFbSession();
      await loadStatus();
    } finally {
      setDisconnecting(false);
    }
  };

  const removeExtraFeeds = async (keepFeedId) => {
    const res = await getFeeds();
    const extraFeeds = (res.feeds || []).filter(feed => feed.id !== keepFeedId);

    for (const feed of extraFeeds) {
      await clearFeedVehicles(feed.id);
      await deleteFeed(feed.id);
    }
  };

  const handleSaveFeed = async () => {
    if (!feedUrl.trim()) { setFeedMsg({ type: 'error', text: 'Enter a feed URL' }); return; }
    if (!feedUrl.trim().toLowerCase().includes('cars.com')) {
      setFeedMsg({ type: 'error', text: 'Only Cars.com dealer inventory URLs are supported. Example: https://www.cars.com/dealers/1234/your-dealer/inventory/' });
      return;
    }
    setFeedSaving(true);
    setFeedMsg(null);
    try {
      const newUrl = feedUrl.trim();
      const newName = dealerName.trim() || null;

      if (activeFeed) {
        const urlChanged = newUrl !== activeFeed.feedUrl;
        const nameChanged = newName !== (activeFeed.name || null);

        if (!urlChanged && !nameChanged) {
          setFeedMsg({ type: 'success', text: 'Feed already up to date' });
          return;
        }

        await updateFeed(activeFeed.id, {
          feedUrl: newUrl,
          name: newName,
        });

        if (urlChanged) {
          if (window.autolander?.stopFeedImageFetch) {
            await window.autolander.stopFeedImageFetch(activeFeed.id).catch(() => {});
          }
          await clearFeedVehicles(activeFeed.id);
          setFeedMsg({ type: 'info', text: 'Feed updated. Old inventory cleared. Syncing new feed...' });
        } else {
          setFeedMsg({ type: 'success', text: 'Feed saved.' });
        }

        await removeExtraFeeds(activeFeed.id);
        const refreshedFeed = await loadFeeds();

        if (urlChanged) {
          window.setTimeout(() => {
            void handleSync(refreshedFeed);
          }, 500);
        }
        return;
      }

      const createdFeed = await createFeed({
        feedUrl: newUrl,
        name: newName,
      });
      setFeedMsg({ type: 'success', text: 'Feed created. Syncing...' });
      await removeExtraFeeds(createdFeed.id);
      const refreshedFeed = await loadFeeds();
      window.setTimeout(() => {
        void handleSync(refreshedFeed || createdFeed);
      }, 500);
    } catch (e) {
      setFeedMsg({ type: 'error', text: 'Failed to save: ' + e.message });
    } finally {
      setFeedSaving(false);
    }
  };

  const handleSync = async (feedOverride = null) => {
    const feed = feedOverride || activeFeed;
    if (!feed) return;
    setFeedSyncing(true);
    publishManualSyncState(
      { type: 'manual-sync-start', feedId: feed.id },
      { type: 'info', text: 'Syncing inventory...' }
    );
    let stopFeedSyncProgress = null;
    try {
      let result;

      // For bot-protected feeds, use Electron's hidden browser to fetch HTML first.
      const needsBrowserFetch =
        feed.feedType === 'CARGURUS' ||
        feed.feedType === 'CARSCOM' ||
        (feed.feedUrl && (
          feed.feedUrl.includes('cargurus.com') ||
          feed.feedUrl.includes('cars.com')
        ));

      if (needsBrowserFetch && window.autolander?.fetchFeedHtml) {
        if (window.autolander?.onFeedSyncProgress) {
          stopFeedSyncProgress = window.autolander.onFeedSyncProgress((data) => {
            if (!data?.page || !data?.totalPages) return;
            publishManualSyncState(
              { type: 'manual-sync-page', feedId: feed.id, page: data.page, totalPages: data.totalPages },
              { type: 'info', text: `Loading page ${data.page} of ${data.totalPages}...` }
            );
          });
        }

        publishManualSyncState(
          { type: 'manual-sync-browser', feedId: feed.id },
          { type: 'info', text: 'Loading dealer page in browser...' }
        );

        const fetchResult = await window.autolander.fetchFeedHtml(feed.feedUrl);

        if (!fetchResult.success || !fetchResult.html) {
          throw new Error(fetchResult.error || 'Failed to load dealer page');
        }

        publishManualSyncState(
          { type: 'manual-sync-parse', feedId: feed.id },
          { type: 'info', text: 'Parsing inventory data...' }
        );

        // Send the HTML to the cloud API for parsing and sync
        result = await syncFeedHtml(feed.id, fetchResult.html);
      } else {
        // For non-browser feeds, use the normal server-side sync
        result = await syncFeed(feed.id);
      }

      await loadFeeds();
      const msg = `Sync complete: ${result.vehiclesFound} found, ${result.vehiclesAdded} added, ${result.vehiclesUpdated} updated`;
      publishManualSyncState(
        { type: 'manual-sync-complete', feedId: feed.id, result },
        { type: 'success', text: msg },
        10000
      );

      if (
        window.autolander?.fetchFeedImages &&
        (feed.feedType === 'CARSCOM' || feed.feedUrl?.toLowerCase().includes('cars.com'))
      ) {
        window.autolander.fetchFeedImages(feed).catch(() => {});
      }
    } catch (e) {
      publishManualSyncState(
        { type: 'manual-sync-error', feedId: feed.id, error: e.message },
        { type: 'error', text: 'Sync failed: ' + e.message },
        10000
      );
    } finally {
      if (typeof stopFeedSyncProgress === 'function') stopFeedSyncProgress();
      setFeedSyncing(false);
    }
  };

  const handleSaveGmail = async () => {
    if (!gmailAddress.trim() || !gmailAppPassword.trim()) {
      setEmailMsg({ type: 'error', text: 'Enter both Gmail address and App Password' });
      return;
    }
    setGmailSaving(true);
    setEmailMsg(null);
    try {
      await saveGmailConfig({ address: gmailAddress.trim(), appPassword: gmailAppPassword.trim() });
      await loadEmailStatus();
      setGmailAppPassword('');
      setEmailMsg({ type: 'success', text: 'Gmail configuration saved' });
    } catch (err) {
      setEmailMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setGmailSaving(false);
    }
  };

  const handleSaveContact = async () => {
    setContactSaving(true);
    setContactMsg(null);
    try {
      await saveDealerContact({ address: dealerAddress.trim(), phone: salesPhone.trim() });
      setContactMsg({ type: 'success', text: 'Dealer contact info saved' });
    } catch (err) {
      setContactMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setContactSaving(false);
    }
  };

  return (
    <div className="space-y-10 pb-12 max-w-4xl">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <SettingsIcon size={14} />
            System Configuration
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
            Platform <span className="text-brand-500">Settings</span>
          </h1>
          <p className="text-surface-500 font-medium">Manage connectivity and core automation parameters</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Facebook Connection */}
        <div className="glass-card overflow-hidden">
          <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
             <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-600/20 flex items-center justify-center text-blue-500 shadow-glow-blue">
                <Facebook size={20} />
             </div>
             <div>
                <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Facebook Marketplace</h2>
                <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">External Distribution Channel</p>
             </div>
          </div>
          
          <div className="p-6">
            {fbStatus ? (
              <div className="space-y-6">
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-surface-950/50 border border-surface-900/50">
                  <div className={`w-2 h-2 rounded-full ${fbStatus.connected ? 'bg-emerald-500 shadow-glow-green' : 'bg-rose-500 shadow-glow-red'} animate-pulse`} />
                  <p className={`text-xs font-black uppercase tracking-widest ${fbStatus.connected ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fbStatus.message}
                  </p>
                </div>

                {fbStatus.connected && (
                  <div className="grid grid-cols-1 gap-3">
                     <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                        <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                           <Clock size={12} />
                           Session Validity
                        </span>
                        <span className="text-xs font-black text-surface-200 uppercase">{fbStatus.daysLeft} Days Remaining</span>
                     </div>
                     <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                        <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                           <Clock size={12} />
                           Last Linked
                        </span>
                        <span className="text-xs font-black text-surface-200 uppercase">{fbStatus.savedAt}</span>
                     </div>
                     <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                        <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                           <Key size={12} />
                           Encryption Status
                        </span>
                        <Badge variant={fbStatus.encrypted ? 'brand' : 'warning'} size="xs">
                           {fbStatus.encrypted ? 'ACTIVE' : 'NONE'}
                        </Badge>
                     </div>
                  </div>
                )}

                <div className="flex flex-col gap-3 pt-4">
                  <button
                    onClick={() => navigate('/settings/facebook')}
                    className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={14} />
                    {fbStatus.connected ? 'Refresh Connection' : 'Initialize Connection'}
                  </button>
                  {fbStatus.connected && (
                    <button
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="w-full py-3 bg-surface-900 hover:bg-surface-800 text-surface-400 text-xs font-black uppercase tracking-widest rounded-xl border border-surface-800 transition-all flex items-center justify-center gap-2"
                    >
                      <LogOut size={14} />
                      {disconnecting ? 'Terminating...' : 'Terminate Session'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center py-10 opacity-30">
                 <RefreshCw size={24} className="animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* System Info */}
        <div className="glass-card overflow-hidden">
           <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
             <div className="w-10 h-10 rounded-xl bg-surface-900 border border-surface-800 flex items-center justify-center text-surface-400">
                <Database size={20} />
             </div>
             <div>
                <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Intelligence Engine</h2>
                <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">Core Architecture & Diagnostics</p>
             </div>
          </div>
          
          <div className="p-6 space-y-6">
             <div className="space-y-4">
               {[
                 { label: 'Firmware Version', value: 'v0.4.0-STABLE', icon: ShieldCheck },
                 { label: 'Auto-Sync Rate', value: '30 Seconds', icon: Clock },
                 { label: 'Environment', value: 'Production / Local', icon: Info },
                 { label: 'AI Model Status', value: 'Active / Connected', icon: Activity }
               ].map((item, idx) => (
                 <div key={idx} className="flex items-center justify-between p-3 rounded-xl bg-surface-950/20 border border-surface-900/50">
                    <div className="flex items-center gap-3 text-[10px] font-bold text-surface-500 uppercase tracking-widest">
                       <item.icon size={14} className="text-brand-500/50" />
                       {item.label}
                    </div>
                    <span className="text-[11px] font-black text-surface-200 uppercase tracking-tight">{item.value}</span>
                 </div>
               ))}
             </div>

             <div className="p-4 rounded-2xl bg-brand-500/5 border border-brand-500/10">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-brand-500 mb-2 flex items-center gap-2">
                   <Info size={12} />
                   ACCESS CONTROL
                </h4>
                <div className="grid grid-cols-2 gap-2">
                   <div className="text-[9px] font-bold text-surface-600 uppercase">Manager Node: <span className="text-brand-400">/manager</span></div>
                   <div className="text-[9px] font-bold text-surface-600 uppercase">Sales Node: <span className="text-brand-400">/sales</span></div>
                </div>
             </div>
          </div>
        </div>
      </div>

      {/* AI Autoresponder */}
      <div className="glass-card overflow-hidden">
        <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 shadow-glow-green">
            <Bot size={20} />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">AI Autoresponder</h2>
            <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">Autonomous Customer Engagement</p>
          </div>
        </div>

        <div className="p-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="space-y-2">
            <p className="text-xs font-bold text-surface-200 uppercase tracking-wide">Status Control</p>
            <p className="text-[11px] text-surface-500 leading-relaxed max-w-md">
              Enable or disable the AI agent's ability to automatically respond to new inquiries on Facebook Marketplace. 
              When active, the agent will analyze sentiment and engage with potential buyers in real-time.
            </p>
          </div>
          <div className="flex-shrink-0">
            <AutoresponderToggle />
          </div>
        </div>
      </div>

      {/* Inventory Feed — full width */}
      <div className="glass-card overflow-hidden">
        <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-500 shadow-glow-blue">
            <Link2 size={20} />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Inventory Feed</h2>
            <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">CarGurus / Dealer Website Sync</p>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {currentSyncState?.message && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold uppercase tracking-widest ${
              currentSyncState.message.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : currentSyncState.message.type === 'info'
                ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
            }`}>
              {currentSyncState.message.type === 'success' ? <CheckCircle size={14} /> : currentSyncState.message.type === 'info' ? <RefreshCw size={14} className="animate-spin" /> : <AlertCircle size={14} />}
              {currentSyncState.message.text}
            </div>
          )}

          {/* Feed URL */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Feed URL</label>
            <input
              type="url"
              value={feedUrl}
              onChange={e => setFeedUrl(e.target.value)}
              placeholder="https://www.cars.com/dealers/1234/your-dealer/inventory/"
              className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
            />
          </div>

          {/* Dealer Name */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Dealer Name <span className="text-surface-700">(Optional)</span></label>
            <input
              type="text"
              value={dealerName}
              onChange={e => setDealerName(e.target.value)}
              placeholder="My Dealership"
              className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
            />
          </div>

          {/* Auto-Generate Toggle */}
          <div className="flex items-center justify-between p-4 rounded-2xl bg-surface-950/50 border border-surface-900/50">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-white">Auto-Generate Listings</p>
              <p className="text-[10px] text-surface-500 mt-1">Automatically create FB Marketplace listings for new vehicles</p>
            </div>
            <button
              onClick={() => setAutoGenerate(!autoGenerate)}
              className={`relative w-12 h-6 rounded-full transition-colors ${autoGenerate ? 'bg-brand-500' : 'bg-surface-800'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${autoGenerate ? 'translate-x-6' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {/* Status section */}
          {activeFeed && (
            <div className="space-y-3 p-4 rounded-2xl bg-surface-950/30 border border-surface-900/50">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-surface-400 flex items-center gap-2">
                <Activity size={12} />
                Last Sync
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                  <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                    <Clock size={12} />
                    Date
                  </span>
                  <span className="text-[11px] font-black text-surface-200 uppercase">
                    {activeFeed.lastSyncAt ? new Date(activeFeed.lastSyncAt).toLocaleDateString() : 'Never'}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                  <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Status</span>
                  <Badge variant={activeFeed.lastSyncStatus === 'success' ? 'brand' : activeFeed.lastSyncStatus ? 'danger' : 'warning'} size="xs">
                    {(activeFeed.lastSyncStatus || 'PENDING').toUpperCase()}
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                  <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Vehicles</span>
                  <span className="text-[11px] font-black text-brand-400 uppercase">
                    {activeFeed.vehicleCount ?? 0}
                  </span>
                </div>
              </div>
              {activeFeed.syncLogs?.[0] && (
                <p className="text-[10px] text-surface-500 font-medium italic px-1">
                  Latest: {activeFeed.syncLogs[0].message}
                </p>
              )}
            </div>
          )}

          {/* Messages */}
          {feedMsg && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold uppercase tracking-widest ${
              feedMsg.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : feedMsg.type === 'info'
                ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
            }`}>
              {feedMsg.type === 'success' ? <CheckCircle size={14} /> : feedMsg.type === 'info' ? <RefreshCw size={14} className="animate-spin" /> : <AlertCircle size={14} />}
              {feedMsg.text}
            </div>
          )}

          {/* Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={handleSaveFeed}
              disabled={feedSaving}
              className="flex-1 py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Save size={14} />
              {feedSaving ? 'Saving...' : 'Save Feed'}
            </button>
            <button
              onClick={() => handleSync()}
              disabled={feedSyncing || !activeFeed}
              className="flex-1 py-3 bg-surface-900 hover:bg-surface-800 text-surface-300 text-xs font-black uppercase tracking-widest rounded-xl border border-surface-800 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Zap size={14} />
              {feedSyncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      </div>

      {/* Dealership Contact — full width */}
      <div className="glass-card overflow-hidden">
        <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 shadow-glow">
            <MapPin size={20} />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Dealership Contact</h2>
            <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">Address & Sales Representative</p>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {contactMsg && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold uppercase tracking-widest ${
              contactMsg.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
            }`}>
              {contactMsg.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {contactMsg.text}
            </div>
          )}

          <p className="text-[11px] text-surface-500 leading-relaxed">
            This information is included in appointment confirmation emails and calendar invites sent to buyers.
          </p>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                <MapPin size={12} className="text-amber-500/50" />
                Dealership Address
              </label>
              <input
                type="text"
                value={dealerAddress}
                onChange={e => setDealerAddress(e.target.value)}
                placeholder="123 Main St, City, State ZIP"
                className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2">
                <Phone size={12} className="text-amber-500/50" />
                Sales Rep Phone
              </label>
              <input
                type="tel"
                value={salesPhone}
                onChange={e => setSalesPhone(e.target.value)}
                placeholder="(555) 555-5555"
                className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
              />
            </div>

            <button
              onClick={handleSaveContact}
              disabled={contactSaving}
              className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Save size={14} />
              {contactSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Email Configuration — full width */}
      <div className="glass-card overflow-hidden">
        <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 shadow-glow-green">
            <Mail size={20} />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Email & Calendar Invites</h2>
            <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">Automatic Confirmation Emails</p>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {emailMsg && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold uppercase tracking-widest ${
              emailMsg.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
            }`}>
              {emailMsg.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {emailMsg.text}
            </div>
          )}

          <p className="text-[11px] text-surface-500 leading-relaxed">
            When a buyer books an appointment and provides their email, the system automatically sends a confirmation email with a calendar invite attached. Configure your Gmail below to enable this.
          </p>

          <div className="flex items-center gap-3 p-4 rounded-2xl bg-surface-950/50 border border-surface-900/50">
            <div className={`w-2 h-2 rounded-full ${emailStatus?.configured ? 'bg-emerald-500 shadow-glow-green' : 'bg-rose-500 shadow-glow-red'} animate-pulse`} />
            <p className={`text-xs font-black uppercase tracking-widest ${emailStatus?.configured ? 'text-emerald-400' : 'text-rose-400'}`}>
              {emailStatus?.configured ? 'Active' : 'Not Connected'}
            </p>
            {emailStatus?.address && (
              <span className="text-[10px] text-surface-500 ml-auto">{emailStatus.address}</span>
            )}
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Your Gmail Address</label>
              <input
                type="email"
                value={gmailAddress}
                onChange={e => setGmailAddress(e.target.value)}
                placeholder="you@gmail.com"
                className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">App Password</label>
              <input
                type="password"
                value={gmailAppPassword}
                onChange={e => setGmailAppPassword(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                className="w-full px-4 py-3 rounded-xl bg-surface-950/50 border border-surface-800/50 text-surface-200 text-sm placeholder-surface-700 focus:border-brand-500/50 focus:outline-none transition-colors"
              />
              <p className="text-[10px] text-surface-600 leading-relaxed mt-1">
                This is NOT your Gmail password. Go to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:text-brand-300 underline">Google App Passwords</a>, create one for "Mail", and paste the 16-character code here.
              </p>
            </div>
            <button
              onClick={handleSaveGmail}
              disabled={gmailSaving}
              className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Save size={14} />
              {gmailSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
