const express = require('express');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP = process.env.SHOP || 'wellessia';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || '2026-07';

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID = process.env.PATHAO_CLIENT_ID;
const PATHAO_CLIENT_SECRET = process.env.PATHAO_CLIENT_SECRET;
const PATHAO_USERNAME = process.env.PATHAO_USERNAME;
const PATHAO_PASSWORD = process.env.PATHAO_PASSWORD;

const PORT = process.env.PORT || 3001;

const SHOPIFY_NOTIFY_CUSTOMER =
  String(process.env.SHOPIFY_NOTIFY_CUSTOMER || 'false').toLowerCase() ===
  'true';

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing CLIENT_ID or CLIENT_SECRET');
  process.exit(1);
}

if (
  !PATHAO_CLIENT_ID ||
  !PATHAO_CLIENT_SECRET ||
  !PATHAO_USERNAME ||
  !PATHAO_PASSWORD
) {
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
// EXPRESS
// ============================================================

app.use(express.json({ limit: '2mb' }));

// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {
  if (
    SHOPIFY_TOKEN &&
    Date.now() < SHOPIFY_EXPIRES_AT - 60000
  ) {
    return SHOPIFY_TOKEN;
  }

  console.log('🔐 Requesting Shopify access token...');

  const tokenUrl =
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      '❌ Shopify token response:',
      JSON.stringify(data, null, 2)
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
      'Shopify response did not contain access_token'
    );
  }

  SHOPIFY_TOKEN = data.access_token;

  SHOPIFY_EXPIRES_AT =
    Date.now() +
    (data.expires_in || 86400) * 1000;

  console.log('✅ Shopify access token obtained');

  return SHOPIFY_TOKEN;
}

// ============================================================
// PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {
  if (
    PATHAO_TOKEN &&
    Date.now() < PATHAO_EXPIRES_AT - 60000
  ) {
    return PATHAO_TOKEN;
  }

  console.log('🔐 Requesting Pathao access token...');

  const tokenUrl =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
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
    console.error(
      '❌ Pathao token response:',
      JSON.stringify(data, null, 2)
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
      'Pathao response did not contain access_token'
    );
  }

  PATHAO_TOKEN = data.access_token;

  PATHAO_EXPIRES_AT =
    Date.now() +
    (data.expires_in || 3600) * 1000;

  console.log('✅ Pathao access token obtained');

  return PATHAO_TOKEN;
}

// ============================================================
// SHOPIFY GRAPHQL REQUEST
// ============================================================

async function shopifyGraphql(
  query,
  variables = {}
) {
  const token =
    await getShopifyToken();

  const url =
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'X-Shopify-Access-Token':
          token,

        'Content-Type':
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
      text ?
        JSON.parse(text) :
        {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        `Shopify GraphQL API ${response.status}`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  if (data.errors) {
    const error =
      new Error(
        'Shopify GraphQL returned errors'
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
// HANDLE SHOPIFY USER ERRORS
// ============================================================

function throwUserErrors(
  label,
  userErrors
) {
  if (
    !Array.isArray(userErrors) ||
    userErrors.length === 0
  ) {
    return;
  }

  const message =
    userErrors
      .map((error) => {
        const field =
          Array.isArray(error.field) ?
            error.field.join('.') :
            error.field || 'field';

        return `${field}: ${error.message}`;
      })
      .join(' | ');

  const error =
    new Error(
      `${label}: ${message}`
    );

  error.status = 400;
  error.data = userErrors;

  throw error;
}

// ============================================================
// PATHAO
// GET ORDER SHORT INFO
//
// Endpoint:
// /aladdin/api/v1/orders/{consignment_id}/info
// ============================================================

async function getPathaoOrderStatus(
  consignmentId
) {
  if (!consignmentId) {
    throw new Error(
      'Consignment ID is required'
    );
  }

  const token =
    await getPathaoToken();

  const endpoint =
    `/aladdin/api/v1/orders/${encodeURIComponent(
      String(consignmentId)
    )}/info`;

  console.log(
    `🔍 Checking Pathao order: ${consignmentId}`
  );

  const response =
    await fetch(
      `${PATHAO_BASE_URL}${endpoint}`,
      {
        method: 'GET',

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

  let data;

  try {
    data =
      text ?
        JSON.parse(text) :
        {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      '❌ Pathao status response:',
      JSON.stringify(data, null, 2)
    );

    const error =
      new Error(
        `Pathao status error ${response.status}: ${
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

  const order =
    data.data || data;

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
    JSON.stringify(
      order,
      null,
      2
    )
  );

  console.log(
    '============================================'
  );

  return order;
}

// ============================================================
// NORMALIZE PATHAO STATUS
// ============================================================

function normalizePathaoStatus(
  value
) {
  return String(
    value || ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /[.\-\s/]+/g,
      '_'
    )
    .replace(
      /_+/g,
      '_'
    );
}

// ============================================================
// GET PATHAO STATUS
// ============================================================

function getPathaoStatusKey(
  pathaoInfo
) {
  return normalizePathaoStatus(
    pathaoInfo?.order_status_slug ||
    pathaoInfo?.order_status ||
    ''
  );
}

// ============================================================
// PATHAO STATUS
//       ↓
// SHOPIFY DELIVERY STATUS
// ============================================================

function mapPathaoToShopifyEvent(
  pathaoInfo
) {
  const status =
    getPathaoStatusKey(
      pathaoInfo
    );

  if (!status) {
    return null;
  }

  // ----------------------------------------------------------
  // DELIVERED
  // ----------------------------------------------------------

  if (
    status === 'delivered' ||
    status.includes('delivered')
  ) {
    return 'DELIVERED';
  }

  // ----------------------------------------------------------
  // OUT FOR DELIVERY
  // ----------------------------------------------------------

  if (
    status.includes(
      'assigned_for_delivery'
    ) ||
    status.includes(
      'out_for_delivery'
    )
  ) {
    return 'OUT_FOR_DELIVERY';
  }

  // ----------------------------------------------------------
  // IN TRANSIT
  // ----------------------------------------------------------

  if (
    status.includes(
      'at_the_sorting_hub'
    ) ||
    status.includes(
      'sorting_hub'
    ) ||
    status.includes(
      'in_transit'
    ) ||
    status.includes(
      'received_at_last_mile_hub'
    ) ||
    status.includes(
      'last_mile_hub'
    )
  ) {
    return 'IN_TRANSIT';
  }

  // ----------------------------------------------------------
  // PICKED
  // ----------------------------------------------------------

  if (
    status === 'picked' ||
    status.endsWith(
      '_picked'
    ) ||
    status.includes(
      'carrier_picked_up'
    )
  ) {
    return 'CARRIER_PICKED_UP';
  }

  // ----------------------------------------------------------
  // DELAYED
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
  // FAILED / RETURNED
  // ----------------------------------------------------------

  if (
    status.includes(
      'returned_to_merchant'
    ) ||
    status.includes(
      'paid_return'
    ) ||
    status.includes(
      'return_in_transit'
    ) ||
    status.includes(
      'returned'
    ) ||
    status.includes(
      'delivery_failed'
    ) ||
    status.includes(
      'failed'
    )
  ) {
    return 'FAILURE';
  }

  // ----------------------------------------------------------
  // PARTIAL DELIVERY
  // ----------------------------------------------------------

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

  // Pending etc. do not create shipment event.

  return null;
}

// ============================================================
// SAVE PATHAO INFORMATION INTO SHOPIFY METAFIELDS
// ============================================================

async function savePathaoMetadata(
  shopifyOrderId,
  consignmentId,
  pathaoInfo
) {
  const ownerId =
    `gid://shopify/Order/${shopifyOrderId}`;

  const mutation = `
    mutation SavePathaoMetadata(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(
        metafields: $metafields
      ) {
        metafields {
          namespace
          key
          value
        }

        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const metafields = [
    {
      namespace:
        'pathao',

      key:
        'consignment_id',

      ownerId,

      type:
        'single_line_text_field',

      value:
        String(
          consignmentId
        )
    },

    {
      namespace:
        'pathao',

      key:
        'merchant_order_id',

      ownerId,

      type:
        'single_line_text_field',

      value:
        String(
          pathaoInfo?.merchant_order_id ||
          ''
        )
    },

    {
      namespace:
        'pathao',

      key:
        'status',

      ownerId,

      type:
        'single_line_text_field',

      value:
        String(
          pathaoInfo?.order_status ||
          'Unknown'
        )
    },

    {
      namespace:
        'pathao',

      key:
        'status_slug',

      ownerId,

      type:
        'single_line_text_field',

      value:
        String(
          pathaoInfo?.order_status_slug ||
          pathaoInfo?.order_status ||
          'Unknown'
        )
    }
  ];

  if (
    pathaoInfo?.updated_at
  ) {
    metafields.push({
      namespace:
        'pathao',

      key:
        'updated_at',

      ownerId,

      type:
        'single_line_text_field',

      value:
        String(
          pathaoInfo.updated_at
        )
    });
  }

  const result =
    await shopifyGraphql(
      mutation,
      {
        metafields
      }
    );

  throwUserErrors(
    'Shopify Pathao metadata update failed',
    result.data?.metafieldsSet?.userErrors
  );

  return (
    result.data
      ?.metafieldsSet
      ?.metafields || []
  );
}

// ============================================================
// FIND SHOPIFY ORDER USING:
// PATHAO merchant_order_id
//
// Example:
//
// Pathao:
// merchant_order_id = #WELL26287633
//
// Shopify:
// order.name = #WELL26287633
//
// MATCH ✅
// ============================================================

async function getShopifyOrderByName(
  merchantOrderId
) {
  if (!merchantOrderId) {
    throw new Error(
      'Pathao merchant_order_id is missing'
    );
  }

  const wantedName =
    String(
      merchantOrderId
    ).trim();

  // Shopify search does not need #
  const searchName =
    wantedName.replace(
      /^#/,
      ''
    );

  console.log(
    '🔎 Looking for Shopify order'
  );

  console.log(
    `Pathao merchant_order_id: ${wantedName}`
  );

  const query = `
    query FindShopifyOrderByName(
      $query: String!
    ) {
      orders(
        first: 10
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
      ?.nodes || [];

  const normalizeName =
    (value) =>
      String(
        value || ''
      )
        .trim()
        .replace(
          /^#/,
          ''
        );

  const wantedNormalized =
    normalizeName(
      wantedName
    );

  const order =
    orders.find(
      (item) =>
        normalizeName(
          item.name
        ) ===
        wantedNormalized
    );

  if (!order) {
    console.error(
      `❌ Shopify order not found: ${wantedName}`
    );

    console.error(
      'Shopify search results:',
      orders.map(
        (item) =>
          item.name
      )
    );

    const error =
      new Error(
        `No Shopify order found with name ${wantedName}`
      );

    error.status = 404;

    throw error;
  }

  console.log(
    '✅ SHOPIFY ORDER MATCHED'
  );

  console.log(
    `Pathao merchant_order_id: ${wantedName}`
  );

  console.log(
    `Shopify order name:       ${order.name}`
  );

  console.log(
    `Shopify order ID:         ${order.id}`
  );

  return {
    ...order,

    numericId:
      String(
        order.id
      )
        .split('/')
        .pop()
  };
}

// ============================================================
// GET SHOPIFY FULFILLMENT INFORMATION
// ============================================================

async function getShopifyFulfillmentContext(
  shopifyOrderId
) {
  const query = `
    query GetOrderFulfillmentContext(
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
          `gid://shopify/Order/${shopifyOrderId}`
      }
    );

  const order =
    result.data?.order;

  if (!order) {
    const error =
      new Error(
        `Shopify order ${shopifyOrderId} not found`
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
  shopifyOrderId,
  consignmentId
) {
  const order =
    await getShopifyFulfillmentContext(
      shopifyOrderId
    );

  // ----------------------------------------------------------
  // Check existing fulfillment
  // ----------------------------------------------------------

  const existingFulfillment =
    (
      order.fulfillments ||
      []
    ).find(
      (fulfillment) =>
        String(
          fulfillment.status
        ).toUpperCase() !==
        'CANCELLED'
    );

  if (
    existingFulfillment
  ) {
    console.log(
      `✅ Existing Shopify fulfillment found: ${existingFulfillment.id}`
    );

    return existingFulfillment;
  }

  // ----------------------------------------------------------
  // Get available fulfillment orders
  // ----------------------------------------------------------

  const fulfillmentOrders =
    order.fulfillmentOrders
      ?.nodes || [];

  const usableFulfillmentOrders =
    fulfillmentOrders.filter(
      (fulfillmentOrder) => {
        const status =
          String(
            fulfillmentOrder.status ||
            ''
          ).toUpperCase();

        return (
          status !==
            'CLOSED' &&
          status !==
            'CANCELLED'
        );
      }
    );

  if (
    usableFulfillmentOrders.length ===
    0
  ) {
    throw new Error(
      `Shopify order ${shopifyOrderId} has no open fulfillment order`
    );
  }

  // ----------------------------------------------------------
  // CREATE FULFILLMENT
  // ----------------------------------------------------------

  const mutation = `
    mutation CreatePathaoFulfillment(
      $fulfillment: FulfillmentInput!
    ) {
      fulfillmentCreate(
        fulfillment: $fulfillment
      ) {
        fulfillment {
          id
          status
          displayStatus
          createdAt

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
            usableFulfillmentOrders.map(
              (
                fulfillmentOrder
              ) => ({
                fulfillmentOrderId:
                  fulfillmentOrder.id
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

  throwUserErrors(
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
    '============================================'
  );

  console.log(
    '✅ SHOPIFY FULFILLMENT CREATED'
  );

  console.log(
    `Order: ${shopifyOrderId}`
  );

  console.log(
    `Fulfillment: ${fulfillment.id}`
  );

  console.log(
    `Pathao consignment: ${consignmentId}`
  );

  console.log(
    '============================================'
  );

  return fulfillment;
}

// ============================================================
// CREATE SHOPIFY DELIVERY / SHIPMENT EVENT
// ============================================================

async function createShopifyFulfillmentEvent(
  fulfillmentId,
  eventStatus,
  pathaoInfo
) {
  const mutation = `
    mutation CreatePathaoFulfillmentEvent(
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
    `Pathao: ${
      pathaoInfo?.order_status ||
      pathaoInfo?.order_status_slug ||
      eventStatus
    }`;

  console.log(
    `🚚 Updating Shopify delivery status → ${eventStatus}`
  );

  const result =
    await shopifyGraphql(
      mutation,
      {
        fulfillmentEvent: {
          fulfillmentId,

          status:
            eventStatus,

          message
        }
      }
    );

  throwUserErrors(
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
  shopifyOrderId,
  consignmentId,
  pathaoInfo
) {
  if (
    !shopifyOrderId ||
    !consignmentId ||
    !pathaoInfo
  ) {
    throw new Error(
      'shopifyOrderId, consignmentId and pathaoInfo are required'
    );
  }

  console.log(
    '============================================'
  );

  console.log(
    '🔄 UPDATING SHOPIFY DELIVERY STATUS'
  );

  console.log(
    '============================================'
  );

  console.log(
    `Shopify Order ID: ${shopifyOrderId}`
  );

  console.log(
    `Pathao Consignment: ${consignmentId}`
  );

  console.log(
    `Pathao merchant_order_id: ${pathaoInfo.merchant_order_id}`
  );

  console.log(
    `Pathao Status: ${pathaoInfo.order_status}`
  );

  // ----------------------------------------------------------
  // Save Pathao information in Shopify metafields
  // ----------------------------------------------------------

  const pathaoMetadata =
    await savePathaoMetadata(
      shopifyOrderId,
      consignmentId,
      pathaoInfo
    );

  // ----------------------------------------------------------
  // Convert Pathao status → Shopify status
  // ----------------------------------------------------------

  const eventStatus =
    mapPathaoToShopifyEvent(
      pathaoInfo
    );

  console.log(
    `Mapped Shopify status: ${eventStatus || 'NONE'}`
  );

  // ----------------------------------------------------------
  // No Shopify event mapping
  // ----------------------------------------------------------

  if (!eventStatus) {
    console.log(
      `ℹ️ Pathao status "${pathaoInfo.order_status}" does not require Shopify delivery status change`
    );

    return {
      pathao_status_saved:
        true,

      shipment_event_changed:
        false,

      reason:
        'No Shopify shipment-event mapping for this Pathao status',

      pathao_metafields:
        pathaoMetadata
    };
  }

  // ----------------------------------------------------------
  // Get current Shopify fulfillment
  // ----------------------------------------------------------

  const before =
    await getShopifyFulfillmentContext(
      shopifyOrderId
    );

  let fulfillment =
    (
      before.fulfillments ||
      []
    ).find(
      (fulfillment) =>
        String(
          fulfillment.status
        ).toUpperCase() !==
        'CANCELLED'
    );

  // ----------------------------------------------------------
  // Create fulfillment if none exists
  // ----------------------------------------------------------

  if (!fulfillment) {
    console.log(
      '📦 No Shopify fulfillment found.'
    );

    console.log(
      '📦 Creating fulfillment...'
    );

    fulfillment =
      await createShopifyFulfillment(
        shopifyOrderId,
        consignmentId
      );
  }

  // ----------------------------------------------------------
  // Check latest event
  // ----------------------------------------------------------

  const latestEvent =
    fulfillment
      .events
      ?.nodes?.[0] ||
    null;

  // ----------------------------------------------------------
  // Avoid duplicate updates
  // ----------------------------------------------------------

  if (
    latestEvent?.status ===
    eventStatus
  ) {
    console.log(
      `✅ Shopify already has status ${eventStatus}`
    );

    return {
      pathao_status_saved:
        true,

      shipment_event_changed:
        false,

      reason:
        `Shopify already has latest shipment event ${eventStatus}`,

      fulfillment_id:
        fulfillment.id,

      shopify_display_status:
        fulfillment.displayStatus,

      latest_event:
        latestEvent
    };
  }

  // ----------------------------------------------------------
  // Update Shopify delivery status
  // ----------------------------------------------------------

  const event =
    await createShopifyFulfillmentEvent(
      fulfillment.id,
      eventStatus,
      pathaoInfo
    );

  // ----------------------------------------------------------
  // Read Shopify again to verify
  // ----------------------------------------------------------

  const after =
    await getShopifyFulfillmentContext(
      shopifyOrderId
    );

  const updatedFulfillment =
    (
      after.fulfillments ||
      []
    ).find(
      (item) =>
        item.id ===
        fulfillment.id
    ) ||
    (
      after.fulfillments ||
      []
    )[0] ||
    null;

  console.log(
    '============================================'
  );

  console.log(
    '✅ SHOPIFY DELIVERY STATUS UPDATED'
  );

  console.log(
    '============================================'
  );

  console.log(
    `Pathao: ${pathaoInfo.order_status}`
  );

  console.log(
    `Shopify Event: ${eventStatus}`
  );

  console.log(
    `Shopify Fulfillment Status: ${after.displayFulfillmentStatus}`
  );

  console.log(
    `Shopify Shipment Status: ${updatedFulfillment?.displayStatus}`
  );

  console.log(
    '============================================'
  );

  return {
    pathao_status_saved:
      true,

    shipment_event_changed:
      true,

    fulfillment_id:
      fulfillment.id,

    fulfillment_event:
      event,

    shopify_order_fulfillment_status:
      after.displayFulfillmentStatus,

    shopify_shipment_display_status:
      updatedFulfillment
        ?.displayStatus ||
      null
  };
}

// ============================================================
// SYNC ONE ORDER
//
// ONLY REQUIRED INPUT:
// consignment_id
//
// Pathao merchant_order_id is automatically used
// to find Shopify order name.
// ============================================================

async function syncOneOrder({
  consignment_id
}) {
  if (!consignment_id) {
    throw new Error(
      'Missing consignment_id'
    );
  }

  console.log(
    '\n============================================'
  );

  console.log(
    '🔄 STARTING PATHAO → SHOPIFY STATUS SYNC'
  );

  console.log(
    '============================================'
  );

  console.log(
    `Consignment ID: ${consignment_id}`
  );

  // ----------------------------------------------------------
  // STEP 1
  // GET PATHAO ORDER
  // ----------------------------------------------------------

  const pathaoInfo =
    await getPathaoOrderStatus(
      consignment_id
    );

  if (!pathaoInfo) {
    const error =
      new Error(
        'Order not found in Pathao'
      );

    error.status =
      404;

    throw error;
  }

  // ----------------------------------------------------------
  // STEP 2
  // GET merchant_order_id
  // ----------------------------------------------------------

  if (
    !pathaoInfo.merchant_order_id
  ) {
    throw new Error(
      `Pathao order ${consignment_id} did not return merchant_order_id`
    );
  }

  console.log(
    `🧾 Pathao merchant_order_id: ${pathaoInfo.merchant_order_id}`
  );

  console.log(
    `🚚 Pathao order_status: ${pathaoInfo.order_status}`
  );

  // ----------------------------------------------------------
  // STEP 3
  // FIND SHOPIFY ORDER
  //
  // merchant_order_id
  //       ==
  // Shopify order.name
  // ----------------------------------------------------------

  const shopifyOrder =
    await getShopifyOrderByName(
      pathaoInfo.merchant_order_id
    );

  const shopifyOrderId =
    shopifyOrder.numericId;

  // ----------------------------------------------------------
  // Extra safety check
  // ----------------------------------------------------------

  const normalize =
    (value) =>
      String(
        value || ''
      )
        .trim()
        .replace(
          /^#/,
          ''
        );

  if (
    normalize(
      pathaoInfo.merchant_order_id
    ) !==
    normalize(
      shopifyOrder.name
    )
  ) {
    throw new Error(
      `Order mismatch. Pathao=${pathaoInfo.merchant_order_id}, Shopify=${shopifyOrder.name}`
    );
  }

  console.log(
    '✅ ORDER MATCH CONFIRMED'
  );

  console.log(
    `Pathao:  ${pathaoInfo.merchant_order_id}`
  );

  console.log(
    `Shopify: ${shopifyOrder.name}`
  );

  // ----------------------------------------------------------
  // STEP 4
  // UPDATE SHOPIFY
  // ----------------------------------------------------------

  const shopifyUpdate =
    await updateShopifyDeliveryStatus(
      shopifyOrderId,
      consignment_id,
      pathaoInfo
    );

  // ----------------------------------------------------------
  // RESULT
  // ----------------------------------------------------------

  return {
    success:
      true,

    consignment_id,

    merchant_order_id:
      pathaoInfo.merchant_order_id,

    shopify_order_name:
      shopifyOrder.name,

    shopify_order_id:
      shopifyOrderId,

    pathao_status:
      pathaoInfo.order_status ||
      null,

    pathao_status_slug:
      pathaoInfo.order_status_slug ||
      null,

    pathao_updated_at:
      pathaoInfo.updated_at ||
      null,

    shopify_update:
      shopifyUpdate
  };
}

// ============================================================
// HEALTH CHECK
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
        new Date().toISOString()
    });
  }
);

// ============================================================
// TEST PATHAO ORDER ONLY
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
        await getPathaoOrderStatus(
          req.params.consignment_id
        );

      res.json({
        success:
          true,

        data
      });
    } catch (
      error
    ) {
      console.error(
        '❌ Pathao order lookup error:',
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
//
// NO shopify_order_id REQUIRED
// ============================================================

app.post(
  '/api/sync/order-status',

  async (
    req,
    res
  ) => {
    try {
      const result =
        await syncOneOrder(
          req.body ||
          {}
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
// SYNC MANY ORDERS
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
//
// merchant_order_id automatically finds Shopify order.
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
            'Body must contain a non-empty orders array'
        });
    }

    const results =
      [];

    // Sequential to avoid API rate limit

    for (
      const order
      of orders
    ) {
      try {
        results.push(
          await syncOneOrder(
            order
          )
        );
      } catch (
        error
      ) {
        results.push({
          success:
            false,

          consignment_id:
            order
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

    const successCount =
      results.filter(
        (result) =>
          result.success
      ).length;

    const failedCount =
      results.length -
      successCount;

    res
      .status(
        failedCount ===
        results.length ?
          500 :
          200
      )
      .json({
        success:
          failedCount ===
          0,

        total:
          results.length,

        synced:
          successCount,

        failed:
          failedCount,

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
    err,
    req,
    res,
    next
  ) => {
    console.error(
      'Unhandled error:',
      err
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
      `🏪 Shopify: ${SHOP}.myshopify.com`
    );

    console.log(
      `📡 Shopify API: ${SHOPIFY_API_VERSION}`
    );

    console.log(
      `🚚 Pathao: ${
        PATHAO_BASE_URL.includes(
          'sandbox'
        ) ?
          'SANDBOX' :
          'PRODUCTION'
      }`
    );

    console.log(
      '--------------------------------------------'
    );

    console.log(
      'GET  /health'
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
