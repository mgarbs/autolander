'use strict';

// TODO: Phase 3 — Port from google-calendar.js, store creds in OrgSettings (DB)

module.exports = {
  async getAvailableSlots(orgSettings, date) {
    return [];
  },

  async createEvent(orgSettings, event) {
    return null;
  },

  async cancelEvent(orgSettings, eventId) {
    return false;
  },
};
