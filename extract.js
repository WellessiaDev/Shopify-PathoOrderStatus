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
  process.env.PATHAO_WEBHOOK_SECRET;

const TRACKING_CARRIER = "Other";

const PORT =
  Number(process.env.PORT || 3002);

// Search newest first
const SHOPIFY_SEARCH_LIMIT = 5000;
const SHOPIFY_PAGE_SIZE = 250;

// ============================================================
// TOKEN CACHE
// ============================================================

let shopifyToken = null;
let shopifyTokenExpires = 0;

let pathaoToken = null;
let pathaoTokenExpires = 0;

// ============================================================
// STATS
// ============================================================

const stats = {
  webhooks_received: 0,
  webhooks_processed: 0,
  fulfilled: 0,
  tracking_updates: 0,
  already_fulfilled: 0,
  errors: 0,
  last_webhook: null
};

// ============================================================
// UTILITIES
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
        `Request timeout: ${url}`
      );
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// NORMALIZE ORDER NAME
// ============================================================

function normalizeOrderName(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

// ============================================================
// NORMALIZE PHONE
//
// +8801798538339
// -> 01798538339
//
// 8801798538339
// -> 01798538339
// ============================================================

function normalizePhone(phone) {

  if (!phone) {
    return "";
  }

  let value =
    String(phone).trim();

  // Remove spaces / - / ( )
  value =
    value.replace(
      /[\s\-()]/g,
      ""
    );

  // +8801XXXXXXXXX
  if (
    value.startsWith("+880")
  ) {

    value =
      "0" +
      value.substring(4);
  }

  // 8801XXXXXXXXX
  else if (
    value.startsWith("880")
  ) {

    value =
      "0" +
      value.substring(3);
  }

  return value;
}

// ============================================================
// BUILD PATHAO TRACKING URL
// ============================================================

function buildTrackingUrl(
  consignmentId,
  phone
) {

  return (
    "https://merchant.pathao.com/tracking" +
    `?consignment_id=${encodeURIComponent(consignmentId)}` +
    `&phone=${encodeURIComponent(phone)}`
  );
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

  const response =
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
    await response.json();

  if (
    !response.ok ||
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

  const response =
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
    await response.json();

  if (
    !response.ok ||
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
// SHOPIFY GRAPHQL
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
      `Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`
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
// VERIFY PATHAO ORDER EXISTS
// ============================================================

async function getPathaoOrder(
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

  let data = {};

  try {

    data =
      await response.json();

  } catch (_) {

    data = {};
  }

  if (!response.ok) {

    throw new Error(
      `Pathao ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data?.data || data;
}

// ============================================================
// SEARCH SHOPIFY FULFILLMENT ORDERS
//
// NEWEST -> OLDEST
//
// EXACT orderName MATCH ONLY
// ============================================================

async function getShopifyOrderByName(
  merchantOrderId
) {

  const expected =
    normalizeOrderName(
      merchantOrderId
    );

  const query = `
    query FindFulfillmentOrders(
      $first: Int!,
      $after: String
    ) {

      fulfillmentOrders(
        first: $first,
        after: $after,
        includeClosed: true,
        reverse: true
      ) {

        nodes {

          id
          orderId
          orderName
          status
          requestStatus

          destination {
            firstName
            lastName
            phone
            email
          }

          fulfillmentHolds {
            id
            reason
            reasonNotes
          }

          fulfillments(first: 20) {

            nodes {

              id
              status

              trackingInfo {
                company
                number
                url
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

  let cursor = null;
  let checked = 0;

  console.log(
    `🔎 Searching newest Shopify orders...`
  );

  console.log(
    `🎯 Looking for: ${merchantOrderId}`
  );

  while (
    checked <
    SHOPIFY_SEARCH_LIMIT
  ) {

    const remaining =
      SHOPIFY_SEARCH_LIMIT -
      checked;

    const first =
      Math.min(
        SHOPIFY_PAGE_SIZE,
        remaining
      );

    const data =
      await shopifyGraphQL(
        query,
        {
          first,
          after: cursor
        }
      );

    const connection =
      data?.fulfillmentOrders;

    const fulfillmentOrders =
      connection?.nodes || [];

    checked +=
      fulfillmentOrders.length;

    // ========================================================
    // EXACT ORDER NAME MATCH
    // ========================================================

    const exactMatches =
      fulfillmentOrders.filter(
        fo =>
          normalizeOrderName(
            fo.orderName
          ) === expected
      );

    if (
      exactMatches.length > 0
    ) {

      console.log(
        `✅ Exact Shopify order found: ${merchantOrderId}`
      );

      console.log(
        `🔎 Checked: ${checked}`
      );

      return {

        id:
          exactMatches[0]
            .orderId,

        name:
          exactMatches[0]
            .orderName,

        fulfillmentOrders:
          exactMatches
      };
    }

    console.log(
      `🔎 Checked ${checked} newest fulfillment orders...`
    );

    // ========================================================
    // NO MORE RESULTS
    // ========================================================

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

  console.log(
    `❌ Shopify order not found: ${merchantOrderId}`
  );

  return null;
}

// ============================================================
// GET FRESH FULFILLMENT ORDER
//
// PHONE COMES DIRECTLY FROM destination.phone
// ============================================================

async function getFulfillmentOrder(
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
        orderId
        orderName
        status
        requestStatus

        destination {

          firstName
          lastName

          phone
          email

          address1
          address2
          city
          province
          zip
          countryCode
        }

        fulfillmentHolds {
          id
          reason
          reasonNotes
        }

        fulfillments(first: 20) {

          nodes {

            id
            status

            trackingInfo {
              company
              number
              url
            }
          }
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
    data
      ?.fulfillmentOrder ||
    null
  );
}

// ============================================================
// RELEASE FULFILLMENT HOLD
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
    `🔓 Releasing ${holdIds.length} Shopify hold(s)...`
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
    "✅ Hold released"
  );

  return (
    result
      ?.fulfillmentOrder ||
    null
  );
}

// ============================================================
// CREATE SHOPIFY FULFILLMENT
// ============================================================

async function createFulfillment(
  fulfillmentOrderId,
  consignmentId,
  phone
) {

  const trackingUrl =
    buildTrackingUrl(
      consignmentId,
      phone
    );

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

      lineItemsByFulfillmentOrder: [

        {
          fulfillmentOrderId:
            fulfillmentOrderId
        }
      ],

      notifyCustomer:
        false,

      trackingInfo: {

        company:
          TRACKING_CARRIER,

        number:
          String(
            consignmentId
          ),

        url:
          trackingUrl
      }
    }
  };

  const data =
    await shopifyGraphQL(
      mutation,
      variables
    );

  const result =
    data
      ?.fulfillmentCreate;

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

  if (
    !result?.fulfillment
  ) {

    throw new Error(
      "Shopify did not create fulfillment."
    );
  }

  console.log("");
  console.log(
    "✅ SHOPIFY FULFILLMENT CREATED"
  );

  console.log(
    `🔢 Tracking: ${consignmentId}`
  );

  console.log(
    `📱 Phone: ${phone}`
  );

  console.log(
    `🚚 Carrier: ${TRACKING_CARRIER}`
  );

  console.log(
    `🔗 Tracking URL: ${trackingUrl}`
  );

  return result.fulfillment;
}

// ============================================================
// UPDATE EXISTING FULFILLMENT TRACKING
// ============================================================

async function updateFulfillmentTracking(
  fulfillmentId,
  consignmentId,
  phone
) {

  const trackingUrl =
    buildTrackingUrl(
      consignmentId,
      phone
    );

  const mutation = `
    mutation UpdateTracking(
      $fulfillmentId: ID!,
      $trackingInfoInput: FulfillmentTrackingInput!,
      $notifyCustomer: Boolean
    ) {

      fulfillmentTrackingInfoUpdate(
        fulfillmentId: $fulfillmentId,
        trackingInfoInput: $trackingInfoInput,
        notifyCustomer: $notifyCustomer
      ) {

        fulfillment {

          id
          status

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

  const data =
    await shopifyGraphQL(
      mutation,
      {

        fulfillmentId,

        notifyCustomer:
          false,

        trackingInfoInput: {

          company:
            TRACKING_CARRIER,

          number:
            String(
              consignmentId
            ),

          url:
            trackingUrl
        }
      }
    );

  const result =
    data
      ?.fulfillmentTrackingInfoUpdate;

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

  stats.tracking_updates += 1;

  console.log(
    "✅ Existing Shopify tracking updated"
  );

  console.log(
    `🔗 ${trackingUrl}`
  );

  return result?.fulfillment;
}

// ============================================================
// UPDATE ALL EXISTING FULFILLMENTS
// ============================================================

async function updateExistingFulfillments(
  fulfillmentOrder,
  consignmentId,
  phone
) {

  const fulfillments =
    fulfillmentOrder
      ?.fulfillments
      ?.nodes || [];

  if (
    fulfillments.length === 0
  ) {
    return 0;
  }

  let updated = 0;

  for (
    const fulfillment
    of fulfillments
  ) {

    try {

      await updateFulfillmentTracking(
        fulfillment.id,
        consignmentId,
        phone
      );

      updated++;

    } catch (error) {

      console.error(
        `⚠️ Tracking update failed: ${error.message}`
      );
    }

    await sleep(200);
  }

  return updated;
}

// ============================================================
// PROCESS ONE FULFILLMENT ORDER
// ============================================================

async function processFulfillmentOrder(
  fulfillmentOrderId,
  merchantOrderId,
  consignmentId
) {

  let fulfillmentOrder =
    await getFulfillmentOrder(
      fulfillmentOrderId
    );

  if (!fulfillmentOrder) {

    throw new Error(
      `Fulfillment order not found: ${fulfillmentOrderId}`
    );
  }

  // ========================================================
  // EXACT SAFETY CHECK
  // ========================================================

  if (
    normalizeOrderName(
      fulfillmentOrder.orderName
    ) !==
    normalizeOrderName(
      merchantOrderId
    )
  ) {

    throw new Error(
      `ORDER MISMATCH BLOCKED: Pathao=${merchantOrderId}, Shopify=${fulfillmentOrder.orderName}`
    );
  }

  // ========================================================
  // GET CUSTOMER PHONE FROM SHOPIFY DESTINATION
  // ========================================================

  const rawPhone =
    fulfillmentOrder
      ?.destination
      ?.phone;

  const phone =
    normalizePhone(
      rawPhone
    );

  console.log(
    `📱 Shopify raw phone: ${rawPhone || "EMPTY"}`
  );

  console.log(
    `📱 Normalized phone: ${phone || "EMPTY"}`
  );

  if (!phone) {

    throw new Error(
      `No destination phone found for Shopify order ${merchantOrderId}`
    );
  }

  const trackingUrl =
    buildTrackingUrl(
      consignmentId,
      phone
    );

  console.log(
    `🔗 Tracking URL: ${trackingUrl}`
  );

  let status =
    String(
      fulfillmentOrder.status ||
      ""
    ).toUpperCase();

  console.log(
    `📍 Fulfillment status: ${status}`
  );

  // ========================================================
  // ALREADY FULFILLED
  // ========================================================

  if (
    status === "CLOSED"
  ) {

    console.log(
      "✅ Already fulfilled"
    );

    await updateExistingFulfillments(
      fulfillmentOrder,
      consignmentId,
      phone
    );

    return {

      fulfilled: false,

      alreadyFulfilled: true,

      phone,

      trackingUrl
    };
  }

  // ========================================================
  // CANCELLED
  // ========================================================

  if (
    status === "CANCELLED"
  ) {

    console.log(
      "⏭ Shopify fulfillment order cancelled"
    );

    return {

      fulfilled: false,

      cancelled: true,

      phone,

      trackingUrl
    };
  }

  // ========================================================
  // ON HOLD
  // ========================================================

  if (
    status === "ON_HOLD"
  ) {

    console.log(
      "⚠️ Shopify fulfillment ON_HOLD"
    );

    await releaseFulfillmentHold(
      fulfillmentOrder
    );

    await sleep(500);

    // Get fresh fulfillment order
    fulfillmentOrder =
      await getFulfillmentOrder(
        fulfillmentOrderId
      );

    status =
      String(
        fulfillmentOrder
          ?.status || ""
      ).toUpperCase();

    console.log(
      `🔄 Status after hold release: ${status}`
    );

    if (
      status === "ON_HOLD"
    ) {

      throw new Error(
        "Shopify fulfillment order is still ON_HOLD."
      );
    }
  }

  // ========================================================
  // FULFILL
  // ========================================================

  if (
    status === "OPEN" ||
    status === "IN_PROGRESS" ||
    status === "SCHEDULED"
  ) {

    console.log(
      "📦 Creating Shopify fulfillment..."
    );

    await createFulfillment(
      fulfillmentOrder.id,
      consignmentId,
      phone
    );

    return {

      fulfilled: true,

      alreadyFulfilled: false,

      phone,

      trackingUrl
    };
  }

  throw new Error(
    `Unsupported fulfillment order status=${status}`
  );
}

// ============================================================
// FULFILL EXACT SHOPIFY ORDER
// ============================================================

async function fulfillExactShopifyOrder(
  merchantOrderId,
  consignmentId
) {

  const shopifyOrder =
    await getShopifyOrderByName(
      merchantOrderId
    );

  if (!shopifyOrder) {

    throw new Error(
      `Exact Shopify order not found: ${merchantOrderId}`
    );
  }

  // Final safety check
  if (
    normalizeOrderName(
      shopifyOrder.name
    ) !==
    normalizeOrderName(
      merchantOrderId
    )
  ) {

    throw new Error(
      `ORDER MISMATCH BLOCKED: ${merchantOrderId} != ${shopifyOrder.name}`
    );
  }

  let fulfilledCount = 0;
  let alreadyCount = 0;

  let phone = "";
  let trackingUrl = "";

  for (
    const fulfillmentOrder
    of shopifyOrder.fulfillmentOrders
  ) {

    console.log("");
    console.log(
      `📦 Processing fulfillment order: ${fulfillmentOrder.id}`
    );

    const result =
      await processFulfillmentOrder(
        fulfillmentOrder.id,
        merchantOrderId,
        consignmentId
      );

    if (
      result.fulfilled
    ) {
      fulfilledCount++;
    }

    if (
      result.alreadyFulfilled
    ) {
      alreadyCount++;
    }

    if (
      result.phone
    ) {
      phone =
        result.phone;
    }

    if (
      result.trackingUrl
    ) {
      trackingUrl =
        result.trackingUrl;
    }

    await sleep(300);
  }

  return {

    orderName:
      shopifyOrder.name,

    phone,

    trackingUrl,

    fulfilledCount,

    alreadyCount
  };
}

// ============================================================
// VERIFY PATHAO WEBHOOK SIGNATURE
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
    String(signature)
      .trim() ===
    String(
      PATHAO_WEBHOOK_SECRET
    ).trim()
  );
}

// ============================================================
// PROCESS PATHAO WEBHOOK
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
    "========================================"
  );

  console.log(
    "📨 PATHAO WEBHOOK"
  );

  console.log(
    `📦 Consignment: ${consignmentId}`
  );

  console.log(
    `🏷 Shopify order: ${merchantOrderId}`
  );

  console.log(
    `🔔 Pathao event: ${event}`
  );

  // ========================================================
  // VALIDATION
  // ========================================================

  if (
    !consignmentId ||
    !merchantOrderId
  ) {

    console.log(
      "❌ Missing consignment/order ID"
    );

    return false;
  }

  try {

    // ======================================================
    // 1. VERIFY PATHAO CONSIGNMENT EXISTS
    // ======================================================

    console.log(
      "🔎 Verifying Pathao order..."
    );

    const pathaoOrder =
      await getPathaoOrder(
        consignmentId
      );

    if (!pathaoOrder) {

      throw new Error(
        `Pathao order not found: ${consignmentId}`
      );
    }

    console.log(
      "✅ Pathao order exists"
    );

    // ======================================================
    // 2. FIND EXACT SHOPIFY ORDER
    // ======================================================

    console.log(
      "🔎 Finding exact Shopify fulfillment order..."
    );

    const result =
      await fulfillExactShopifyOrder(
        merchantOrderId,
        consignmentId
      );

    // ======================================================
    // SUCCESS
    // ======================================================

    if (
      result.fulfilledCount >
      0
    ) {

      stats.fulfilled +=
        result.fulfilledCount;

      console.log("");
      console.log(
        "✅ SHOPIFY FULFILLED"
      );
    }

    if (
      result.alreadyCount >
      0
    ) {

      stats.already_fulfilled +=
        result.alreadyCount;

      console.log(
        "✅ Shopify already fulfilled"
      );

      console.log(
        "✅ Tracking updated"
      );
    }

    console.log("");
    console.log(
      "========== RESULT =========="
    );

    console.log(
      `🏷 Order: ${result.orderName}`
    );

    console.log(
      `🔢 Tracking: ${consignmentId}`
    );

    console.log(
      `📱 Phone: ${result.phone}`
    );

    console.log(
      `🚚 Carrier: ${TRACKING_CARRIER}`
    );

    console.log(
      `🔗 Tracking URL: ${result.trackingUrl}`
    );

    console.log(
      "============================"
    );

    stats.webhooks_processed += 1;

    return true;

  } catch (error) {

    console.error(
      `❌ Error: ${error.message}`
    );

    stats.errors += 1;

    return false;
  }
}

// ============================================================
// HOME
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.json({

      success:
        true,

      service:
        "Pathao → Shopify Auto Fulfillment",

      flow: [
        "Verify Pathao consignment",
        "Find exact Shopify fulfillment order",
        "Read destination.phone from Shopify",
        "Normalize Bangladesh phone",
        "Build Pathao tracking URL",
        "Fulfill Shopify",
        "Add tracking"
      ],

      tracking: {

        number:
          "Pathao consignment_id",

        phone:
          "Shopify FulfillmentOrder.destination.phone",

        carrier:
          TRACKING_CARRIER,

        url:
          "https://merchant.pathao.com/tracking?consignment_id=CONSIGNMENT_ID&phone=PHONE"
      },

      endpoints: {

        health:
          "GET /health",

        stats:
          "GET /api/stats",

        test:
          "GET /api/test",

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

      success:
        true,

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

      success:
        true,

      stats
    });
  }
);

// ============================================================
// TEST CONNECTIONS
// ============================================================

app.get(
  "/api/test",
  async (req, res) => {

    try {

      await getShopifyToken();
      await getPathaoToken();

      res.json({

        success:
          true,

        message:
          "Shopify and Pathao connections OK"
      });

    } catch (error) {

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

    // ======================================================
    // PATHAO WEBHOOK HANDSHAKE
    // ======================================================

    if (
      body.event ===
      "webhook_integration"
    ) {

      console.log(
        "✅ Pathao webhook verification handshake"
      );

      res.set(
        "X-Pathao-Merchant-Webhook-Integration-Secret",
        PATHAO_WEBHOOK_SECRET
      );

      return res
        .status(202)
        .json({

          success:
            true,

          message:
            "Verified"
        });
    }

    // ======================================================
    // VERIFY WEBHOOK SIGNATURE
    // ======================================================

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

          success:
            false,

          error:
            "Invalid signature"
        });
    }

    // ======================================================
    // RESPOND TO PATHAO IMMEDIATELY
    // ======================================================

    res
      .status(202)
      .json({

        success:
          true,

        received:
          true
      });

    // ======================================================
    // PROCESS WEBHOOK
    // ======================================================

    processWebhook(
      body
    )
      .catch(
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

        success:
          false,

        error:
          "Not found"
      });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "🚀 PATHAO → SHOPIFY AUTO FULFILLMENT"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🏪 Shopify: ${SHOP}`
    );

    console.log(
      "🔎 Search: NEWEST → OLDEST"
    );

    console.log(
      `🔎 Maximum search: ${SHOPIFY_SEARCH_LIMIT}`
    );

    console.log(
      "📱 Phone: Shopify destination.phone"
    );

    console.log(
      `🚚 Carrier: ${TRACKING_CARRIER}`
    );

    console.log(
      "🔗 URL: merchant.pathao.com/tracking"
    );

    console.log(
      "========================================"
    );

    console.log(
      "📌 POST /webhooks/pathao"
    );

    console.log(
      "========================================"
    );

    console.log(
      "🔄 FLOW:"
    );

    console.log(
      "1. Pathao webhook received"
    );

    console.log(
      "2. Verify consignment exists"
    );

    console.log(
      "3. Find exact Shopify order"
    );

    console.log(
      "4. Read Shopify destination phone"
    );

    console.log(
      "5. Normalize +880 / 880 → 0"
    );

    console.log(
      "6. Build dynamic Pathao tracking URL"
    );

    console.log(
      "7. Release fulfillment hold if necessary"
    );

    console.log(
      "8. Fulfill Shopify"
    );

    console.log(
      "9. Add tracking number + URL"
    );

    console.log(
      "========================================"
    );

    console.log(
      "✅ Ready!"
    );
  }
);
