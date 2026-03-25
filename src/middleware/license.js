'use strict';

const { getPlan, getFeatures, hasFeature, getFeatureLimit, isWithinLimit } = require('../services/license');

function injectLicense(req, res, next) {
  res.locals.license = {
    plan: getPlan(),
    features: getFeatures(),
    hasFeature,
    isWithinLimit,
  };
  next();
}

function requireFeature(featureKey) {
  return (req, res, next) => {
    if (!hasFeature(featureKey)) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

function requireLimit(featureKey, countFn) {
  return (req, res, next) => {
    const limit = getFeatureLimit(featureKey);
    if (limit === -1) return next();
    if (limit === 0) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    const count = countFn();
    if (count >= limit) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.limit_reached') : 'Limit reached',
        feature: featureKey,
        current: count,
        limit,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

function requireFeatureField(bodyField, featureKey) {
  return (req, res, next) => {
    if (req.body && req.body[bodyField] && !hasFeature(featureKey)) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

module.exports = { injectLicense, requireFeature, requireLimit, requireFeatureField };
