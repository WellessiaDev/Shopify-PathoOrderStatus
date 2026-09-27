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

const TRACKING_CARRIER = "Other";

const PORT =
  Number(process.env.PORT || 3002);

const SHOPIFY_SEARCH_LIMIT = 5000;
const SHOPIFY_PAGE_SIZE = 250;

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
  fulfilled: 0,
  tracking_updates: 0,
  already_fulfilled: 0,
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
// PATHAO ORDER CHECK
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
// FIND EXACT SHOPIFY ORDER
// NEWEST -> OLDEST
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
    `   🔎 Searching newest Shopify fulfillment orders...`
  );

  console.log(
    `   🎯 Looking for: ${merchantOrderId}`
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
          after:
            cursor
        }
      );

    const connection =
      data?.fulfillmentOrders;

    const fulfillmentOrders =
      connection?.nodes || [];

    checked +=
      fulfillmentOrders.length;

    const exactMatches =
      fulfillmentOrders.filter(
        fulfillmentOrder =>
          normalizeOrderName(
            fulfillmentOrder.orderName
          ) === expected
      );

    if (
      exactMatches.length > 0
    ) {

      console.log(
        `   ✅ EXACT Shopify order found: ${merchantOrderId}`
      );

      console.log(
        `   🔎 Checked ${checked} fulfillment orders`
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
      `   🔎 Checked ${checked} newest fulfillment orders...`
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

  console.log(
    `   ❌ Exact Shopify order not found: ${merchantOrderId}`
  );

  return null;
}

// ============================================================
// GET SHOPIFY ORDER PHONE BY EXACT ORDER ID
// ============================================================

async function getShopifyOrderPhone(
  orderId
) {

  const query = `
    query GetOrderPhone(
      $id: ID!
    ) {
      order(id: $id) {
        id
        name
        phone

        shippingAddress {
          phone
        }

        billingAddress {
          phone
        }

        customer {
          defaultPhoneNumber {
            phoneNumber
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
          orderId
      }
    );

  const order =
    data?.order;

  if (!order) {

    throw new Error(
      `Shopify order not found by ID: ${orderId}`
    );
  }

  const phone =
    order.phone ||
    order.shippingAddress?.phone ||
    order.billingAddress?.phone ||
    order.customer
      ?.defaultPhoneNumber
      ?.phoneNumber ||
    "";

  if (!phone) {

    throw new Error(
      `No phone number found for Shopify order ${order.name}`
    );
  }

  console.log(
    `   📱 Shopify phone found: ${phone}`
  );

  return String(phone).trim();
}

// ============================================================
// GET FRESH FULFILLMENT ORDER
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
// RELEASE HOLD
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
    "      ✅ Hold released"
  );

  return (
    result
      ?.fulfillmentOrder ||
    null
  );
}

// ============================================================
// CREATE FULFILLMENT WITH DYNAMIC TRACKING
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

  console.log(
    "      ✅ Shopify fulfillment created"
  );

  console.log(
    `      🔢 Tracking: ${consignmentId}`
  );

  console.log(
    `      📱 Phone: ${phone}`
  );

  console.log(
    `      🚚 Carrier: ${TRACKING_CARRIER}`
  );

  console.log(
    `      🔗 ${trackingUrl}`
  );

  return result.fulfillment;
}

// ============================================================
// UPDATE EXISTING TRACKING
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

  const variables = {

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
  };

  const data =
    await shopifyGraphQL(
      mutation,
      variables
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
    "      ✅ Existing tracking updated"
  );

  console.log(
    `      🔗 ${trackingUrl}`
  );

  return result?.fulfillment;
}

// ============================================================
// UPDATE EXISTING FULFILLMENTS
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
        `      ⚠️ Tracking update failed: ${error.message}`
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
  consignmentId,
  phone
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

  let status =
    String(
      fulfillmentOrder.status ||
      ""
    ).toUpperCase();

  console.log(
    `      📍 Status: ${status}`
  );

  // ========================================================
  // CLOSED
  // ========================================================

  if (
    status === "CLOSED"
  ) {

    console.log(
      "      ✅ Already fulfilled"
    );

    await updateExistingFulfillments(
      fulfillmentOrder,
      consignmentId,
      phone
    );

    return {
      fulfilled: false,
      alreadyFulfilled: true
    };
  }

  // ========================================================
  // CANCELLED
  // ========================================================

  if (
    status === "CANCELLED"
  ) {

    console.log(
      "      ⏭ Cancelled"
    );

    return {
      fulfilled: false,
      cancelled: true
    };
  }

  // ========================================================
  // ON_HOLD
  // ========================================================

  if (
    status === "ON_HOLD"
  ) {

    console.log(
      "      ⚠️ ON_HOLD"
    );

    await releaseFulfillmentHold(
      fulfillmentOrder
    );

    await sleep(500);

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
      `      🔄 After hold release: ${status}`
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
  // CREATE FULFILLMENT
  // ========================================================

  if (
    status === "OPEN" ||
    status === "IN_PROGRESS" ||
    status === "SCHEDULED"
  ) {

    await createFulfillment(
      fulfillmentOrder.id,
      consignmentId,
      phone
    );

    return {
      fulfilled: true,
      alreadyFulfilled: false
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

  // ========================================================
  // GET PHONE FROM SHOPIFY USING EXACT ORDER ID
  // ========================================================

  const phone =
    await getShopifyOrderPhone(
      shopifyOrder.id
    );

  const trackingUrl =
    buildTrackingUrl(
      consignmentId,
      phone
    );

  console.log(
    `   📱 Shopify phone: ${phone}`
  );

  console.log(
    `   🔗 Tracking URL: ${trackingUrl}`
  );

  let fulfilledCount = 0;
  let alreadyCount = 0;

  for (
    const fulfillmentOrder
    of shopifyOrder.fulfillmentOrders
  ) {

    console.log(
      `   📦 Fulfillment Order: ${fulfillmentOrder.id}`
    );

    const result =
      await processFulfillmentOrder(
        fulfillmentOrder.id,
        merchantOrderId,
        consignmentId,
        phone
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
    String(signature)
      .trim() ===
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
    // VERIFY PATHAO ORDER
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
    // SHOPIFY
    // ======================================================

    console.log(
      "🔎 Finding exact Shopify fulfillment order..."
    );

    const result =
      await fulfillExactShopifyOrder(
        merchantOrderId,
        consignmentId
      );

    if (
      result.fulfilledCount > 0
    ) {

      stats.fulfilled +=
        result.fulfilledCount;

      console.log(
        "✅ SHOPIFY FULFILLED"
      );
    }

    if (
      result.alreadyCount > 0
    ) {

      stats.already_fulfilled +=
        result.alreadyCount;

      console.log(
        "✅ Already fulfilled — tracking updated"
      );
    }

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
      `🔗 ${result.trackingUrl}`
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

      success: true,

      service:
        "Pathao → Shopify Auto Fulfillment",

      tracking: {

        number:
          "Pathao consignment_id",

        phone:
          "Shopify order/customer phone",

        carrier:
          TRACKING_CARRIER,

        url_format:
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
      success: true,
      status: "healthy",
      timestamp:
        new Date().toISOString()
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
          success: true,
          message: "Verified"
        });
    }

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

    res
      .status(202)
      .json({
        success: true,
        received: true
      });

    processWebhook(
      body
    ).catch(error => {

      console.error(
        "❌ Webhook processing error:",
        error.message
      );

      stats.errors += 1;
    });
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
        error: "Not found"
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
      `🚚 Carrier: ${TRACKING_CARRIER}`
    );

    console.log(
      "📱 Phone source: Shopify order"
    );

    console.log(
      "🔗 Tracking URL:"
    );

    console.log(
      "https://merchant.pathao.com/tracking?consignment_id=...&phone=..."
    );

    console.log(
      "========================================"
    );

    console.log(
      "✅ Ready!"
    );
  }
);
