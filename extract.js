const express = require('express');
const crypto = require('crypto');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP =
  process.env.SHOP || 'wellessia';

const CLIENT_ID =
  process.env.CLIENT_ID;

const CLIENT_SECRET =
  process.env.CLIENT_SECRET;

const SHOPIFY_WEBHOOK_SECRET =
  process.env.SHOPIFY_WEBHOOK_SECRET ||
  CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  '2026-07';

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID =
  process.env.PATHAO_CLIENT_ID;

const PATHAO_CLIENT_SECRET =
  process.env.PATHAO_CLIENT_SECRET;

const PATHAO_USERNAME =
  process.env.PATHAO_USERNAME;

const PATHAO_PASSWORD =
  process.env.PATHAO_PASSWORD;

const MERCHANT_STORE_ID =
  Number(process.env.MERCHANT_STORE_ID) || 1;

const PORT =
  process.env.PORT || 3000;


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '❌ Missing CLIENT_ID or CLIENT_SECRET'
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

  process.exit(1);
}

if (!SHOPIFY_WEBHOOK_SECRET) {
  console.error(
    '❌ Missing SHOPIFY_WEBHOOK_SECRET'
  );

  process.exit(1);
}


// ============================================================
// DEPLOYMENT CUTOFF
// ============================================================
//
// Any Shopify order whose created_at is BEFORE this timestamp
// will be ignored by the webhook handler.
//
// ============================================================

const SERVER_STARTED_AT = new Date();

console.log(
  `🕒 Server started at: ${SERVER_STARTED_AT.toISOString()}`
);

console.log(
  '   Orders created before this time will be skipped by the webhook.'
);


// ============================================================
// TOKEN CACHE
// ============================================================

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;


// ============================================================
// DUPLICATE PROTECTION
// ============================================================

const submittedOrders = new Map();


// ============================================================
// EXPRESS JSON BODY
// ============================================================

app.use(
  express.json({
    limit: '1mb',

    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    }
  })
);


// ============================================================
// SHOPIFY WEBHOOK HMAC VERIFICATION
// ============================================================

function verifyShopifyWebhook(req) {

  try {

    const hmacHeader =
      req.get('X-Shopify-Hmac-Sha256');

    if (!hmacHeader) {

      console.error(
        '❌ Missing X-Shopify-Hmac-Sha256 header'
      );

      return false;
    }

    if (!req.rawBody) {

      console.error(
        '❌ Raw webhook body is missing'
      );

      return false;
    }

    const generatedHash =
      crypto
        .createHmac(
          'sha256',
          SHOPIFY_WEBHOOK_SECRET
        )
        .update(req.rawBody)
        .digest('base64');

    const receivedBuffer =
      Buffer.from(
        hmacHeader,
        'utf8'
      );

    const generatedBuffer =
      Buffer.from(
        generatedHash,
        'utf8'
      );

    if (
      receivedBuffer.length !==
      generatedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      receivedBuffer,
      generatedBuffer
    );

  } catch (error) {

    console.error(
      'Webhook HMAC verification error:',
      error.message
    );

    return false;
  }
}


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
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`;

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

  const data =
    await response.json();

  if (!response.ok) {

    console.error(
      '❌ Shopify token response:',
      JSON.stringify(
        data,
        null,
        2
      )
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

  SHOPIFY_TOKEN =
    data.access_token;

  SHOPIFY_EXPIRES_AT =
    Date.now() +
    (
      (data.expires_in || 86400) *
      1000
    );

  console.log(
    '✅ Shopify access token obtained'
  );

  return SHOPIFY_TOKEN;
}


// ============================================================
// PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {

  if (
    PATHAO_TOKEN &&
    Date.now() <
      PATHAO_EXPIRES_AT - 60000
  ) {
    return PATHAO_TOKEN;
  }

  console.log(
    '🔐 Requesting Pathao access token...'
  );

  const tokenUrl =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;

  const response =
    await fetch(
      tokenUrl,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
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
              'password'
          })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {

    console.error(
      '❌ Pathao token response:',
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
      'Pathao response did not contain access_token'
    );
  }

  PATHAO_TOKEN =
    data.access_token;

  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      (data.expires_in || 3600) *
      1000
    );

  console.log(
    '✅ Pathao access token obtained'
  );

  return PATHAO_TOKEN;
}


// ============================================================
// SHOPIFY API REQUEST
// ============================================================

async function shopifyRequest(
  endpoint,
  options = {}
) {

  const token =
    await getShopifyToken();

  const url =
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;

  const response =
    await fetch(
      url,
      {
        method:
          options.method || 'GET',

        headers: {

          'X-Shopify-Access-Token':
            token,

          'Content-Type':
            'application/json',

          ...(options.headers || {})
        },

        body:
          options.body
            ? JSON.stringify(
                options.body
              )
            : undefined
      }
    );

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
        `Shopify API ${response.status}`
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
// PATHAO API REQUEST
// ============================================================

async function pathaoRequest(
  endpoint,
  options = {}
) {

  const token =
    await getPathaoToken();

  const url =
    `${PATHAO_BASE_URL}${endpoint}`;

  const response =
    await fetch(
      url,
      {
        method:
          options.method || 'GET',

        headers: {

          'Authorization':
            `Bearer ${token}`,

          'Content-Type':
            'application/json',

          ...(options.headers || {})
        },

        body:
          options.body
            ? JSON.stringify(
                options.body
              )
            : undefined
      }
    );

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
        `Pathao API ${response.status}`
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
// ROOT
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'ok',

      service:
        'Shopify Pathao Bridge',

      shop:
        SHOP,

      shopify_api_version:
        SHOPIFY_API_VERSION,

      pathao_environment:
        PATHAO_BASE_URL.includes(
          'sandbox'
        )
          ? 'sandbox'
          : 'production',

      server_started_at:
        SERVER_STARTED_AT.toISOString(),

      webhook:
        '/webhooks/orders-create',

      pathao_order_status:
        '/api/pathao/order/:consignment_id'
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
        new Date().toISOString()
    });
  }
);





// ============================================================
// PATHAO - GET ORDER SHORT INFO
// ============================================================
//
// Pathao:
// GET /aladdin/api/v1/orders/{consignment_id}/info
//
// Uses existing:
// pathaoRequest()
//     ↓
// getPathaoToken()
//     ↓
// Authorization: Bearer token
//
// ============================================================

async function getPathaoOrderInfo(
  consignmentId
) {

  if (!consignmentId) {

    throw new Error(
      'consignment_id is required'
    );
  }

  console.log(
    '\n============================================'
  );

  console.log(
    '📦 GET PATHAO ORDER STATUS'
  );

  console.log(
    'Consignment ID:',
    consignmentId
  );

  console.log(
    '============================================'
  );

  const result =
    await pathaoRequest(
      `/aladdin/api/v1/orders/${encodeURIComponent(
        String(consignmentId)
      )}/info`,
      {
        method:
          'GET'
      }
    );

  const order =
    result.data ||
    result;

  console.log(
    '✅ PATHAO ORDER INFO'
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
// API - GET PATHAO ORDER STATUS
// ============================================================
//
// Example:
//
// GET
// /api/pathao/order/DW170926U7G8U6
//
// ============================================================

app.get(
  '/api/pathao/order/:consignment_id',
  async (req, res) => {

    try {

      const consignmentId =
        req.params.consignment_id;

      const order =
        await getPathaoOrderInfo(
          consignmentId
        );

      res.json({

        success:
          true,

        consignment_id:
          order.consignment_id ||
          consignmentId,

        merchant_order_id:
          order.merchant_order_id ||
          null,

        order_status:
          order.order_status ||
          null,

        order_status_slug:
          order.order_status_slug ||
          null,

        updated_at:
          order.updated_at ||
          null,

        invoice_id:
          order.invoice_id ||
          null,

        data:
          order
      });

    } catch (error) {

      console.error(
        '❌ Pathao order status error:',
        error.data ||
        error.message
      );

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data || null
      });
    }
  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

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

    res.status(500).json({

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
      '🚀 SHOPIFY → PATHAO BRIDGE'
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
        )
          ? 'SANDBOX'
          : 'PRODUCTION'
      }`
    );

    console.log(
      `🏬 Pathao Store ID: ${MERCHANT_STORE_ID}`
    );

    console.log(
      `🕒 Cutoff: orders before ${SERVER_STARTED_AT.toISOString()} will be skipped`
    );

    console.log(
      '🔔 Webhook: POST /webhooks/orders-create'
    );

    console.log(
      '📦 Pathao status: GET /api/pathao/order/:consignment_id'
    );

    console.log(
      '============================================'
    );
  }
);
