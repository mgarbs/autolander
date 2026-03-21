'use strict';

const express = require('express');
const aiService = require('../services/ai-service');
const automations = require('../services/automations');
const { Commands } = require('@autolander/shared/protocol');

module.exports = function createConversationsRouter(prisma) {
  const router = express.Router();

  // Per-conversation lock to prevent parallel auto-replies
  const autoReplyLocks = new Map();
  // Batched auto-reply: collect messages for 10s before responding.
  const autoReplyTimers = new Map();
  const BATCH_WINDOW_MS = 10 * 1000;

  function acquireLock(convId) {
    if (autoReplyLocks.get(convId)) return false;
    autoReplyLocks.set(convId, true);
    return true;
  }

  function releaseLock(convId) {
    autoReplyLocks.delete(convId);
  }

  async function resolveVehicle(orgId, title) {
    if (!title) return null;
    const rawTitle = title.trim();
    const yearMatch = rawTitle.match(/^(\d{4})\s+(\S+)\s+(\S+)/);
    const noYearMatch = !yearMatch && rawTitle.match(/^(\S+)\s+(\S+)/);
    const where = { orgId, status: 'ACTIVE' };
    if (yearMatch) {
      where.year = parseInt(yearMatch[1], 10);
      where.make = { contains: yearMatch[2], mode: 'insensitive' };
      where.model = { contains: yearMatch[3], mode: 'insensitive' };
    } else if (noYearMatch) {
      where.make = { contains: noYearMatch[1], mode: 'insensitive' };
      where.model = { contains: noYearMatch[2], mode: 'insensitive' };
    }
    if (!where.make) return null;
    try {
      const vehicle = await prisma.vehicle.findFirst({ where });
      return vehicle ? vehicle.id : null;
    } catch (err) {
      console.warn('[auto-reply] Vehicle lookup failed:', err.message);
      return null;
    }
  }

  function didSendMessageFail(result) {
    return Boolean(result && typeof result === 'object' && result.sent === false);
  }

  async function triggerAutoReply(convId, orgId, app) {
    if (!acquireLock(convId)) {
      console.log(`[auto-reply] Skipping - already processing conv ${convId}`);
      return;
    }

    try {
      let freshConv = await prisma.conversation.findFirst({
        where: { id: convId },
        include: { vehicle: true },
      });
      if (!freshConv) return;

      // Cooldown: don't auto-reply if we sent one within the last 30 seconds
      const lastAutoReply = await prisma.message.findFirst({
        where: {
          conversationId: convId,
          direction: 'OUTBOUND',
          intent: 'auto_reply',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (lastAutoReply) {
        const elapsed = Date.now() - lastAutoReply.createdAt.getTime();
        if (elapsed < 30000) {
          console.log(`[auto-reply] Cooldown: conv ${convId} replied ${Math.round(elapsed / 1000)}s ago, skipping`);
          return;
        }
        // Skip if a SENDING/SENT reply exists within the last 60s (desktop /respond path handled it)
        if (['SENDING', 'SENT'].includes(lastAutoReply.status) && elapsed < 60000) {
          console.log(`[auto-reply] Skipping conv ${convId} - recent ${lastAutoReply.status} reply exists (${Math.round(elapsed / 1000)}s ago)`);
          return;
        }
      }

      const allMessages = await prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      // Guard: only respond if the most recent non-tool message is INBOUND.
      // This prevents the AI from re-responding when no new buyer input exists.
      const realMessages = allMessages.filter(m => m.intent !== 'tool_action');
      const lastReal = realMessages.length > 0 ? realMessages[realMessages.length - 1] : null;
      if (!lastReal || lastReal.direction !== 'INBOUND') {
        console.log(`[auto-reply] Skipping conv ${convId} - last message is ${lastReal?.direction || 'none'}, not INBOUND`);
        return;
      }

      const formattedMessages = [];
      for (const m of allMessages) {
        const role = m.direction === 'INBOUND' ? 'user' : 'assistant';
        const text = m.intent === 'tool_action' ? m.text : m.text;

        if (
          formattedMessages.length > 0 &&
          formattedMessages[formattedMessages.length - 1].role === role
        ) {
          formattedMessages[formattedMessages.length - 1].content += `\n${text}`;
        } else {
          formattedMessages.push({ role, content: text });
        }
      }

      const orgSettings = await prisma.orgSettings.findUnique({
        where: { orgId },
      });

      const org = await prisma.organization.findFirst({
        where: { id: orgId },
      });

      const toolContext = { prisma, orgSettings, conversation: freshConv, orgId };
      let aiResult = await aiService.generateResponse(freshConv, formattedMessages, {
        orgId,
        dealerName: org?.name || 'our dealership',
        orgSettings,
      });

      const MAX_TOOL_ROUNDS = 4;
      let round = 0;
      let wasEscalated = false;
      const toolActionsLog = [];

      while (aiResult.toolCalls && aiResult.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        round++;
        const toolResults = [];
        for (const tc of aiResult.toolCalls) {
          if (tc.name === 'escalate_to_human') wasEscalated = true;
          const result = await aiService.executeToolCall(tc.name, tc.input, toolContext);
          toolResults.push({ tool_use_id: tc.id, content: result });
          toolActionsLog.push({ tool: tc.name, input: tc.input, result });
        }

        freshConv = await prisma.conversation.findFirst({
          where: { id: convId },
          include: { vehicle: true },
        });
        if (!freshConv) break;
        toolContext.conversation = freshConv;

        aiResult = await aiService.continueWithToolResults(
          freshConv,
          formattedMessages,
          aiResult.fullMessages,
          toolResults,
          {
            orgId,
            dealerName: org?.name || 'our dealership',
            orgSettings,
          }
        );
      }

      const stateChangingTools = [
        'book_appointment',
        'cancel_appointment',
        'update_buyer_info',
        'escalate_to_human',
      ];
      const actionEntries = toolActionsLog.filter(a => stateChangingTools.includes(a.tool));

      if (actionEntries.length > 0) {
        const summaries = actionEntries.map(a => {
          let parsed;
          try {
            parsed = JSON.parse(a.result);
          } catch {
            parsed = {};
          }

          switch (a.tool) {
            case 'book_appointment': {
              if (parsed.success) {
                const t = new Date(a.input.scheduledTime);
                const timeStr = t.toLocaleString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                });
                return parsed.alreadyExisted
                  ? `Appointment already exists: ${timeStr}`
                  : `Booked appointment: ${timeStr}`;
              }
              return `Failed to book: ${parsed.error || 'unknown'}`;
            }
            case 'cancel_appointment':
              return parsed.cancelled
                ? `Cancelled appointment (${a.input.reason || 'no reason'})`
                : `Cancel failed: ${parsed.reason || 'not found'}`;
            case 'update_buyer_info': {
              const parts = [];
              if (a.input.email) parts.push(`email: ${a.input.email}`);
              if (a.input.phone) parts.push(`phone: ${a.input.phone}`);
              if (a.input.fullName) parts.push(`name: ${a.input.fullName}`);
              if (a.input.financing) parts.push(`financing: ${a.input.financing}`);
              if (a.input.tradeIn) parts.push(`trade-in: ${a.input.tradeIn}`);
              return `Saved buyer info - ${parts.join(', ')}`;
            }
            case 'escalate_to_human':
              return `Escalated to human: ${a.input.reason}`;
            default:
              return `${a.tool}: done`;
          }
        });

        await prisma.message.create({
          data: {
            conversationId: convId,
            direction: 'OUTBOUND',
            text: `[ACTIONS: ${summaries.join(' | ')}]`,
            intent: 'tool_action',
            status: 'DELIVERED',
            attempts: 0,
          },
        });
      }

      if (!freshConv) return;

      // System automations: auto-send email + calendar invite if conditions met
      await automations.runPostToolAutomations(prisma, orgId, convId);

      console.log(`[auto-reply] Conv ${convId}: text="${(aiResult.text || '').slice(0, 80)}..." toolRounds=${round} escalated=${wasEscalated}`);

      if (aiResult.text && !wasEscalated) {
        const twoHoursAgoOut = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const duplicateOutbound = await prisma.message.findFirst({
          where: {
            conversationId: convId,
            direction: 'OUTBOUND',
            text: aiResult.text,
            createdAt: { gte: twoHoursAgoOut },
          },
        });
        if (duplicateOutbound) {
          console.log(`[auto-reply] Skipping duplicate outbound for conv ${convId}: "${aiResult.text.slice(0, 60)}..."`);
        } else {
          if (aiResult.text.length > 280) {
            let truncated = aiResult.text.slice(0, 280);
            const lastPeriod = truncated.lastIndexOf('.');
            const lastQuestion = truncated.lastIndexOf('?');
            const lastExclaim = truncated.lastIndexOf('!');
            const cutPoint = Math.max(lastPeriod, lastQuestion, lastExclaim);
            if (cutPoint > 150) {
              truncated = truncated.slice(0, cutPoint + 1);
            }
            console.log(`[auto-reply] Truncated response from ${aiResult.text.length} to ${truncated.length} chars`);
            aiResult.text = truncated;
          }

          // Mark as SENT immediately to prevent the pending-message sweep from re-sending
          const outboundMsg = await prisma.message.create({
            data: {
              conversationId: convId,
              direction: 'OUTBOUND',
              text: aiResult.text,
              intent: 'auto_reply',
              status: 'SENT',
              attempts: 1,
            },
          });

          const newState = freshConv.state === 'NEW' ? 'ENGAGED' : freshConv.state;
          await prisma.conversation.update({
            where: { id: convId },
            data: { state: newState, lastMessageAt: new Date() },
          });

          const dispatcher = app.get('commandDispatcher');
          const agentGateway = app.get('agentGateway');
          const dispatchListingTitle = freshConv.vehicle
            ? [freshConv.vehicle.year, freshConv.vehicle.make, freshConv.vehicle.model].filter(Boolean).join(' ')
            : '';

          if (dispatcher && agentGateway) {
            const onlineAgents = agentGateway.getOnlineAgents(orgId);
            if (onlineAgents.length > 0) {
              try {
                const dispatchResult = await dispatcher.dispatch(
                  orgId,
                  onlineAgents[0].id,
                  Commands.SEND_MESSAGE,
                  {
                    threadId: freshConv.threadId || freshConv.id,
                    fbThreadUrl: freshConv.fbThreadUrl || null,
                    text: aiResult.text,
                    expectedBuyer: freshConv.buyerName,
                    listingTitle: dispatchListingTitle,
                    messageId: outboundMsg.id,
                  }
                );
                if (didSendMessageFail(dispatchResult)) {
                  await prisma.message.update({
                    where: { id: outboundMsg.id },
                    data: { status: 'FAILED', attempts: 1 },
                  });
                  console.warn(`[auto-reply] Agent reported send failure for conv ${convId}, msg ${outboundMsg.id}`);
                } else {
                  console.log(`[auto-reply] Sent reply for conv ${convId}, msg ${outboundMsg.id}`);
                }
              } catch (err) {
                // Dispatch failed — mark back to PENDING so sweep can retry
                await prisma.message.update({
                  where: { id: outboundMsg.id },
                  data: { status: 'PENDING', attempts: 0 },
                });
                console.warn(`[auto-reply] Dispatch failed for conv ${convId}, msg ${outboundMsg.id}: ${err.message} — marked PENDING for retry`);
              }
            } else {
              // No agent online — mark PENDING so sweep retries when agent connects
              await prisma.message.update({
                where: { id: outboundMsg.id },
                data: { status: 'PENDING', attempts: 0 },
              });
              console.warn(`[auto-reply] No online agents for org ${orgId}, msg ${outboundMsg.id} — marked PENDING for retry`);
            }
          } else {
            await prisma.message.update({
              where: { id: outboundMsg.id },
              data: { status: 'PENDING', attempts: 0 },
            });
            console.warn(`[auto-reply] Command dispatch unavailable for org ${orgId}, msg ${outboundMsg.id} — marked PENDING for retry`);
          }
        }
      } else if (wasEscalated) {
        console.log(`[auto-reply] Conv ${convId} escalated to human`);
      }

      freshConv = await prisma.conversation.findFirst({
        where: { id: convId },
        include: { vehicle: true },
      });
      if (!freshConv) return;

      const freshMessages = await prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      const scoreResult = await aiService.scoreLeadAI(freshConv, freshMessages, { orgId });

      let finalScore = scoreResult.score;
      if (freshConv.state === 'APPOINTMENT_SET' && finalScore < 65) {
        finalScore = 65;
      }

      await prisma.conversation.update({
        where: { id: convId },
        data: {
          leadScore: finalScore,
          sentimentScore: finalScore,
        },
      });
      console.log(`[auto-reply] Lead scored: ${finalScore} (raw=${scoreResult.score}, ${scoreResult.sentiment}/${scoreResult.category})`);

      const clientGateway = app.get('clientGateway');
      if (clientGateway) {
        clientGateway.broadcast(orgId, {
          type: 'lead:updated',
          data: { buyerId: convId, conversationId: convId },
        });
      }
    } finally {
      releaseLock(convId);
    }
  }

  router.get('/pipeline', async (req, res) => {
    const orgId = req.orgId;
    const baseWhere = { orgId, archivedAt: null };
    if (req.user?.role === 'AGENT') {
      baseWhere.agentId = req.user.sub || req.user.id;
    }
    const [hot, warm, cold, dead] = await Promise.all([
      prisma.conversation.count({ where: { ...baseWhere, leadScore: { gte: 70 } } }),
      prisma.conversation.count({ where: { ...baseWhere, leadScore: { gte: 45, lt: 70 } } }),
      prisma.conversation.count({ where: { ...baseWhere, leadScore: { gte: 20, lt: 45 } } }),
      prisma.conversation.count({ where: { ...baseWhere, leadScore: { lt: 20 } } }),
    ]);
    res.json({ hot, warm, cold, dead });
  });

  router.get('/', async (req, res) => {
    const { sentiment, state, agentId, limit = '50', offset = '0' } = req.query;
    const where = { orgId: req.orgId, archivedAt: null };

    if (sentiment === 'hot') where.leadScore = { gte: 70 };
    else if (sentiment === 'warm') where.leadScore = { gte: 45, lt: 70 };
    else if (sentiment === 'cold') where.leadScore = { gte: 20, lt: 45 };
    else if (sentiment === 'dead') where.leadScore = { lt: 20 };

    if (state) where.state = state;
    if (agentId) where.agentId = agentId;

    // AGENT users only see their own leads; ADMIN/MANAGER see all
    if (!agentId && req.user?.role === 'AGENT') {
      where.agentId = req.user.sub || req.user.id;
    }

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        vehicle: { select: { year: true, make: true, model: true, vin: true } },
        agent: { select: { displayName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    res.json(conversations);
  });

  router.post('/', async (req, res) => {
    const { buyerName, buyerId, state, leadScore, vehicleId, agentId } = req.body;
    if (!buyerName) return res.status(400).json({ error: 'buyerName is required.' });

    const conversation = await prisma.conversation.create({
      data: {
        orgId: req.orgId,
        buyerName,
        buyerId: buyerId || null,
        state: state || 'NEW',
        leadScore: leadScore !== undefined ? parseInt(leadScore) : 20,
        vehicleId: vehicleId || null,
        agentId: agentId || req.user.sub,
        lastMessageAt: new Date(),
      },
    });
    res.status(201).json(conversation);
  });

  router.post('/:threadId/respond', async (req, res) => {
    const orgId = req.orgId;
    const userId = req.user?.id || req.user?.sub;
    const threadId = req.params.threadId;
    const { buyerName, listingTitle, lastBuyerMessageText, messages: scrapedMessages } = req.body;

    if (!Array.isArray(scrapedMessages) || scrapedMessages.length === 0) {
      return res.json({ reply: null });
    }

    const lastMsg = scrapedMessages[scrapedMessages.length - 1];
    if (!lastMsg || !lastMsg.isBuyer) {
      return res.json({ reply: null, reason: 'last_message_not_from_buyer' });
    }

    let conv = await prisma.conversation.findFirst({
      where: { threadId, orgId },
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!conv) {
      // Try listing title first, then scan messages for vehicle mentions
      let matchedVehicleId = await resolveVehicle(orgId, listingTitle);
      if (!matchedVehicleId) {
        for (const m of scrapedMessages) {
          const vMatch = (m.text || '').match(/\b(19\d{2}|20[0-3]\d)\s+(\w+)\s+([\w-]+)/);
          if (vMatch) {
            matchedVehicleId = await resolveVehicle(orgId, `${vMatch[1]} ${vMatch[2]} ${vMatch[3]}`);
            if (matchedVehicleId) break;
          }
        }
      }
      conv = await prisma.conversation.create({
        data: {
          threadId,
          orgId,
          buyerName: buyerName || 'Unknown Buyer',
          buyerId: null,
          state: 'NEW',
          leadScore: 20,
          vehicleId: matchedVehicleId,
          agentId: userId,
          lastMessageAt: new Date(),
        },
        include: { vehicle: true },
      });
      console.log(`[respond] Created conversation ${conv.id} for thread ${threadId}`);
    }

    if (!conv.vehicleId) {
      let matchedVehicleId = listingTitle ? await resolveVehicle(orgId, listingTitle) : null;
      if (!matchedVehicleId) {
        for (const m of scrapedMessages) {
          const vMatch = (m.text || '').match(/\b(19\d{2}|20[0-3]\d)\s+(\w+)\s+([\w-]+)/);
          if (vMatch) {
            matchedVehicleId = await resolveVehicle(orgId, `${vMatch[1]} ${vMatch[2]} ${vMatch[3]}`);
            if (matchedVehicleId) break;
          }
        }
      }
      if (matchedVehicleId) {
        conv = await prisma.conversation.update({
          where: { id: conv.id },
          data: { vehicleId: matchedVehicleId },
          include: { vehicle: true },
        });
      }
    }

    if (
      buyerName &&
      buyerName !== 'Unknown Buyer' &&
      buyerName !== 'Unknown' &&
      (conv.buyerName === 'Unknown Buyer' || conv.buyerName === 'Unknown')
    ) {
      conv = await prisma.conversation.update({
        where: { id: conv.id },
        data: { buyerName },
        include: { vehicle: true },
      });
    }

    const updates = {};
    for (const m of scrapedMessages) {
      if (!m.isBuyer) continue;
      const text = m.text || '';
      if (!conv.buyerEmail) {
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) updates.buyerEmail = emailMatch[0].toLowerCase();
      }
      if (!conv.buyerPhone) {
        const phoneMatch = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
        if (phoneMatch) {
          const digits = phoneMatch[0].replace(/\D/g, '');
          if (digits.length >= 10) {
            updates.buyerPhone = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
          }
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      conv = await prisma.conversation.update({
        where: { id: conv.id },
        data: updates,
        include: { vehicle: true },
      });
    }

    const lastAutoReply = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: 'OUTBOUND', intent: 'auto_reply' },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAutoReply) {
      const elapsed = Date.now() - lastAutoReply.createdAt.getTime();
      if (elapsed < 30000) {
        return res.json({ reply: null, reason: 'cooldown' });
      }
    }

    const formattedMessages = [];
    for (const m of scrapedMessages) {
      const role = m.isBuyer ? 'user' : 'assistant';
      const text = (m.text || '').trim();
      if (!text) continue;
      if (
        formattedMessages.length > 0 &&
        formattedMessages[formattedMessages.length - 1].role === role
      ) {
        formattedMessages[formattedMessages.length - 1].content += `\n${text}`;
      } else {
        formattedMessages.push({ role, content: text });
      }
    }

    const orgSettings = await prisma.orgSettings.findUnique({ where: { orgId } });
    const org = await prisma.organization.findFirst({ where: { id: orgId } });

    const toolContext = { prisma, orgSettings, conversation: conv, orgId };
    let aiResult = await aiService.generateResponse(conv, formattedMessages, {
      orgId,
      dealerName: org?.name || 'our dealership',
      orgSettings,
    });

    const MAX_TOOL_ROUNDS = 4;
    let round = 0;
    while (aiResult.toolCalls && aiResult.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      round += 1;
      const toolResults = [];
      for (const tc of aiResult.toolCalls) {
        const result = await aiService.executeToolCall(tc.name, tc.input, toolContext);
        toolResults.push({ tool_use_id: tc.id, content: result });
      }

      conv = await prisma.conversation.findFirst({
        where: { id: conv.id },
        include: { vehicle: true },
      });
      if (!conv) break;
      toolContext.conversation = conv;

      aiResult = await aiService.continueWithToolResults(
        conv,
        formattedMessages,
        aiResult.fullMessages,
        toolResults,
        {
          orgId,
          dealerName: org?.name || 'our dealership',
          orgSettings,
        }
      );
    }

    if (!conv) return res.json({ reply: null });

    let replyText = aiResult.text || '';
    if (replyText.length > 280) {
      let truncated = replyText.slice(0, 280);
      const cutPoint = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('?'),
        truncated.lastIndexOf('!')
      );
      if (cutPoint > 150) truncated = truncated.slice(0, cutPoint + 1);
      replyText = truncated;
    }

    // Save ALL scraped messages to DB for UI display (buyer AND ours)
    for (const m of scrapedMessages) {
      let text = (m.text || '').trim();
      if (!text) continue;
      text = text.replace(/^[A-Z][a-z]+\n/, '').trim();
      if (!text) continue;
      const direction = m.isBuyer ? 'INBOUND' : 'OUTBOUND';
      const existing = await prisma.message.findFirst({
        where: { conversationId: conv.id, direction, text },
      });
      if (!existing) {
        await prisma.message.create({
          data: { conversationId: conv.id, direction, text, status: 'SENT' },
        });
      }
    }

    let outMsg = null;
    if (replyText) {

      // Delete any old FAILED/PENDING auto_reply so we don't accumulate duplicates
      await prisma.message.deleteMany({
        where: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          intent: 'auto_reply',
          status: { in: ['FAILED', 'PENDING'] },
        },
      });

      outMsg = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          text: replyText,
          intent: 'auto_reply',
          status: 'SENDING',  // Desktop will send directly; sweep ignores SENDING
          attempts: 1,
        },
      });

      const newState = conv.state === 'NEW' ? 'ENGAGED' : conv.state;
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { state: newState, lastMessageAt: new Date() },
      });
    }

    const freshMessages = await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    const scoreResult = await aiService.scoreLeadAI(conv, freshMessages, { orgId });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { leadScore: scoreResult.score, sentimentScore: scoreResult.score },
    });

    const clientGateway = req.app.get('clientGateway');
    if (clientGateway) {
      clientGateway.broadcast(orgId, {
        type: 'lead:updated',
        data: { buyerId: conv.id, conversationId: conv.id },
      });
    }

    console.log(`[respond] ${buyerName}: "${replyText?.slice(0, 60)}..." score=${scoreResult.score}`);
    res.json({ reply: replyText || null, conversationId: conv.id, messageId: outMsg?.id || null });
  });

  router.put('/messages/:messageId/confirm-sent', async (req, res) => {
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId },
      include: { conversation: true },
    });
    if (!message || message.conversation.orgId !== req.orgId) {
      return res.status(404).json({ error: 'Message not found' });
    }
    await prisma.message.update({
      where: { id: req.params.messageId },
      data: { status: 'SENT', attempts: 1 },
    });
    console.log(`[confirm-sent] Message ${req.params.messageId} marked SENT`);
    res.json({ success: true });
  });

  router.post('/:threadId/sync', async (req, res) => {
    const orgId = req.orgId;
    const userId = req.user?.id || req.user?.sub;
    const app = req.app;
    const threadId = req.params.threadId;
    const { buyerName, listingTitle, messages: scrapedMessages, fbThreadUrl } = req.body;

    if (!Array.isArray(scrapedMessages) || scrapedMessages.length === 0) {
      return res.status(200).json({ synced: 0, newInbound: 0 });
    }

    let conv = await prisma.conversation.findFirst({
      where: { threadId, orgId },
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });

    // Fallback: if no exact threadId match, look for an existing conversation
    // with the same buyer + vehicle. The client-side threadId can drift when FB
    // preview text bleeds into the listing title (e.g. "NavigatorI have a trade").
    if (!conv && buyerName) {
      const matchedVehicleId = await resolveVehicle(orgId, listingTitle);
      if (matchedVehicleId) {
        const fallback = await prisma.conversation.findFirst({
          where: {
            orgId,
            buyerName: { equals: buyerName, mode: 'insensitive' },
            vehicleId: matchedVehicleId,
            archivedAt: null,
          },
          include: { vehicle: true },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (fallback) {
          console.log(`[sync] ThreadId drift: "${threadId}" matched existing conv ${fallback.id} by buyer+vehicle`);
          // Update the threadId to the latest so future syncs hit the fast path
          conv = await prisma.conversation.update({
            where: { id: fallback.id },
            data: { threadId },
            include: { vehicle: true },
          });
        }
      }
    }

    let isFirstSync = false;

    if (!conv) {
      isFirstSync = true;
      // If scraped thread has outbound messages, it's a historical import (already responded)
      // If only inbound messages, it's a fresh lead — should trigger auto-reply
      const hasOutbound = scrapedMessages.some(m => !m.isBuyer);
      if (!hasOutbound) isFirstSync = false;
      const matchedVehicleId = await resolveVehicle(orgId, listingTitle);

      let carryEmail = null;
      let carryPhone = null;
      if (buyerName) {
        const prevConv = await prisma.conversation.findFirst({
          where: {
            orgId,
            buyerName: { equals: buyerName, mode: 'insensitive' },
            OR: [
              { buyerEmail: { not: null } },
              { buyerPhone: { not: null } },
            ],
          },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (prevConv) {
          carryEmail = prevConv.buyerEmail;
          carryPhone = prevConv.buyerPhone;
        }
      }

      conv = await prisma.conversation.create({
        data: {
          threadId,
          fbThreadUrl: fbThreadUrl || null,
          orgId,
          buyerName: buyerName || 'Unknown Buyer',
          buyerId: null,
          buyerEmail: carryEmail,
          buyerPhone: carryPhone,
          state: 'NEW',
          leadScore: 20,
          vehicleId: matchedVehicleId,
          agentId: userId,
          lastMessageAt: new Date(),
        },
        include: { vehicle: true },
      });
      console.log(`[sync] Created conversation ${conv.id} for thread ${threadId}`);
    }

    if (conv && fbThreadUrl && !conv.fbThreadUrl) {
      conv = await prisma.conversation.update({
        where: { id: conv.id },
        data: { fbThreadUrl },
        include: { vehicle: true },
      });
    }

    // Update buyer name if currently "Unknown" and sync provides a real name
    if (buyerName && buyerName !== 'Unknown Buyer' && buyerName !== 'Unknown' &&
        (conv.buyerName === 'Unknown Buyer' || conv.buyerName === 'Unknown')) {
      conv = await prisma.conversation.update({
        where: { id: conv.id },
        data: { buyerName },
        include: { vehicle: true },
      });
      console.log(`[sync] Updated buyer name from "Unknown" to "${buyerName}" for conv ${conv.id}`);
    }

    const existingMessages = await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });

    const newMessages = [];

    if (isFirstSync) {
      // First sync: sequential walk to import full history in order
      let dbIndex = 0;
      for (const scraped of scrapedMessages) {
        const scrapedDir = scraped.isBuyer ? 'INBOUND' : 'OUTBOUND';
        const scrapedText = (scraped.text || '').trim();
        if (!scrapedText) continue;

        let matched = false;
        for (let look = 0; look < 5 && dbIndex + look < existingMessages.length; look++) {
          const dbMsg = existingMessages[dbIndex + look];
          if (dbMsg.intent === 'tool_action') {
            dbIndex++;
            look--;
            continue;
          }
          const dbText = (dbMsg.text || '').trim();
          const dbDir = dbMsg.direction;

          const textMatch = scrapedDir === 'OUTBOUND'
            ? (dbText.startsWith(scrapedText.slice(0, 50)) || scrapedText.startsWith(dbText.slice(0, 50)))
            : dbText.toLowerCase() === scrapedText.toLowerCase();

          if (scrapedDir === dbDir && textMatch) {
            dbIndex = dbIndex + look + 1;
            matched = true;
            break;
          }
        }

        if (!matched) {
          // Reject scraped inbound messages that match existing outbound text.
          const isEcho = scrapedDir === 'INBOUND' && existingMessages.some(
            m => m.direction === 'OUTBOUND' && m.text.trim().toLowerCase() === scrapedText.toLowerCase()
          );
          if (isEcho) continue;

          newMessages.push({ text: scrapedText, direction: scrapedDir });
        }
      }
    } else {
      // Subsequent syncs: content-based dedup — only add truly new INBOUND messages.
      // Build a set of existing inbound message texts for fast lookup.
      const existingInbound = new Set(
        existingMessages
          .filter(m => m.direction === 'INBOUND')
          .map(m => m.text.trim().toLowerCase())
      );
      // Also track outbound messages - the scraper sometimes mislabels our AI
      // responses as buyer messages. If a "buyer" message matches something we
      // already sent, it's an echo and must be rejected.
      const existingOutbound = new Set(
        existingMessages
          .filter(m => m.direction === 'OUTBOUND')
          .map(m => m.text.trim().toLowerCase())
      );
      const buyerNorm = (conv.buyerName || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();

      for (const scraped of scrapedMessages) {
        if (!scraped.isBuyer) { console.log(`[sync-debug] SKIP non-buyer: "${(scraped.text||'').slice(0,40)}"`); continue; }
        const scrapedText = (scraped.text || '').trim();
        if (!scrapedText) { console.log(`[sync-debug] SKIP empty`); continue; }

        // Skip if this exact text already exists in the conversation
        if (existingInbound.has(scrapedText.toLowerCase())) { console.log(`[sync-debug] SKIP dup-inbound: "${scrapedText.slice(0,40)}"`); continue; }

        // Skip if this text matches an OUTBOUND message we already sent
        // (scraper mislabeled our AI response as a buyer message).
        if (existingOutbound.has(scrapedText.toLowerCase())) {
          console.log(`[sync] Rejected echo: "${scrapedText.slice(0, 60)}..." matches existing outbound`);
          continue;
        }

        // Skip if the message is just the buyer's name (scraper artifact)
        if (scrapedText.length < 60) {
          const normText = scrapedText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
          const lenDiff = Math.abs(normText.length - buyerNorm.length);
          if (normText && buyerNorm && normText.length > 1 && lenDiff <= 3) {
            if (normText === buyerNorm || buyerNorm.startsWith(normText) || normText.startsWith(buyerNorm)) {
              console.log(`[sync-debug] SKIP name-label: "${scrapedText}"`);
              continue;
            }
          }
        }

        console.log(`[sync-debug] NEW: "${scrapedText.slice(0,60)}"`);
        newMessages.push({ text: scrapedText, direction: 'INBOUND' });
        // Add to set so we don't double-add within the same batch
        existingInbound.add(scrapedText.toLowerCase());
      }
    }

    let newInboundCount = 0;
    for (const msg of newMessages) {
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: msg.direction,
          text: msg.text,
        },
      });
      if (msg.direction === 'INBOUND' && !isFirstSync) newInboundCount++;

      if (msg.direction === 'INBOUND' && !isFirstSync) {
        const updates = {};
        const emailMatch = msg.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch && !conv.buyerEmail) {
          updates.buyerEmail = emailMatch[0].toLowerCase();
        }
        const phoneMatch = msg.text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
        if (phoneMatch && !conv.buyerPhone) {
          const digits = phoneMatch[0].replace(/\D/g, '');
          if (digits.length >= 10) {
            updates.buyerPhone = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
          }
        }
        if (Object.keys(updates).length > 0) {
          await prisma.conversation.update({ where: { id: conv.id }, data: updates });
          conv = { ...conv, ...updates };
        }
      }
    }

    if (newMessages.length > 0) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: new Date() },
      });
    }

    // Only trigger auto-reply on subsequent syncs (not first sync — those are historical imports)
    if (newInboundCount > 0 && !isFirstSync) {
      const convId = conv.id;
      if (autoReplyTimers.has(convId)) {
        clearTimeout(autoReplyTimers.get(convId));
      }
      const timer = setTimeout(() => {
        autoReplyTimers.delete(convId);
        triggerAutoReply(convId, orgId, app).catch(err => {
          console.error(`[auto-reply] Error processing conv ${convId}:`, err.message);
        });
      }, BATCH_WINDOW_MS);
      autoReplyTimers.set(convId, timer);
    }

    console.log(`[sync] Thread ${threadId}: ${scrapedMessages.length} scraped, ${newMessages.length} new (${newInboundCount} inbound)${isFirstSync ? ' [first sync — no auto-reply]' : ''}`);
    res.status(200).json({ synced: scrapedMessages.length, newInbound: newInboundCount, conversationId: conv.id });
  });

  router.put('/:id/archive', async (req, res) => {
    const result = await prisma.conversation.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ success: true, archived: true });
  });

  router.put('/:id/unarchive', async (req, res) => {
    const result = await prisma.conversation.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data: { archivedAt: null },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ success: true, archived: false });
  });

  router.put('/messages/:messageId/status', async (req, res) => {
    const { status } = req.body;
    if (!['SENT', 'DELIVERED', 'FAILED', 'PENDING'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId },
      include: { conversation: true },
    });
    if (!message || message.conversation.orgId !== req.orgId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await prisma.message.update({
      where: { id: req.params.messageId },
      data: { status },
    });
    res.json({ success: true });
  });

  router.get('/:id', async (req, res) => {
    // Try by id first, then by threadId
    let conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        vehicle: true,
        agent: { select: { displayName: true, username: true } },
      },
    });
    if (!conversation) {
      conversation = await prisma.conversation.findFirst({
        where: { threadId: req.params.id, orgId: req.orgId },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          vehicle: true,
          agent: { select: { displayName: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

    // Attach the latest appointment for this buyer
    const appointment = await prisma.appointment.findFirst({
      where: {
        orgId: req.orgId,
        buyerName: conversation.buyerName,
      },
      orderBy: { scheduledTime: 'desc' },
      select: { id: true, scheduledTime: true, status: true },
    });
    conversation.appointment = appointment || null;

    res.json(conversation);
  });

  router.put('/:id', async (req, res) => {
    const { state, leadScore, agentId } = req.body;
    const data = {};
    if (state) data.state = state;
    if (leadScore !== undefined) data.leadScore = parseInt(leadScore);
    if (agentId !== undefined) data.agentId = agentId;

    const result = await prisma.conversation.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ success: true });
  });

  router.post('/:id/messages', async (req, res) => {
    const { direction, text, intent, status } = req.body;
    if (!direction || !text) {
      return res.status(400).json({ error: 'direction and text are required.' });
    }
    if (status && !['SENT', 'DELIVERED', 'FAILED', 'PENDING'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const orgId = req.orgId;
    const userId = req.user?.id || req.user?.sub;
    const app = req.app;

    // Find or create conversation - route by threadId with buyer+vehicle fallback
    const threadId = req.params.id;
    const { buyerName, vehicleId, listingTitle, fbThreadUrl } = req.body;

    let conv = await prisma.conversation.findFirst({
      where: { threadId, orgId },
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });

    // Fallback: match by buyer+vehicle when threadId drifts
    if (!conv && buyerName && direction === 'INBOUND') {
      const resolvedVid = vehicleId || await resolveVehicle(orgId, listingTitle);
      if (resolvedVid) {
        const fallback = await prisma.conversation.findFirst({
          where: {
            orgId,
            buyerName: { equals: buyerName, mode: 'insensitive' },
            vehicleId: resolvedVid,
            archivedAt: null,
          },
          include: { vehicle: true },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (fallback) {
          console.log(`[auto-reply] ThreadId drift: "${threadId}" matched existing conv ${fallback.id} by buyer+vehicle`);
          conv = await prisma.conversation.update({
            where: { id: fallback.id },
            data: { threadId },
            include: { vehicle: true },
          });
        }
      }
    }

    if (direction === 'INBOUND') {
      const incomingVehicleId = vehicleId || await resolveVehicle(orgId, listingTitle);

      if (conv && incomingVehicleId && incomingVehicleId !== conv.vehicleId) {
        console.log(`[auto-reply] Vehicle changed for thread ${threadId}: ${conv.vehicleId} -> ${incomingVehicleId}`);
        conv = await prisma.conversation.update({
          where: { id: conv.id },
          data: { vehicleId: incomingVehicleId },
          include: { vehicle: true },
        });
      } else if (!conv) {
        const matchedVehicleId = vehicleId || await resolveVehicle(orgId, listingTitle);

        let carryEmail = null;
        let carryPhone = null;
        if (buyerName) {
          const prevConv = await prisma.conversation.findFirst({
            where: {
              orgId,
              buyerName: { equals: buyerName, mode: 'insensitive' },
              OR: [
                { buyerEmail: { not: null } },
                { buyerPhone: { not: null } },
              ],
            },
            orderBy: { lastMessageAt: 'desc' },
          });
          if (prevConv) {
            carryEmail = prevConv.buyerEmail;
            carryPhone = prevConv.buyerPhone;
            console.log(`[auto-reply] Carrying over contact info from prev conv ${prevConv.id}: email=${carryEmail}, phone=${carryPhone}`);
          }
        }

        conv = await prisma.conversation.create({
          data: {
            threadId,
            orgId,
            buyerName: buyerName || 'Unknown Buyer',
            buyerId: null,
            buyerEmail: carryEmail,
            buyerPhone: carryPhone,
            state: 'NEW',
            leadScore: 20,
            vehicleId: matchedVehicleId,
            agentId: userId,
            lastMessageAt: new Date(),
          },
          include: { vehicle: true },
        });
        console.log(`[auto-reply] Created conversation ${conv.id} for new thread ${threadId}`);
      }
    }

    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    if (fbThreadUrl && !conv.fbThreadUrl) {
      conv = await prisma.conversation.update({
        where: { id: conv.id },
        data: { fbThreadUrl },
        include: { vehicle: true },
      });
    }

    if (direction === 'INBOUND') {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      // Check against ALL messages (inbound AND outbound) — if the scraper
      // picks up the dealer's own sent message, this catches it.
      const duplicate = await prisma.message.findFirst({
        where: {
          conversation: { is: { threadId, orgId } },
          text,
          createdAt: { gte: twoHoursAgo },
        },
      });
      if (duplicate) {
        console.log(`[auto-reply] Skipping duplicate: "${text.slice(0, 50)}..." (matched ${duplicate.direction} msg)`);
        return res.status(200).json({ deduplicated: true });
      }

      // Reject messages that are just the buyer's name (scraper artifact from FB DOM)
      const trimmedText = text.trim();
      if (trimmedText.length < 60) {
        const normText = trimmedText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const convBuyerName = conv?.buyerName || buyerName || '';
        const normBuyer = convBuyerName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        if (normText && normBuyer && normText.length > 1) {
          if (
            normText === normBuyer ||
            normBuyer.startsWith(normText) ||
            normText.startsWith(normBuyer)
          ) {
            console.log(`[auto-reply] Filtered name-label message: "${trimmedText}" (matches buyer "${convBuyerName}")`);
            return res.status(200).json({ filtered: true, reason: 'name_label' });
          }
        }
      }
    }

    const shouldDispatchOutbound = direction === 'OUTBOUND' && !status;
    let message = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction,
        text,
        intent,
        ...(direction === 'OUTBOUND'
          ? { status: status || 'PENDING', attempts: status && status !== 'PENDING' ? 1 : 0 }
          : (status ? { status } : {})),
      },
    });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() },
    });

    if (direction === 'INBOUND' && text) {
      const updates = {};

      const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch && !conv.buyerEmail) {
        updates.buyerEmail = emailMatch[0].toLowerCase();
      }

      const phoneMatch = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
      if (phoneMatch && !conv.buyerPhone) {
        const digits = phoneMatch[0].replace(/\D/g, '');
        if (digits.length >= 10) {
          updates.buyerPhone = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
        }
      }

      if (Object.keys(updates).length > 0) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: updates,
        });
        conv = { ...conv, ...updates };
        console.log(`[auto-extract] Conversation ${conv.id}: extracted`, updates);
      }
    }

    if (direction === 'INBOUND') {
      const convId = conv.id;

      if (autoReplyTimers.has(convId)) {
        clearTimeout(autoReplyTimers.get(convId));
      }

      const timer = setTimeout(() => {
        autoReplyTimers.delete(convId);
        triggerAutoReply(convId, orgId, app).catch(err => {
          console.error(`[auto-reply] Error processing conv ${convId}:`, err.message);
        });
      }, BATCH_WINDOW_MS);

      autoReplyTimers.set(convId, timer);
    }

    if (shouldDispatchOutbound) {
      const dispatcher = app.get('commandDispatcher');
      const agentGateway = app.get('agentGateway');
      const dispatchListingTitle = listingTitle || (
        conv.vehicle
          ? [conv.vehicle.year, conv.vehicle.make, conv.vehicle.model].filter(Boolean).join(' ')
          : ''
      );

      if (dispatcher && agentGateway) {
        const onlineAgents = agentGateway.getOnlineAgents(orgId);
        if (onlineAgents.length > 0) {
          try {
            const dispatchResult = await dispatcher.dispatch(
              orgId,
              onlineAgents[0].id,
              Commands.SEND_MESSAGE,
              {
                threadId: conv.threadId || conv.id,
                fbThreadUrl: conv.fbThreadUrl || null,
                text,
                expectedBuyer: conv.buyerName,
                listingTitle: dispatchListingTitle,
                messageId: message.id,
              }
            );
            message = await prisma.message.update({
              where: { id: message.id },
              data: {
                status: didSendMessageFail(dispatchResult) ? 'FAILED' : 'SENT',
                attempts: 1,
              },
            });
          } catch (err) {
            message = await prisma.message.update({
              where: { id: message.id },
              data: { status: 'PENDING', attempts: 0 },
            });
          }
        }
      }
    }

    res.status(201).json(message);
  });

  return router;
};
