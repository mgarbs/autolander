import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFbAuthStatus, deleteFbSession, getDealerConfig, saveDealerConfig, triggerSync, getSyncProgress, getGoogleStatus, uploadGoogleCredentials, getGoogleAuthUrl, disconnectGoogle, saveGmailConfig } from '../api/client';
import {
  Settings as SettingsIcon,
  Facebook,
  Database,
  Info,
  ShieldCheck,
  RefreshCw,
  LogOut,
  Clock,
  Calendar,
  Key,
  Activity,
  Link2,
  Save,
  Zap,
  CheckCircle,
  AlertCircle,
  Mail,
  Upload,
  Unplug
} from 'lucide-react';
import { motion } from 'framer-motion';
import Badge from '../components/Badge';

export default function Settings() {
  const navigate = useNavigate();
  const [fbStatus, setFbStatus] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Dealer / Inventory Feed state
  const [feedUrl, setFeedUrl] = useState('');
  const [dealerName, setDealerName] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [dealerConfig, setDealerConfig] = useState(null);
  const [feedSaving, setFeedSaving] = useState(false);
  const [feedSyncing, setFeedSyncing] = useState(false);
  const [feedMsg, setFeedMsg] = useState(null);

  // Google Services state
  const [googleStatus, setGoogleStatus] = useState(null);
  const [googleMsg, setGoogleMsg] = useState(null);
  const [gmailAddress, setGmailAddress] = useState('');
  const [gmailAppPassword, setGmailAppPassword] = useState('');
  const [gmailSaving, setGmailSaving] = useState(false);
  const [calConnecting, setCalConnecting] = useState(false);

  const SYNC_STATE_KEY = 'autolander_sync_state';
  const GOOGLE_OAUTH_HOSTS = new Set([
    'accounts.google.com',
    'oauth2.googleapis.com',
  ]);

  const isSafeGoogleAuthUrl = (value) => {
    if (typeof value !== 'string') return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && GOOGLE_OAUTH_HOSTS.has(parsed.hostname);
    } catch {
      return false;
    }
  };

  const loadStatus = () => getFbAuthStatus().then(setFbStatus).catch(() => {});

  const loadDealerConfig = () =>
    getDealerConfig()
      .then(cfg => {
        setDealerConfig(cfg);
        const primary = (cfg.dealers || []).find(d => d.id === 'primary');
        if (primary) {
          setFeedUrl(primary.url || '');
          setDealerName(primary.name || '');
          setAutoGenerate(primary.options?.autoGenerate !== false);
        }
        return cfg;
      })
      .catch(() => {});

  // Poll sync progress — works both for fresh syncs and resuming after navigation
  const pollSyncProgress = async () => {
    const INTERVAL = 1500;
    const TIMEOUT = 300_000; // 5 minutes
    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, INTERVAL));
      try {
        const progress = await getSyncProgress();
        if (!progress || progress.stage === 'idle') {
          // Sync ended (progress file cleared or never existed) — check final result
          await loadDealerConfig();
          finishSync({ type: 'success', text: 'Sync complete' });
          return;
        }
        // Show live progress message
        if (progress.stage === 'complete') {
          await loadDealerConfig();
          finishSync({ type: 'success', text: progress.message });
          return;
        }
        if (progress.stage === 'error') {
          finishSync({ type: 'error', text: progress.message });
          return;
        }
        // Still in progress — update the message
        setFeedMsg({ type: 'info', text: progress.message });
      } catch { /* keep polling */ }
    }

    finishSync({ type: 'error', text: 'Sync timed out — check server logs' });
  };

  const loadGoogleStatus = () =>
    getGoogleStatus()
      .then(s => {
        setGoogleStatus(s);
        if (s.email?.address && !gmailAddress) setGmailAddress(s.email.address);
      })
      .catch(() => {});

  // On mount: check if a sync is already running (e.g. navigated away and came back)
  useEffect(() => {
    loadStatus();
    loadDealerConfig();
    loadGoogleStatus();

    // Check for Google OAuth redirect result
    const params = new URLSearchParams(window.location.search);
    const googleResult = params.get('google');
    if (googleResult === 'connected') {
      setGoogleMsg({ type: 'success', text: 'Google Calendar connected successfully' });
      window.history.replaceState({}, '', '/settings');
    } else if (googleResult === 'error') {
      setGoogleMsg({ type: 'error', text: 'Google Calendar authorization failed — please try again' });
      window.history.replaceState({}, '', '/settings');
    }

    // Check if sync is in-flight
    const saved = localStorage.getItem(SYNC_STATE_KEY);
    if (saved) {
      try {
        const { syncStartTime } = JSON.parse(saved);
        if (Date.now() - syncStartTime < 300_000) {
          setFeedSyncing(true);
          setFeedMsg({ type: 'info', text: 'Syncing inventory — reconnecting...' });
          pollSyncProgress();
          return;
        }
      } catch { /* ignore */ }
      localStorage.removeItem(SYNC_STATE_KEY);
    }
  }, []);

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

  const handleSaveFeed = async () => {
    if (!feedUrl.trim()) { setFeedMsg({ type: 'error', text: 'Enter a feed URL' }); return; }
    setFeedSaving(true);
    setFeedMsg(null);
    try {
      await saveDealerConfig({ url: feedUrl.trim(), name: dealerName.trim(), enabled: true, autoGenerate });
      await loadDealerConfig();
      setFeedMsg({ type: 'success', text: 'Feed saved successfully' });
    } catch (e) {
      setFeedMsg({ type: 'error', text: 'Failed to save: ' + e.message });
    } finally {
      setFeedSaving(false);
    }
  };

  const finishSync = (msg) => {
    localStorage.removeItem(SYNC_STATE_KEY);
    setFeedMsg(msg);
    setFeedSyncing(false);
  };

  const handleSync = async () => {
    setFeedSyncing(true);
    setFeedMsg({ type: 'info', text: 'Starting sync...' });
    try {
      localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ syncStartTime: Date.now() }));
      await triggerSync();
      await pollSyncProgress();
    } catch (e) {
      finishSync({ type: 'error', text: 'Sync failed: ' + e.message });
    }
  };

  const handleCredentialsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setGoogleMsg(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await uploadGoogleCredentials(json);
      await loadGoogleStatus();
      setGoogleMsg({ type: 'success', text: 'Credentials uploaded successfully' });
    } catch (err) {
      setGoogleMsg({ type: 'error', text: 'Invalid credentials file: ' + err.message });
    }
    e.target.value = '';
  };

  const handleConnectCalendar = async () => {
    setCalConnecting(true);
    setGoogleMsg(null);
    try {
      const { url } = await getGoogleAuthUrl();
      if (!isSafeGoogleAuthUrl(url)) {
        throw new Error('Received an invalid Google authorization URL');
      }
      window.location.assign(url);
    } catch (err) {
      setGoogleMsg({ type: 'error', text: 'Failed to get auth URL: ' + err.message });
      setCalConnecting(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    if (!confirm('Disconnect Google Calendar? Appointments will no longer sync.')) return;
    setGoogleMsg(null);
    try {
      await disconnectGoogle();
      await loadGoogleStatus();
      setGoogleMsg({ type: 'success', text: 'Google Calendar disconnected' });
    } catch (err) {
      setGoogleMsg({ type: 'error', text: 'Failed to disconnect: ' + err.message });
    }
  };

  const handleSaveGmail = async () => {
    if (!gmailAddress.trim() || !gmailAppPassword.trim()) {
      setGoogleMsg({ type: 'error', text: 'Enter both Gmail address and App Password' });
      return;
    }
    setGmailSaving(true);
    setGoogleMsg(null);
    try {
      await saveGmailConfig({ address: gmailAddress.trim(), appPassword: gmailAppPassword.trim() });
      await loadGoogleStatus();
      setGmailAppPassword('');
      setGoogleMsg({ type: 'success', text: 'Gmail configuration saved' });
    } catch (err) {
      setGoogleMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setGmailSaving(false);
    }
  };

  // Calendar status: green=connected, amber=credentials uploaded, red=none
  const calStatus = googleStatus?.calendar?.connected
    ? { color: 'emerald', label: 'Your Calendar Is Synced' }
    : googleStatus?.calendar?.credentialsUploaded
    ? { color: 'amber', label: 'Almost Ready — Sign In to Finish' }
    : { color: 'rose', label: 'Not Connected' };

  const primaryDealer = (dealerConfig?.dealers || []).find(d => d.id === 'primary');

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
                           <Calendar size={12} />
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
          {/* Feed URL */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Feed URL</label>
            <input
              type="url"
              value={feedUrl}
              onChange={e => setFeedUrl(e.target.value)}
              placeholder="https://www.cargurus.com/Cars/inventorylisting/..."
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
          {primaryDealer && primaryDealer.lastScrape && (
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
                    {new Date(primaryDealer.lastScrape).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                  <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Status</span>
                  <Badge variant={primaryDealer.lastScrapeStatus?.startsWith('success') ? 'brand' : 'danger'} size="xs">
                    {primaryDealer.lastScrapeStatus?.startsWith('success') ? 'OK' : 'ERROR'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/30 border border-surface-800/50">
                  <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Vehicles</span>
                  <span className="text-[11px] font-black text-brand-400 uppercase">
                    {primaryDealer.lastScrapeStats?.validCount ?? '—'}
                  </span>
                </div>
              </div>
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
              onClick={handleSync}
              disabled={feedSyncing || !primaryDealer}
              className="flex-1 py-3 bg-surface-900 hover:bg-surface-800 text-surface-300 text-xs font-black uppercase tracking-widest rounded-xl border border-surface-800 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Zap size={14} />
              {feedSyncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      </div>

      {/* Google Services — full width */}
      <div className="glass-card overflow-hidden">
        <div className="p-6 border-b border-surface-900/50 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 shadow-glow-green">
            <Calendar size={20} />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-white leading-none">Appointments & Email</h2>
            <p className="text-[10px] text-surface-500 uppercase font-bold tracking-widest mt-1">Google Calendar & Gmail Integration</p>
          </div>
        </div>

        <div className="p-6 space-y-8">
          {/* Messages */}
          {googleMsg && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold uppercase tracking-widest ${
              googleMsg.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
            }`}>
              {googleMsg.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {googleMsg.text}
            </div>
          )}

          {googleStatus ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Google Calendar */}
              <div className="space-y-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-surface-400 flex items-center gap-2">
                  <Calendar size={12} />
                  Appointment Calendar
                </h3>
                <p className="text-[11px] text-surface-500 leading-relaxed -mt-2">
                  Connect your Google Calendar so the bot can check your real availability and book test drives directly onto your schedule.
                </p>

                <div className="flex items-center gap-3 p-4 rounded-2xl bg-surface-950/50 border border-surface-900/50">
                  <div className={`w-2 h-2 rounded-full animate-pulse ${
                    googleStatus.calendar.connected
                      ? 'bg-emerald-500 shadow-glow-green'
                      : googleStatus.calendar.credentialsUploaded
                      ? 'bg-amber-500 shadow-glow-amber'
                      : 'bg-rose-500 shadow-glow-red'
                  }`} />
                  <p className={`text-xs font-black uppercase tracking-widest ${
                    googleStatus.calendar.connected
                      ? 'text-emerald-400'
                      : googleStatus.calendar.credentialsUploaded
                      ? 'text-amber-400'
                      : 'text-rose-400'
                  }`}>
                    {calStatus.label}
                  </p>
                </div>

                {!googleStatus.calendar.credentialsUploaded && (
                  <div className="space-y-3">
                    <div className="p-4 rounded-2xl bg-surface-950/30 border border-surface-900/50 space-y-2">
                      <h4 className="text-[10px] font-black uppercase tracking-widest text-surface-300 flex items-center gap-2">
                        <Info size={11} />
                        One-Time Setup
                      </h4>
                      <p className="text-[11px] text-surface-500 leading-relaxed">
                        Your admin needs to create a Google Cloud project and download the credentials file. Once you have it, upload it here and then sign in with your Google account.
                      </p>
                    </div>
                    <label className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2 cursor-pointer">
                      <Upload size={14} />
                      Upload Setup File
                      <input type="file" accept=".json" onChange={handleCredentialsUpload} className="hidden" />
                    </label>
                  </div>
                )}

                {googleStatus.calendar.credentialsUploaded && !googleStatus.calendar.connected && (
                  <div className="space-y-3">
                    <p className="text-[11px] text-surface-500 leading-relaxed">
                      Setup file uploaded. Now sign in with Google to give the bot access to your calendar.
                    </p>
                    <button
                      onClick={handleConnectCalendar}
                      disabled={calConnecting}
                      className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      <Calendar size={14} />
                      {calConnecting ? 'Redirecting to Google...' : 'Sign In with Google'}
                    </button>
                  </div>
                )}

                {googleStatus.calendar.connected && (
                  <div className="space-y-3">
                    <p className="text-[11px] text-surface-500 leading-relaxed">
                      The bot will check your calendar before offering appointment times and add confirmed test drives automatically.
                    </p>
                    <button
                      onClick={handleDisconnectGoogle}
                      className="w-full py-3 bg-surface-900 hover:bg-surface-800 text-surface-400 text-xs font-black uppercase tracking-widest rounded-xl border border-surface-800 transition-all flex items-center justify-center gap-2"
                    >
                      <Unplug size={14} />
                      Disconnect Calendar
                    </button>
                  </div>
                )}

                {googleStatus.calendar.credentialsUploaded && (
                  <label className="w-full py-2 bg-surface-900/50 hover:bg-surface-800 text-surface-500 text-[10px] font-bold uppercase tracking-widest rounded-xl border border-surface-800/50 transition-all flex items-center justify-center gap-2 cursor-pointer">
                    <Upload size={11} />
                    Replace Setup File
                    <input type="file" accept=".json" onChange={handleCredentialsUpload} className="hidden" />
                  </label>
                )}
              </div>

              {/* Gmail Email */}
              <div className="space-y-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-surface-400 flex items-center gap-2">
                  <Mail size={12} />
                  Email Notifications
                </h3>
                <p className="text-[11px] text-surface-500 leading-relaxed -mt-2">
                  Get emailed when a hot lead needs your attention, and send buyers automatic appointment confirmations.
                </p>

                <div className="flex items-center gap-3 p-4 rounded-2xl bg-surface-950/50 border border-surface-900/50">
                  <div className={`w-2 h-2 rounded-full ${googleStatus.email.configured ? 'bg-emerald-500 shadow-glow-green' : 'bg-rose-500 shadow-glow-red'} animate-pulse`} />
                  <p className={`text-xs font-black uppercase tracking-widest ${googleStatus.email.configured ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {googleStatus.email.configured ? 'Active' : 'Not Connected'}
                  </p>
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
          ) : (
            <div className="flex items-center justify-center py-10 opacity-30">
              <RefreshCw size={24} className="animate-spin" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
