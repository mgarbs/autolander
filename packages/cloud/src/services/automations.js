'use strict';

const emailService = require('./email');

function buildVehicleTitle(vehicle) {
  if (!vehicle) {
    return 'Vehicle';
  }

  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Vehicle';
}

function buildAutomationMessage(email) {
  return `[SYSTEM: Confirmation email + calendar invite sent to ${email}]`;
}

function toICSDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function generateICS({ uid, summary, description, location, start, end, organizerEmail, attendeeEmail }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AutoLander//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(start)}`,
    `DTEND:${toICSDate(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${(description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${location || ''}`,
    `STATUS:CONFIRMED`,
    `SEQUENCE:0`,
  ];
  if (organizerEmail) {
    lines.push(`ORGANIZER;CN=Dealer:mailto:${organizerEmail}`);
  }
  if (attendeeEmail) {
    lines.push(`ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

module.exports = {
  async runPostToolAutomations(prisma, orgId, conversationId) {
    try {
      if (!prisma || !orgId || !conversationId) {
        return;
      }

      const [conversation, orgSettings, org] = await Promise.all([
        prisma.conversation.findFirst({
          where: { id: conversationId, orgId },
          include: { vehicle: true },
        }),
        prisma.orgSettings.findUnique({
          where: { orgId },
        }),
        prisma.organization.findFirst({
          where: { id: orgId },
        }),
      ]);

      if (!conversation) {
        return;
      }

      const buyerEmail = conversation.buyerEmail
        ? conversation.buyerEmail.trim().toLowerCase()
        : '';

      if (
        conversation.state !== 'APPOINTMENT_SET' ||
        !buyerEmail ||
        !conversation.buyerName
      ) {
        return;
      }

      const automationMessage = buildAutomationMessage(buyerEmail);

      // Build appointment query scoped to THIS conversation's vehicle.
      // Without vehicleId filter, concurrent auto-replies for the same buyer
      // (e.g. Romeo inquiring about CX-30 AND Kia Telluride) race and the
      // wrong appointment gets attached to the email.
      const apptWhere = {
        orgId,
        buyerName: {
          equals: conversation.buyerName,
          mode: 'insensitive',
        },
        status: 'SCHEDULED',
      };
      if (conversation.vehicleId) {
        apptWhere.vehicleId = conversation.vehicleId;
      }

      const [appt, existingAutomation] = await Promise.all([
        prisma.appointment.findFirst({
          where: apptWhere,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.message.findFirst({
          where: {
            conversationId,
            direction: 'OUTBOUND',
            intent: 'tool_action',
            text: automationMessage,
          },
        }),
      ]);

      if (!appt || existingAutomation) {
        return;
      }

      const vehicleTitle = buildVehicleTitle(conversation.vehicle);
      const subject = `Your appointment is confirmed \u2014 ${vehicleTitle}`;
      const body = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2>Hi ${conversation.buyerName}!</h2>
    <p>Your appointment is confirmed:</p>
    <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
      <strong>When:</strong> ${appt.scheduledTime.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}<br>
      <strong>Vehicle:</strong> ${vehicleTitle}<br>
      <strong>Where:</strong> ${org?.address || 'Our dealership'}<br>
      <strong>Phone:</strong> ${org?.phone || ''}
    </div>
    <p>We'll have the ${vehicleTitle} pulled up and ready for you. If anything changes, just reply to this email or message us back on Facebook.</p>
    <p>See you soon!<br>${org?.name || 'The Team'}</p>
  </div>`;

      const endTime = new Date(appt.scheduledTime.getTime() + 30 * 60000);
      const gmailUser = orgSettings?.gmailAddress || process.env.GMAIL_USER;
      const icsContent = generateICS({
        uid: `appt-${appt.id}@autolander`,
        summary: `${vehicleTitle} Showing`,
        description: `Buyer: ${conversation.buyerName}\nVehicle: ${vehicleTitle}`,
        location: org?.address || 'Our dealership',
        start: appt.scheduledTime,
        end: endTime,
        organizerEmail: gmailUser || undefined,
        attendeeEmail: buyerEmail,
      });

      const emailOrgSettings = {
        gmailUser: orgSettings?.gmailAddress,
        gmailAppPassword: orgSettings?.gmailAppPassword,
      };
      const sent = await emailService.sendEmail(emailOrgSettings, {
        to: buyerEmail,
        subject,
        body,
        icalEvent: icsContent,
      });

      if (!sent) {
        return;
      }

      // Log the automation action (idempotency check already done above via existingAutomation)
      await prisma.message.create({
        data: {
          conversationId,
          direction: 'OUTBOUND',
          text: automationMessage,
          intent: 'tool_action',
          status: 'DELIVERED',
          attempts: 0,
        },
      });
    } catch (error) {
      console.error('[automations]', error);
    }
  },
};
