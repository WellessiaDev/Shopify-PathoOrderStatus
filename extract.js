const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP = process.env.SHOP || 'wellessia';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

const PATHAO_BASE_URL = process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID = process.env.PATHAO_CLIENT_ID;
const PATHAO_CLIENT_SECRET = process.env.PATHAO_CLIENT_SECRET;
const PATHAO_USERNAME = process.env.PATHAO_USERNAME;
const PATHAO_PASSWORD = process.env.PATHAO_PASSWORD;

const PATHAO_WEBHOOK_SECRET = process.env.PATHAO_WEBHOOK_SECRET || '';

const PORT = Number(process.env.PORT || 3000);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

const POLL_LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS || 30);

const PATHAO_TRACKING_COMPANY = String(process.env.PATHAO_TRACKING_COMPANY || 'Pathao').toLowerCase();

// ============================================================
// VALIDATE ENVIRONMENT
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing CLIENT_ID or CLIENT_SECRET');
  process.exit(1);
}

if (!PATHAO_CLIENT_ID || !PATHAO_CLIENT_SECRET || !PATHAO_USERNAME || !PATHAO_PASSWORD) {
  console.error('❌ Missing Pathao credentials');
  process.exit(1);
}

if (!PATHAO_WEBHOOK_SECRET) {
  console.warn(
    '⚠️ PATHAO_WEBHOOK_SECRET is not set. The webhook verification handshake ' +
    'will fail and incoming webhook events will be rejected until it is configured.'
  );
}

// ============================================================
// TOKEN CACHE
// ============================================================

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;

// ============================================================
// AUTO SYNC STATE
// ============================================================

let autoSyncRunning = false;

let lastAutoSync = {
  started_at: null,
  finished_at: null,
  checked: 0,
  updated: 0,
  skipped: 0,
  errors: 0
};

let webhookStats = {
  last_event_at: null,
  received: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  rejected_invalid_signature: 0
};

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {
  if (SHOPIFY_TOKEN && Date.now() < SHOPIFY_EXPIRES_AT - 60000) {
    return SHOPIFY_TOKEN;
  }

  console.log('🔐 Requesting Shopify access token...');

  const response = await fetchWithTimeout(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    }).toString()
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    const error = new Error(`Shopify token error ${response.status}: ${data.error_description || data.error || JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  SHOPIFY_TOKEN = data.access_token;
  SHOPIFY_EXPIRES_AT = Date.now() + Number(data.expires_in || 86400) * 1000;

  console.log('✅ Shopify access token obtained');

  return SHOPIFY_TOKEN;
}

// ============================================================
// PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {
  if (PATHAO_TOKEN && Date.now() < PATHAO_EXPIRES_AT - 60000) {
    return PATHAO_TOKEN;
  }

  console.log('🔐 Requesting Pathao access token...');

  const response = await fetchWithTimeout(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: PATHAO_CLIENT_ID,
      client_secret: PATHAO_CLIENT_SECRET,
      username: PATHAO_USERNAME,
      password: PATHAO_PASSWORD,
      grant_type: 'password'
    })
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    const error = new Error(`Pathao token error ${response.status}: ${data.message || data.error || JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  PATHAO_TOKEN = data.access_token;
  PATHAO_EXPIRES_AT = Date.now() + Number(data.expires_in || 3600) * 1000;

  console.log('✅ Pathao access token obtained');

  return PATHAO_TOKEN;
}

// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

const MAX_THROTTLE_RETRIES = 5;

async function shopifyGraphQL(query, variables = {}, attempt = 1) {
  const token = await getShopifyToken();

  const response = await fetchWithTimeout(`https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Shopify API HTTP ${response.status}`);
    error.status = response.status;
    error.data = payload;
    throw error;
  }

  if (payload.errors?.length) {
    const isThrottled = payload.errors.some(item => item.extensions?.code === 'THROTTLED');

    if (isThrottled && attempt <= MAX_THROTTLE_RETRIES) {
      const throttleStatus = payload.extensions?.cost?.throttleStatus;

      let waitMs = 1000 * attempt;

      if (throttleStatus && Number(throttleStatus.restoreRate) > 0) {
        const maximumAvailable = Number(throttleStatus.maximumAvailable) || 1000;
        const currentlyAvailable = Number(throttleStatus.currentlyAvailable) || 0;
        const needed = Math.max(0, maximumAvailable * 0.5 - currentlyAvailable);
        waitMs = Math.max(500, Math.ceil((needed / Number(throttleStatus.restoreRate)) * 1000));
      }

      console.warn(`⏳ Shopify GraphQL throttled — retrying in ${waitMs}ms (attempt ${attempt}/${MAX_THROTTLE_RETRIES})`);
      await sleep(waitMs);

      return shopifyGraphQL(query, variables, attempt + 1);
    }

    const error = new Error(payload.errors.map(item => item.message).join('; '));
    error.status = 400;
    error.data = payload.errors;
    throw error;
  }

  return payload.data;
}

// ============================================================
// GET PATHAO ORDER STATUS
// ============================================================

async function getPathaoOrder(consignmentId) {
  if (!consignmentId) {
    throw new Error('Consignment ID is required');
  }

  const token = await getPathaoToken();

  const response = await fetchWithTimeout(
    `${PATHAO_BASE_URL}/aladdin/api/v1/orders/${encodeURIComponent(String(consignmentId))}/info`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || data.error || `Pathao order API error ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  const order = data.data || data;

  console.log(`📦 [Pathao] ${consignmentId} -> ${JSON.stringify(order)}`);

  return order;
}

// ============================================================
// PATHAO STATUS -> SHOPIFY STATUS
// ============================================================

function mapPathaoStatus(orderStatus, orderStatusSlug = '') {
  const status = `${orderStatus || ''} ${orderStatusSlug || ''}`
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (!status) {
    return null;
  }

  // Waiting for pickup
  if (
    status.includes('waiting for pickup') ||
    status.includes('assigned for pickup') ||
    status.includes('pickup requested') ||
    status.includes('order created') ||
    status.includes('pending')
  ) {
    return 'CONFIRMED';
  }

  // Picked up
  if (status.includes('picked up') || status.includes('pickup done') || status.includes('picked')) {
    return 'CARRIER_PICKED_UP';
  }

  // Out for delivery
  if (status.includes('out for delivery') || status.includes('assigned for delivery')) {
    return 'OUT_FOR_DELIVERY';
  }

  // Delivered
  if (status.includes('successfully delivered') || status.startsWith('delivered ') || status === 'delivered') {
    return 'DELIVERED';
  }

  // Failed delivery
  if (
    status.includes('delivery failed') ||
    status.includes('attempted delivery') ||
    status.includes('partial delivery')
  ) {
    return 'ATTEMPTED_DELIVERY';
  }

  // Delayed
  if (status.includes('on hold') || status.includes('delay')) {
    return 'DELAYED';
  }

  // Transit
  if (
    status.includes('in transit') ||
    status.includes('sorting hub') ||
    status.includes('last mile hub') ||
    status.includes('transit')
  ) {
    return 'IN_TRANSIT';
  }

  // Do not map these
  if (
    status.includes('return') ||
    status.includes('cancelled') ||
    status.includes('canceled') ||
    status.includes('pickup failed') ||
    status.includes('pickup cancelled')
  ) {
    return null;
  }

  return null;
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT EVENT
// ============================================================

async function createShopifyFulfillmentEvent(fulfillmentId, shopifyStatus, pathaoStatus, pathaoUpdatedAt = null) {
  if (!fulfillmentId || !shopifyStatus) {
    throw new Error('fulfillmentId and shopifyStatus are required');
  }

  const mutation = `
    mutation CreateFulfillmentEvent($event: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $event) {
        fulfillmentEvent {
          id
          status
          message
          happenedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const event = {
    fulfillmentId: fulfillmentId,
    status: shopifyStatus,
    message: `Pathao: ${pathaoStatus}`
  };

  if (pathaoUpdatedAt) {
    try {
      const parsed = new Date(`${String(pathaoUpdatedAt).replace(' ', 'T')}+06:00`);
      if (!Number.isNaN(parsed.getTime())) {
        event.happenedAt = parsed.toISOString();
      }
    } catch (e) {
      console.warn('⚠️ Failed to parse Pathao timestamp:', pathaoUpdatedAt);
    }
  }

  const data = await shopifyGraphQL(mutation, { event });
  const result = data.fulfillmentEventCreate;

  if (result.userErrors?.length) {
    const error = new Error(result.userErrors.map(item => item.message).join('; '));
    error.status = 400;
    error.data = result.userErrors;
    throw error;
  }

  return result.fulfillmentEvent;
}

// ============================================================
// EXTRACT PATHAO TARGETS FROM FULFILLMENT ORDER
// ============================================================

function extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder, seen, companySample) {
  const targets = [];

  if (!fulfillmentOrder) return targets;

  for (const fulfillment of fulfillmentOrder.fulfillments?.nodes || []) {
    if (!fulfillment) continue;

    for (const tracking of fulfillment.trackingInfo || []) {
      const rawCompany = tracking.company || '';
      const company = String(rawCompany).toLowerCase();
      const consignmentId = String(tracking.number || '').trim();

      if (!consignmentId) continue;

      if (companySample && companySample.size < 25) {
        companySample.add(rawCompany === '' ? '(empty)' : rawCompany);
      }

      // Only Pathao shipments
      if (!company.includes(PATHAO_TRACKING_COMPANY)) continue;

      const key = `${fulfillment.id}:${consignmentId}`;
      if (seen && seen.has(key)) continue;
      if (seen) seen.add(key);

      targets.push({
        fulfillment_order_id: fulfillmentOrder.id,
        shopify_order_id: fulfillmentOrder.orderId,
        shopify_order_name: fulfillmentOrder.orderName,
        fulfillment_id: fulfillment.id,
        consignment_id: consignmentId,
        current_shopify_status: fulfillment.displayStatus || null
      });
    }
  }

  return targets;
}

const FULFILLMENT_ORDER_NODE_FIELDS = `
  id
  orderName
  orderId
  status
  updatedAt
  fulfillments(first: 20) {
    nodes {
      id
      status
      displayStatus
      trackingInfo(first: 10) {
        company
        number
        url
      }
    }
  }
`;

// ============================================================
// GET PATHAO FULFILLMENT TARGETS
// ============================================================

let inFlightFullScan = null;

async function getPathaoFulfillmentTargets() {
  if (inFlightFullScan) {
    console.log('⏭ Full fulfillment-order scan already in progress');
    return inFlightFullScan;
  }

  inFlightFullScan = runPathaoFulfillmentTargetsScan();

  try {
    return await inFlightFullScan;
  } finally {
    inFlightFullScan = null;
  }
}

async function runPathaoFulfillmentTargetsScan() {
  const since = new Date(Date.now() - POLL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const query = `
    query GetFulfillmentOrders($first: Int!, $after: String, $search: String!) {
      fulfillmentOrders(first: $first, after: $after, includeClosed: true, query: $search, sortKey: UPDATED_AT) {
        nodes {
          ${FULFILLMENT_ORDER_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const targets = [];
  const seen = new Set();
  const companySample = new Set();

  let after = null;
  let hasNextPage = true;
  let page = 0;
  const MAX_PAGES = 50;

  while (hasNextPage) {
    page += 1;

    if (page > MAX_PAGES) {
      console.warn(`⚠️ Hit MAX_PAGES (${MAX_PAGES}) safety cap, stopping scan early`);
      break;
    }

    const data = await shopifyGraphQL(query, {
      first: 100,
      after,
      search: `updated_at:>=${since}`
    });

    const connection = data.fulfillmentOrders;

    if (!connection) {
      console.error('⚠️ No fulfillmentOrders in response');
      break;
    }

    for (const fulfillmentOrder of connection.nodes || []) {
      targets.push(...extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder, seen, companySample));
    }

    console.log(`  …scanned page ${page} (${connection.nodes?.length || 0} orders, ${targets.length} Pathao targets so far)`);

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = connection.pageInfo?.endCursor || null;
  }

  if (targets.length === 0 && companySample.size > 0) {
    console.warn(
      `⚠️ No fulfillments matched tracking company "${PATHAO_TRACKING_COMPANY}". ` +
      `Actual values: ${JSON.stringify(Array.from(companySample))}`
    );
  }

  return targets;
}

// ============================================================
// GET TARGETS BY ORDER NAME
// ============================================================

async function getPathaoFulfillmentTargetsByOrderName(orderName) {
  if (!orderName) return [];

  const normalizedName = String(orderName).startsWith('#') ? orderName : `#${orderName}`;

  const query = `
    query GetFulfillmentOrdersByName($search: String!) {
      fulfillmentOrders(first: 5, includeClosed: true, query: $search) {
        nodes {
          ${FULFILLMENT_ORDER_NODE_FIELDS}
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { search: `order_name:${normalizedName}` });

  const targets = [];
  for (const fulfillmentOrder of data.fulfillmentOrders?.nodes || []) {
    targets.push(...extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder));
  }

  return targets;
}

// ============================================================
// APPLY PATHAO STATUS TO SHOPIFY
// ============================================================

async function applyPathaoStatusToShopify(target, { merchantOrderId, pathaoStatus, pathaoStatusSlug = '', pathaoUpdatedAt = null }) {
  console.log(
    `🔎 [Sync] consignment=${target.consignment_id} order=${target.shopify_order_name} ` +
    `pathao_status="${pathaoStatus}" current_shopify=${target.current_shopify_status}`
  );

  if (!merchantOrderId || !pathaoStatus) {
    console.log('  ↳ SKIP: missing merchant_order_id or order_status');
    return {
      success: false,
      updated: false,
      skipped: true,
      reason: 'Pathao merchant_order_id or order_status missing',
      consignment_id: target.consignment_id
    };
  }

  if (merchantOrderId !== target.shopify_order_name) {
    console.log(`  ↳ SKIP: order mismatch — Pathao="${merchantOrderId}", Shopify="${target.shopify_order_name}"`);
    return {
      success: false,
      updated: false,
      skipped: true,
      reason: 'Order name mismatch',
      merchant_order_id: merchantOrderId,
      shopify_order_name: target.shopify_order_name,
      consignment_id: target.consignment_id
    };
  }

  const shopifyStatus = mapPathaoStatus(pathaoStatus, pathaoStatusSlug);

  console.log(`  ↳ mapped "${pathaoStatus}" -> ${shopifyStatus || '(unmapped)'}`);

  if (!shopifyStatus) {
    console.log('  ↳ SKIP: no Shopify mapping for this Pathao status');
    return {
      success: true,
      updated: false,
      skipped: true,
      reason: 'Pathao status has no Shopify mapping',
      pathao_order_status: pathaoStatus
    };
  }

  if (target.current_shopify_status === shopifyStatus) {
    console.log(`  ↳ SKIP: Shopify already shows "${shopifyStatus}"`);
    return {
      success: true,
      updated: false,
      skipped: true,
      reason: 'Shopify already has this status',
      pathao_order_status: pathaoStatus,
      shopify_status: shopifyStatus
    };
  }

  console.log(`  ↳ PUSHING: fulfillment ${target.fulfillment_id} -> ${shopifyStatus}`);

  const event = await createShopifyFulfillmentEvent(target.fulfillment_id, shopifyStatus, pathaoStatus, pathaoUpdatedAt);

  console.log(`  ↳ ✅ Updated, event ${event.id}, status ${event.status}`);

  return {
    success: true,
    updated: true,
    merchant_order_id: merchantOrderId,
    shopify_order_name: target.shopify_order_name,
    consignment_id: target.consignment_id,
    pathao_order_status: pathaoStatus,
    previous_shopify_status: target.current_shopify_status,
    shopify_delivery_status: event.status,
    event_id: event.id
  };
}

// ============================================================
// SYNC ONE TARGET
// ============================================================

async function syncTarget(target) {
  const pathaoOrder = await getPathaoOrder(target.consignment_id);

  return applyPathaoStatusToShopify(target, {
    merchantOrderId: pathaoOrder.merchant_order_id,
    pathaoStatus: pathaoOrder.order_status,
    pathaoStatusSlug: pathaoOrder.order_status_slug || '',
    pathaoUpdatedAt: pathaoOrder.updated_at || null
  });
}

// ============================================================
// FIND TARGET BY CONSIGNMENT ID
// ============================================================

async function findTargetByConsignmentId(consignmentId) {
  const targets = await getPathaoFulfillmentTargets();
  return targets.find(item => item.consignment_id === String(consignmentId)) || null;
}

// ============================================================
// AUTOMATIC SYNC
// ============================================================

async function runAutomaticStatusSync() {
  if (autoSyncRunning) {
    console.log('⏭ Auto-sync already running');
    return lastAutoSync;
  }

  autoSyncRunning = true;

  const stats = {
    started_at: new Date().toISOString(),
    finished_at: null,
    checked: 0,
    updated: 0,
    skipped: 0,
    errors: 0
  };

  try {
    console.log('============================================');
    console.log('🔄 PATHAO AUTO STATUS CHECK (polling)');
    console.log(`🕒 ${stats.started_at}`);

    const targets = await getPathaoFulfillmentTargets();

    console.log(`📦 Found: ${targets.length} Pathao fulfillments`);

    for (const target of targets) {
      stats.checked += 1;

      try {
        const result = await syncTarget(target);

        if (result.updated) {
          stats.updated += 1;
          console.log(`✅ ${target.shopify_order_name} | ${result.pathao_order_status} -> ${result.shopify_delivery_status}`);
        } else {
          stats.skipped += 1;
          console.log(`✓ ${target.shopify_order_name} | ${result.reason}`);
        }
      } catch (error) {
        stats.errors += 1;
        console.error(`❌ ${target.shopify_order_name} / ${target.consignment_id}:`, error.message);
      }
    }
  } catch (error) {
    stats.errors += 1;
    console.error('❌ Auto-sync cycle failed:', error.message);
  } finally {
    stats.finished_at = new Date().toISOString();
    lastAutoSync = stats;
    autoSyncRunning = false;

    console.log('--------------------------------------------');
    console.log(`Checked: ${stats.checked}`);
    console.log(`Updated: ${stats.updated}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Errors: ${stats.errors}`);
    console.log('============================================');
  }

  return stats;
}

// ============================================================
// PATHAO WEBHOOK — SIGNATURE VERIFICATION
// ============================================================

function isValidPathaoSignature(signature) {
  if (!PATHAO_WEBHOOK_SECRET || !signature) return false;

  const provided = Buffer.from(String(signature));
  const expected = Buffer.from(PATHAO_WEBHOOK_SECRET);

  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}

// ============================================================
// EXTRACT PATHAO WEBHOOK FIELDS
// ============================================================

function extractPathaoWebhookFields(body = {}) {
  const nested = body.data || body.order || {};

  const consignmentId = String(body.consignment_id || nested.consignment_id || '').trim() || null;
  const merchantOrderId = body.merchant_order_id || nested.merchant_order_id || null;
  const orderStatus = body.order_status || nested.order_status || body.event || null;
  const orderStatusSlug = body.order_status_slug || nested.order_status_slug || '';
  const updatedAt = body.updated_at || nested.updated_at || null;

  return { consignmentId, merchantOrderId, orderStatus, orderStatusSlug, updatedAt };
}

// ============================================================
// PROCESS WEBHOOK EVENT
// ============================================================

async function processPathaoWebhookEvent(body) {
  webhookStats.last_event_at = new Date().toISOString();
  webhookStats.received += 1;

  console.log(`📨 [Webhook] raw: ${JSON.stringify(body)}`);

  const fields = extractPathaoWebhookFields(body);

  console.log(`📨 [Webhook] parsed: ${JSON.stringify(fields)}`);

  if (!fields.consignmentId || !fields.orderStatus) {
    webhookStats.skipped += 1;
    console.log(`⏭ [Webhook] Missing consignment_id or status`);
    return;
  }

  try {
    let targets = fields.merchantOrderId ? await getPathaoFulfillmentTargetsByOrderName(fields.merchantOrderId) : [];

    console.log(`📨 [Webhook] targeted lookup returned ${targets.length} target(s)`);

    let target = targets.find(t => t.consignment_id === fields.consignmentId) || null;

    if (!target) {
      console.log(`ℹ️ [Webhook] Falling back to full scan`);
      target = await findTargetByConsignmentId(fields.consignmentId);
    }

    if (!target) {
      webhookStats.skipped += 1;
      console.log(`⏭ [Webhook] No matching Shopify fulfillment`);
      return;
    }

    const result = await applyPathaoStatusToShopify(target, {
      merchantOrderId: fields.merchantOrderId || target.shopify_order_name,
      pathaoStatus: fields.orderStatus,
      pathaoStatusSlug: fields.orderStatusSlug,
      pathaoUpdatedAt: fields.updatedAt
    });

    if (result.updated) {
      webhookStats.updated += 1;
      console.log(`✅ [Webhook] ${target.shopify_order_name} | ${fields.orderStatus} -> ${result.shopify_delivery_status}`);
    } else {
      webhookStats.skipped += 1;
      console.log(`✓ [Webhook] ${target.shopify_order_name} | ${result.reason}`);
    }
  } catch (error) {
    webhookStats.errors += 1;
    console.error(`❌ [Webhook] ${fields.merchantOrderId || ''}:`, error.message);
  }
}

// ============================================================
// WEBHOOK QUEUE
// ============================================================

let webhookQueue = Promise.resolve();

function enqueuePathaoWebhookEvent(body) {
  webhookQueue = webhookQueue
    .then(() => processPathaoWebhookEvent(body))
    .catch(error => {
      webhookStats.errors += 1;
      console.error('❌ Unhandled webhook error:', error.message);
    });

  return webhookQueue;
}

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Pathao -> Shopify Delivery Status Sync',
    endpoints: {
      health: 'GET /health',
      pathao_test: 'GET /api/test/pathao',
      shopify_test: 'GET /api/test/shopify',
      pathao_order: 'GET /api/pathao/order/:consignment_id',
      debug: 'GET /api/debug/:consignment_id',
      sync_manual: 'POST /api/sync/:consignment_id',
      auto_sync_status: 'GET /api/auto-sync/status',
      auto_sync_run: 'POST /api/auto-sync/run',
      webhook_status: 'GET /api/webhook/status',
      webhook: 'POST /webhooks/pathao'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/test/pathao', async (req, res) => {
  try {
    const token = await getPathaoToken();
    res.json({
      success: true,
      message: 'Pathao API authentication working',
      environment: PATHAO_BASE_URL.includes('sandbox') ? 'sandbox' : 'production'
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/shopify', async (req, res) => {
  try {
    const query = `query { fulfillmentOrders(first: 1) { nodes { id orderName } } }`;
    const data = await shopifyGraphQL(query);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/pathao/order/:consignment_id', async (req, res) => {
  try {
    const order = await getPathaoOrder(req.params.consignment_id);
    res.json({
      success: true,
      consignment_id: order.consignment_id || req.params.consignment_id,
      merchant_order_id: order.merchant_order_id || null,
      order_status: order.order_status || null,
      updated_at: order.updated_at || null
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/debug/:consignment_id', async (req, res) => {
  const trace = { consignment_id: req.params.consignment_id };

  try {
    trace.pathao_order = await getPathaoOrder(req.params.consignment_id);
  } catch (error) {
    trace.pathao_error = error.message;
  }

  try {
    trace.shopify_target = await findTargetByConsignmentId(req.params.consignment_id);
  } catch (error) {
    trace.shopify_error = error.message;
  }

  res.json({ success: true, trace });
});

app.post('/api/sync/:consignment_id', async (req, res) => {
  try {
    const target = await findTargetByConsignmentId(req.params.consignment_id);

    if (!target) {
      return res.status(404).json({ success: false, error: 'No Shopify fulfillment found for this consignment ID' });
    }

    const result = await syncTarget(target);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/auto-sync/status', (req, res) => {
  res.json({
    success: true,
    running: autoSyncRunning,
    interval_seconds: Math.round(POLL_INTERVAL_MS / 1000),
    lookback_days: POLL_LOOKBACK_DAYS,
    tracking_company: PATHAO_TRACKING_COMPANY,
    last_run: lastAutoSync
  });
});

app.post('/api/auto-sync/run', async (req, res) => {
  if (autoSyncRunning) {
    return res.status(409).json({ success: false, message: 'Auto-sync is already running' });
  }

  const result = await runAutomaticStatusSync();
  return res.json({ success: true, result });
});

app.get('/api/webhook/status', (req, res) => {
  res.json({
    success: true,
    secret_configured: Boolean(PATHAO_WEBHOOK_SECRET),
    stats: webhookStats
  });
});

app.post('/webhooks/pathao', (req, res) => {
  const body = req.body || {};

  // Verification handshake
  if (body.event === 'webhook_integration') {
    console.log('✅ Pathao webhook verification handshake');
    res.set('X-Pathao-Merchant-Webhook-Integration-Secret', PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ success: true, message: 'Verified' });
  }

  // Verify signature
  const signature = req.get('X-PATHAO-Signature') || req.get('X-Pathao-Signature');

  if (!isValidPathaoSignature(signature)) {
    webhookStats.rejected_invalid_signature += 1;
    console.warn('⚠️ Rejected webhook: invalid signature');
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  // Acknowledge immediately
  res.status(202).json({ success: true, received: true });

  // Process in background
  enqueuePathaoWebhookEvent(body);
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('🚀 PATHAO -> SHOPIFY STATUS SYNC');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}.myshopify.com`);
  console.log(`🚚 Pathao: ${PATHAO_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`🔄 Poll interval: ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
  console.log(`📅 Lookback: ${POLL_LOOKBACK_DAYS} days`);
  console.log(`🪝 Webhook: ${PATHAO_WEBHOOK_SECRET ? 'ENABLED' : 'ENABLED (⚠️ secret not set)'}`);
  console.log('============================================');

  // First sync 5 seconds after start
  setTimeout(() => {
    runAutomaticStatusSync().catch(error => {
      console.error('Initial auto-sync error:', error.message);
    });
  }, 5000);

  // Periodic sync
  setInterval(() => {
    runAutomaticStatusSync().catch(error => {
      console.error('Auto-sync error:', error.message);
    });
  }, POLL_INTERVAL_MS);
});
