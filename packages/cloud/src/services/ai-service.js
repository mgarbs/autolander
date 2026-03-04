'use strict';

// TODO: Phase 3 — Port prompts from listing-generator.js + ai-responder.js
// Will use @anthropic-ai/sdk for Claude API calls

module.exports = {
  async generateListing(vehicle, options = {}) {
    // Stub — returns simple listing
    const title = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}`;
    const description = `${title} for sale. ${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' miles.' : ''} Contact us today!`;
    return { title, description };
  },

  async generateResponse(conversation, messages, options = {}) {
    // Stub — returns generic response
    return {
      response: 'Thank you for your interest! Let me get back to you shortly.',
      handoff: false,
    };
  },
};
