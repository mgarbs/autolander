'use strict';

module.exports = {
  HEARTBEAT_INTERVAL_MS: 30000,
  HEARTBEAT_TIMEOUT_MS: 60000,
  RECONNECT_DELAY_MS: 5000,
  DEFAULT_COMMAND_TIMEOUT_MS: 120000,

  LEAD_SCORE_THRESHOLDS: {
    HOT: 70,
    WARM: 45,
    COLD: 20,
  },

  WS_PATHS: {
    AGENT: '/ws/agent',
    DASHBOARD: '/ws/dashboard',
  },
};
