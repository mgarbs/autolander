'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Listen for auth expiry from backend services and redirect to login
ipcRenderer.on('auth:expired', () => {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  window.location.hash = '#/login';
});

contextBridge.exposeInMainWorld('autolander', {
  fetchFeedHtml: (url) => ipcRenderer.invoke('feed:fetch-html', url),
  fetchFeedImages: (feed) => ipcRenderer.invoke('feed:fetch-images', feed),
  stopFeedImageFetch: (feedId) => ipcRenderer.invoke('feed:stop-image-fetch', feedId),
  onFeedSyncProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('feed:sync-progress', listener);
    return () => ipcRenderer.removeListener('feed:sync-progress', listener);
  },
  onFeedAutoSync: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('feed:auto-sync', listener);
    return () => ipcRenderer.removeListener('feed:auto-sync', listener);
  },
  onImageFetchProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('feed:image-fetch', listener);
    return () => ipcRenderer.removeListener('feed:image-fetch', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Agent connection
  agent: {
    login: (opts) => ipcRenderer.invoke('agent:login', opts),
    logout: () => ipcRenderer.invoke('agent:logout'),
    getStatus: () => ipcRenderer.invoke('agent:get-status'),
    getConfig: () => ipcRenderer.invoke('agent:get-config'),
    onStatusUpdate: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('agent:status-update', listener);
      return () => ipcRenderer.removeListener('agent:status-update', listener);
    },
  },

  autoresponder: {
    pause: () => ipcRenderer.invoke('autoresponder:pause'),
    resume: () => ipcRenderer.invoke('autoresponder:resume'),
  },

  // Facebook operations
  fb: {
    login: () => ipcRenderer.invoke('fb:login'),
    getStatus: () => ipcRenderer.invoke('fb:get-status'),
    postVehicle: (opts) => ipcRenderer.invoke('fb:post-vehicle', opts),
    checkInbox: () => ipcRenderer.invoke('fb:check-inbox'),
    sendMessage: (opts) => ipcRenderer.invoke('fb:send-message', opts),
    startAssistedPost: (opts) => ipcRenderer.invoke('fb:start-assisted-post', opts),
    cancelAssistedPost: () => ipcRenderer.invoke('fb:cancel-assisted-post'),
    sendInput: (data) => ipcRenderer.invoke('fb:send-input', data),
    updateListing: (opts) => ipcRenderer.invoke('fb:update-listing', opts),
    delistVehicle: (opts) => ipcRenderer.invoke('fb:delist-vehicle', opts),
    renewListing: (opts) => ipcRenderer.invoke('fb:renew-listing', opts),
    deleteSession: () => ipcRenderer.invoke('fb:delete-session'),
    onProgress: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('fb:progress', listener);
      return () => ipcRenderer.removeListener('fb:progress', listener);
    },
    onFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('fb:frame', listener);
      return () => ipcRenderer.removeListener('fb:frame', listener);
    },
  },

  // Auto-updates
  updates: {
    onAvailable: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('update:available', listener);
      return () => ipcRenderer.removeListener('update:available', listener);
    },
    onDownloaded: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('update:downloaded', listener);
      return () => ipcRenderer.removeListener('update:downloaded', listener);
    },
  },
});
