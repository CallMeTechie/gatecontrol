'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const supertest = require('supertest');

// Set test env before any imports
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.GC_DB_PATH = dbPath;
process.env.GC_ADMIN_PASSWORD = 'TestPass123!';
process.env.GC_ADMIN_USER = 'admin';
process.env.GC_WG_HOST = 'test.example.com';
process.env.GC_BASE_URL = 'http://localhost:3000';
process.env.GC_LOG_LEVEL = 'silent';
process.env.GC_DATA_DIR = tmpDir;

// Now import app modules
const { runMigrations } = require('../../src/db/migrations');
const { seedAdminUser } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { closeDb } = require('../../src/db/connection');
const license = require('../../src/services/license');

let app = null;
let agent = null;
let csrfToken = null;

/**
 * Initialize test app, run migrations, seed admin, authenticate
 */
async function setup() {
  runMigrations();
  await seedAdminUser();

  // Unlock all features for API tests
  license._overrideForTest({
    vpn_peers: -1,
    http_routes: -1,
    l4_routes: -1,
    route_auth: true,
    custom_branding: true,
    ip_access_control: true,
    peer_acl: true,
    rate_limiting: true,
    custom_headers: true,
    load_balancing: true,
    retry_on_error: true,
    circuit_breaker: true,
    request_mirroring: true,
    uptime_monitoring: true,
    prometheus_metrics: true,
    log_export: true,
    scheduled_backups: true,
    email_alerts: true,
    webhooks: true,
    api_tokens: true,
    remote_desktop: true,
    gateway_pools: true,
    gateway_pool_failover: true,
    gateway_pool_load_balancing: true,
    gateway_pools_limit: 100,
  });

  app = createApp();
  agent = supertest.agent(app);

  // Login to get session
  // First get login page to get CSRF token
  const loginPage = await agent.get('/login');
  // Extract CSRF token from cookie or response
  const csrfMatch = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrfFromPage = csrfMatch ? csrfMatch[1] : '';

  await agent
    .post('/login')
    .type('form')
    .send({ username: 'admin', password: 'TestPass123!', _csrf: csrfFromPage })
    .expect(302);

  // Get CSRF token for API calls from a page load
  const dashPage = await agent.get('/dashboard');
  const gcMatch = dashPage.text.match(/csrfToken:\s*'([^']+)'/);
  csrfToken = gcMatch ? gcMatch[1] : '';

  return { app, agent, csrfToken };
}

/**
 * Get authenticated agent with CSRF token
 */
function getAgent() {
  return agent;
}

function getCsrf() {
  return csrfToken;
}

/**
 * Cleanup after tests
 */
function teardown() {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

module.exports = { setup, teardown, getAgent, getCsrf };
