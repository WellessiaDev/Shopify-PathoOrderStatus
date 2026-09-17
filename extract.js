const express = require('express');

const app = express();
app.use(express.json());

const SHOP = process.env.SHOP || 'wellessia';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
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
  process.env.PORT || 3000;


// ============================================================
// CHECK ENV
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'Missing CLIENT_ID or CLIENT_SECRET'
  );
}

if (
  !PATHAO_CLIENT_ID ||
  !PATHAO_CLIENT_SECRET ||
  !PATHAO_USERNAME ||
  !PATHAO_PASSWORD
) {
  throw new Error(
    'Missing Pathao credentials'
  );
}


// ============================================================
// TOKEN CACHE
// ============================================================

let shopifyToken;
let shopifyExpiresAt = 0;

let pathaoToken;
let pathaoExpiresAt = 0;


// ============================================================
// SHOPIFY TOKEN
// ============================================================

async function getShopifyToken() {

  if (
    shopifyToken &&
    Date.now() <
      shopifyExpiresAt - 60000
  ) {
    return shopifyToken;
  }

  const response =
    await fetch(
      `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
      {
        method: 'POST',

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

  shopifyToken =
    data.access_token;

  shopifyExpiresAt =
    Date.now() +
    Number(
      data.expires_in || 86400
    ) * 1000;

  return shopifyToken;
}


// ============================================================
// PATHAO TOKEN
// ============================================================

async function getPathaoToken() {

  if (
    pathaoToken &&
    Date.now() <
      pathaoExpiresAt - 60000
  ) {
    return pathaoToken;
  }

  const response =
    await fetch(
      `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`,
      {
        method: 'POST',

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

  pathaoToken =
    data.access_token;

  pathaoExpiresAt =
    Date.now() +
    Number(
      data.expires_in || 3600
    ) * 1000;

  return pathaoToken;
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
        method: 'GET',

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const data =
    await response.json();

  if (!response.ok) {

    const error =
      new Error(
        data.message ||
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
// SHOPIFY GRAPHQL
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
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.errors?.length
  ) {

    const error =
      new Error(
        data.errors
          ?.map(
            x => x.message
          )
          .join('; ') ||

        `Shopify API ${response.status}`
      );

    error.status =
      response.status || 400;

    error.data =
      data.errors || data;

    throw error;
  }

  return data.data;
}


// ============================================================
// FIND SHOPIFY ORDER BY NAME
// Pathao merchant_order_id == Shopify order.name
// Example:
// #WELL26287635 == #WELL26287635
// ============================================================

async function findShopifyOrderByName(
  orderName
) {

  const query = `
    query FindOrder($search: String!) {

      orders(
        first: 1,
        query: $search
      ) {

        nodes {

          id
          name

          fulfillments(first: 10) {

            id
            status
            displayStatus

            trackingInfo(first: 10) {
              company
              number
            }

            events(last: 1) {

              nodes {
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

  const order =
    data.orders.nodes[0];

  if (
    order?.name !== orderName
  ) {
    return null;
  }

  return order;
}


// ============================================================
// CREATE SHOPIFY FULFILLMENT
// Only if Shopify order has no fulfillment yet
// ============================================================

async function createShopifyFulfillment(
  orderId,
  consignmentId
) {

  const query = `
    query GetFulfillmentOrders($id: ID!) {

      order(id: $id) {

        fulfillmentOrders(
          first: 10
        ) {

          nodes {
            id
            status
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

  const fulfillmentOrder =
    data.order
      ?.fulfillmentOrders
      .nodes
      .find(
        fo =>
          [
            'OPEN',
            'IN_PROGRESS'
          ].includes(
            fo.status
          )
      );

  if (!fulfillmentOrder) {

    throw new Error(
      'No open Shopify fulfillment order found'
    );
  }


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

          trackingInfo(first: 10) {
            company
            number
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
    await shopifyGraphQL(
      mutation,
      {
        fulfillment: {

          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId:
                fulfillmentOrder.id
            }
          ],

          notifyCustomer:
            false,

          trackingInfo: {
            company:
              'Pathao',

            number:
              consignmentId
          }
        }
      }
    );


  const payload =
    result.fulfillmentCreate;


  if (
    payload.userErrors?.length
  ) {

    const error =
      new Error(
        payload.userErrors
          .map(
            x => x.message
          )
          .join('; ')
      );

    error.status =
      400;

    error.data =
      payload.userErrors;

    throw error;
  }


  return {
    ...payload.fulfillment,

    events: {
      nodes: []
    }
  };
}


// ============================================================
// GET CORRECT FULFILLMENT
// ============================================================

async function getFulfillment(
  order,
  consignmentId
) {

  const fulfillments =
    order.fulfillments || [];


  // Try finding fulfillment
  // using Pathao consignment ID.

  const exact =
    fulfillments.find(
      fulfillment =>

        (
          fulfillment
            .trackingInfo || []
        ).some(
          tracking =>
            tracking.number ===
            consignmentId
        )
    );


  if (exact) {
    return exact;
  }


  // If only one fulfillment exists,
  // use it.

  if (
    fulfillments.length === 1
  ) {
    return fulfillments[0];
  }


  // Multiple fulfillments but
  // tracking number not matched.

  if (
    fulfillments.length > 1
  ) {

    throw new Error(
      `Multiple Shopify fulfillments found, but none uses ${consignmentId}`
    );
  }


  // No fulfillment exists.
  // Create one.

  return createShopifyFulfillment(
    order.id,
    consignmentId
  );
}


// ============================================================
// MAP PATHAO STATUS → SHOPIFY DELIVERY STATUS
// ============================================================

function mapPathaoStatus(
  orderStatus
) {

  const status =
    String(
      orderStatus || ''
    )
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


  // Waiting for pickup

  if (
    status ===
      'waiting for pickup' ||

    status.includes(
      'assigned for pickup'
    )
  ) {

    return 'CONFIRMED';
  }


  // Picked up

  if (
    status.includes(
      'picked up'
    ) ||

    status.includes(
      'pickup done'
    )
  ) {

    return 'CARRIER_PICKED_UP';
  }


  // Out for delivery

  if (
    status.includes(
      'out for delivery'
    )
  ) {

    return 'OUT_FOR_DELIVERY';
  }


  // Delivered

  if (
    status ===
      'delivered' ||

    status.includes(
      'successfully delivered'
    )
  ) {

    return 'DELIVERED';
  }


  // Attempted

  if (
    status.includes(
      'attempted delivery'
    )
  ) {

    return 'ATTEMPTED_DELIVERY';
  }


  // Delayed

  if (
    status.includes(
      'delay'
    )
  ) {

    return 'DELAYED';
  }


  // Transit

  if (
    status.includes(
      'in transit'
    ) ||

    status.includes(
      'transit'
    ) ||

    status.includes(
      'sorting'
    ) ||

    status.includes(
      'hub'
    )
  ) {

    return 'IN_TRANSIT';
  }


  // Failed / Cancelled

  if (
    status.includes(
      'failed'
    ) ||

    status.includes(
      'cancelled'
    ) ||

    status.includes(
      'canceled'
    )
  ) {

    return 'FAILURE';
  }


  return null;
}


// ============================================================
// UPDATE SHOPIFY DELIVERY STATUS
// ============================================================

async function updateShopifyDeliveryStatus(
  fulfillmentId,
  shopifyStatus,
  pathaoStatus
) {

  const mutation = `
    mutation UpdateDelivery(
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


  const result =
    await shopifyGraphQL(
      mutation,
      {
        event: {

          fulfillmentId:
            fulfillmentId,

          status:
            shopifyStatus,

          message:
            \`Pathao: \${pathaoStatus}\`
        }
      }
    );


  const payload =
    result.fulfillmentEventCreate;


  if (
    payload.userErrors?.length
  ) {

    const error =
      new Error(
        payload.userErrors
          .map(
            x => x.message
          )
          .join('; ')
      );

    error.status =
      400;

    error.data =
      payload.userErrors;

    throw error;
  }


  return payload.fulfillmentEvent;
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

      endpoints: {

        pathao_order:
          'GET /api/pathao/order/:consignment_id',

        sync:
          'POST /api/sync/:consignment_id'
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
        'healthy'
    });
  }
);


// ============================================================
// CHECK PATHAO ORDER
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
          req.params.consignment_id,

        merchant_order_id:
          order.merchant_order_id ||
          null,

        order_status:
          order.order_status ||
          null,

        updated_at:
          order.updated_at ||
          null
      });


    } catch (error) {

      res
        .status(
          error.status || 500
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
// SYNC PATHAO → SHOPIFY
// ============================================================

app.post(
  '/api/sync/:consignment_id',

  async (req, res) => {

    try {

      const consignmentId =
        req.params
          .consignment_id;


      // --------------------------------------------------------
      // 1. GET PATHAO ORDER
      // --------------------------------------------------------

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


      if (
        !merchantOrderId ||
        !pathaoStatus
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              'Pathao response is missing merchant_order_id or order_status'
          });
      }


      console.log(
        'Pathao order:',
        merchantOrderId,
        pathaoStatus
      );


      // --------------------------------------------------------
      // 2. CONVERT PATHAO STATUS
      // --------------------------------------------------------

      const shopifyStatus =
        mapPathaoStatus(
          pathaoStatus
        );


      if (!shopifyStatus) {

        return res
          .status(422)
          .json({

            success:
              false,

            merchant_order_id:
              merchantOrderId,

            pathao_order_status:
              pathaoStatus,

            error:
              'Pathao status is not mapped; Shopify was not changed'
          });
      }


      // --------------------------------------------------------
      // 3. FIND SHOPIFY ORDER
      //
      // PATHAO:
      // merchant_order_id = #WELL26287635
      //
      // SHOPIFY:
      // name = #WELL26287635
      // --------------------------------------------------------

      const shopifyOrder =
        await findShopifyOrderByName(
          merchantOrderId
        );


      if (!shopifyOrder) {

        return res
          .status(404)
          .json({

            success:
              false,

            merchant_order_id:
              merchantOrderId,

            error:
              `Shopify order ${merchantOrderId} not found`
          });
      }


      console.log(
        'Shopify order found:',
        shopifyOrder.name
      );


      // --------------------------------------------------------
      // 4. FIND / CREATE FULFILLMENT
      // --------------------------------------------------------

      const fulfillment =
        await getFulfillment(
          shopifyOrder,
          consignmentId
        );


      // --------------------------------------------------------
      // 5. CHECK EXISTING STATUS
      // --------------------------------------------------------

      const currentStatus =
        fulfillment
          .events
          ?.nodes
          ?.[0]
          ?.status ||
        null;


      if (
        currentStatus ===
        shopifyStatus
      ) {

        return res.json({

          success:
            true,

          updated:
            false,

          reason:
            'Shopify already has this delivery status',

          consignment_id:
            consignmentId,

          merchant_order_id:
            merchantOrderId,

          shopify_order_name:
            shopifyOrder.name,

          pathao_order_status:
            pathaoStatus,

          shopify_delivery_status:
            shopifyStatus
        });
      }


      // --------------------------------------------------------
      // 6. UPDATE SHOPIFY STATUS
      // --------------------------------------------------------

      const event =
        await updateShopifyDeliveryStatus(

          fulfillment.id,

          shopifyStatus,

          pathaoStatus
        );


      // --------------------------------------------------------
      // SUCCESS
      // --------------------------------------------------------

      res.json({

        success:
          true,

        updated:
          true,

        consignment_id:
          consignmentId,

        merchant_order_id:
          merchantOrderId,

        shopify_order_name:
          shopifyOrder.name,

        pathao_order_status:
          pathaoStatus,

        shopify_delivery_status:
          event.status,

        fulfillment_id:
          fulfillment.id,

        event_id:
          event.id
      });


    } catch (error) {

      console.error(
        'Sync error:',
        error.data ||
        error.message
      );


      res
        .status(
          error.status || 500
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
// START
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
      `🌐 Port: ${PORT}`
    );

    console.log(
      'GET  /api/pathao/order/:consignment_id'
    );

    console.log(
      'POST /api/sync/:consignment_id'
    );

    console.log(
      '============================================'
    );
  }
);
