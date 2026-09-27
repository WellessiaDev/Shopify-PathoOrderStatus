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

// The secret you enter in the Pathao Merchant Panel webhook integration form.
// Pathao echoes it back to us on the verification handshake, and sends it
// on every subsequent event as the X-PATHAO-Signature header.
const PATHAO_WEBHOOK_SECRET = process.env.PATHAO_WEBHOOK_SECRET || '';

const PORT = Number(process.env.PORT || 3000);

// Check every minute (fallback polling, in addition to the webhook)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

// Check recent fulfillment orders
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

// Webhook stats, separate from the polling stats above.
let webhookStats = {
  last_event_at: null,
  received: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  rejected_invalid_signature: 0
};

// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {
  if (SHOPIFY_TOKEN && Date.now() < SHOPIFY_EXPIRES_AT - 60000) {
    return SHOPIFY_TOKEN;
  }

  console.log('🔐 Requesting Shopify access token...');

  const response = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
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
    throw new Error(`Shopify token error ${response.status}: ${data.error_description || data.error || JSON.stringify(data)}`);
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

  const response = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
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
    throw new Error(`Pathao token error ${response.status}: ${data.message || data.error || JSON.stringify(data)}`);
  }

  PATHAO_TOKEN = data.access_token;
  PATHAO_EXPIRES_AT = Date.now() + Number(data.expires_in || 3600) * 1000;

  console.log('✅ Pathao access token obtained');

  return PATHAO_TOKEN;
}

// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyToken();

  const response = await fetch(`https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
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
  const token = await getPathaoToken();

  const response = await fetch(
    `${PATHAO_BASE_URL}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`,
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

  return data.data || data;
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
    status.includes('order created')
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

  // Do not incorrectly map these
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
// CREATE SHOPIFY DELIVERY EVENT
// ============================================================

async function createShopifyFulfillmentEvent(fulfillmentId, shopifyStatus, pathaoStatus, pathaoUpdatedAt = null) {
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

  // Pathao timestamp example: 2026-09-17 22:49:28 (Bangladesh UTC+6)
  if (pathaoUpdatedAt) {
    const parsed = new Date(`${String(pathaoUpdatedAt).replace(' ', 'T')}+06:00`);

    if (!Number.isNaN(parsed.getTime())) {
      event.happenedAt = parsed.toISOString();
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
// SHARED: BUILD A "TARGET" FROM A FULFILLMENT ORDER NODE
// ============================================================

function extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder, seen) {
  const targets = [];

  for (const fulfillment of fulfillmentOrder.fulfillments?.nodes || []) {
    for (const tracking of fulfillment.trackingInfo || []) {
      const company = String(tracking.company || '').toLowerCase();
      const consignmentId = String(tracking.number || '').trim();

      if (!consignmentId) continue;

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
        // NOTE: Fulfillment.events requires a scope this app's token
        // doesn't have ("Access denied for events field"), so we use
        // displayStatus (Shopify's own current-status summary) as the
        // dedup baseline instead of the last fulfillment event.
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
// GET SHOPIFY FULFILLMENT ORDERS (bulk, for the polling sync)
//
// IMPORTANT: this does NOT use orders(...), so it avoids
// "Access denied for orders field". Shopify FulfillmentOrder
// exposes orderName / fulfillments / trackingInfo directly.
// ============================================================

async function getPathaoFulfillmentTargets() {
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

  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(query, {
      first: 100,
      after,
      search: `updated_at:>=${since}`
    });

    const connection = data.fulfillmentOrders;

    for (const fulfillmentOrder of connection.nodes || []) {
      targets.push(...extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder, seen));
    }

    hasNextPage = Boolean(connection.pageInfo.hasNextPage);
    after = connection.pageInfo.endCursor;
  }

  return targets;
}

// ============================================================
// GET SHOPIFY FULFILLMENT ORDERS BY ORDER NAME (targeted lookup,
// used by the webhook so we don't have to scan every recent order)
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

  const data = await shopifyGraphQL(query, { search: `name:${normalizedName}` });

  const targets = [];
  for (const fulfillmentOrder of data.fulfillmentOrders?.nodes || []) {
    targets.push(...extractPathaoTargetsFromFulfillmentOrderNode(fulfillmentOrder));
  }

  return targets;
}

// ============================================================
// APPLY A KNOWN PATHAO STATUS TO A SHOPIFY FULFILLMENT
//
// Shared by the polling sync (which fetches the status from the
// Pathao API) and the webhook handler (which already has the
// status in the event payload).
// ============================================================

async function applyPathaoStatusToShopify(target, { merchantOrderId, pathaoStatus, pathaoStatusSlug = '', pathaoUpdatedAt = null }) {
  if (!merchantOrderId || !pathaoStatus) {
    return {
      success: false,
      updated: false,
      skipped: true,
      reason: 'Pathao merchant_order_id or order_status missing',
      consignment_id: target.consignment_id
    };
  }

  // Verify order: Pathao merchant_order_id (#WELL26287635) must match
  // Shopify fulfillmentOrder.orderName (#WELL26287635)
  if (merchantOrderId !== target.shopify_order_name) {
    return {
      success: false,
      updated: false,
      skipped: true,
      reason: 'Pathao merchant_order_id does not match Shopify orderName',
      merchant_order_id: merchantOrderId,
      shopify_order_name: target.shopify_order_name,
      consignment_id: target.consignment_id
    };
  }

  const shopifyStatus = mapPathaoStatus(pathaoStatus, pathaoStatusSlug);

  if (!shopifyStatus) {
    return {
      success: true,
      updated: false,
      skipped: true,
      reason: 'Pathao status is not mapped to a Shopify delivery event',
      merchant_order_id: merchantOrderId,
      pathao_order_status: pathaoStatus,
      pathao_order_status_slug: pathaoStatusSlug
    };
  }

  if (target.current_shopify_status === shopifyStatus) {
    return {
      success: true,
      updated: false,
      skipped: true,
      reason: 'Shopify already has this delivery status',
      merchant_order_id: merchantOrderId,
      pathao_order_status: pathaoStatus,
      shopify_delivery_status: shopifyStatus
    };
  }

  const event = await createShopifyFulfillmentEvent(target.fulfillment_id, shopifyStatus, pathaoStatus, pathaoUpdatedAt);

  return {
    success: true,
    updated: true,
    merchant_order_id: merchantOrderId,
    shopify_order_name: target.shopify_order_name,
    consignment_id: target.consignment_id,
    pathao_order_status: pathaoStatus,
    pathao_order_status_slug: pathaoStatusSlug,
    previous_shopify_status: target.current_shopify_status,
    shopify_delivery_status: event.status,
    fulfillment_id: target.fulfillment_id,
    event_id: event.id
  };
}

// ============================================================
// SYNC ONE PATHAO ORDER -> SHOPIFY (polling path — calls the
// Pathao order-info API to find out the current status)
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
// FIND TARGET USING CONSIGNMENT ID (full scan fallback)
// ============================================================

async function findTargetByConsignmentId(consignmentId) {
  const targets = await getPathaoFulfillmentTargets();

  return targets.find(item => item.consignment_id === String(consignmentId)) || null;
}

// ============================================================
// AUTOMATIC SYNC (polling — safety net alongside the webhook)
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

    console.log(`📦 Pathao fulfillments found: ${targets.length}`);

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
        console.error(
          `❌ ${target.shopify_order_name} / ${target.consignment_id}:`,
          JSON.stringify(error.data || { message: error.message }, null, 2)
        );
      }
    }
  } catch (error) {
    stats.errors += 1;
    console.error('❌ Auto-sync cycle failed:', JSON.stringify(error.data || { message: error.message }, null, 2));
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
//
// Per Pathao's docs, the X-PATHAO-Signature header is simply the
// secret you configured in the Merchant Panel, sent back on every
// event — not an HMAC of the body. So verification is an equality
// check (done in constant time to avoid timing attacks).
// ============================================================

function isValidPathaoSignature(signature) {
  if (!PATHAO_WEBHOOK_SECRET || !signature) return false;

  const provided = Buffer.from(String(signature));
  const expected = Buffer.from(PATHAO_WEBHOOK_SECRET);

  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}

// ============================================================
// PATHAO WEBHOOK — PARSE INCOMING EVENT PAYLOAD
//
// Pathao's exact field names can vary slightly by event type, so
// this pulls from the top level, or a nested "data"/"order" object,
// whichever is present. Falls back to the "event" name itself
// (e.g. "Delivered", "Picked Up") when a dedicated order_status
// field isn't included.
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
// PATHAO WEBHOOK — PROCESS ONE EVENT
// ============================================================

async function processPathaoWebhookEvent(body) {
  webhookStats.last_event_at = new Date().toISOString();
  webhookStats.received += 1;

  const fields = extractPathaoWebhookFields(body);

  if (!fields.consignmentId || !fields.orderStatus) {
    webhookStats.skipped += 1;
    console.log(`⏭ [Webhook] Ignoring event, missing consignment_id or status: ${JSON.stringify(body)}`);
    return;
  }

  try {
    // Fast path: look the order up directly by name.
    let targets = fields.merchantOrderId
      ? await getPathaoFulfillmentTargetsByOrderName(fields.merchantOrderId)
      : [];

    let target = targets.find(t => t.consignment_id === fields.consignmentId) || null;

    // Fallback: scan recent fulfillment orders by consignment id
    // (covers cases where merchant_order_id was missing/mismatched).
    if (!target) {
      target = await findTargetByConsignmentId(fields.consignmentId);
    }

    if (!target) {
      webhookStats.skipped += 1;
      console.log(`⏭ [Webhook] No matching Shopify fulfillment for consignment ${fields.consignmentId}`);
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
    console.error(
      `❌ [Webhook] ${fields.merchantOrderId || ''} / ${fields.consignmentId}:`,
      JSON.stringify(error.data || { message: error.message }, null, 2)
    );
  }
}

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Pathao -> Shopify Delivery Status Sync',
    shopify_lookup: 'fulfillmentOrders',
    orders_query: false,
    auto_sync: true,
    webhook_enabled: true,
    interval_seconds: Math.round(POLL_INTERVAL_MS / 1000),
    endpoints: {
      health: 'GET /health',
      pathao_auth: 'GET /api/test/pathao',
      shopify_test: 'GET /api/test/shopify-fulfillment-orders',
      pathao_order: 'GET /api/pathao/order/:consignment_id',
      manual_sync: 'POST /api/sync/:consignment_id',
      auto_sync_status: 'GET /api/auto-sync/status',
      auto_sync_run: 'POST /api/auto-sync/run',
      webhook_status: 'GET /api/webhook/status',
      pathao_webhook: 'POST /webhooks/pathao'
    }
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================
// TEST PATHAO AUTH
// ============================================================

app.get('/api/test/pathao', async (req, res) => {
  try {
    const token = await getPathaoToken();

    res.json({
      success: true,
      message: 'Pathao API authentication working',
      environment: PATHAO_BASE_URL.includes('sandbox') ? 'sandbox' : 'production',
      access_token_received: Boolean(token)
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

// ============================================================
// TEST SHOPIFY FULFILLMENT ORDER ACCESS
// (does NOT query orders(...))
// ============================================================

app.get('/api/test/shopify-fulfillment-orders', async (req, res) => {
  try {
    const query = `
      query {
        fulfillmentOrders(first: 5, includeClosed: true) {
          nodes {
            id
            orderName
            orderId
            status
            updatedAt
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query);

    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

// ============================================================
// CHECK PATHAO ORDER
// ============================================================

app.get('/api/pathao/order/:consignment_id', async (req, res) => {
  try {
    const order = await getPathaoOrder(req.params.consignment_id);

    res.json({
      success: true,
      consignment_id: order.consignment_id || req.params.consignment_id,
      merchant_order_id: order.merchant_order_id || null,
      order_status: order.order_status || null,
      order_status_slug: order.order_status_slug || null,
      updated_at: order.updated_at || null,
      data: order
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      consignment_id: req.params.consignment_id,
      error: error.message,
      details: error.data || null
    });
  }
});

// ============================================================
// MANUAL SYNC ONE CONSIGNMENT
// ============================================================

app.post('/api/sync/:consignment_id', async (req, res) => {
  try {
    const target = await findTargetByConsignmentId(req.params.consignment_id);

    if (!target) {
      return res.status(404).json({
        success: false,
        error: 'No Shopify Pathao fulfillment found with this consignment ID'
      });
    }

    const result = await syncTarget(target);

    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

// ============================================================
// AUTO SYNC STATUS
// ============================================================

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

// ============================================================
// MANUAL AUTO SYNC RUN
// ============================================================

app.post('/api/auto-sync/run', async (req, res) => {
  if (autoSyncRunning) {
    return res.status(409).json({ success: false, message: 'Auto-sync is already running' });
  }

  const result = await runAutomaticStatusSync();

  return res.json({ success: true, result });
});

// ============================================================
// WEBHOOK STATUS
// ============================================================

app.get('/api/webhook/status', (req, res) => {
  res.json({
    success: true,
    secret_configured: Boolean(PATHAO_WEBHOOK_SECRET),
    stats: webhookStats
  });
});

// ============================================================
// PATHAO WEBHOOK
//
// Handles two kinds of requests:
//
// 1. The one-time verification handshake Pathao sends when you
//    click "Add Webhook" in the Merchant Panel:
//      { "event": "webhook_integration" }
//    We must reply with HTTP 202 and a
//    X-Pathao-Merchant-Webhook-Integration-Secret header whose
//    value exactly matches the secret you entered in that form.
//
// 2. Every real delivery-status event afterwards (Order Created,
//    Picked Up, In Transit, Delivered, etc.), which arrives with
//    an X-PATHAO-Signature header equal to that same secret. We
//    verify it, acknowledge immediately (202), and update the
//    matching Shopify fulfillment in the background.
// ============================================================

app.post('/webhooks/pathao', (req, res) => {
  const body = req.body || {};

  // 1. Verification handshake
  if (body.event === 'webhook_integration') {
    console.log('✅ Pathao webhook verification handshake received');

    res.set('X-Pathao-Merchant-Webhook-Integration-Secret', PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ success: true, message: 'Webhook verified' });
  }

  // 2. Real event — verify signature first
  const signature = req.get('X-PATHAO-Signature') || req.get('X-Pathao-Signature');

  if (!isValidPathaoSignature(signature)) {
    webhookStats.rejected_invalid_signature += 1;
    console.warn('⚠️ Rejected Pathao webhook: invalid or missing X-PATHAO-Signature');
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  // Acknowledge immediately (must respond within 10s), then process.
  res.status(202).json({ success: true, received: true });

  processPathaoWebhookEvent(body).catch(error => {
    webhookStats.errors += 1;
    console.error('❌ Unhandled error processing Pathao webhook event:', error);
  });
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', path: req.path });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('🚀 PATHAO -> SHOPIFY STATUS SYNC');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}.myshopify.com`);
  console.log(`📡 Shopify API: ${SHOPIFY_API_VERSION}`);
  console.log(`🚚 Pathao: ${PATHAO_BASE_URL}`);
  console.log('🧾 Shopify lookup: fulfillmentOrders');
  console.log('🚫 orders(...) query: DISABLED');
  console.log(`🔄 Poll interval (fallback): ${POLL_INTERVAL_MS / 1000} seconds`);
  console.log(`📅 Lookback: ${POLL_LOOKBACK_DAYS} days`);
  console.log(`🪝 Pathao webhook: ${PATHAO_WEBHOOK_SECRET ? 'ENABLED' : 'ENABLED (⚠️ secret not set)'}`);
  console.log('============================================');

  // First automatic check, 5 seconds after start.
  setTimeout(() => {
    runAutomaticStatusSync().catch(error => {
      console.error('Initial auto-sync error:', error);
    });
  }, 5000);

  // Every POLL_INTERVAL_MS, as a safety net alongside the webhook.
  setInterval(() => {
    runAutomaticStatusSync().catch(error => {
      console.error('Auto-sync error:', error);
    });
  }, POLL_INTERVAL_MS);
});
