'use strict';

const { getPlan, getFeatures, hasFeature, getFeatureLimit, isWithinLimit, isUnlicensedMode, getLicenseInfo } = require('../services/license');

function injectLicense(req, res, next) {
  const info = getLicenseInfo();
  // Lazy require to avoid potential circular dependency at module load time
  const pihole = require('../services/pihole');
  const piholeCache = pihole.getCache();
  res.locals.license = {
    plan: getPlan(),
    features: {
      ...getFeatures(),
      pihole: {
        available: true,
        licensed: hasFeature('pihole_integration'),
        attribution: piholeCache.attribution,
      },
    },
    unlicensed: isUnlicensedMode(),
    license_key_masked: info.license_key_masked || null,
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

// A value that leaves the feature off (false, 0, '', empty list, custom_headers
// with empty lists) needs no license. Without this, every full-form save from
// the route editor 403'd on plans lacking e.g. compression, because the form
// always sends compress_enabled: false.
function isEnabling(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0' && value !== 'false';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(isEnabling);
  return true;
}

function requireFeatureField(bodyField, featureKey, opts = {}) {
  return (req, res, next) => {
    const value = req.body && req.body[bodyField];
    if (value === undefined || value === null) return next();
    if (opts.onlyValue !== undefined && value !== opts.onlyValue) return next();
    if (opts.onlyValue === undefined && !isEnabling(value)) return next();
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

module.exports = { injectLicense, requireFeature, requireLimit, requireFeatureField };
