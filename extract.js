const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ============================================================
// HELPERS
// ============================================================

function cleanEnv(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

// ============================================================
// CONFIGURATION
// ============================================================

const CLIENT_ID = cleanEnv(process.env.CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.CLIENT_SECRET);

const SHOP = cleanEnv(process.env.SHOP || 'wellessia');

/*
IMPORTANT:

Your previous webhook log showed:

Shop: a1f2c6-5.myshopify.com

If that is your REAL Shopify .myshopify.com domain,
add this Railway variable:

SHOPIFY_SHOP_DOMAIN=a1f2c6-5.myshopify.com

Otherwise it falls back to:

wellessia.myshopify.com
*/

const SHOPIFY_SHOP_DOMAIN =
  cleanEnv(process.env.SHOPIFY_SHOP_DOMAIN) ||
  `${SHOP}.myshopify.com`;

const SHOPIFY_API_VERSION =
  cleanEnv(process.env.SHOPIFY_API_VERSION) ||
  '2026-07';

// ------------------------------------------------------------
// PATHAO
// ------------------------------------------------------------

const PATHAO_BASE_URL =
  cleanEnv(process.env.PATHAO_BASE_URL) ||
  'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID =
  cleanEnv(process.env.PATHAO_CLIENT_ID);

const PATHAO_CLIENT_SECRET =
  cleanEnv(process.env.PATHAO_CLIENT_SECRET);

const PATHAO_USERNAME =
  cleanEnv(process.env.PATHAO_USERNAME);

const PATHAO_PASSWORD =
  cleanEnv(process.env.PATHAO_PASSWORD);

const PATHAO_GRANT_TYPE =
  cleanEnv(process.env.PATHAO_GRANT_TYPE) ||
  'password';

const PORT =
  Number(cleanEnv(process.env.PORT)) ||
  3000;

// ============================================================
// CHECK ENVIRONMENT
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '❌ Missing Shopify CLIENT_ID or CLIENT_SECRET'
  );
  process.exit(1);
}

if (
  !PATHAO_CLIENT_ID ||
  !PATHAO_CLIENT_SECRET ||
  !PATHAO_USERNAME ||
  !PATHAO_PASSWORD
) {
  console.error(
    '❌ Missing Pathao credentials'
  );

  console.error({
    client_id: !!PATHAO_CLIENT_ID,
    client_secret: !!PATHAO_CLIENT_SECRET,
    username: !!PATHAO_USERNAME,
    password: !!PATHAO_PASSWORD
  });

  process.exit(1);
}

// ============================================================
// TOKEN CACHE
// ============================================================

// Shopify
let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

// Pathao
let PATHAO_TOKEN = null;
let PATHAO_REFRESH_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;

// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {

  if (
    SHOPIFY_TOKEN &&
    Date.now() <
      SHOPIFY_EXPIRES_AT - 60000
  ) {
    return SHOPIFY_TOKEN;
  }

  console.log(
    '🔐 Requesting Shopify access token...'
  );

  const url =
    `https://${SHOPIFY_SHOP_DOMAIN}` +
    `/admin/oauth/access_token`;

  const body =
    new URLSearchParams({
      grant_type:
        'client_credentials',

      client_id:
        CLIENT_ID,

      client_secret:
        CLIENT_SECRET
    });

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },

      body:
        body.toString()
    });

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    console.error(
      '❌ Shopify token response:',
      data
    );

    throw new Error(
      `Shopify token error ${response.status}: ${
        data.error_description ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }

  if (!data.access_token) {
    throw new Error(
      'Shopify did not return access_token'
    );
  }

  SHOPIFY_TOKEN =
    data.access_token;

  SHOPIFY_EXPIRES_AT =
    Date.now() +
    (Number(data.expires_in) || 86400) *
      1000;

  console.log(
    '✅ Shopify access token obtained'
  );

  return SHOPIFY_TOKEN;
}

// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

async function shopifyGraphql(
  query,
  variables = {}
) {

  const token =
    await getShopifyToken();

  const url =
    `https://${SHOPIFY_SHOP_DOMAIN}` +
    `/admin/api/${SHOPIFY_API_VERSION}` +
    `/graphql.json`;

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'X-Shopify-Access-Token':
          token,

        'Content-Type':
          'application/json',

        Accept:
          'application/json'
      },

      body:
        JSON.stringify({
          query,
          variables
        })
    });

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    const error =
      new Error(
        `Shopify GraphQL HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  if (
    Array.isArray(data.errors) &&
    data.errors.length
  ) {

    console.error(
      '❌ Shopify GraphQL errors:',
      JSON.stringify(
        data.errors,
        null,
        2
      )
    );

    const error =
      new Error(
        data.errors
          .map(
            (item) =>
              item.message
          )
          .join(' | ')
      );

    error.status =
      400;

    error.data =
      data.errors;

    throw error;
  }

  return data;
}

// ============================================================
// SHOPIFY USER ERRORS
// ============================================================

function throwShopifyUserErrors(
  label,
  errors
) {

  if (
    !Array.isArray(errors) ||
    !errors.length
  ) {
    return;
  }

  const message =
    errors
      .map(
        (error) => {

          const field =
            Array.isArray(
              error.field
            )
              ? error.field.join('.')
              : error.field ||
                'unknown';

          return (
            `${field}: ` +
            `${error.message}`
          );
        }
      )
      .join(' | ');

  throw new Error(
    `${label}: ${message}`
  );
}

// ============================================================
// PATHAO — ISSUE FIRST TOKEN
// ============================================================

async function issuePathaoToken() {

  const url =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/issue-token`;

  console.log(
    '============================================'
  );

  console.log(
    '🔐 PATHAO TOKEN REQUEST'
  );

  console.log(
    '============================================'
  );

  console.log(
    'URL:',
    url
  );

  console.log(
    'Grant Type:',
    PATHAO_GRANT_TYPE
  );

  console.log(
    'Client ID present:',
    !!PATHAO_CLIENT_ID
  );

  console.log(
    'Client Secret present:',
    !!PATHAO_CLIENT_SECRET
  );

  console.log(
    'Username:',
    PATHAO_USERNAME
  );

  console.log(
    'Password present:',
    !!PATHAO_PASSWORD
  );

  console.log(
    'Username length:',
    PATHAO_USERNAME.length
  );

  console.log(
    'Password length:',
    PATHAO_PASSWORD.length
  );

  console.log(
    '============================================'
  );

  const response =
    await fetch(url, {

      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        Accept:
          'application/json'
      },

      body:
        JSON.stringify({

          client_id:
            PATHAO_CLIENT_ID,

          client_secret:
            PATHAO_CLIENT_SECRET,

          grant_type:
            'password',

          username:
            PATHAO_USERNAME,

          password:
            PATHAO_PASSWORD
        })
    });

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  console.log(
    'Pathao HTTP Status:',
    response.status
  );

  if (!response.ok) {

    console.error(
      '❌ PATHAO TOKEN ERROR'
    );

    console.error(
      JSON.stringify(
        data,
        null,
        2
      )
    );

    throw new Error(
      `Pathao token error ${response.status}: ${
        data.message ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }

  if (!data.access_token) {
    throw new Error(
      'Pathao did not return access_token'
    );
  }

  PATHAO_TOKEN =
    data.access_token;

  PATHAO_REFRESH_TOKEN =
    data.refresh_token || null;

  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      Number(data.expires_in) ||
      432000
    ) *
      1000;

  console.log(
    '✅ Pathao access token obtained'
  );

  console.log(
    '✅ Refresh token:',
    !!PATHAO_REFRESH_TOKEN
  );

  console.log(
    '✅ expires_in:',
    data.expires_in
  );

  return PATHAO_TOKEN;
}

// ============================================================
// PATHAO — REFRESH TOKEN
// ============================================================

async function refreshPathaoToken() {

  if (!PATHAO_REFRESH_TOKEN) {

    console.log(
      'ℹ️ No Pathao refresh token available.'
    );

    return issuePathaoToken();
  }

  console.log(
    '🔄 Refreshing Pathao access token...'
  );

  const url =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/issue-token`;

  const response =
    await fetch(url, {

      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        Accept:
          'application/json'
      },

      body:
        JSON.stringify({

          client_id:
            PATHAO_CLIENT_ID,

          client_secret:
            PATHAO_CLIENT_SECRET,

          grant_type:
            'refresh_token',

          refresh_token:
            PATHAO_REFRESH_TOKEN
        })
    });

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    console.error(
      '⚠️ Pathao refresh failed:',
      JSON.stringify(
        data,
        null,
        2
      )
    );

    PATHAO_TOKEN = null;
    PATHAO_REFRESH_TOKEN = null;
    PATHAO_EXPIRES_AT = 0;

    // Try normal login again
    return issuePathaoToken();
  }

  if (!data.access_token) {

    PATHAO_TOKEN = null;
    PATHAO_REFRESH_TOKEN = null;

    return issuePathaoToken();
  }

  PATHAO_TOKEN =
    data.access_token;

  PATHAO_REFRESH_TOKEN =
    data.refresh_token ||
    PATHAO_REFRESH_TOKEN;

  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      Number(data.expires_in) ||
      432000
    ) *
      1000;

  console.log(
    '✅ Pathao token refreshed'
  );

  return PATHAO_TOKEN;
}

// ============================================================
// GET VALID PATHAO TOKEN
// ============================================================

async function getPathaoToken() {

  if (
    PATHAO_TOKEN &&
    Date.now() <
      PATHAO_EXPIRES_AT - 60000
  ) {

    return PATHAO_TOKEN;
  }

  if (PATHAO_REFRESH_TOKEN) {
    return refreshPathaoToken();
  }

  return issuePathaoToken();
}

// ============================================================
// PATHAO — GET ORDER SHORT INFO
// ============================================================

async function getPathaoOrderInfo(
  consignmentId
) {

  if (!consignmentId) {
    throw new Error(
      'consignment_id is required'
    );
  }

  const token =
    await getPathaoToken();

  const url =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/orders/` +
    `${encodeURIComponent(
      String(consignmentId)
    )}/info`;

  console.log(
    '============================================'
  );

  console.log(
    '📦 GET PATHAO ORDER INFO'
  );

  console.log(
    'Consignment:',
    consignmentId
  );

  console.log(
    '============================================'
  );

  const response =
    await fetch(url, {

      method: 'GET',

      headers: {

        Authorization:
          `Bearer ${token}`,

        Accept:
          'application/json'
      }
    });

  const text =
    await response.text();

  let result;

  try {
    result =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    result = {
      raw: text
    };
  }

  if (!response.ok) {

    console.error(
      '❌ Pathao order error:',
      JSON.stringify(
        result,
        null,
        2
      )
    );

    throw new Error(
      `Pathao order error ${response.status}: ${
        result.message ||
        result.error ||
        JSON.stringify(result)
      }`
    );
  }

  const data =
    result.data || result;

  console.log(
    '✅ PATHAO ORDER FOUND'
  );

  console.log(
    'Consignment ID:',
    data.consignment_id
  );

  console.log(
    'Merchant Order ID:',
    data.merchant_order_id
  );

  console.log(
    'Order Status:',
    data.order_status
  );

  console.log(
    'Order Status Slug:',
    data.order_status_slug
  );

  console.log(
    'Updated At:',
    data.updated_at
  );

  return data;
}

// ============================================================
// NORMALIZE ORDER NAME
// ============================================================

function normalizeOrderName(
  value
) {

  return String(
    value || ''
  )
    .trim()
    .replace(
      /^#/,
      ''
    )
    .toLowerCase();
}

// ============================================================
// FIND SHOPIFY ORDER
//
// Pathao:
// merchant_order_id = #WELL26287633
//
// Shopify:
// name = #WELL26287633
// ============================================================

async function findShopifyOrderByName(
  merchantOrderId
) {

  if (!merchantOrderId) {
    throw new Error(
      'Pathao merchant_order_id is missing'
    );
  }

  const originalName =
    String(
      merchantOrderId
    ).trim();

  const searchName =
    originalName.replace(
      /^#/,
      ''
    );

  console.log(
    '============================================'
  );

  console.log(
    '🔎 FIND SHOPIFY ORDER'
  );

  console.log(
    'Pathao merchant_order_id:',
    originalName
  );

  const query = `
    query FindOrder(
      $query: String!
    ) {
      orders(
        first: 20
        query: $query
      ) {
        nodes {
          id
          name
          displayFulfillmentStatus
        }
      }
    }
  `;

  const response =
    await shopifyGraphql(
      query,
      {
        query:
          `name:${searchName}`
      }
    );

  const orders =
    response.data
      ?.orders
      ?.nodes || [];

  const expected =
    normalizeOrderName(
      originalName
    );

  const order =
    orders.find(
      (item) =>
        normalizeOrderName(
          item.name
        ) ===
        expected
    );

  if (!order) {

    console.error(
      '❌ Shopify order not found'
    );

    console.error(
      'Wanted:',
      originalName
    );

    console.error(
      'Results:',
      orders.map(
        (item) =>
          item.name
      )
    );

    throw new Error(
      `Shopify order ${originalName} not found`
    );
  }

  console.log(
    '✅ SHOPIFY ORDER MATCHED'
  );

  console.log(
    'Pathao:',
    originalName
  );

  console.log(
    'Shopify:',
    order.name
  );

  console.log(
    'Shopify GID:',
    order.id
  );

  return order;
}

// ============================================================
// GET SHOPIFY FULFILLMENT INFORMATION
// ============================================================

async function getShopifyOrderContext(
  orderGid
) {

  const query = `
    query OrderFulfillmentContext(
      $id: ID!
    ) {
      order(id: $id) {

        id
        name
        displayFulfillmentStatus

        fulfillments(
          first: 50
        ) {
          nodes {

            id
            status
            displayStatus

            trackingInfo {
              company
              number
              url
            }

            events(
              last: 1
            ) {
              nodes {
                id
                status
                happenedAt
                message
              }
            }
          }
        }

        fulfillmentOrders(
          first: 50
        ) {
          nodes {

            id
            status
            requestStatus

            assignedLocation {
              location {
                id
              }
            }
          }
        }
      }
    }
  `;

  const response =
    await shopifyGraphql(
      query,
      {
        id:
          orderGid
      }
    );

  const order =
    response.data?.order;

  if (!order) {
    throw new Error(
      `Shopify order not found: ${orderGid}`
    );
  }

  return order;
}

// ============================================================
// NORMALIZE PATHAO STATUS
// ============================================================

function normalizeStatus(
  value
) {

  return String(
    value || ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      '_'
    )
    .replace(
      /^_+|_+$/g,
      ''
    );
}

// ============================================================
// PATHAO STATUS → SHOPIFY EVENT
// ============================================================

function mapPathaoStatusToShopify(
  pathaoInfo
) {

  const rawStatus =
    pathaoInfo.order_status_slug ||
    pathaoInfo.order_status ||
    '';

  const status =
    normalizeStatus(
      rawStatus
    );

  console.log(
    'Pathao normalized status:',
    status
  );

  // ----------------------------------------------------------
  // DELIVERED
  // ----------------------------------------------------------

  if (
    status === 'delivered' ||
    status.includes(
      'successfully_delivered'
    )
  ) {
    return 'DELIVERED';
  }

  // ----------------------------------------------------------
  // OUT FOR DELIVERY
  // ----------------------------------------------------------

  if (
    status.includes(
      'out_for_delivery'
    ) ||
    status.includes(
      'assigned_for_delivery'
    )
  ) {
    return 'OUT_FOR_DELIVERY';
  }

  // ----------------------------------------------------------
  // ATTEMPTED DELIVERY
  // ----------------------------------------------------------

  if (
    status.includes(
      'attempted_delivery'
    ) ||
    status.includes(
      'delivery_attempt'
    )
  ) {
    return 'ATTEMPTED_DELIVERY';
  }

  // ----------------------------------------------------------
  // CARRIER PICKED UP
  // ----------------------------------------------------------

  if (
    status === 'picked' ||
    status.includes(
      'picked_up'
    ) ||
    status.includes(
      'pickup_done'
    )
  ) {
    return 'CARRIER_PICKED_UP';
  }

  // ----------------------------------------------------------
  // IN TRANSIT
  // ----------------------------------------------------------

  if (
    status.includes(
      'in_transit'
    ) ||

    status.includes(
      'sorting_hub'
    ) ||

    status.includes(
      'last_mile_hub'
    ) ||

    status.includes(
      'transferred'
    ) ||

    status.includes(
      'received_at_hub'
    )
  ) {
    return 'IN_TRANSIT';
  }

  // ----------------------------------------------------------
  // DELAYED / HOLD
  // ----------------------------------------------------------

  if (
    status.includes(
      'on_hold'
    ) ||
    status.includes(
      'delayed'
    )
  ) {
    return 'DELAYED';
  }

  // ----------------------------------------------------------
  // FAILURE / RETURN
  // ----------------------------------------------------------

  if (
    status.includes(
      'delivery_failed'
    ) ||

    status.includes(
      'failed'
    ) ||

    status.includes(
      'returned'
    ) ||

    status.includes(
      'return_to_merchant'
    ) ||

    status.includes(
      'return_in_transit'
    )
  ) {
    return 'FAILURE';
  }

  /*
  Pending / Pickup Requested / Assigned for Pickup etc.
  do not yet represent a shipped delivery event.
  */

  return null;
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT FOR FULFILLMENT ORDERS
// ============================================================

async function createFulfillment(
  fulfillmentOrderIds,
  consignmentId
) {

  const mutation = `
    mutation CreateFulfillment(
      $fulfillment: FulfillmentInput!
    ) {
      fulfillmentCreate(
        fulfillment: $fulfillment
      ) {

        fulfillment {
          id
          status
          displayStatus

          trackingInfo {
            company
            number
            url
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

    fulfillment: {

      notifyCustomer:
        false,

      trackingInfo: {

        company:
          "Pathao",

        number:
          String(
            consignmentId
          )
      },

      lineItemsByFulfillmentOrder:
        fulfillmentOrderIds.map(
          (id) => ({
            fulfillmentOrderId:
              id
          })
        )
    }
  };

  const response =
    await shopifyGraphql(
      mutation,
      variables
    );

  throwShopifyUserErrors(
    'fulfillmentCreate failed',
    response.data
      ?.fulfillmentCreate
      ?.userErrors
  );

  const fulfillment =
    response.data
      ?.fulfillmentCreate
      ?.fulfillment;

  if (!fulfillment?.id) {
    throw new Error(
      'Shopify did not create fulfillment'
    );
  }

  console.log(
    '✅ Shopify fulfillment created:',
    fulfillment.id
  );

  return fulfillment;
}

// ============================================================
// ENSURE SHOPIFY HAS FULFILLMENTS
// ============================================================

async function ensureFulfillments(
  orderGid,
  consignmentId
) {

  let order =
    await getShopifyOrderContext(
      orderGid
    );

  let activeFulfillments =
    (
      order.fulfillments?.nodes ||
      []
    ).filter(
      (item) =>
        String(
          item.status
        ).toUpperCase() !==
        'CANCELLED'
    );

  const fulfillmentOrders =
    order.fulfillmentOrders
      ?.nodes || [];

  const openFulfillmentOrders =
    fulfillmentOrders.filter(
      (item) => {

        const status =
          String(
            item.status || ''
          ).toUpperCase();

        return (
          status === 'OPEN' ||
          status === 'IN_PROGRESS' ||
          status === 'SCHEDULED'
        );
      }
    );

  // ----------------------------------------------------------
  // Create fulfillment for any unfulfilled fulfillment orders
  // ----------------------------------------------------------

  if (
    openFulfillmentOrders.length
  ) {

    /*
    Fulfillment orders from different locations cannot always
    be fulfilled in one mutation.

    Group by location.
    */

    const groups =
      new Map();

    for (
      const fulfillmentOrder
      of openFulfillmentOrders
    ) {

      const locationId =
        fulfillmentOrder
          .assignedLocation
          ?.location
          ?.id ||
        fulfillmentOrder.id;

      if (
        !groups.has(
          locationId
        )
      ) {
        groups.set(
          locationId,
          []
        );
      }

      groups
        .get(locationId)
        .push(
          fulfillmentOrder.id
        );
    }

    for (
      const ids
      of groups.values()
    ) {

      console.log(
        '📦 Creating Shopify fulfillment for:',
        ids
      );

      await createFulfillment(
        ids,
        consignmentId
      );
    }

    // Reload order
    order =
      await getShopifyOrderContext(
        orderGid
      );

    activeFulfillments =
      (
        order.fulfillments?.nodes ||
        []
      ).filter(
        (item) =>
          String(
            item.status
          ).toUpperCase() !==
          'CANCELLED'
      );
  }

  if (
    activeFulfillments.length === 0
  ) {
    throw new Error(
      'No active Shopify fulfillment was found or could be created'
    );
  }

  return activeFulfillments;
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT EVENT
// ============================================================

async function createFulfillmentEvent(
  fulfillmentId,
  eventStatus,
  pathaoInfo
) {

  const mutation = `
    mutation CreateFulfillmentEvent(
      $fulfillmentEvent: FulfillmentEventInput!
    ) {

      fulfillmentEventCreate(
        fulfillmentEvent: $fulfillmentEvent
      ) {

        fulfillmentEvent {
          id
          status
          happenedAt
          message
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const message =
    `Pathao status: ${
      pathaoInfo.order_status ||
      pathaoInfo.order_status_slug ||
      eventStatus
    }`;

  const variables = {

    fulfillmentEvent: {

      fulfillmentId:
        fulfillmentId,

      status:
        eventStatus,

      message:
        message,

      happenedAt:
        new Date().toISOString()
    }
  };

  const response =
    await shopifyGraphql(
      mutation,
      variables
    );

  throwShopifyUserErrors(
    'fulfillmentEventCreate failed',
    response.data
      ?.fulfillmentEventCreate
      ?.userErrors
  );

  return response.data
    ?.fulfillmentEventCreate
    ?.fulfillmentEvent;
}

// ============================================================
// UPDATE SHOPIFY DELIVERY STATUS
// ============================================================

async function updateShopifyDeliveryStatus(
  shopifyOrder,
  consignmentId,
  pathaoInfo
) {

  const shopifyEvent =
    mapPathaoStatusToShopify(
      pathaoInfo
    );

  console.log(
    '============================================'
  );

  console.log(
    '🚚 DELIVERY STATUS MAPPING'
  );

  console.log(
    'Pathao:',
    pathaoInfo.order_status
  );

  console.log(
    'Shopify:',
    shopifyEvent || 'NO EVENT'
  );

  console.log(
    '============================================'
  );

  // Pending etc.
  if (!shopifyEvent) {

    return {

      changed:
        false,

      reason:
        `Pathao status "${pathaoInfo.order_status}" does not require a Shopify shipment event yet.`,

      pathao_status:
        pathaoInfo.order_status
    };
  }

  // ----------------------------------------------------------
  // Ensure fulfillment exists
  // ----------------------------------------------------------

  const fulfillments =
    await ensureFulfillments(
      shopifyOrder.id,
      consignmentId
    );

  const results =
    [];

  for (
    const fulfillment
    of fulfillments
  ) {

    const latestEvent =
      fulfillment.events
        ?.nodes?.[0] ||
      null;

    // --------------------------------------------------------
    // Don't add duplicate event
    // --------------------------------------------------------

    if (
      latestEvent?.status ===
      shopifyEvent
    ) {

      console.log(
        `ℹ️ Fulfillment ${fulfillment.id} already ${shopifyEvent}`
      );

      results.push({

        fulfillment_id:
          fulfillment.id,

        changed:
          false,

        status:
          shopifyEvent,

        reason:
          'Already current'
      });

      continue;
    }

    console.log(
      `🚚 ${fulfillment.id} → ${shopifyEvent}`
    );

    const event =
      await createFulfillmentEvent(
        fulfillment.id,
        shopifyEvent,
        pathaoInfo
      );

    results.push({

      fulfillment_id:
        fulfillment.id,

      changed:
        true,

      event:
        event
    });
  }

  // ----------------------------------------------------------
  // Verify final state
  // ----------------------------------------------------------

  const updatedOrder =
    await getShopifyOrderContext(
      shopifyOrder.id
    );

  console.log(
    '============================================'
  );

  console.log(
    '✅ SHOPIFY STATUS SYNC FINISHED'
  );

  console.log(
    'Shopify Order:',
    updatedOrder.name
  );

  console.log(
    'Order Fulfillment Status:',
    updatedOrder.displayFulfillmentStatus
  );

  console.log(
    '============================================'
  );

  return {

    changed:
      results.some(
        (item) =>
          item.changed
      ),

    shopify_event:
      shopifyEvent,

    display_fulfillment_status:
      updatedOrder.displayFulfillmentStatus,

    fulfillments:
      updatedOrder.fulfillments
        ?.nodes || [],

    results:
      results
  };
}

// ============================================================
// SYNC ONE ORDER
// ============================================================

async function syncOneOrder(
  consignmentId
) {

  console.log(
    '\n============================================'
  );

  console.log(
    '🔄 PATHAO → SHOPIFY SYNC'
  );

  console.log(
    'Consignment:',
    consignmentId
  );

  console.log(
    '============================================'
  );

  // ----------------------------------------------------------
  // 1. Get Pathao order
  // ----------------------------------------------------------

  const pathao =
    await getPathaoOrderInfo(
      consignmentId
    );

  if (
    !pathao.merchant_order_id
  ) {
    throw new Error(
      'Pathao did not return merchant_order_id'
    );
  }

  // ----------------------------------------------------------
  // 2. Find Shopify order using merchant_order_id
  // ----------------------------------------------------------

  const shopify =
    await findShopifyOrderByName(
      pathao.merchant_order_id
    );

  // ----------------------------------------------------------
  // 3. Safety check
  // ----------------------------------------------------------

  if (
    normalizeOrderName(
      pathao.merchant_order_id
    ) !==
    normalizeOrderName(
      shopify.name
    )
  ) {

    throw new Error(
      `Order mismatch: Pathao ${pathao.merchant_order_id} != Shopify ${shopify.name}`
    );
  }

  console.log(
    '✅ ORDER IDs MATCH'
  );

  console.log(
    `${pathao.merchant_order_id} = ${shopify.name}`
  );

  // ----------------------------------------------------------
  // 4. Update Shopify shipment status
  // ----------------------------------------------------------

  const update =
    await updateShopifyDeliveryStatus(
      shopify,
      consignmentId,
      pathao
    );

  return {

    success:
      true,

    consignment_id:
      pathao.consignment_id ||
      consignmentId,

    merchant_order_id:
      pathao.merchant_order_id,

    shopify_order_name:
      shopify.name,

    shopify_order_gid:
      shopify.id,

    pathao_status:
      pathao.order_status,

    pathao_status_slug:
      pathao.order_status_slug,

    pathao_updated_at:
      pathao.updated_at,

    shopify:
      update
  };
}

// ============================================================
// ROOT
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      success:
        true,

      service:
        'Pathao → Shopify Delivery Status Sync',

      status:
        'running',

      shopify:
        SHOPIFY_SHOP_DOMAIN,

      pathao:
        PATHAO_BASE_URL,

      endpoints: {

        health:
          'GET /health',

        pathao_auth:
          'GET /api/test/pathao-auth',

        pathao_order:
          'GET /api/pathao/order/:consignment_id',

        sync_one:
          'POST /api/sync/order-status',

        sync_many:
          'POST /api/sync/all-order-status'
      }
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'healthy',

      timestamp:
        new Date().toISOString(),

      shopify_domain:
        SHOPIFY_SHOP_DOMAIN,

      shopify_api:
        SHOPIFY_API_VERSION,

      pathao:
        PATHAO_BASE_URL
    });
  }
);

// ============================================================
// TEST PATHAO AUTH
//
// Browser:
// /api/test/pathao-auth
// ============================================================

app.get(
  '/api/test/pathao-auth',

  async (
    req,
    res
  ) => {

    try {

      const token =
        await getPathaoToken();

      res.json({

        success:
          true,

        message:
          'Pathao authentication successful',

        access_token_received:
          !!token,

        refresh_token_received:
          !!PATHAO_REFRESH_TOKEN,

        expires_at:
          new Date(
            PATHAO_EXPIRES_AT
          ).toISOString()
      });

    } catch (error) {

      console.error(
        '❌ Pathao auth test:',
        error
      );

      res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message
        });
    }
  }
);

// ============================================================
// TEST PATHAO ORDER
//
// Example:
//
// GET
// /api/pathao/order/DW170926U7G8U6
// ============================================================

app.get(
  '/api/pathao/order/:consignment_id',

  async (
    req,
    res
  ) => {

    try {

      const result =
        await getPathaoOrderInfo(
          req.params.consignment_id
        );

      res.json({

        success:
          true,

        data:
          result
      });

    } catch (error) {

      console.error(
        '❌ Pathao order error:',
        error
      );

      res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message
        });
    }
  }
);

// ============================================================
// SYNC ONE ORDER
//
// POST /api/sync/order-status
//
// {
//   "consignment_id": "DW170926U7G8U6"
// }
// ============================================================

app.post(
  '/api/sync/order-status',

  async (
    req,
    res
  ) => {

    try {

      const consignmentId =
        req.body
          ?.consignment_id;

      if (!consignmentId) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              'consignment_id is required'
          });
      }

      const result =
        await syncOneOrder(
          consignmentId
        );

      res.json(
        result
      );

    } catch (error) {

      console.error(
        '============================================'
      );

      console.error(
        '❌ SYNC ERROR'
      );

      console.error(
        error.data ||
        error.message
      );

      console.error(
        '============================================'
      );

      res
        .status(
          error.status ||
          500
        )
        .json({

          success:
            false,

          error:
            error.message,

          details:
            error.data ||
            null
        });
    }
  }
);

// ============================================================
// SYNC MULTIPLE ORDERS
//
// POST /api/sync/all-order-status
//
// {
//   "orders": [
//      {"consignment_id":"DW170926U7G8U6"},
//      {"consignment_id":"DW170926XXXXXX"}
//   ]
// }
// ============================================================

app.post(
  '/api/sync/all-order-status',

  async (
    req,
    res
  ) => {

    const orders =
      req.body?.orders;

    if (
      !Array.isArray(
        orders
      ) ||
      orders.length === 0
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            'orders array is required'
        });
    }

    const results =
      [];

    /*
    Sequential intentionally.
    Avoid hitting Shopify/Pathao APIs too quickly.
    */

    for (
      const order
      of orders
    ) {

      try {

        if (
          !order
            ?.consignment_id
        ) {

          results.push({

            success:
              false,

            error:
              'Missing consignment_id'
          });

          continue;
        }

        const result =
          await syncOneOrder(
            order.consignment_id
          );

        results.push(
          result
        );

      } catch (error) {

        results.push({

          success:
            false,

          consignment_id:
            order
              ?.consignment_id ||
            null,

          error:
            error.message
        });
      }
    }

    const successCount =
      results.filter(
        (item) =>
          item.success
      ).length;

    res.json({

      success:
        successCount ===
        results.length,

      total:
        results.length,

      synced:
        successCount,

      failed:
        results.length -
        successCount,

      results:
        results
    });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    res
      .status(404)
      .json({

        success:
          false,

        error:
          'Endpoint not found',

        path:
          req.originalUrl
      });
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'Unhandled error:',
      error
    );

    res
      .status(500)
      .json({

        success:
          false,

        error:
          'Internal server error'
      });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '============================================'
    );

    console.log(
      '🚀 PATHAO → SHOPIFY STATUS SYNC'
    );

    console.log(
      '============================================'
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🏪 Shopify: ${SHOPIFY_SHOP_DOMAIN}`
    );

    console.log(
      `📡 Shopify API: ${SHOPIFY_API_VERSION}`
    );

    console.log(
      `🚚 Pathao: ${PATHAO_BASE_URL}`
    );

    console.log(
      '--------------------------------------------'
    );

    console.log(
      'GET  /'
    );

    console.log(
      'GET  /health'
    );

    console.log(
      'GET  /api/test/pathao-auth'
    );

    console.log(
      'GET  /api/pathao/order/:consignment_id'
    );

    console.log(
      'POST /api/sync/order-status'
    );

    console.log(
      'POST /api/sync/all-order-status'
    );

    console.log(
      '============================================'
    );
  }
);
