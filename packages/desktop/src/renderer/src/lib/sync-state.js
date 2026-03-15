let currentSyncState = null;
const listeners = new Set();

export function setSyncState(state) {
  currentSyncState = state;
  listeners.forEach((listener) => listener(state));
}

export function getSyncState() {
  return currentSyncState;
}

export function onSyncStateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearSyncState() {
  currentSyncState = null;
  listeners.forEach((listener) => listener(null));
}
