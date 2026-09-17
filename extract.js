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

function normalizeShopDomain(value) {
  const v = cleanEnv(value);

  if (!v) {
    return '';
  }

  return v.includes('.myshopify.com')
    ? v
    : `${v}.myshopify.com`;
}

function normalizeOrderName(value) {
  return String(value || '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
}

function normalizePathaoStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseJson(text) {
  try {
    return text
      ? JSON.parse(text)
      : {};
  } catch {
    return {
      raw: text
    };
  }
}

// ============================================================
// CONFIGURATION
// ============================================================

// Shopify
const CLIENT_ID =
  cleanEnv(process.env.CLIENT_ID);

const CLIENT_SECRET =
  cleanEnv(process.env.CLIENT_SECRET);

// IMPORTANT:
//
// Prefer your REAL .myshopify.com domain:
//
// SHOPIFY_SHOP_DOMAIN=a1f2c6-5.myshopify.com
//
// If not set, this uses SHOP:
//
// SHOP=wellessia
//
// → wellessia.myshopify.com

const SHOPIFY_SHOP_DOMAIN =
  normalizeShopDomain(
    process.env.SHOPIFY_SHOP_DOMAIN ||
    process.env.SHOP ||
    'wellessia'
  );

const SHOPIFY_API_VERSION =
  cleanEnv(
    process.env.SHOPIFY_API_VERSION
  ) ||
  '2026-07';

// Pathao
const PATHAO_BASE_URL =
  cleanEnv(
    process.env.PATHAO_BASE_URL
  ) ||
  'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID =
  cleanEnv(
    process.env.PATHAO_CLIENT_ID
  );

const PATHAO_CLIENT_SECRET =
  cleanEnv(
    process.env.PATHAO_CLIENT_SECRET
  );

const PATHAO_USERNAME =
  cleanEnv(
    process.env.PATHAO_USERNAME
  );

const PATHAO_PASSWORD =
  cleanEnv(
    process.env.PATHAO_PASSWORD
  );

const SHOPIFY_NOTIFY_CUSTOMER =
  cleanEnv(
    process.env.SHOPIFY_NOTIFY_CUSTOMER ||
    'false'
  ).toLowerCase() === 'true';

const PORT =
  Number(
    cleanEnv(process.env.PORT)
  ) ||
  3000;

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

if (
  !CLIENT_ID ||
  !CLIENT_SECRET
) {
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
    PATHAO_CLIENT_ID:
      !!PATHAO_CLIENT_ID,

    PATHAO_CLIENT_SECRET:
      !!PATHAO_CLIENT_SECRET,

    PATHAO_USERNAME:
      !!PATHAO_USERNAME,

    PATHAO_PASSWORD:
      !!PATHAO_PASSWORD
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

  const tokenUrl =
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
    await fetch(
      tokenUrl,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body:
          body.toString()
      }
    );

  const text =
    await response.text();

  const data =
    parseJson(text);

  if (!response.ok) {

    const error =
      new Error(
        `Shopify token error ${response.status}: ${
          data.error_description ||
          data.error ||
          JSON.stringify(data)
        }`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  if (
    !data.access_token
  ) {
    throw new Error(
      'Shopify did not return access_token'
    );
  }

  SHOPIFY_TOKEN =
    data.access_token;

  SHOPIFY_EXPIRES_AT =
    Date.now() +
    (
      Number(
        data.expires_in
      ) ||
      86400
    ) *
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
    await fetch(
      url,
      {
        method:
          'POST',

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
      }
    );

  const text =
    await response.text();

  const data =
    parseJson(text);

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
    Array.isArray(
      data.errors
    ) &&
    data.errors.length > 0
  ) {

    const error =
      new Error(
        data.errors
          .map(
            item =>
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
    !Array.isArray(
      errors
    ) ||
    errors.length === 0
  ) {
    return;
  }

  const message =
    errors
      .map(
        item => {

          const field =
            Array.isArray(
              item.field
            )
              ? item.field.join('.')
              : item.field ||
                'unknown';

          return (
            `${field}: ` +
            `${item.message}`
          );
        }
      )
      .join(' | ');

  const error =
    new Error(
      `${label}: ${message}`
    );

  error.status =
    400;

  error.data =
    errors;

  throw error;
}

// ============================================================
// PATHAO TOKEN REQUEST
// ============================================================

async function requestPathaoToken(
  body
) {

  const tokenUrl =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/issue-token`;

  console.log(
    '============================================'
  );

  console.log(
    '🔐 PATHAO AUTH REQUEST'
  );

  console.log(
    '============================================'
  );

  console.log(
    'URL:',
    tokenUrl
  );

  console.log(
    'Grant type:',
    body.grant_type
  );

  console.log(
    'Client ID exists:',
    !!PATHAO_CLIENT_ID
  );

  console.log(
    'Client Secret exists:',
    !!PATHAO_CLIENT_SECRET
  );

  console.log(
    'Username exists:',
    !!PATHAO_USERNAME
  );

  console.log(
    'Password exists:',
    !!PATHAO_PASSWORD
  );

  console.log(
    'Client ID length:',
    PATHAO_CLIENT_ID.length
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
    await fetch(
      tokenUrl,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json',

          Accept:
            'application/json'
        },

        body:
          JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  const data =
    parseJson(text);

  console.log(
    'Pathao token HTTP status:',
    response.status
  );

  if (
    !response.ok ||
    !data.access_token
  ) {

    console.error(
      '❌ Pathao token response:',
      JSON.stringify(
        data,
        null,
        2
      )
    );

    const error =
      new Error(
        `Pathao token error ${response.status}: ${
          data.message ||
          data.error ||
          JSON.stringify(data)
        }`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}

// ============================================================
// PATHAO PASSWORD GRANT
// ============================================================

async function issuePathaoPasswordToken() {

  console.log(
    '🔐 Requesting Pathao token with password grant...'
  );

  const data =
    await requestPathaoToken({
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
    });

  PATHAO_TOKEN =
    data.access_token;

  PATHAO_REFRESH_TOKEN =
    data.refresh_token ||
    null;

  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      Number(
        data.expires_in
      ) ||
      432000
    ) *
      1000;

  console.log(
    '✅ Pathao authentication successful'
  );

  console.log(
    'Refresh token received:',
    !!PATHAO_REFRESH_TOKEN
  );

  return PATHAO_TOKEN;
}

// ============================================================
// PATHAO REFRESH TOKEN
// ============================================================

async function refreshPathaoToken() {

  if (
    !PATHAO_REFRESH_TOKEN
  ) {
    return issuePathaoPasswordToken();
  }

  console.log(
    '🔄 Refreshing Pathao access token...'
  );

  try {

    const data =
      await requestPathaoToken({
        client_id:
          PATHAO_CLIENT_ID,

        client_secret:
          PATHAO_CLIENT_SECRET,

        grant_type:
          'refresh_token',

        refresh_token:
          PATHAO_REFRESH_TOKEN
      });

    PATHAO_TOKEN =
      data.access_token;

    PATHAO_REFRESH_TOKEN =
      data.refresh_token ||
      PATHAO_REFRESH_TOKEN;

    PATHAO_EXPIRES_AT =
      Date.now() +
      (
        Number(
          data.expires_in
        ) ||
        432000
      ) *
        1000;

    console.log(
      '✅ Pathao access token refreshed'
    );

    return PATHAO_TOKEN;

  } catch (
    error
  ) {

    console.warn(
      '⚠️ Refresh failed; trying password grant:',
      error.message
    );

    PATHAO_TOKEN =
      null;

    PATHAO_REFRESH_TOKEN =
      null;

    PATHAO_EXPIRES_AT =
      0;

    return issuePathaoPasswordToken();
  }
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

  if (
    PATHAO_REFRESH_TOKEN
  ) {
    return refreshPathaoToken();
  }

  return issuePathaoPasswordToken();
}

// ============================================================
// PATHAO ORDER SHORT INFO
//
// GET:
// /aladdin/api/v1/orders/{consignment_id}/info
// ============================================================

async function getPathaoOrderInfo(
  consignmentId
) {

  if (
    !consignmentId
  ) {
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
      String(
        consignmentId
      )
    )}/info`;

  console.log(
    `🔍 Checking Pathao order: ${consignmentId}`
  );

  const response =
    await fetch(
      url,
      {
        method:
          'GET',

        headers: {
          Authorization:
            `Bearer ${token}`,

          Accept:
            'application/json'
        }
      }
    );

  const text =
    await response.text();

  const result =
    parseJson(text);

  if (!response.ok) {

    const error =
      new Error(
        `Pathao order error ${response.status}: ${
          result.message ||
          result.error ||
          JSON.stringify(result)
        }`
      );

    error.status =
      response.status;

    error.data =
      result;

    throw error;
  }

  const data =
    result.data ||
    result;

  console.log(
    '============================================'
  );

  console.log(
    '📦 PATHAO ORDER INFO'
  );

  console.log(
    '============================================'
  );

  console.log(
    'Consignment:',
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

  console.log(
    '============================================'
  );

  return data;
}

// ============================================================
// PATHAO STATUS
//       ↓
// SHOPIFY FULFILLMENT EVENT
// ============================================================

function mapPathaoToShopifyEvent(
  pathaoInfo
) {

  const status =
    normalizePathaoStatus(
      pathaoInfo?.order_status_slug ||
      pathaoInfo?.order_status ||
      ''
    );

  if (!status) {
    return null;
  }

  // IMPORTANT:
  // Must be before DELIVERED
  // because "partial_delivered" includes "delivered".

  if (
    status.includes(
      'partial_delivery'
    ) ||
    status.includes(
      'partial_delivered'
    )
  ) {
    return null;
  }

  // Delivered
  if (
    status ===
      'delivered' ||
    status.includes(
      'successfully_delivered'
    )
  ) {
    return 'DELIVERED';
  }

  // Out for delivery
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

  // Attempted delivery
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

  // Picked
  if (
    status ===
      'picked' ||
    status.endsWith(
      '_picked'
    ) ||
    status.includes(
      'picked_up'
    ) ||
    status.includes(
      'carrier_picked_up'
    )
  ) {
    return 'CARRIER_PICKED_UP';
  }

  // Transit
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
      'received_at_hub'
    ) ||
    status.includes(
      'transferred'
    )
  ) {
    return 'IN_TRANSIT';
  }

  // Delay
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

  // Failed / Return
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
      'returned_to_merchant'
    ) ||
    status.includes(
      'return_in_transit'
    ) ||
    status.includes(
      'paid_return'
    )
  ) {
    return 'FAILURE';
  }

  // Pending / pickup request etc.
  return null;
}

// ============================================================
// FIND SHOPIFY ORDER
//
// Pathao:
// merchant_order_id = #WELL26287633
//
// Shopify:
// order.name = #WELL26287633
// ============================================================

async function findShopifyOrderByName(
  merchantOrderId
) {

  if (
    !merchantOrderId
  ) {
    throw new Error(
      'Pathao merchant_order_id is missing'
    );
  }

  const wantedName =
    String(
      merchantOrderId
    ).trim();

  const searchName =
    wantedName.replace(
      /^#/,
      ''
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

  const result =
    await shopifyGraphql(
      query,
      {
        query:
          `name:${searchName}`
      }
    );

  const orders =
    result.data
      ?.orders
      ?.nodes ||
    [];

  const wanted =
    normalizeOrderName(
      wantedName
    );

  const order =
    orders.find(
      item =>
        normalizeOrderName(
          item.name
        ) ===
        wanted
    );

  if (!order) {

    const error =
      new Error(
        `No Shopify order found with name ${wantedName}`
      );

    error.status =
      404;

    error.data = {
      searched:
        wantedName,

      results:
        orders.map(
          item =>
            item.name
        )
    };

    throw error;
  }

  console.log(
    '✅ SHOPIFY ORDER MATCHED'
  );

  console.log(
    'Pathao merchant_order_id:',
    wantedName
  );

  console.log(
    'Shopify order name:',
    order.name
  );

  console.log(
    'Shopify order ID:',
    order.id
  );

  return order;
}

// ============================================================
// GET SHOPIFY FULFILLMENT CONTEXT
// ============================================================

async function getShopifyOrderContext(
  orderGid
) {

  const query = `
    query OrderFulfillmentContext(
      $id: ID!
    ) {
      order(
        id: $id
      ) {

        id
        name

        displayFulfillmentStatus

        fulfillments(
          first: 50
        ) {

          id

          status

          displayStatus

          createdAt

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

  const result =
    await shopifyGraphql(
      query,
      {
        id:
          orderGid
      }
    );

  const order =
    result.data
      ?.order;

  if (!order) {

    const error =
      new Error(
        `Shopify order not found: ${orderGid}`
      );

    error.status =
      404;

    throw error;
  }

  return order;
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT
// ============================================================

async function createShopifyFulfillment(
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

  const result =
    await shopifyGraphql(
      mutation,
      {
        fulfillment: {

          lineItemsByFulfillmentOrder:
            fulfillmentOrderIds.map(
              id => ({
                fulfillmentOrderId:
                  id
              })
            ),

          notifyCustomer:
            SHOPIFY_NOTIFY_CUSTOMER,

          trackingInfo: {
            company:
              'Pathao',

            number:
              String(
                consignmentId
              )
          }
        }
      }
    );

  throwShopifyUserErrors(
    'Shopify fulfillment creation failed',
    result.data
      ?.fulfillmentCreate
      ?.userErrors
  );

  const fulfillment =
    result.data
      ?.fulfillmentCreate
      ?.fulfillment;

  if (
    !fulfillment?.id
  ) {
    throw new Error(
      'Shopify fulfillmentCreate did not return fulfillment ID'
    );
  }

  console.log(
    '✅ Shopify fulfillment created:',
    fulfillment.id
  );

  return fulfillment;
}

// ============================================================
// ENSURE FULFILLMENT EXISTS
// ============================================================

async function ensureShopifyFulfillments(
  orderGid,
  consignmentId
) {

  let order =
    await getShopifyOrderContext(
      orderGid
    );

  let activeFulfillments =
    (
      order.fulfillments ||
      []
    ).filter(
      item =>
        String(
          item.status ||
          ''
        ).toUpperCase() !==
        'CANCELLED'
    );

  const openFulfillmentOrders =
    (
      order
        .fulfillmentOrders
        ?.nodes ||
      []
    ).filter(
      item => {

        const status =
          String(
            item.status ||
            ''
          ).toUpperCase();

        return (
          status ===
            'OPEN' ||
          status ===
            'IN_PROGRESS' ||
          status ===
            'SCHEDULED'
        );
      }
    );

  if (
    openFulfillmentOrders.length >
    0
  ) {

    /*
      Shopify requires fulfillment orders
      in one fulfillmentCreate call to be
      assigned to the same location.

      Group by assigned location.
    */

    const groups =
      new Map();

    for (
      const fo
      of openFulfillmentOrders
    ) {

      const locationId =
        fo
          .assignedLocation
          ?.location
          ?.id ||
        fo.id;

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
          fo.id
        );
    }

    for (
      const fulfillmentOrderIds
      of groups.values()
    ) {

      await createShopifyFulfillment(
        fulfillmentOrderIds,
        consignmentId
      );
    }

    // Reload after creating fulfillment.
    order =
      await getShopifyOrderContext(
        orderGid
      );

    activeFulfillments =
      (
        order.fulfillments ||
        []
      ).filter(
        item =>
          String(
            item.status ||
            ''
          ).toUpperCase() !==
          'CANCELLED'
      );
  }

  if (
    activeFulfillments.length ===
    0
  ) {
    throw new Error(
      'No active Shopify fulfillment exists and none could be created'
    );
  }

  return activeFulfillments;
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT EVENT
// ============================================================

async function createShopifyFulfillmentEvent(
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

  const result =
    await shopifyGraphql(
      mutation,
      {
        fulfillmentEvent: {

          fulfillmentId:
            fulfillmentId,

          status:
            eventStatus,

          happenedAt:
            new Date().toISOString(),

          message:
            `Pathao status: ${
              pathaoInfo
                ?.order_status ||
              pathaoInfo
                ?.order_status_slug ||
              eventStatus
            }`
        }
      }
    );

  throwShopifyUserErrors(
    'Shopify fulfillment event creation failed',
    result.data
      ?.fulfillmentEventCreate
      ?.userErrors
  );

  return (
    result.data
      ?.fulfillmentEventCreate
      ?.fulfillmentEvent ||
    null
  );
}

// ============================================================
// UPDATE SHOPIFY DELIVERY STATUS
// ============================================================

async function updateShopifyDeliveryStatus(
  shopifyOrder,
  consignmentId,
  pathaoInfo
) {

  const eventStatus =
    mapPathaoToShopifyEvent(
      pathaoInfo
    );

  console.log(
    '============================================'
  );

  console.log(
    '🚚 STATUS MAPPING'
  );

  console.log(
    'Pathao:',
    pathaoInfo.order_status
  );

  console.log(
    'Shopify event:',
    eventStatus ||
    'NO EVENT'
  );

  console.log(
    '============================================'
  );

  // Pending etc.
  if (
    !eventStatus
  ) {

    return {

      changed:
        false,

      pathao_status:
        pathaoInfo
          .order_status ||
        null,

      reason:
        'Current Pathao status does not require a Shopify shipment event'
    };
  }

  const fulfillments =
    await ensureShopifyFulfillments(
      shopifyOrder.id,
      consignmentId
    );

  const results = [];

  for (
    const fulfillment
    of fulfillments
  ) {

    const latestEvent =
      fulfillment
        .events
        ?.nodes?.[0] ||
      null;

    // Don't create duplicate event.
    if (
      latestEvent
        ?.status ===
      eventStatus
    ) {

      results.push({

        fulfillment_id:
          fulfillment.id,

        changed:
          false,

        status:
          eventStatus,

        reason:
          'Already current'
      });

      continue;
    }

    const event =
      await createShopifyFulfillmentEvent(
        fulfillment.id,
        eventStatus,
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

  const updatedOrder =
    await getShopifyOrderContext(
      shopifyOrder.id
    );

  return {

    changed:
      results.some(
        item =>
          item.changed
      ),

    shopify_event:
      eventStatus,

    display_fulfillment_status:
      updatedOrder
        .displayFulfillmentStatus,

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

  if (
    !consignmentId
  ) {
    throw new Error(
      'consignment_id is required'
    );
  }

  console.log(
    '\n============================================'
  );

  console.log(
    '🔄 PATHAO → SHOPIFY STATUS SYNC'
  );

  console.log(
    'Consignment:',
    consignmentId
  );

  console.log(
    '============================================'
  );

  // ==========================================================
  // STEP 1
  // GET PATHAO ORDER
  // ==========================================================

  const pathaoInfo =
    await getPathaoOrderInfo(
      consignmentId
    );

  if (
    !pathaoInfo
      .merchant_order_id
  ) {
    throw new Error(
      'Pathao did not return merchant_order_id'
    );
  }

  // ==========================================================
  // STEP 2
  // merchant_order_id == Shopify order name
  // ==========================================================

  const shopifyOrder =
    await findShopifyOrderByName(
      pathaoInfo
        .merchant_order_id
    );

  // ==========================================================
  // STEP 3
  // VERIFY MATCH
  // ==========================================================

  if (
    normalizeOrderName(
      pathaoInfo
        .merchant_order_id
    ) !==
    normalizeOrderName(
      shopifyOrder.name
    )
  ) {

    throw new Error(
      `Order mismatch: ` +
      `Pathao=${pathaoInfo.merchant_order_id}, ` +
      `Shopify=${shopifyOrder.name}`
    );
  }

  console.log(
    '✅ ORDER MATCH CONFIRMED'
  );

  console.log(
    'Pathao:',
    pathaoInfo
      .merchant_order_id
  );

  console.log(
    'Shopify:',
    shopifyOrder.name
  );

  // ==========================================================
  // STEP 4
  // UPDATE SHOPIFY
  // ==========================================================

  const shopifyUpdate =
    await updateShopifyDeliveryStatus(
      shopifyOrder,
      consignmentId,
      pathaoInfo
    );

  return {

    success:
      true,

    consignment_id:
      pathaoInfo
        .consignment_id ||
      consignmentId,

    merchant_order_id:
      pathaoInfo
        .merchant_order_id,

    shopify_order_name:
      shopifyOrder.name,

    shopify_order_gid:
      shopifyOrder.id,

    pathao_status:
      pathaoInfo
        .order_status ||
      null,

    pathao_status_slug:
      pathaoInfo
        .order_status_slug ||
      null,

    pathao_updated_at:
      pathaoInfo
        .updated_at ||
      null,

    shopify:
      shopifyUpdate
  };
}

// ============================================================
// ROOT
// ============================================================

app.get(
  '/',
  (
    req,
    res
  ) => {

    res.json({

      success:
        true,

      service:
        'Pathao → Shopify Delivery Status Sync',

      status:
        'running',

      shopify_domain:
        SHOPIFY_SHOP_DOMAIN,

      shopify_api:
        SHOPIFY_API_VERSION,

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
  (
    req,
    res
  ) => {

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
// GET:
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

    } catch (
      error
    ) {

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
// GET PATHAO ORDER
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

      const data =
        await getPathaoOrderInfo(
          req.params
            .consignment_id
        );

      res.json({

        success:
          true,

        data:
          data
      });

    } catch (
      error
    ) {

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
// SYNC ONE ORDER
//
// POST:
// /api/sync/order-status
//
// BODY:
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

      if (
        !consignmentId
      ) {

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

    } catch (
      error
    ) {

      console.error(
        '❌ Order status sync error:',
        error.data ||
        error.message
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
// POST:
// /api/sync/all-order-status
//
// BODY:
//
// {
//   "orders": [
//     {
//       "consignment_id": "DW170926U7G8U6"
//     },
//     {
//       "consignment_id": "DW170926XXXXXX"
//     }
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
      req.body
        ?.orders;

    if (
      !Array.isArray(
        orders
      ) ||
      orders.length ===
        0
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            'Body must contain a non-empty orders array'
        });
    }

    const results = [];

    // Sequential to reduce API rate pressure.
    for (
      const item
      of orders
    ) {

      try {

        if (
          !item
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

        results.push(
          await syncOneOrder(
            item.consignment_id
          )
        );

      } catch (
        error
      ) {

        results.push({

          success:
            false,

          consignment_id:
            item
              ?.consignment_id ||
            null,

          error:
            error.message,

          details:
            error.data ||
            null
        });
      }
    }

    const synced =
      results.filter(
        item =>
          item.success
      ).length;

    res.json({

      success:
        synced ===
        results.length,

      total:
        results.length,

      synced:
        synced,

      failed:
        results.length -
        synced,

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
// ERROR HANDLER
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
