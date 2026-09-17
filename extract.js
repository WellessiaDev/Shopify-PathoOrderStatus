const express = require('express');

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP =
  process.env.SHOP || 'wellessia';

const CLIENT_ID =
  process.env.CLIENT_ID;

const CLIENT_SECRET =
  process.env.CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || '2026-07';


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


const PORT =
  Number(process.env.PORT || 3000);


// Every 1 minute
const POLL_INTERVAL_MS =
  Number(
    process.env.POLL_INTERVAL_MS ||
    60000
  );


// Check orders from last 30 days
const POLL_LOOKBACK_DAYS =
  Number(
    process.env.POLL_LOOKBACK_DAYS ||
    30
  );


// Shopify tracking company should be Pathao
const PATHAO_TRACKING_COMPANY =
  String(
    process.env.PATHAO_TRACKING_COMPANY ||
    'Pathao'
  ).toLowerCase();


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

if (
  !CLIENT_ID ||
  !CLIENT_SECRET
) {

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


// ============================================================
// TOKEN CACHE
// ============================================================

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;


// ============================================================
// AUTO SYNC STATE
// ============================================================

let autoSyncRunning = false;

let lastAutoSync = {

  started_at: null,

  finished_at: null,

  checked: 0,

  updated: 0,

  skipped: 0,

  errors: 0
};


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


  const response =
    await fetch(

      `https://${SHOP}.myshopify.com/admin/oauth/access_token`,

      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body:
          new URLSearchParams({

            grant_type:
              'client_credentials',

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

      `Shopify token error ${response.status}: ${
        data.error_description ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }


  SHOPIFY_TOKEN =
    data.access_token;


  SHOPIFY_EXPIRES_AT =
    Date.now() +
    Number(
      data.expires_in ||
      86400
    ) * 1000;


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


  const response =
    await fetch(

      `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`,

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


  if (
    !response.ok ||
    !data.access_token
  ) {

    throw new Error(

      `Pathao token error ${response.status}: ${
        data.message ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }


  PATHAO_TOKEN =
    data.access_token;


  PATHAO_EXPIRES_AT =
    Date.now() +
    Number(
      data.expires_in ||
      3600
    ) * 1000;


  console.log(
    '✅ Pathao access token obtained'
  );


  return PATHAO_TOKEN;
}


// ============================================================
// SHOPIFY GRAPHQL REQUEST
// ============================================================

async function shopifyGraphQL(
  query,
  variables = {}
) {

  const token =
    await getShopifyToken();


  const response =
    await fetch(

      `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,

      {

        method:
          'POST',

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
      }
    );


  const text =
    await response.text();


  let payload;


  try {

    payload =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    payload = {
      raw: text
    };
  }


  if (!response.ok) {

    const error =
      new Error(

        `Shopify API HTTP ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      payload;


    throw error;
  }


  if (
    payload.errors?.length
  ) {

    const error =
      new Error(

        payload.errors
          .map(
            item =>
              item.message
          )
          .join('; ')
      );


    error.status =
      400;


    error.data =
      payload.errors;


    throw error;
  }


  return payload.data;
}


// ============================================================
// GET PATHAO ORDER
// ============================================================

async function getPathaoOrder(
  consignmentId
) {

  const token =
    await getPathaoToken();


  const response =
    await fetch(

      `${PATHAO_BASE_URL}/aladdin/api/v1/orders/${encodeURIComponent(
        consignmentId
      )}/info`,

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

        data.message ||
        data.error ||
        `Pathao order API error ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      data;


    throw error;
  }


  return data.data || data;
}


// ============================================================
// PATHAO STATUS -> SHOPIFY DELIVERY STATUS
// ============================================================

function mapPathaoStatus(
  orderStatus,
  orderStatusSlug = ''
) {

  const status =
    `${orderStatus || ''} ${orderStatusSlug || ''}`

      .trim()

      .toLowerCase()

      .replace(
        /[_-]+/g,
        ' '
      )

      .replace(
        /\s+/g,
        ' '
      );


  if (!status) {

    return null;
  }


  // ==========================================================
  // WAITING FOR PICKUP
  // ==========================================================

  if (

    status.includes(
      'waiting for pickup'
    ) ||

    status.includes(
      'assigned for pickup'
    ) ||

    status.includes(
      'pickup requested'
    ) ||

    status.includes(
      'order created'
    )

  ) {

    return 'CONFIRMED';
  }


  // ==========================================================
  // PICKED UP BY PATHAO
  // ==========================================================

  if (

    status.includes(
      'picked up'
    ) ||

    status.includes(
      'pickup done'
    ) ||

    status.includes(
      'picked'
    )

  ) {

    return 'CARRIER_PICKED_UP';
  }


  // ==========================================================
  // OUT FOR DELIVERY
  // ==========================================================

  if (

    status.includes(
      'out for delivery'
    ) ||

    status.includes(
      'assigned for delivery'
    )

  ) {

    return 'OUT_FOR_DELIVERY';
  }


  // ==========================================================
  // DELIVERED
  // ==========================================================

  if (

    status.includes(
      'successfully delivered'
    ) ||

    status ===
      'delivered delivered' ||

    status.startsWith(
      'delivered '
    )

  ) {

    return 'DELIVERED';
  }


  // ==========================================================
  // DELIVERY FAILED
  // ==========================================================

  if (

    status.includes(
      'delivery failed'
    ) ||

    status.includes(
      'attempted delivery'
    ) ||

    status.includes(
      'partial delivery'
    )

  ) {

    return 'ATTEMPTED_DELIVERY';
  }


  // ==========================================================
  // DELAYED / ON HOLD
  // ==========================================================

  if (

    status.includes(
      'on hold'
    ) ||

    status.includes(
      'delay'
    )

  ) {

    return 'DELAYED';
  }


  // ==========================================================
  // IN TRANSIT
  // ==========================================================

  if (

    status.includes(
      'in transit'
    ) ||

    status.includes(
      'sorting hub'
    ) ||

    status.includes(
      'last mile hub'
    ) ||

    status.includes(
      'transit'
    )

  ) {

    return 'IN_TRANSIT';
  }


  // ==========================================================
  // RETURN / CANCEL
  //
  // Shopify does not have an exact equivalent delivery event
  // for these statuses, so do not write an incorrect status.
  // ==========================================================

  if (

    status.includes(
      'return'
    ) ||

    status.includes(
      'cancelled'
    ) ||

    status.includes(
      'canceled'
    ) ||

    status.includes(
      'pickup failed'
    )

  ) {

    return null;
  }


  return null;
}


// ============================================================
// CREATE SHOPIFY FULFILLMENT EVENT
// ============================================================

async function createShopifyFulfillmentEvent(

  fulfillmentId,

  shopifyStatus,

  pathaoStatus,

  pathaoUpdatedAt = null

) {

  const mutation = `

    mutation CreateFulfillmentEvent(
      $event: FulfillmentEventInput!
    ) {

      fulfillmentEventCreate(
        fulfillmentEvent: $event
      ) {

        fulfillmentEvent {

          id
          status
          message
          happenedAt
        }

        userErrors {

          field
          message
        }
      }
    }

  `;


  const event = {

    fulfillmentId:

      fulfillmentId,


    status:

      shopifyStatus,


    // IMPORTANT:
    // Correct syntax.
    // No escaped backticks.

    message:

      `Pathao: ${pathaoStatus}`
  };


  // ==========================================================
  // PATHAO uses Bangladesh local time:
  // YYYY-MM-DD HH:mm:ss
  // Bangladesh = UTC+6
  // ==========================================================

  if (pathaoUpdatedAt) {

    const isoCandidate =

      String(
        pathaoUpdatedAt
      )
        .replace(
          ' ',
          'T'
        ) +

      '+06:00';


    const parsed =
      new Date(
        isoCandidate
      );


    if (
      !Number.isNaN(
        parsed.getTime()
      )
    ) {

      event.happenedAt =
        parsed.toISOString();
    }
  }


  const data =
    await shopifyGraphQL(

      mutation,

      {
        event
      }
    );


  const result =
    data
      .fulfillmentEventCreate;


  if (
    result.userErrors?.length
  ) {

    const error =
      new Error(

        result.userErrors

          .map(
            item =>
              item.message
          )

          .join('; ')
      );


    error.status =
      400;


    error.data =
      result.userErrors;


    throw error;
  }


  return result.fulfillmentEvent;
}


// ============================================================
// FIND SHOPIFY ORDER USING ORDER NAME
//
// Pathao:
// merchant_order_id = #WELL26287635
//
// Shopify:
// order.name = #WELL26287635
// ============================================================

async function findShopifyOrderByName(
  orderName
) {

  const query = `

    query FindOrder(
      $search: String!
    ) {

      orders(
        first: 5,
        query: $search
      ) {

        nodes {

          id
          name

          fulfillments(
            first: 20
          ) {

            id
            displayStatus

            trackingInfo(
              first: 10
            ) {

              company
              number
              url
            }

            events(
              first: 1,
              reverse: true,
              sortKey: HAPPENED_AT
            ) {

              nodes {

                id
                status
                happenedAt
              }
            }
          }
        }
      }
    }

  `;


  const safeName =

    String(orderName)

      .replace(
        /\\/g,
        '\\\\'
      )

      .replace(
        /"/g,
        '\\"'
      );


  const data =
    await shopifyGraphQL(

      query,

      {

        search:

          `name:"${safeName}"`
      }
    );


  return (

    data.orders.nodes.find(

      order =>
        order.name ===
        orderName

    ) || null

  );
}


// ============================================================
// FIND FULFILLMENT USING PATHAO CONSIGNMENT ID
// ============================================================

function findFulfillmentByConsignment(

  order,

  consignmentId

) {

  const fulfillments =

    order?.fulfillments ||
    [];


  const exact =

    fulfillments.find(

      fulfillment =>

        (
          fulfillment
            .trackingInfo ||
          []
        ).some(

          tracking =>

            String(
              tracking.number ||
              ''
            ) ===

            String(
              consignmentId
            )
        )
    );


  if (exact) {

    return exact;
  }


  // If only one fulfillment exists,
  // use it as fallback.

  if (
    fulfillments.length === 1
  ) {

    return fulfillments[0];
  }


  return null;
}


// ============================================================
// GET RECENT SHOPIFY PATHAO SHIPMENTS
//
// It looks for:
//
// Tracking company = Pathao
// Tracking number = Pathao consignment ID
//
// Example:
//
// company = Pathao
// number  = DW170926BS7Q42
// ============================================================

async function getPathaoTrackedFulfillments() {

  const since =

    new Date(

      Date.now() -

      POLL_LOOKBACK_DAYS *

      24 *
      60 *
      60 *
      1000

    ).toISOString();


  const query = `

    query RecentOrders(

      $first: Int!,

      $after: String,

      $search: String!

    ) {

      orders(

        first: $first,

        after: $after,

        query: $search,

        sortKey: UPDATED_AT

      ) {

        nodes {

          id
          name
          updatedAt

          fulfillments(
            first: 20
          ) {

            id
            displayStatus

            trackingInfo(
              first: 10
            ) {

              company
              number
              url
            }

            events(

              first: 1,

              reverse: true,

              sortKey: HAPPENED_AT

            ) {

              nodes {

                id
                status
                happenedAt
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


  const results =
    [];


  const seen =
    new Set();


  let after =
    null;


  let hasNextPage =
    true;


  while (hasNextPage) {

    const data =
      await shopifyGraphQL(

        query,

        {

          first:
            100,

          after,

          search:

            `updated_at:>='${since}'`
        }
      );


    for (
      const order
      of data.orders.nodes ||
      []
    ) {

      for (
        const fulfillment
        of order.fulfillments ||
        []
      ) {

        for (
          const tracking
          of fulfillment.trackingInfo ||
          []
        ) {

          const company =

            String(
              tracking.company ||
              ''
            )
              .toLowerCase();


          const consignmentId =

            String(
              tracking.number ||
              ''
            )
              .trim();


          if (!consignmentId) {

            continue;
          }


          // Only Pathao tracking

          if (

            !company.includes(
              PATHAO_TRACKING_COMPANY
            )

          ) {

            continue;
          }


          const key =

            `${fulfillment.id}:${consignmentId}`;


          if (
            seen.has(key)
          ) {

            continue;
          }


          seen.add(key);


          results.push({

            shopify_order_id:
              order.id,

            shopify_order_name:
              order.name,

            fulfillment_id:
              fulfillment.id,

            consignment_id:
              consignmentId,

            current_shopify_status:

              fulfillment
                .events
                ?.nodes
                ?.[0]
                ?.status ||

              null
          });
        }
      }
    }


    hasNextPage =

      Boolean(
        data.orders
          .pageInfo
          .hasNextPage
      );


    after =

      data.orders
        .pageInfo
        .endCursor;
  }


  return results;
}


// ============================================================
// SYNC ONE CONSIGNMENT
// ============================================================

async function syncOneConsignment({

  consignmentId,

  shopifyOrderName = null,

  fulfillmentId = null,

  currentShopifyStatus = null

}) {

  // ==========================================================
  // 1. GET PATHAO ORDER
  // ==========================================================

  const pathaoOrder =
    await getPathaoOrder(
      consignmentId
    );


  const merchantOrderId =

    pathaoOrder
      .merchant_order_id;


  const pathaoStatus =

    pathaoOrder
      .order_status;


  const pathaoStatusSlug =

    pathaoOrder
      .order_status_slug ||

    '';


  // ==========================================================
  // VALIDATE PATHAO DATA
  // ==========================================================

  if (!merchantOrderId) {

    return {

      success:
        false,

      updated:
        false,

      skipped:
        true,

      reason:
        'Pathao merchant_order_id is missing',

      consignment_id:
        consignmentId
    };
  }


  if (!pathaoStatus) {

    return {

      success:
        false,

      updated:
        false,

      skipped:
        true,

      reason:
        'Pathao order_status is missing',

      consignment_id:
        consignmentId,

      merchant_order_id:
        merchantOrderId
    };
  }


  // ==========================================================
  // VERIFY:
  //
  // PATHAO merchant_order_id
  // =
  // SHOPIFY order.name
  // ==========================================================

  if (

    shopifyOrderName &&

    merchantOrderId !==
    shopifyOrderName

  ) {

    return {

      success:
        false,

      updated:
        false,

      skipped:
        true,

      reason:
        'Pathao merchant_order_id does not match Shopify order name',

      consignment_id:
        consignmentId,

      merchant_order_id:
        merchantOrderId,

      shopify_order_name:
        shopifyOrderName
    };
  }


  let resolvedOrderName =
    shopifyOrderName;


  let resolvedFulfillmentId =
    fulfillmentId;


  let resolvedCurrentStatus =
    currentShopifyStatus;


  // ==========================================================
  // MANUAL SYNC
  //
  // If fulfillment info was not supplied,
  // find Shopify using merchant_order_id.
  // ==========================================================

  if (!resolvedFulfillmentId) {

    const order =
      await findShopifyOrderByName(
        merchantOrderId
      );


    if (!order) {

      const error =
        new Error(

          `Shopify order ${merchantOrderId} was not found`
        );


      error.status =
        404;


      throw error;
    }


    resolvedOrderName =
      order.name;


    const fulfillment =
      findFulfillmentByConsignment(

        order,

        consignmentId
      );


    if (!fulfillment) {

      const error =
        new Error(

          `No Shopify fulfillment found for ${merchantOrderId}. ` +

          'The Shopify fulfillment must exist before its delivery status can be updated.'
        );


      error.status =
        404;


      throw error;
    }


    resolvedFulfillmentId =
      fulfillment.id;


    resolvedCurrentStatus =

      fulfillment
        .events
        ?.nodes
        ?.[0]
        ?.status ||

      null;
  }


  // ==========================================================
  // CONVERT PATHAO STATUS
  // ==========================================================

  const shopifyStatus =
    mapPathaoStatus(

      pathaoStatus,

      pathaoStatusSlug
    );


  if (!shopifyStatus) {

    return {

      success:
        true,

      updated:
        false,

      skipped:
        true,

      reason:
        'This Pathao status is not mapped to a Shopify delivery event',

      consignment_id:
        consignmentId,

      merchant_order_id:
        merchantOrderId,

      shopify_order_name:
        resolvedOrderName,

      pathao_order_status:
        pathaoStatus,

      pathao_order_status_slug:
        pathaoStatusSlug
    };
  }


  // ==========================================================
  // ALREADY SAME STATUS
  //
  // Do not create duplicate Shopify events.
  // ==========================================================

  if (

    resolvedCurrentStatus ===
    shopifyStatus

  ) {

    return {

      success:
        true,

      updated:
        false,

      skipped:
        true,

      reason:
        'Shopify already has this delivery status',

      consignment_id:
        consignmentId,

      merchant_order_id:
        merchantOrderId,

      shopify_order_name:
        resolvedOrderName,

      pathao_order_status:
        pathaoStatus,

      shopify_delivery_status:
        shopifyStatus
    };
  }


  // ==========================================================
  // UPDATE SHOPIFY
  // ==========================================================

  const event =
    await createShopifyFulfillmentEvent(

      resolvedFulfillmentId,

      shopifyStatus,

      pathaoStatus,

      pathaoOrder.updated_at ||
      null
    );


  return {

    success:
      true,

    updated:
      true,

    consignment_id:
      consignmentId,

    merchant_order_id:
      merchantOrderId,

    shopify_order_name:
      resolvedOrderName,

    pathao_order_status:
      pathaoStatus,

    pathao_order_status_slug:
      pathaoStatusSlug,

    previous_shopify_status:
      resolvedCurrentStatus,

    shopify_delivery_status:
      event.status,

    fulfillment_id:
      resolvedFulfillmentId,

    event_id:
      event.id
  };
}


// ============================================================
// RUN AUTOMATIC SYNC
// ============================================================

async function runAutomaticStatusSync() {

  // Prevent 2 sync jobs running together

  if (autoSyncRunning) {

    console.log(
      '⏭ Auto-sync already running'
    );


    return lastAutoSync;
  }


  autoSyncRunning =
    true;


  const stats = {

    started_at:
      new Date()
        .toISOString(),

    finished_at:
      null,

    checked:
      0,

    updated:
      0,

    skipped:
      0,

    errors:
      0
  };


  try {

    console.log(
      '============================================'
    );

    console.log(
      '🔄 PATHAO AUTO STATUS CHECK'
    );

    console.log(
      `🕒 ${stats.started_at}`
    );


    // ========================================================
    // GET SHOPIFY PATHAO SHIPMENTS
    // ========================================================

    const shipments =
      await getPathaoTrackedFulfillments();


    console.log(

      `📦 Pathao-tracked shipments found: ${shipments.length}`
    );


    // ========================================================
    // CHECK EACH PATHAO CONSIGNMENT
    // ========================================================

    for (
      const shipment
      of shipments
    ) {

      stats.checked +=
        1;


      try {

        const result =
          await syncOneConsignment({

            consignmentId:
              shipment
                .consignment_id,

            shopifyOrderName:
              shipment
                .shopify_order_name,

            fulfillmentId:
              shipment
                .fulfillment_id,

            currentShopifyStatus:
              shipment
                .current_shopify_status
          });


        if (
          result.updated
        ) {

          stats.updated +=
            1;


          console.log(

            `✅ ${shipment.shopify_order_name}: ` +

            `${result.pathao_order_status} -> ` +

            `${result.shopify_delivery_status}`
          );

        } else {

          stats.skipped +=
            1;


          console.log(

            `✓ ${shipment.shopify_order_name}: ` +

            `${result.reason}`
          );
        }


      } catch (error) {

        stats.errors +=
          1;


        console.error(

          `❌ ${shipment.shopify_order_name} / ` +

          `${shipment.consignment_id}:`,

          error.data ||
          error.message
        );
      }
    }


  } catch (error) {

    stats.errors +=
      1;


    console.error(

      '❌ Auto-sync cycle failed:',

      error.data ||
      error.message
    );


  } finally {

    stats.finished_at =

      new Date()
        .toISOString();


    lastAutoSync =
      stats;


    autoSyncRunning =
      false;


    console.log(
      '--------------------------------------------'
    );


    console.log(
      `Checked: ${stats.checked}`
    );


    console.log(
      `Updated: ${stats.updated}`
    );


    console.log(
      `Skipped: ${stats.skipped}`
    );


    console.log(
      `Errors: ${stats.errors}`
    );


    console.log(
      '============================================'
    );
  }


  return stats;
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
        'Pathao -> Shopify Delivery Status Sync',

      auto_sync:
        true,

      interval_seconds:

        Math.round(
          POLL_INTERVAL_MS /
          1000
        ),

      lookback_days:
        POLL_LOOKBACK_DAYS,

      endpoints: {

        health:
          'GET /health',

        pathao_auth:
          'GET /api/test/pathao',

        pathao_order:
          'GET /api/pathao/order/:consignment_id',

        manual_sync:
          'POST /api/sync/:consignment_id',

        auto_sync_status:
          'GET /api/auto-sync/status',

        auto_sync_run:
          'POST /api/auto-sync/run'
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
        new Date()
          .toISOString()
    });
  }
);


// ============================================================
// TEST PATHAO AUTH
// ============================================================

app.get(
  '/api/test/pathao',

  async (req, res) => {

    try {

      const token =
        await getPathaoToken();


      res.json({

        success:
          true,

        message:
          'Pathao API authentication working',

        environment:

          PATHAO_BASE_URL.includes(
            'sandbox'
          )

            ? 'sandbox'

            : 'production',

        access_token_received:
          Boolean(token)
      });


    } catch (error) {

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
// TEST SHOPIFY ORDERS ACCESS
// ============================================================

app.get('/api/test/shopify-orders', async (req, res) => {
  try {

    const query = `
      query {
        orders(first: 1) {
          nodes {
            id
            name
          }
        }
      }
    `;

    const data =
      await shopifyGraphQL(query);

    return res.json({
      success: true,
      data
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.data || null
    });
  }
});
// ============================================================
// CHECK PATHAO CONSIGNMENT
// ============================================================

app.get(
  '/api/pathao/order/:consignment_id',

  async (req, res) => {

    try {

      const order =
        await getPathaoOrder(

          req.params
            .consignment_id
        );


      res.json({

        success:
          true,

        consignment_id:

          order.consignment_id ||

          req.params
            .consignment_id,

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

        data:
          order
      });


    } catch (error) {

      res
        .status(
          error.status ||
          500
        )
        .json({

          success:
            false,

          consignment_id:

            req.params
              .consignment_id,

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
// MANUAL SYNC ONE CONSIGNMENT
//
// POST /api/sync/DW170926BS7Q42
// ============================================================

app.post(
  '/api/sync/:consignment_id',

  async (req, res) => {

    try {

      const result =
        await syncOneConsignment({

          consignmentId:

            req.params
              .consignment_id
        });


      res.json(
        result
      );


    } catch (error) {

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
// AUTO SYNC STATUS
// ============================================================

app.get(
  '/api/auto-sync/status',

  (req, res) => {

    res.json({

      success:
        true,

      running:
        autoSyncRunning,

      interval_seconds:

        Math.round(
          POLL_INTERVAL_MS /
          1000
        ),

      lookback_days:
        POLL_LOOKBACK_DAYS,

      tracking_company:
        PATHAO_TRACKING_COMPANY,

      last_run:
        lastAutoSync
    });
  }
);


// ============================================================
// MANUALLY RUN COMPLETE AUTO SYNC
//
// POST /api/auto-sync/run
// ============================================================

app.post(
  '/api/auto-sync/run',

  async (req, res) => {

    if (autoSyncRunning) {

      return res
        .status(409)
        .json({

          success:
            false,

          message:
            'Auto-sync is already running'
        });
    }


    const result =
      await runAutomaticStatusSync();


    return res.json({

      success:
        true,

      result
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

        success:
          false,

        error:
          'Endpoint not found',

        path:
          req.path
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
      '🚀 PATHAO -> SHOPIFY STATUS SYNC'
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
      `🚚 Pathao: ${PATHAO_BASE_URL}`
    );


    console.log(

      `🔄 Poll interval: ${
        POLL_INTERVAL_MS /
        1000
      } seconds`
    );


    console.log(

      `📅 Lookback: ${
        POLL_LOOKBACK_DAYS
      } days`
    );


    console.log(
      '============================================'
    );


    // ========================================================
    // FIRST CHECK
    // 5 seconds after Railway starts
    // ========================================================

    setTimeout(

      () => {

        runAutomaticStatusSync()

          .catch(

            error =>

              console.error(

                'Initial auto-sync error:',

                error
              )
          );
      },

      5000
    );


    // ========================================================
    // CHECK EVERY 60 SECONDS
    // ========================================================

    setInterval(

      () => {

        runAutomaticStatusSync()

          .catch(

            error =>

              console.error(

                'Auto-sync error:',

                error
              )
          );
      },

      POLL_INTERVAL_MS
    );
  }
);
