'use strict';

function orgScope(req, res, next) {
  if (!req.user?.orgId) {
    return res.status(403).json({ error: 'Organization context required.' });
  }

  req.orgId = req.user.orgId;
  next();
}

function scoped(req, query = {}) {
  const orgId = req.orgId;
  if (!orgId) throw new Error('orgScope middleware not applied — req.orgId is missing');

  return {
    ...query,
    where: {
      ...query.where,
      orgId,
    },
  };
}

module.exports = { orgScope, scoped };
