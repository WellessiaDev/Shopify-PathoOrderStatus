const express = require('express');

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

const PORT = Number(process.env.PORT || 3001);
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL || 120000); // 2 minutes

// ============================================================
// TOKENS
// ============================================================

let shopifyToken = null;
let shopifyTokenExpires = 0;

let pathaoToken = null;
let pathaoTokenExpires = 0;

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
// GET PATHAO ORDER STATUS
// ============================================================

async function getPathaoOrderStatus(consignmentId) {
  const token = await getPathaoToken();

  const res = await fetchTimeout(
    `${PATHAO_BASE_URL}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }
  );

  const data = await res.json();

  if (!res.ok || !data.data) {
    console.error(`❌ Pathao error for ${consignmentId}:`, data.message || data.error);
    return null;
  }

  return data.data; // { consignment_id, merchant_order_id, order_status, updated_at, ... }
}

// ============================================================
// GET SHOPIFY ORDERS (simple)
// ============================================================

async function getShopifyOrders(limit = 50, after = null) {
  const token = await getShopifyToken();

  const query = `
    query GetOrders($first: Int!, $after: String) {
      orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          name
          updatedAt
          metafield(namespace: "custom" key: "pathao_consignment") {
            value
          }
          fulfillmentOrders(first: 10, query: "status:OPEN OR status:SCHEDULED") {
            nodes {
              id
              fulfillments(first: 10) {
                nodes {
                  id
                  status
                  lineItems(first: 20) {
                    nodes {
                      id
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
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
      body: JSON.stringify({ query, variables: { first: limit, after } })
    }
  );

  const payload = await res.json();

  if (payload.errors?.length) {
    console.error('❌ Shopify GraphQL error:', payload.errors);
    return { orders: [], hasNextPage: false, endCursor: null };
  }

  const orders = payload.data?.orders?.nodes || [];
  const hasNextPage = payload.data?.orders?.pageInfo?.hasNextPage || false;
  const endCursor = payload.data?.orders?.pageInfo?.endCursor || null;

  return { orders, hasNextPage, endCursor };
}

// ============================================================
// UPDATE SHOPIFY FULFILLMENT STATUS
// ============================================================

async function updateShopifyFulfillmentStatus(fulfillmentId, status, pathaoStatus) {
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
    message: `Pathao: ${pathaoStatus}`
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
    console.error('❌ Shopify update error:', payload.errors);
    return false;
  }

  const errors = payload.data?.fulfillmentEventCreate?.userErrors;
  if (errors?.length) {
    console.error('❌ Fulfillment event error:', errors);
    return false;
  }

  return true;
}

// ============================================================
// SET METAFIELD (store consignment ID on order)
// ============================================================

async function setOrderMetafield(orderId, consignmentId) {
  const token = await getShopifyToken();

  const mutation = `
    mutation SetMetafield($input: OrderInput!) {
      orderUpdate(input: $input) {
        order {
          id
          metafields(first: 10) {
            nodes {
              key
              value
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    id: orderId,
    metafields: [
      {
        namespace: 'custom',
        key: 'pathao_consignment',
        value: consignmentId,
        valueType: 'STRING'
      }
    ]
  };

  const res = await fetchTimeout(
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: mutation, variables: { input } })
    }
  );

  const payload = await res.json();

  if (payload.errors?.length) {
    console.error('❌ Metafield error:', payload.errors);
    return false;
  }

  return true;
}

// ============================================================
// MAP STATUS
// ============================================================

function mapPathaoStatus(pathaoStatus) {
  const status = String(pathaoStatus || '').toLowerCase().trim();

  if (status.includes('pending') || status.includes('order created') || status.includes('waiting')) {
    return 'CONFIRMED';
  }
  if (status.includes('picked') || status.includes('pickup')) {
    return 'CARRIER_PICKED_UP';
  }
  if (status.includes('out for') || status.includes('out_for')) {
    return 'OUT_FOR_DELIVERY';
  }
  if (status.includes('delivered')) {
    return 'DELIVERED';
  }
  if (status.includes('failed') || status.includes('attempted')) {
    return 'ATTEMPTED_DELIVERY';
  }
  if (status.includes('transit') || status.includes('in transit')) {
    return 'IN_TRANSIT';
  }

  return null;
}

// ============================================================
// SYNC LOGIC
// ============================================================

let syncing = false;
let lastSync = { startedAt: null, finishedAt: null, checked: 0, updated: 0, errors: 0 };

async function syncOrderStatuses() {
  if (syncing) {
    console.log('⏭ Sync already running');
    return;
  }

  syncing = true;
  lastSync = { startedAt: new Date().toISOString(), finishedAt: null, checked: 0, updated: 0, errors: 0 };

  console.log('\n============================================');
  console.log('🔄 SYNCING ORDER STATUSES');
  console.log(`🕒 ${lastSync.startedAt}`);
  console.log('============================================');

  try {
    let hasMore = true;
    let after = null;

    while (hasMore) {
      const { orders, hasNextPage, endCursor } = await getShopifyOrders(50, after);

      console.log(`📦 Fetched ${orders.length} orders`);

      for (const order of orders) {
        lastSync.checked += 1;

        try {
          // Get consignment ID from metafield
          const consignmentId = order.metafield?.value;

          if (!consignmentId) {
            console.log(`⏭ ${order.name} - no Pathao consignment ID`);
            continue;
          }

          console.log(`🔍 ${order.name} - consignment: ${consignmentId}`);

          // Get Pathao status
          const pathaoOrder = await getPathaoOrderStatus(consignmentId);

          if (!pathaoOrder) {
            console.log(`  ❌ Not found in Pathao`);
            lastSync.errors += 1;
            continue;
          }

          const pathaoStatus = pathaoOrder.order_status;
          const shopifyStatus = mapPathaoStatus(pathaoStatus);

          console.log(`  📦 Pathao status: ${pathaoStatus}`);
          console.log(`  🔄 Mapped to: ${shopifyStatus || '(no mapping)'}`);

          if (!shopifyStatus) {
            console.log(`  ⏭ No Shopify mapping`);
            continue;
          }

          // Update fulfillments
          const fulfillmentOrders = order.fulfillmentOrders?.nodes || [];

          for (const fulfillmentOrder of fulfillmentOrders) {
            const fulfillments = fulfillmentOrder.fulfillments?.nodes || [];

            for (const fulfillment of fulfillments) {
              const lineItemCount = fulfillment.lineItems?.nodes?.length || 0;

              if (lineItemCount === 0) {
                console.log(`    ⏭ Fulfillment has no line items`);
                continue;
              }

              console.log(`    📝 Updating fulfillment ${fulfillment.id} to ${shopifyStatus}`);

              const ok = await updateShopifyFulfillmentStatus(
                fulfillment.id,
                shopifyStatus,
                pathaoStatus
              );

              if (ok) {
                console.log(`    ✅ Updated`);
                lastSync.updated += 1;
              } else {
                console.log(`    ❌ Failed`);
                lastSync.errors += 1;
              }

              // Rate limiting
              await sleep(500);
            }
          }
        } catch (error) {
          console.error(`❌ Error processing ${order.name}:`, error.message);
          lastSync.errors += 1;
        }

        // Rate limiting between orders
        await sleep(1000);
      }

      hasMore = hasNextPage;
      after = endCursor;

      if (hasMore) {
        console.log('📄 Next page...');
        await sleep(2000);
      }
    }
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    lastSync.errors += 1;
  } finally {
    lastSync.finishedAt = new Date().toISOString();
    syncing = false;

    console.log('--------------------------------------------');
    console.log(`Checked: ${lastSync.checked}`);
    console.log(`Updated: ${lastSync.updated}`);
    console.log(`Errors: ${lastSync.errors}`);
    console.log('============================================\n');
  }
}

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Simple Pathao Order Status Sync',
    endpoints: {
      health: 'GET /health',
      status: 'GET /api/status',
      sync_now: 'POST /api/sync',
      test_pathao: 'GET /api/test/pathao',
      test_shopify: 'GET /api/test/shopify'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy' });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    syncing,
    interval_seconds: Math.round(SYNC_INTERVAL / 1000),
    last_sync: lastSync
  });
});

app.post('/api/sync', async (req, res) => {
  if (syncing) {
    return res.status(409).json({ success: false, message: 'Already syncing' });
  }

  syncOrderStatuses().catch(error => {
    console.error('Sync error:', error);
  });

  res.json({ success: true, message: 'Sync started' });
});

app.get('/api/test/pathao', async (req, res) => {
  try {
    const token = await getPathaoToken();
    res.json({ success: true, message: 'Pathao auth OK' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/shopify', async (req, res) => {
  try {
    const { orders } = await getShopifyOrders(1);
    res.json({ success: true, orders_found: orders.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('🚀 SIMPLE ORDER STATUS SYNC');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}`);
  console.log(`🚚 Pathao: ${PATHAO_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`⏱ Sync every: ${Math.round(SYNC_INTERVAL / 1000)}s`);
  console.log('============================================');

  // First sync after 5 seconds
  setTimeout(() => {
    syncOrderStatuses().catch(console.error);
  }, 5000);

  // Periodic sync
  setInterval(() => {
    syncOrderStatuses().catch(console.error);
  }, SYNC_INTERVAL);
});
