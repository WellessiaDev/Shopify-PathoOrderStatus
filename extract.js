const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
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

// WEBHOOK SECRET - Get this from Pathao Merchant Panel
const PATHAO_WEBHOOK_SECRET = process.env.PATHAO_WEBHOOK_SECRET || 'f3992ecc-59da-4cbe-a049-a13da2018d51';

const PORT = Number(process.env.PORT || 3002);

// ============================================================
// TOKENS
// ============================================================

let shopifyToken = null;
let shopifyTokenExpires = 0;

let pathaoToken = null;
let pathaoTokenExpires = 0;

// ============================================================
// STATS
// ============================================================

let stats = {
  webhooks_received: 0,
  webhooks_processed: 0,
  updates_sent: 0,
  errors: 0,
  last_webhook: null
};

// ============================================================
// UTILS
// ============================================================

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTimeout(url, options = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SHOPIFY TOKEN
// ============================================================

async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpires) {
    return shopifyToken;
  }

  console.log('🔐 Getting Shopify token...');

  const res = await fetchTimeout(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    }).toString()
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Shopify token failed: ${JSON.stringify(data)}`);
  }

  shopifyToken = data.access_token;
  shopifyTokenExpires = Date.now() + (data.expires_in || 86400) * 1000;

  console.log('✅ Shopify token OK');
  return shopifyToken;
}

// ============================================================
// PATHAO TOKEN
// ============================================================

async function getPathaoToken() {
  if (pathaoToken && Date.now() < pathaoTokenExpires) {
    return pathaoToken;
  }

  console.log('🔐 Getting Pathao token...');

  const res = await fetchTimeout(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PATHAO_CLIENT_ID,
      client_secret: PATHAO_CLIENT_SECRET,
      username: PATHAO_USERNAME,
      password: PATHAO_PASSWORD,
      grant_type: 'password'
    })
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Pathao token failed: ${JSON.stringify(data)}`);
  }

  pathaoToken = data.access_token;
  pathaoTokenExpires = Date.now() + (data.expires_in || 3600) * 1000;

  console.log('✅ Pathao token OK');
  return pathaoToken;
}

// ============================================================
// GET SHOPIFY ORDER BY MERCHANT ORDER ID
// ============================================================

async function getShopifyOrderByName(orderName) {
  const token = await getShopifyToken();

  const query = `
    query GetOrder($name: String!) {
      orders(first: 1, query: $name) {
        nodes {
          id
          name
          fulfillmentOrders(first: 10) {
            nodes {
              id
              status
              fulfillments(first: 10) {
                nodes {
                  id
                  status
                }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetchTimeout(
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables: { name: `name:${orderName}` } })
    }
  );

  const payload = await res.json();

  if (payload.errors?.length) {
    console.error('❌ GraphQL error:', payload.errors);
    throw new Error(payload.errors[0]?.message);
  }

  const orders = payload.data?.orders?.nodes || [];
  return orders[0] || null;
}

// ============================================================
// UPDATE SHOPIFY FULFILLMENT STATUS
// ============================================================

async function updateShopifyFulfillmentStatus(fulfillmentId, status, pathaoEvent) {
  const token = await getShopifyToken();

  const mutation = `
    mutation CreateFulfillmentEvent($event: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $event) {
        fulfillmentEvent {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const event = {
    fulfillmentId,
    status,
    message: `Pathao: ${pathaoEvent}`
  };

  const res = await fetchTimeout(
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: mutation, variables: { event } })
    }
  );

  const payload = await res.json();

  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message);
  }

  const errors = payload.data?.fulfillmentEventCreate?.userErrors;
  if (errors?.length) {
    throw new Error(errors[0]?.message);
  }

  return true;
}

// ============================================================
// MAP PATHAO EVENT TO SHOPIFY STATUS
// ============================================================

function mapEventToShopifyStatus(event) {
  event = String(event || '').toLowerCase();

  // Pending
  if (event.includes('order.created') || event.includes('order.updated') || event.includes('order.pickup-requested') || event.includes('order.assigned-for-pickup')) {
    return 'CONFIRMED';
  }

  // Picked up
  if (event.includes('order.picked')) {
    return 'CARRIER_PICKED_UP';
  }

  // In transit
  if (event.includes('order.at-the-sorting-hub') || event.includes('order.in-transit') || event.includes('order.received-at-last-mile-hub')) {
    return 'IN_TRANSIT';
  }

  // Out for delivery
  if (event.includes('order.assigned-for-delivery')) {
    return 'OUT_FOR_DELIVERY';
  }

  // Delivered
  if (event.includes('order.delivered') || event.includes('order.partial-delivery')) {
    return 'DELIVERED';
  }

  // Failed/Returned
  if (event.includes('order.pickup-failed') || event.includes('order.pickup-cancelled') || event.includes('order.returned')) {
    return 'ATTEMPTED_DELIVERY';
  }

  return null;
}

// ============================================================
// VERIFY WEBHOOK SIGNATURE
// ============================================================

function verifyWebhookSignature(signature) {
  if (!signature || !PATHAO_WEBHOOK_SECRET) {
    return false;
  }

  const provided = String(signature).trim();
  const expected = String(PATHAO_WEBHOOK_SECRET).trim();

  return provided === expected;
}

// ============================================================
// PROCESS WEBHOOK
// ============================================================

async function processWebhook(body) {
  stats.webhooks_received += 1;
  stats.last_webhook = new Date().toISOString();

  const consignmentId = body.consignment_id;
  const merchantOrderId = body.merchant_order_id;
  const event = body.event;

  console.log(`\n📨 Webhook received:`);
  console.log(`   📦 Consignment: ${consignmentId}`);
  console.log(`   🏷 Order ID: ${merchantOrderId}`);
  console.log(`   🔔 Event: ${event}`);

  if (!consignmentId || !merchantOrderId || !event) {
    console.log('   ❌ Missing required fields');
    return false;
  }

  // Map event to Shopify status
  const shopifyStatus = mapEventToShopifyStatus(event);

  if (!shopifyStatus) {
    console.log(`   ⏭ No Shopify mapping for this event`);
    return true; // Not an error, just skip
  }

  console.log(`   🔄 Mapped event to: ${shopifyStatus}`);

  try {
    // Get Shopify order
    const shopifyOrder = await getShopifyOrderByName(merchantOrderId);

    if (!shopifyOrder) {
      console.log(`   ❌ Order not found in Shopify: ${merchantOrderId}`);
      return false;
    }

    console.log(`   ✅ Found order: ${shopifyOrder.name}`);

    // Update fulfillments
    const fulfillmentOrders = shopifyOrder.fulfillmentOrders?.nodes || [];

    if (fulfillmentOrders.length === 0) {
      console.log(`   ⏭ No fulfillment orders found`);
      return true;
    }

    let updated = 0;

    for (const fulfillmentOrder of fulfillmentOrders) {
      const fulfillments = fulfillmentOrder.fulfillments?.nodes || [];

      for (const fulfillment of fulfillments) {
        console.log(`   📝 Updating fulfillment ${fulfillment.id}`);

        await updateShopifyFulfillmentStatus(fulfillment.id, shopifyStatus, event);

        console.log(`   ✅ Updated to ${shopifyStatus}`);
        updated += 1;

        await sleep(300);
      }
    }

    if (updated > 0) {
      stats.updates_sent += updated;
      stats.webhooks_processed += 1;
      return true;
    }

    return false;
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    stats.errors += 1;
    return false;
  }
}

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Pathao Webhook Status Sync',
    description: 'Listens for Pathao webhooks and automatically updates Shopify delivery status',
    endpoints: {
      health: 'GET /health',
      stats: 'GET /api/stats',
      webhook: 'POST /webhooks/pathao',
      test: 'GET /api/test'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats,
    webhook_secret_configured: Boolean(PATHAO_WEBHOOK_SECRET),
    expected_secret: PATHAO_WEBHOOK_SECRET
  });
});

app.get('/api/test', async (req, res) => {
  try {
    await getShopifyToken();
    await getPathaoToken();
    res.json({ success: true, message: 'Both connections OK' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// WEBHOOK ENDPOINT
// ============================================================

app.post('/webhooks/pathao', (req, res) => {
  const signature = req.get('X-PATHAO-Signature') || req.get('X-Pathao-Signature');
  const body = req.body || {};

  // Handle verification handshake
  if (body.event === 'webhook_integration') {
    console.log('✅ Pathao webhook verification handshake');
    res.set('X-Pathao-Merchant-Webhook-Integration-Secret', PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ success: true, message: 'Verified' });
  }

  // Verify signature
  if (!verifyWebhookSignature(signature)) {
    console.warn('⚠️ Webhook signature mismatch');
    console.warn(`   Expected: ${PATHAO_WEBHOOK_SECRET}`);
    console.warn(`   Received: ${signature}`);
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  // Acknowledge immediately (must respond within 10s)
  res.status(202).json({ success: true, received: true });

  // Process in background
  processWebhook(body).catch(error => {
    console.error('❌ Webhook processing error:', error.message);
    stats.errors += 1;
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('🚀 PATHAO WEBHOOK STATUS SYNC');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}`);
  console.log(`🚚 Pathao: ${PATHAO_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`🔐 Webhook secret configured: ${Boolean(PATHAO_WEBHOOK_SECRET)}`);
  console.log('============================================');
  console.log('');
  console.log('📌 Webhook URL for Pathao:');
  console.log(`   https://your-domain.com/webhooks/pathao`);
  console.log('');
  console.log('📝 Webhook Secret in Pathao:');
  console.log(`   ${PATHAO_WEBHOOK_SECRET}`);
  console.log('');
  console.log('🔄 How it works:');
  console.log('   1. Order status changes in Pathao');
  console.log('   2. Pathao sends webhook to your server');
  console.log('   3. Service receives webhook');
  console.log('   4. Verifies signature');
  console.log('   5. Updates Shopify fulfillment');
  console.log('');
  console.log('✅ Ready to receive webhooks!');
  console.log('============================================');
});
