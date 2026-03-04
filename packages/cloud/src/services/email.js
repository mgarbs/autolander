'use strict';

// TODO: Phase 3 — Port from email-sender.js, store config in OrgSettings

module.exports = {
  async sendEmail(orgSettings, { to, subject, body }) {
    console.log(`[email] Stub: would send to ${to}: ${subject}`);
    return false;
  },
};
