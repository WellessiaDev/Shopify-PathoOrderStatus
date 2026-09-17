const express = require('express');

const app = express();

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

const PORT = process.env.PORT || 3001;


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing CLIENT_ID or CLIENT_SECRET');
  process.exit(1);
}

if (!PATHAO_CLIENT_ID || !PATHAO_CLIENT_SECRET || !PATHAO_USERNAME || !PATHAO_PASSWORD) {
  console.error('❌ Missing Pathao credentials');
  process.exit(1);
}


// ============================================================
// TOKEN CACHE
// ============================================================

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;


// ============================================================
// EXPRESS JSON BODY
// ============================================================

app.use(express.json({ limit: '1mb' }));


// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {

  if (SHOPIFY_TOKEN && Date.now() < SHOPIFY_EXPIRES_AT - 60000) {
    return SHOPIFY_TOKEN;
  }

  console.log('🔐 Requesting Shopify access token...');

  const tokenUrl = `https://${SHOP}.myshopify.com/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Shopify token response:', JSON.stringify(data, null, 2));
    throw new Error(
      `Shopify token error ${response.status}: ${data.error_description || data.error || JSON.stringify(data)}`
    );
  }

  if (!data.access_token) {
    throw new Error('Shopify response did not contain access_token');
  }

  SHOPIFY_TOKEN = data.access_token;
  SHOPIFY_EXPIRES_AT = Date.now() + (data.expires_in || 86400) * 1000;

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

  const tokenUrl = `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;

  const response = await fetch(tokenUrl, {
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

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Pathao token response:', JSON.stringify(data, null, 2));
    throw new Error(
      `Pathao token error ${response.status}: ${data.message || data.error || JSON.stringify(data)}`
    );
  }

  if (!data.access_token) {
    throw new Error('Pathao response did not contain access_token');
  }

  PATHAO_TOKEN = data.access_token;
  PATHAO_EXPIRES_AT = Date.now() + (data.expires_in || 3600) * 1000;

  console.log('✅ Pathao access token obtained');

  return PATHAO_TOKEN;
}


// ============================================================
// SHOPIFY GRAPHQL REQUEST
// ============================================================
//
// NOTE: your original file called `shopifyGraphql(...)` inside
// updateShopifyDeliveryStatus() but never defined that function
// anywhere — it would have thrown "shopifyGraphql is not defined"
// the first time this code path ran. Defined here so this file
// actually works standalone.
//
// ============================================================

async function shopifyGraphql(query, variables = {}) {

  const token = await getShopifyToken();

  const url = `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Shopify GraphQL API ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (data.errors) {
    const error = new Error('Shopify GraphQL returned errors');
    error.status = 400;
    error.data = data.errors;
    throw error;
  }

  return data;
}


// ============================================================
// GET PATHAO ORDER STATUS
// ============================================================

async function getPathaoOrderStatus(consignmentId) {

  if (!consignmentId) {
    throw new Error('Consignment ID is required');
  }

  const token = await getPathaoToken();

  const endpoint = `/aladdin/api/v1/orders/${encodeURIComponent(String(consignmentId))}/info`;

  const response = await fetch(`${PATHAO_BASE_URL}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Pathao status response:', JSON.stringify(data, null, 2));
    throw new Error(
      `Pathao status error ${response.status}: ${data.message || data.error || JSON.stringify(data)}`
    );
  }

  return data.data || data;
}


// ============================================================
// UPDATE SHOPIFY DELIVERY STATUS
// ============================================================

async function updateShopifyDeliveryStatus(shopifyOrderId, pathaoStatus) {

  if (!shopifyOrderId || !pathaoStatus) {
    throw new Error('Order ID and status are required');
  }

  const status = String(pathaoStatus).toLowerCase();

  let fulfillmentStatus = 'pending';

  if (status.includes('delivered') || status.includes('completed')) {
    fulfillmentStatus = 'fulfilled';
  } else if (
    status.includes('cancelled') ||
    status.includes('failed') ||
    status.includes('returned')
  ) {
    fulfillmentStatus = 'cancelled';
  } else if (
    status.includes('in_transit') ||
    status.includes('in transit') ||
    status.includes('out_for_delivery') ||
    status.includes('out for delivery')
  ) {
    fulfillmentStatus = 'in_transit';
  }

  const mutation = `
    mutation UpdatePathaoStatus($id: ID!, $value: String!) {
      orderUpdateV2(
        input: {
          id: $id
          customAttributes: { key: "pathao_status", value: $value }
        }
      ) {
        order {
          id
          customAttributes {
            key
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: `gid://shopify/Order/${shopifyOrderId}`,
    value: status
  };

  const result = await shopifyGraphql(mutation, variables);

  if (result.data?.orderUpdateV2?.userErrors?.length > 0) {
    console.error('❌ Shopify update error:', result.data.orderUpdateV2.userErrors);
    throw new Error('Failed to update Shopify order');
  }

  console.log(`✅ Updated Shopify order ${shopifyOrderId} with Pathao status: ${status}`);

  // fulfillmentStatus is computed above for potential downstream use
  // (e.g. driving a separate fulfillment-status update) but is not
  // sent anywhere in the original code — left here for you to wire up.
  void fulfillmentStatus;

  return result.data?.orderUpdateV2?.order;
}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});


// ============================================================
// SYNC ORDER STATUS
// ============================================================

app.post('/api/sync/order-status', async (req, res) => {

  try {

    const { consignment_id, shopify_order_id } = req.body;

    if (!consignment_id || !shopify_order_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing consignment_id or shopify_order_id'
      });
    }

    // Get Pathao order status
    const pathaoStatus = await getPathaoOrderStatus(consignment_id);

    if (!pathaoStatus) {
      return res.status(404).json({
        success: false,
        error: 'Order not found in Pathao'
      });
    }

    // Update Shopify order
    const updatedOrder = await updateShopifyDeliveryStatus(
      shopify_order_id,
      pathaoStatus.order_status
    );

    console.log(
      `📦 Order status synced - Consignment: ${consignment_id}, Status: ${pathaoStatus.order_status}`
    );

    res.json({
      success: true,
      shopify_order_id: shopify_order_id,
      consignment_id: consignment_id,
      pathao_status: pathaoStatus.order_status,
      shopify_update: updatedOrder
    });

  } catch (error) {

    console.error('❌ Order status sync error:', error.data || error.message);

    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.data || null
    });
  }
});


// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('🚀 ORDER STATUS SYNC SERVICE');
  console.log('============================================');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}.myshopify.com`);
  console.log(`📡 Shopify API: ${SHOPIFY_API_VERSION}`);
  console.log(
    `🚚 Pathao: ${PATHAO_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}`
  );
  console.log('🔗 Endpoint: POST /api/sync/order-status');
  console.log('============================================');
});
