'use strict';

const nodemailer = require('nodemailer');

const transporterCache = new Map();

function getEmailCredentials(orgSettings) {
  const gmailUser = orgSettings?.gmailUser || process.env.GMAIL_USER;
  const gmailAppPassword =
    orgSettings?.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

  return { gmailUser, gmailAppPassword };
}

module.exports = {
  async sendEmail(orgSettings, { to, subject, body, icalEvent }) {
    try {
      const { gmailUser, gmailAppPassword } = getEmailCredentials(orgSettings);

      if (!gmailUser || !gmailAppPassword) {
        console.warn(
          '[email] Missing Gmail credentials (orgSettings/env). Email not sent.'
        );
        return false;
      }

      let transporter = transporterCache.get(gmailUser);
      if (!transporter) {
        transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: gmailUser, pass: gmailAppPassword },
        });
        transporterCache.set(gmailUser, transporter);
      }

      const mailOpts = {
        from: gmailUser,
        to,
        subject,
        html: body,
      };
      if (icalEvent) {
        mailOpts.icalEvent = {
          method: 'REQUEST',
          content: icalEvent,
        };
      }
      await transporter.sendMail(mailOpts);

      console.log(`[email] Sent email to ${to}: ${subject}`);
      return true;
    } catch (error) {
      console.error(`[email] Failed to send email to ${to}:`, error);
      return false;
    }
  },
};
