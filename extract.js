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
// GET PATHAO ORDER
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
// EXACT SHOPIFY ORDER LOOKUP
// FIXED: fulfillments is direct list, NOT nodes
// ============================================================

async function getExactShopifyOrder(
  merchantOrderId
) {

  const expected =
    normalizeOrderName(
      merchantOrderId
    );

  const query = `
    query FindOrder(
      $search: String!
    ) {
      orders(
        first: 20,
        query: $search
      ) {
        nodes {
          id
          name
          createdAt
          displayFulfillmentStatus

          consignment: metafield(
            namespace: "pathao",
            key: "consignment_id"
          ) {
            value
          }

          fulfillments(first: 20) {
            id
            status

            trackingInfo {
              company
              number
              url
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

  let orders =
    data?.orders?.nodes || [];

  let exact =
    orders.find(
      order =>
        normalizeOrderName(
          order.name
        ) === expected
    );

  // fallback without #
  if (!exact) {

    const clean =
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
            `name:${clean}`
        }
      );

    orders =
      data?.orders?.nodes || [];

    exact =
      orders.find(
        order =>
          normalizeOrderName(
            order.name
          ) === expected
      );
  }

  if (!exact) {
    return null;
  }

  if (
    normalizeOrderName(
      exact.name
    ) !== expected
  ) {
    throw new Error(
      `ORDER MISMATCH BLOCKED: Pathao=${merchantOrderId}, Shopify=${exact.name}`
    );
  }

  return exact;
}

// ============================================================
// SAVE TRACKING INFO ON ORDER METAFIELDS
// ============================================================

async function savePathaoTrackingOnOrder(
  orderId,
  consignmentId
) {

  const mutation = `
    mutation UpdateOrder(
      $input: OrderInput!
    ) {
      orderUpdate(
        input: $input
      ) {
        order {
          id
          name
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {

    input: {

      id:
        orderId,

      metafields: [

        {
          namespace:
            "pathao",

          key:
            "consignment_id",

          type:
            "single_line_text_field",

          value:
            String(
              consignmentId
            )
        },

        {
          namespace:
            "pathao",

          key:
            "tracking_url",

          type:
            "url",

          value:
            TRACKING_URL
        },

        {
          namespace:
            "pathao",

          key:
            "carrier",

          type:
            "single_line_text_field",

          value:
            TRACKING_CARRIER
        }
      ]
    }
  };

  const data =
    await shopifyGraphQL(
      mutation,
      variables
    );

  const result =
    data?.orderUpdate;

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
    "   ✅ Pathao tracking saved on Shopify order"
  );

  return true;
}

// ============================================================
// GET FULFILLMENT ORDER
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
// RELEASE HOLD
// ============================================================

async function releaseFulfillmentHold(
  fulfillmentOrder
) {

  const holdIds =
    (
      fulfillmentOrder
        ?.fulfillmentHolds ||
      []
    )
      .map(hold =>
        hold.id
      )
      .filter(Boolean);

  if (
    holdIds.length === 0
  ) {
    throw new Error(
      "Fulfillment is ON_HOLD but no hold IDs were found."
    );
  }

  console.log(
    `      🔓 Releasing ${holdIds.length} hold(s)`
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

  return true;
}

// ============================================================
// CREATE FULFILLMENT + TRACKING
// ============================================================

async function createFulfillmentWithTracking(
  fulfillmentOrderId,
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

      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId:
            fulfillmentOrderId
        }
      ],

      trackingInfo: {

        company:
          TRACKING_CARRIER,

        number:
          String(
            consignmentId
          ),

        url:
          TRACKING_URL
      }
    }
  };

  const data =
    await shopifyGraphQL(
      mutation,
      variables
    );

  const result =
    data?.fulfillmentCreate;

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
    !result
      ?.fulfillment
  ) {
    throw new Error(
      "Shopify fulfillment was not created."
    );
  }

  console.log(
    "      ✅ Fulfillment created"
  );

  console.log(
    `      🔢 Tracking: ${consignmentId}`
  );

  console.log(
    `      🚚 Carrier: ${TRACKING_CARRIER}`
  );

  console.log(
    `      🔗 ${TRACKING_URL}`
  );

  return result.fulfillment;
}

// ============================================================
// UPDATE EXISTING FULFILLMENT TRACKING
// ============================================================

async function updateFulfillmentTracking(
  fulfillmentId,
  consignmentId
) {

  const mutation = `
    mutation UpdateTracking(
      $fulfillmentId: ID!,
      $trackingInfoInput: FulfillmentTrackingInput!
    ) {

      fulfillmentTrackingInfoUpdate(
        fulfillmentId: $fulfillmentId,
        trackingInfoInput: $trackingInfoInput,
        notifyCustomer: false
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

        trackingInfoInput: {

          company:
            TRACKING_CARRIER,

          number:
            String(
              consignmentId
            ),

          url:
            TRACKING_URL
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

  stats.tracking_updates +=
    1;

  console.log(
    "      ✅ Existing tracking updated"
  );

  return result
    ?.fulfillment;
}

// ============================================================
// UPDATE TRACKING ON ALL EXISTING FULFILLMENTS
// FIXED: order.fulfillments is direct array
// ============================================================

async function updateExistingTracking(
  order,
  consignmentId
) {

  const fulfillments =
    order?.fulfillments || [];

  let updated = 0;

  for (
    const fulfillment
    of fulfillments
  ) {

    try {

      await updateFulfillmentTracking(
        fulfillment.id,
        consignmentId
      );

      updated++;

    } catch (error) {

      console.log(
        `      ⚠️ Tracking update failed: ${error.message}`
      );
    }

    await sleep(200);
  }

  return updated;
}

// ============================================================
// FULFILL SHOPIFY ORDER
// ============================================================

async function fulfillShopifyOrder(
  order,
  consignmentId
) {

  // Always save tracking
  await savePathaoTrackingOnOrder(
    order.id,
    consignmentId
  );

  // ========================================================
  // ALREADY FULFILLED
  // ========================================================

  if (
    String(
      order
        .displayFulfillmentStatus ||
      ""
    ).toUpperCase() ===
    "FULFILLED"
  ) {

    console.log(
      "   ✅ Shopify already fulfilled"
    );

    await updateExistingTracking(
      order,
      consignmentId
    );

    return {
      changed: 0,
      alreadyFulfilled: true
    };
  }

  // ========================================================
  // FULFILLMENT ORDERS
  // ========================================================

  const fulfillmentOrders =
    order
      ?.fulfillmentOrders
      ?.nodes || [];

  if (
    fulfillmentOrders.length === 0
  ) {
    throw new Error(
      `No fulfillment orders found for ${order.name}`
    );
  }

  let changed = 0;

  for (
    let fulfillmentOrder
    of fulfillmentOrders
  ) {

    console.log(
      `   📦 Fulfillment Order: ${fulfillmentOrder.id}`
    );

    let fresh =
      await getFulfillmentOrder(
        fulfillmentOrder.id
      );

    if (!fresh) {
      continue;
    }

    let status =
      String(
        fresh.status || ""
      ).toUpperCase();

    console.log(
      `      Status: ${status}`
    );

    // ======================================================
    // CLOSED
    // ======================================================

    if (
      status === "CLOSED"
    ) {

      console.log(
        "      ✅ Already closed"
      );

      continue;
    }

    // ======================================================
    // CANCELLED
    // ======================================================

    if (
      status === "CANCELLED"
    ) {

      console.log(
        "      ⏭ Cancelled"
      );

      continue;
    }

    // ======================================================
    // ON HOLD
    // ======================================================

    if (
      status === "ON_HOLD"
    ) {

      console.log(
        "      ⚠️ ON_HOLD"
      );

      await releaseFulfillmentHold(
        fresh
      );

      await sleep(500);

      fresh =
        await getFulfillmentOrder(
          fulfillmentOrder.id
        );

      status =
        String(
          fresh?.status || ""
        ).toUpperCase();

      console.log(
        `      🔄 Status after hold release: ${status}`
      );

      if (
        status === "ON_HOLD"
      ) {
        throw new Error(
          "Fulfillment still ON_HOLD after release."
        );
      }
    }

    // ======================================================
    // CREATE FULFILLMENT
    // ======================================================

    if (
      status === "OPEN" ||
      status === "IN_PROGRESS" ||
      status === "SCHEDULED"
    ) {

      await createFulfillmentWithTracking(
        fulfillmentOrder.id,
        consignmentId
      );

      changed++;

      continue;
    }

    console.log(
      `      ⚠️ Unsupported status: ${status}`
    );
  }

  return {
    changed,
    alreadyFulfilled: false
  };
}

// ============================================================
// VERIFY WEBHOOK
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
//
// RULE:
// IF PATHAO ORDER EXISTS -> FULFILL SHOPIFY
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
    // 1. CHECK PATHAO
    // ======================================================

    console.log(
      "🔎 Verifying Pathao order..."
    );

    const pathaoOrder =
      await getPathaoOrderStatus(
        consignmentId
      );

    if (!pathaoOrder) {

      throw new Error(
        `Pathao order does not exist: ${consignmentId}`
      );
    }

    console.log(
      "✅ Pathao order exists"
    );

    // ======================================================
    // 2. EXACT SHOPIFY ORDER
    // ======================================================

    const order =
      await getExactShopifyOrder(
        merchantOrderId
      );

    if (!order) {

      throw new Error(
        `Exact Shopify order not found: ${merchantOrderId}`
      );
    }

    if (
      normalizeOrderName(
        order.name
      ) !==
      normalizeOrderName(
        merchantOrderId
      )
    ) {

      throw new Error(
        `ORDER MISMATCH BLOCKED: ${merchantOrderId} != ${order.name}`
      );
    }

    console.log(
      `✅ Exact Shopify order: ${order.name}`
    );

    // ======================================================
    // 3. FULFILL
    // ======================================================

    console.log(
      "➡️ Fulfilling Shopify..."
    );

    const result =
      await fulfillShopifyOrder(
        order,
        consignmentId
      );

    if (
      result.changed > 0
    ) {

      stats.updates_sent +=
        result.changed;

      console.log(
        "✅ SHOPIFY FULFILLED"
      );

    } else if (
      result.alreadyFulfilled
    ) {

      console.log(
        "✅ Already fulfilled — tracking synchronized"
      );
    }

    console.log(
      `🔢 Tracking number: ${consignmentId}`
    );

    console.log(
      `🚚 Carrier: ${TRACKING_CARRIER}`
    );

    console.log(
      `🔗 Tracking URL: ${TRACKING_URL}`
    );

    stats.webhooks_processed +=
      1;

    return true;

  } catch (error) {

    console.error(
      `❌ Error: ${error.message}`
    );

    stats.errors +=
      1;

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

      rule:
        "If Pathao order exists → Shopify Fulfilled",

      tracking: {

        tracking_number:
          "Pathao consignment_id",

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

    // verification handshake
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

    // signature
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

    // respond immediately
    res
      .status(202)
      .json({

        success: true,

        received: true
      });

    // process
    processWebhook(
      body
    )
      .catch(
        error => {

          console.error(
            "❌ Webhook processing error:",
            error.message
          );

          stats.errors +=
            1;
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
      "🚀 PATHAO → SHOPIFY AUTO FULFILLMENT"
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

    console.log("");

    console.log(
      "🔄 RULE:"
    );

    console.log(
      "1. Pathao webhook received"
    );

    console.log(
      "2. Verify Pathao consignment exists"
    );

    console.log(
      "3. Find EXACT Shopify order"
    );

    console.log(
      "4. Release ON_HOLD if needed"
    );

    console.log(
      "5. Fulfill Shopify"
    );

    console.log(
      "6. Tracking number = Pathao consignment"
    );

    console.log(
      `7. Carrier = ${TRACKING_CARRIER}`
    );

    console.log(
      `8. URL = ${TRACKING_URL}`
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
