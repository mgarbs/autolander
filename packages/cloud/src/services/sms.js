'use strict';

// TODO: Phase 3 — Port from notifier.js, store config in OrgSettings

module.exports = {
  async sendSms(orgSettings, { to, body }) {
    console.log(`[sms] Stub: would send to ${to}: ${body}`);
    return false;
  },
};
