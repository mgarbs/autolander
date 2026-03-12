'use strict';

const twilio = require('twilio');

const clientCache = new Map();

function getSmsCredentials(orgSettings) {
  const twilioAccountSid =
    orgSettings?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken =
    orgSettings?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
  const twilioPhoneNumber =
    orgSettings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;

  return { twilioAccountSid, twilioAuthToken, twilioPhoneNumber };
}

module.exports = {
  async sendSms(orgSettings, { to, body }) {
    try {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } =
        getSmsCredentials(orgSettings);

      if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
        console.warn(
          '[sms] Missing Twilio credentials (orgSettings/env). SMS not sent.'
        );
        return false;
      }

      let client = clientCache.get(twilioAccountSid);
      if (!client) {
        client = twilio(twilioAccountSid, twilioAuthToken);
        clientCache.set(twilioAccountSid, client);
      }

      await client.messages.create({
        body,
        from: twilioPhoneNumber,
        to,
      });

      console.log(`[sms] Sent SMS to ${to}`);
      return true;
    } catch (error) {
      console.error(`[sms] Failed to send SMS to ${to}:`, error);
      return false;
    }
  },
};
