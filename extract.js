const express = require("express");

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const SHOP = process.env.SHOP || "wellessia";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  "https://api-hermes.pathao.com";

const PATHAO_CLIENT_ID =
  process.env.PATHAO_CLIENT_ID;

const PATHAO_CLIENT_SECRET =
  process.env.PATHAO_CLIENT_SECRET;

const PATHAO_USERNAME =
  process.env.PATHAO_USERNAME;

const PATHAO_PASSWORD =
  process.env.PATHAO_PASSWORD;

const PATHAO_WEBHOOK_SECRET =
  process.env.PATHAO_WEBHOOK_SECRET ||
  "f3992ecc-59da-4cbe-a049-a13da2018d51";

const TRACKING_URL =
  "https://pcom.page.link/ZvxGGEEgwsiFguMA8";

const TRACKING_CARRIER =
  "Other";

const PORT =
  Number(process.env.PORT || 3002);

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
  tracking_updates: 0,
  errors: 0,
  last_webhook: null
};

// ============================================================
// UTILS
// ============================================================

async function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function fetchTimeout(
  url,
  options = {},
  timeout = 20000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {

    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

  } catch (error) {

    if (
      error.name === "AbortError"
    ) {
      throw new Error(
        `Timeout: ${url}`
      );
    }

    throw error;

  } finally {

    clearTimeout(timer);
  }
}

function normalizeOrderName(value) {

  return String(value || "")
    .trim()
    .toUpperCase();
}

function numericShopifyId(gid) {

  if (!gid) {
    return null;
  }

  const value =
    String(gid);

  if (
    /^\d+$/.test(value)
  ) {
    return value;
  }

  const match =
    value.match(/\/(\d+)$/);

  return match
    ? match[1]
    : null;
}

// ============================================================
// SHOPIFY TOKEN
// ============================================================

async function getShopifyToken() {

  if (
    shopifyToken &&
    Date.now() <
      shopifyTokenExpires
  ) {

    return shopifyToken;
  }

  console.log(
    "🔐 Getting Shopify token..."
  );

  const res =
    await fetchTimeout(
      `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          new URLSearchParams({
            grant_type:
              "client_credentials",

            client_id:
              CLIENT_ID,

            client_secret:
              CLIENT_SECRET
          }).toString()
      }
    );

  const data =
    await res.json();

  if (
    !res.ok ||
    !data.access_token
  ) {

    throw new Error(
      `Shopify token failed: ${JSON.stringify(data)}`
    );
  }

  shopifyToken =
    data.access_token;

  shopifyTokenExpires =
    Date.now() +
    (data.expires_in || 86400) *
      1000;

  console.log(
    "✅ Shopify token OK"
  );

  return shopifyToken;
}

// ============================================================
// PATHAO TOKEN
// ============================================================

async function getPathaoToken() {

  if (
    pathaoToken &&
    Date.now() <
      pathaoTokenExpires
  ) {

    return pathaoToken;
  }

  console.log(
    "🔐 Getting Pathao token..."
  );

  const res =
    await fetchTimeout(
      `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            client_id:
              PATHAO_CLIENT_ID,

            client_secret:
              PATHAO_CLIENT_SECRET,

            username:
              PATHAO_USERNAME,

            password:
              PATHAO_PASSWORD,

            grant_type:
              "password"
          })
      }
    );

  const data =
    await res.json();

  if (
    !res.ok ||
    !data.access_token
  ) {

    throw new Error(
      `Pathao token failed: ${JSON.stringify(data)}`
    );
  }

  pathaoToken =
    data.access_token;

  pathaoTokenExpires =
    Date.now() +
    (data.expires_in || 3600) *
      1000;

  console.log(
    "✅ Pathao token OK"
  );

  return pathaoToken;
}

// ============================================================
// SHOPIFY REST
// ============================================================

async function shopifyRest(
  path,
  options = {}
) {

  const token =
    await getShopifyToken();

  const response =
    await fetchTimeout(
      `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}${path}`,
      {
        ...options,

        headers: {
          "X-Shopify-Access-Token":
            token,

          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  let data = {};

  try {
    data =
      await response.json();
  } catch (_) {
    data = {};
  }

  if (!response.ok) {

    throw new Error(
      `Shopify ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ============================================================
// SHOPIFY GRAPHQL
// Used for exact order lookup + hold info/release
// ============================================================

async function shopifyGraphQL(
  query,
  variables = {}
) {

  const token =
    await getShopifyToken();

  const response =
    await fetchTimeout(
      `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",

        headers: {
          "X-Shopify-Access-Token":
            token,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            query,
            variables
          })
      }
    );

  const payload =
    await response.json();

  if (!response.ok) {

    throw new Error(
      `Shopify ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  if (
    payload.errors?.length
  ) {

    throw new Error(
      payload.errors
        .map(error =>
          error.message
        )
        .join(", ")
    );
  }

  return payload.data;
}

// ============================================================
// EXACT SHOPIFY ORDER LOOKUP
// ============================================================

async function getExactShopifyOrder(
  merchantOrderId
) {

  const expected =
    normalizeOrderName(
      merchantOrderId
    );

  const query = `
    query FindExactOrder(
      $search: String!
    ) {
      orders(
        first: 20,
        query: $search
      ) {
        nodes {
          id
          legacyResourceId
          name
          displayFulfillmentStatus

          fulfillments(first: 20) {
            nodes {
              id
              legacyResourceId
              status

              trackingInfo {
                company
                number
                url
              }
            }
          }

          fulfillmentOrders(first: 20) {
            nodes {
              id
              status
              requestStatus

              fulfillmentHolds {
                id
                reason
                reasonNotes
              }
            }
          }
        }
      }
    }
  `;

  let data =
    await shopifyGraphQL(
      query,
      {
        search:
          `name:${merchantOrderId}`
      }
    );

  let candidates =
    data?.orders?.nodes || [];

  let order =
    candidates.find(
      item =>
        normalizeOrderName(
          item.name
        ) === expected
    );

  // fallback without #
  if (!order) {

    const cleanName =
      String(
        merchantOrderId
      )
        .replace(/^#/, "")
        .trim();

    data =
      await shopifyGraphQL(
        query,
        {
          search:
            `name:${cleanName}`
        }
      );

    candidates =
      data?.orders?.nodes || [];

    order =
      candidates.find(
        item =>
          normalizeOrderName(
            item.name
          ) === expected
      );
  }

  if (!order) {

    console.log(
      `   ❌ Exact Shopify order not found: ${merchantOrderId}`
    );

    return null;
  }

  if (
    normalizeOrderName(
      order.name
    ) !== expected
  ) {

    throw new Error(
      `ORDER MISMATCH: Pathao=${merchantOrderId}, Shopify=${order.name}`
    );
  }

  return order;
}

// ============================================================
// GET FULFILLMENT ORDER REST
// ============================================================

async function getFulfillmentOrders(
  orderId
) {

  const data =
    await shopifyRest(
      `/orders/${orderId}/fulfillment_orders.json`
    );

  return (
    data.fulfillment_orders || []
  );
}

// ============================================================
// GET FRESH GRAPHQL FULFILLMENT ORDER
// Includes hold IDs
// ============================================================

async function getFulfillmentOrderGraphQL(
  fulfillmentOrderId
) {

  const query = `
    query GetFulfillmentOrder(
      $id: ID!
    ) {
      fulfillmentOrder(
        id: $id
      ) {
        id
        status
        requestStatus

        fulfillmentHolds {
          id
          reason
          reasonNotes
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      query,
      {
        id:
          fulfillmentOrderId
      }
    );

  return (
    data?.fulfillmentOrder ||
    null
  );
}

// ============================================================
// RELEASE ON_HOLD
// ============================================================

async function releaseFulfillmentHold(
  fulfillmentOrder
) {

  const holds =
    fulfillmentOrder
      ?.fulfillmentHolds ||
    [];

  const holdIds =
    holds
      .map(hold =>
        hold.id
      )
      .filter(Boolean);

  if (
    holdIds.length === 0
  ) {

    throw new Error(
      "Fulfillment is ON_HOLD but Shopify returned no hold IDs."
    );
  }

  console.log(
    `      🔓 Releasing ${holdIds.length} hold(s)...`
  );

  const mutation = `
    mutation ReleaseHold(
      $id: ID!,
      $holdIds: [ID!]
    ) {
      fulfillmentOrderReleaseHold(
        id: $id,
        holdIds: $holdIds
      ) {
        fulfillmentOrder {
          id
          status
          requestStatus
        }

        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      mutation,
      {
        id:
          fulfillmentOrder.id,

        holdIds
      }
    );

  const result =
    data
      ?.fulfillmentOrderReleaseHold;

  if (
    result
      ?.userErrors
      ?.length
  ) {

    throw new Error(
      result.userErrors
        .map(error =>
          error.message
        )
        .join(", ")
    );
  }

  console.log(
    `      ✅ Hold released`
  );

  return true;
}

// ============================================================
// CREATE FULFILLMENT + TRACKING
//
// tracking number = Pathao consignment ID
// tracking URL = fixed
// company = Other
// ============================================================

async function createFulfillmentWithTracking(
  fulfillmentOrderId,
  consignmentId
) {

  const numericFulfillmentOrderId =
    numericShopifyId(
      fulfillmentOrderId
    );

  if (
    !numericFulfillmentOrderId
  ) {

    throw new Error(
      `Invalid fulfillment order ID: ${fulfillmentOrderId}`
    );
  }

  const data =
    await shopifyRest(
      "/fulfillments.json",
      {
        method: "POST",

        body:
          JSON.stringify({
            fulfillment: {

              line_items_by_fulfillment_order: [
                {
                  fulfillment_order_id:
                    Number(
                      numericFulfillmentOrderId
                    )
                }
              ],

              tracking_info: {
                number:
                  consignmentId,

                url:
                  TRACKING_URL,

                company:
                  TRACKING_CARRIER
              },

              notify_customer:
                false
            }
          })
      }
    );

  if (
    !data.fulfillment
  ) {

    throw new Error(
      "Shopify did not return a fulfillment."
    );
  }

  return data.fulfillment;
}

// ============================================================
// UPDATE TRACKING ON EXISTING FULFILLMENT
// ============================================================

async function updateFulfillmentTracking(
  fulfillmentId,
  consignmentId
) {

  const numericId =
    numericShopifyId(
      fulfillmentId
    );

  if (!numericId) {

    throw new Error(
      `Invalid fulfillment ID: ${fulfillmentId}`
    );
  }

  console.log(
    `      🔄 Updating tracking on fulfillment ${numericId}`
  );

  const data =
    await shopifyRest(
      `/fulfillments/${numericId}/update_tracking.json`,
      {
        method: "POST",

        body:
          JSON.stringify({
            fulfillment: {

              tracking_info: {
                number:
                  consignmentId,

                url:
                  TRACKING_URL,

                company:
                  TRACKING_CARRIER
              },

              notify_customer:
                false
            }
          })
      }
    );

  stats.tracking_updates += 1;

  return data.fulfillment;
}

// ============================================================
// FULFILL ONE FULFILLMENT ORDER SAFELY
// ============================================================

async function safelyFulfillOrder(
  fulfillmentOrder,
  consignmentId
) {

  let status =
    String(
      fulfillmentOrder.status ||
      ""
    ).toLowerCase();

  console.log(
    `      📍 Fulfillment order status: ${status}`
  );

  // ----------------------------------------
  // Already closed / fulfilled
  // ----------------------------------------

  if (
    status === "closed"
  ) {

    console.log(
      "      ✅ Already closed/fulfilled"
    );

    return {
      changed: false,
      alreadyFulfilled: true
    };
  }

  // ----------------------------------------
  // Cancelled
  // ----------------------------------------

  if (
    status === "cancelled"
  ) {

    console.log(
      "      ⏭ Cancelled fulfillment order"
    );

    return {
      changed: false,
      cancelled: true
    };
  }

  // ----------------------------------------
  // ON HOLD
  // ----------------------------------------

  if (
    status === "on_hold"
  ) {

    console.log(
      "      ⚠️ Fulfillment order is ON_HOLD"
    );

    const gid =
      `gid://shopify/FulfillmentOrder/${fulfillmentOrder.id}`;

    let graphOrder =
      await getFulfillmentOrderGraphQL(
        gid
      );

    if (!graphOrder) {

      throw new Error(
        "Could not retrieve Shopify hold information."
      );
    }

    await releaseFulfillmentHold(
      graphOrder
    );

    await sleep(400);

    // Fetch REST again
    // after releasing hold.

    const updated =
      await shopifyRest(
        `/fulfillment_orders/${fulfillmentOrder.id}.json`
      );

    fulfillmentOrder =
      updated.fulfillment_order;

    status =
      String(
        fulfillmentOrder?.status ||
        ""
      ).toLowerCase();

    console.log(
      `      🔄 After hold release: ${status}`
    );

    if (
      status === "on_hold"
    ) {

      throw new Error(
        "Fulfillment order is still ON_HOLD."
      );
    }
  }

  // ----------------------------------------
  // CREATE FULFILLMENT
  // ----------------------------------------

  if (
    status !== "open"
  ) {

    throw new Error(
      `Fulfillment order is not open. Current status=${status}`
    );
  }

  console.log(
    "      📦 Creating fulfillment..."
  );

  console.log(
    `      🔢 Tracking: ${consignmentId}`
  );

  console.log(
    `      🚚 Carrier: ${TRACKING_CARRIER}`
  );

  console.log(
    `      🔗 URL: ${TRACKING_URL}`
  );

  const fulfillment =
    await createFulfillmentWithTracking(
      fulfillmentOrder.id,
      consignmentId
    );

  console.log(
    `      ✅ Fulfillment created: ${fulfillment.id}`
  );

  console.log(
    `      ✅ Tracking number: ${consignmentId}`
  );

  return {
    changed: true,
    fulfillment
  };
}

// ============================================================
// EXACT ORDER -> FULFILL
// ============================================================

async function fulfillExactShopifyOrder(
  merchantOrderId,
  consignmentId
) {

  // ----------------------------------------
  // Find exact order
  // ----------------------------------------

  const order =
    await getExactShopifyOrder(
      merchantOrderId
    );

  if (!order) {

    throw new Error(
      `Exact Shopify order not found: ${merchantOrderId}`
    );
  }

  // ----------------------------------------
  // FINAL SAFETY CHECK
  // ----------------------------------------

  if (
    normalizeOrderName(
      order.name
    ) !==
    normalizeOrderName(
      merchantOrderId
    )
  ) {

    throw new Error(
      `ORDER MISMATCH BLOCKED: Pathao=${merchantOrderId}, Shopify=${order.name}`
    );
  }

  console.log(
    `   ✅ EXACT Shopify order found: ${order.name}`
  );

  const orderId =
    order.legacyResourceId ||
    numericShopifyId(
      order.id
    );

  console.log(
    `   🆔 Shopify Order ID: ${orderId}`
  );

  // ==========================================================
  // ALREADY FULFILLED?
  // ==========================================================

  if (
    String(
      order.displayFulfillmentStatus ||
      ""
    ).toUpperCase() ===
    "FULFILLED"
  ) {

    console.log(
      "   ✅ Already fulfilled"
    );

    // ----------------------------------------
    // Make sure existing fulfillment has
    // correct Pathao tracking information.
    // ----------------------------------------

    const fulfillments =
      order?.fulfillments?.nodes ||
      [];

    for (
      const fulfillment
      of fulfillments
    ) {

      const currentTracking =
        fulfillment
          ?.trackingInfo?.[0];

      const currentNumber =
        String(
          currentTracking?.number ||
          ""
        ).trim();

      const currentUrl =
        String(
          currentTracking?.url ||
          ""
        ).trim();

      const currentCompany =
        String(
          currentTracking?.company ||
          ""
        ).trim();

      const needsUpdate =
        currentNumber !==
          consignmentId ||

        currentUrl !==
          TRACKING_URL ||

        currentCompany !==
          TRACKING_CARRIER;

      if (
        needsUpdate
      ) {

        console.log(
          "   🔄 Fulfillment exists but tracking needs update"
        );

        await updateFulfillmentTracking(
          fulfillment.id,
          consignmentId
        );

        console.log(
          "   ✅ Tracking updated"
        );

      } else {

        console.log(
          "   ✅ Tracking already correct"
        );
      }
    }

    return {
      order,
      changed: 0,
      alreadyFulfilled: true
    };
  }

  // ==========================================================
  // GET REST FULFILLMENT ORDERS
  // ==========================================================

  const fulfillmentOrders =
    await getFulfillmentOrders(
      orderId
    );

  if (
    fulfillmentOrders.length === 0
  ) {

    throw new Error(
      `No fulfillment orders found for ${order.name}`
    );
  }

  let changed = 0;

  for (
    const fulfillmentOrder
    of fulfillmentOrders
  ) {

    console.log(
      `   📦 Fulfillment Order: ${fulfillmentOrder.id}`
    );

    const result =
      await safelyFulfillOrder(
        fulfillmentOrder,
        consignmentId
      );

    if (
      result.changed
    ) {
      changed++;
    }

    await sleep(300);
  }

  return {
    order,
    changed,
    alreadyFulfilled: false
  };
}

// ============================================================
// PATHAO GET CURRENT STATUS
// ============================================================

async function getPathaoOrderStatus(
  consignmentId
) {

  const token =
    await getPathaoToken();

  const response =
    await fetchTimeout(
      `${PATHAO_BASE_URL}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${token}`,

          Accept:
            "application/json",

          "Content-Type":
            "application/json"
        }
      }
    );

  const data =
    await response.json();

  if (!response.ok) {

    throw new Error(
      `Pathao ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data?.data || data;
}

// ============================================================
// CHECK PATHAO DELIVERED
// ============================================================

function isPathaoDelivered(
  data
) {

  const status =
    String(
      data?.order_status_slug ||
      data?.order_status ||
      data?.status ||
      ""
    )
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");

  return (
    status === "delivered" ||
    status === "order.delivered" ||
    status.endsWith(
      ".delivered"
    )
  );
}

// ============================================================
// FIND CONSIGNMENT FROM SHOPIFY
// ============================================================

function getConsignmentIdFromOrder(
  order
) {

  const fulfillments =
    order
      ?.fulfillments
      ?.nodes || [];

  for (
    const fulfillment
    of fulfillments
  ) {

    const tracking =
      fulfillment
        ?.trackingInfo ||
      [];

    for (
      const item
      of tracking
    ) {

      const number =
        String(
          item?.number ||
          ""
        ).trim();

      if (number) {

        return number;
      }
    }
  }

  return null;
}

// ============================================================
// LAST 24 HOURS SHOPIFY ORDERS
// MAX 1000
// ============================================================

async function getLastDayShopifyOrders(
  maxOrders = 1000
) {

  const limit =
    Math.min(
      Number(maxOrders) ||
        1000,
      1000
    );

  const since =
    new Date(
      Date.now() -
      24 *
      60 *
      60 *
      1000
    ).toISOString();

  const query = `
    query LastDayOrders(
      $first: Int!,
      $after: String,
      $search: String!
    ) {

      orders(
        first: $first,
        after: $after,
        query: $search,
        sortKey: CREATED_AT,
        reverse: true
      ) {

        nodes {
          id
          legacyResourceId
          name
          createdAt
          displayFulfillmentStatus

          fulfillments(first: 20) {
            nodes {
              id
              legacyResourceId
              status

              trackingInfo {
                company
                number
                url
              }
            }
          }

          fulfillmentOrders(first: 20) {
            nodes {
              id
              status

              fulfillmentHolds {
                id
                reason
                reasonNotes
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

  let orders = [];
  let cursor = null;

  while (
    orders.length <
    limit
  ) {

    const first =
      Math.min(
        250,
        limit -
        orders.length
      );

    const data =
      await shopifyGraphQL(
        query,
        {
          first,

          after:
            cursor,

          search:
            `created_at:>=${since}`
        }
      );

    const connection =
      data?.orders;

    const nodes =
      connection
        ?.nodes || [];

    orders.push(
      ...nodes
    );

    console.log(
      `📦 Loaded ${orders.length} orders`
    );

    if (
      !connection
        ?.pageInfo
        ?.hasNextPage
    ) {

      break;
    }

    cursor =
      connection
        ?.pageInfo
        ?.endCursor;

    if (!cursor) {

      break;
    }
  }

  return orders.slice(
    0,
    limit
  );
}

// ============================================================
// VERIFY PATHAO WEBHOOK
// ============================================================

function verifyWebhookSignature(
  signature
) {

  if (
    !signature ||
    !PATHAO_WEBHOOK_SECRET
  ) {

    return false;
  }

  return (
    String(signature).trim() ===
    String(
      PATHAO_WEBHOOK_SECRET
    ).trim()
  );
}

// ============================================================
// PROCESS WEBHOOK
// ============================================================

async function processWebhook(
  body
) {

  stats.webhooks_received += 1;

  stats.last_webhook =
    new Date()
      .toISOString();

  const consignmentId =
    body.consignment_id;

  const merchantOrderId =
    body.merchant_order_id;

  const event =
    body.event;

  console.log("");
  console.log(
    "📨 Webhook received:"
  );

  console.log(
    `   📦 Consignment: ${consignmentId}`
  );

  console.log(
    `   🏷 Order ID: ${merchantOrderId}`
  );

  console.log(
    `   🔔 Event: ${event}`
  );

  if (
    !consignmentId ||
    !merchantOrderId ||
    !event
  ) {

    console.log(
      "   ❌ Missing required fields"
    );

    return false;
  }

  const eventLower =
    String(event)
      .trim()
      .toLowerCase();

  // ==========================================================
  // ONLY DELIVERED -> FULFILL
  // ==========================================================

  if (
    eventLower ===
      "order.delivered" ||
    eventLower.includes(
      "order.delivered"
    )
  ) {

    console.log(
      "   ✅ Pathao DELIVERED"
    );

    console.log(
      "   🔄 Shopify → FULFILLED"
    );

    try {

      const result =
        await fulfillExactShopifyOrder(
          merchantOrderId,
          consignmentId
        );

      if (
        result.changed >
        0
      ) {

        stats.updates_sent +=
          result.changed;

        console.log(
          `   ✅ ${merchantOrderId} FULFILLED`
        );

        console.log(
          `   🔢 Tracking: ${consignmentId}`
        );

        console.log(
          `   🚚 Carrier: ${TRACKING_CARRIER}`
        );

        console.log(
          `   🔗 ${TRACKING_URL}`
        );
      }

      stats.webhooks_processed +=
        1;

      return true;

    } catch (error) {

      console.error(
        `   ❌ Error: ${error.message}`
      );

      stats.errors += 1;

      return false;
    }
  }

  // ==========================================================
  // NOT DELIVERED
  // ==========================================================

  console.log(
    "   ⏭ Not delivered"
  );

  console.log(
    "   📦 Shopify remains UNFULFILLED"
  );

  stats.webhooks_processed += 1;

  return true;
}

// ============================================================
// HOME
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.json({
      success: true,

      service:
        "Pathao → Shopify Fulfillment Sync",

      tracking: {
        carrier:
          TRACKING_CARRIER,

        url:
          TRACKING_URL
      },

      endpoints: {

        health:
          "GET /health",

        stats:
          "GET /api/stats",

        test:
          "GET /api/test",

        sync_last_day:
          "GET /api/sync-last-day",

        webhook:
          "POST /webhooks/pathao"
      }
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      success: true,

      status:
        "healthy",

      timestamp:
        new Date()
          .toISOString()
    });
  }
);

// ============================================================
// STATS
// ============================================================

app.get(
  "/api/stats",
  (req, res) => {

    res.json({
      success: true,
      stats
    });
  }
);

// ============================================================
// TEST
// ============================================================

app.get(
  "/api/test",
  async (req, res) => {

    try {

      await getShopifyToken();
      await getPathaoToken();

      res.json({
        success: true,

        message:
          "Shopify and Pathao connections OK"
      });

    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

// ============================================================
// LAST 24 HOURS SYNC
// MAX 1000
// ============================================================

app.get(
  "/api/sync-last-day",
  async (req, res) => {

    try {

      console.log("");
      console.log(
        "========================================"
      );

      console.log(
        "🔄 LAST 24 HOURS SYNC"
      );

      console.log(
        "========================================"
      );

      const orders =
        await getLastDayShopifyOrders(
          1000
        );

      let checked = 0;
      let delivered = 0;
      let fulfilled = 0;
      let alreadyFulfilled = 0;
      let notDelivered = 0;
      let noTracking = 0;
      let errors = 0;

      const results = [];

      for (
        const order
        of orders
      ) {

        checked++;

        console.log("");
        console.log(
          `[${checked}/${orders.length}] ${order.name}`
        );

        const consignmentId =
          getConsignmentIdFromOrder(
            order
          );

        if (
          !consignmentId
        ) {

          console.log(
            "   ⏭ No consignment ID"
          );

          noTracking++;

          results.push({
            order:
              order.name,

            result:
              "no_consignment_id"
          });

          continue;
        }

        try {

          const pathao =
            await getPathaoOrderStatus(
              consignmentId
            );

          const pathaoStatus =
            pathao
              ?.order_status_slug ||
            pathao
              ?.order_status ||
            pathao
              ?.status ||
            "Unknown";

          console.log(
            `   🚚 ${consignmentId}`
          );

          console.log(
            `   📍 ${pathaoStatus}`
          );

          if (
            isPathaoDelivered(
              pathao
            )
          ) {

            delivered++;

            const result =
              await fulfillExactShopifyOrder(
                order.name,
                consignmentId
              );

            if (
              result.changed >
              0
            ) {

              fulfilled++;

              console.log(
                "   ✅ Shopify FULFILLED"
              );

            } else {

              alreadyFulfilled++;

              console.log(
                "   ✅ Already fulfilled"
              );
            }

            results.push({

              order:
                order.name,

              consignment_id:
                consignmentId,

              pathao_status:
                pathaoStatus,

              shopify:
                result.changed > 0
                  ? "fulfilled"
                  : "already_fulfilled",

              tracking_number:
                consignmentId,

              tracking_url:
                TRACKING_URL,

              carrier:
                TRACKING_CARRIER
            });

          } else {

            notDelivered++;

            console.log(
              "   ⏭ Remains UNFULFILLED"
            );

            results.push({

              order:
                order.name,

              consignment_id:
                consignmentId,

              pathao_status:
                pathaoStatus,

              shopify:
                "unfulfilled"
            });
          }

        } catch (error) {

          errors++;

          console.error(
            `   ❌ ${error.message}`
          );

          results.push({
            order:
              order.name,

            consignment_id:
              consignmentId,

            result:
              "error",

            error:
              error.message
          });
        }

        await sleep(300);
      }

      return res.json({

        success: true,

        period:
          "last 24 hours",

        max_orders:
          1000,

        total_orders:
          orders.length,

        checked,

        delivered,

        newly_fulfilled:
          fulfilled,

        already_fulfilled:
          alreadyFulfilled,

        not_delivered:
          notDelivered,

        no_consignment_id:
          noTracking,

        errors,

        tracking: {

          carrier:
            TRACKING_CARRIER,

          url:
            TRACKING_URL
        },

        results
      });

    } catch (error) {

      console.error(
        "❌ Sync failed:",
        error.message
      );

      return res
        .status(500)
        .json({
          success: false,

          error:
            error.message
        });
    }
  }
);

// ============================================================
// PATHAO WEBHOOK
// ============================================================

app.post(
  "/webhooks/pathao",
  (req, res) => {

    const signature =
      req.get(
        "X-PATHAO-Signature"
      ) ||
      req.get(
        "X-Pathao-Signature"
      );

    const body =
      req.body || {};

    // Verification handshake
    if (
      body.event ===
      "webhook_integration"
    ) {

      console.log(
        "✅ Pathao webhook verification"
      );

      res.set(
        "X-Pathao-Merchant-Webhook-Integration-Secret",
        PATHAO_WEBHOOK_SECRET
      );

      return res
        .status(202)
        .json({
          success: true,
          message:
            "Verified"
        });
    }

    // Signature check
    if (
      !verifyWebhookSignature(
        signature
      )
    ) {

      console.warn(
        "⚠️ Invalid Pathao signature"
      );

      return res
        .status(401)
        .json({
          success: false,

          error:
            "Invalid signature"
        });
    }

    // Reply immediately
    res
      .status(202)
      .json({
        success: true,
        received: true
      });

    // Process
    processWebhook(
      body
    ).catch(
      error => {

        console.error(
          "❌ Webhook processing error:",
          error.message
        );

        stats.errors += 1;
      }
    );
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        success: false,
        error:
          "Not found"
      });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "🚀 PATHAO → SHOPIFY SYNC"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🏪 Shopify: ${SHOP}`
    );

    console.log(
      `🚚 Carrier: ${TRACKING_CARRIER}`
    );

    console.log(
      `🔗 Tracking URL: ${TRACKING_URL}`
    );

    console.log(
      "========================================"
    );

    console.log("");

    console.log(
      "📌 POST /webhooks/pathao"
    );

    console.log(
      "📌 GET /api/sync-last-day"
    );

    console.log("");

    console.log(
      "🔄 Delivered flow:"
    );

    console.log(
      "   1. Receive Pathao delivery"
    );

    console.log(
      "   2. Match EXACT Shopify order"
    );

    console.log(
      "   3. Release Shopify hold if required"
    );

    console.log(
      "   4. Fulfill Shopify order"
    );

    console.log(
      "   5. Tracking number = Pathao consignment ID"
    );

    console.log(
      `   6. Carrier = ${TRACKING_CARRIER}`
    );

    console.log(
      `   7. Tracking URL = ${TRACKING_URL}`
    );

    console.log("");

    console.log(
      "✅ Ready!"
    );

    console.log(
      "========================================"
    );
  }
);
