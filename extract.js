const express = require('express');

const app = express();

app.use(
  express.json({
    limit: '1mb'
  })
);


// ============================================================
// CONFIGURATION
// ============================================================

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

let PATHAO_TOKEN = null;

let PATHAO_EXPIRES_AT = 0;


// ============================================================
// GET PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {

  // Use cached token if still valid
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


  const url =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;


  const response =
    await fetch(
      url,
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
      '❌ Pathao token error:',
      JSON.stringify(
        data,
        null,
        2
      )
    );


    const error =
      new Error(
        data.message ||
        data.error ||
        `Pathao authentication failed (${response.status})`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }


  if (!data.access_token) {

    throw new Error(
      'Pathao did not return access_token'
    );
  }


  PATHAO_TOKEN =
    data.access_token;


  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      Number(
        data.expires_in
      ) ||
      3600
    ) *
      1000;


  console.log(
    '✅ Pathao access token obtained'
  );


  return PATHAO_TOKEN;
}


// ============================================================
// GET ONE PATHAO ORDER DETAILS
//
// Equivalent to:
//
// curl --location \
// '{{base_url}}/aladdin/api/v1/orders/{{consignment_id}}/info' \
// --header 'Authorization: Bearer {{access_token}}'
//
// ============================================================

async function getPathaoOrder(
  consignmentId
) {

  if (!consignmentId) {

    throw new Error(
      'consignment_id is required'
    );
  }


  const accessToken =
    await getPathaoToken();


  const url =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/orders/` +
    `${encodeURIComponent(
      consignmentId
    )}` +
    `/info`;


  console.log(
    `📦 Checking Pathao order: ${consignmentId}`
  );


  const response =
    await fetch(
      url,
      {
        method:
          'GET',

        redirect:
          'follow',

        headers: {

          Authorization:
            `Bearer ${accessToken}`,

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
        `Pathao order request failed (${response.status})`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }


  return (
    data.data ||
    data
  );
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
        'Pathao Order Status API',

      environment:
        PATHAO_BASE_URL.includes(
          'sandbox'
        )
          ? 'sandbox'
          : 'production',

      endpoints: {

        test_auth:
          'GET /api/test/pathao',

        single_order:
          'GET /api/pathao/order/:consignment_id',

        multiple_orders:
          'POST /api/pathao/orders-status'
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

      time:
        new Date()
          .toISOString()
    });
  }
);


// ============================================================
// TEST PATHAO ACCESS TOKEN
// ============================================================

app.get(
  '/api/test/pathao',

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
          'Pathao authentication working',

        access_token_received:
          !!token
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
// GET ONE ORDER STATUS
//
// Example:
//
// GET
// /api/pathao/order/DW170926U7G8U6
//
// ============================================================

app.get(
  '/api/pathao/order/:consignment_id',

  async (
    req,
    res
  ) => {

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


      console.error(
        '❌ Pathao order error:',
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
// GET MULTIPLE ORDER STATUSES
//
// POST
// /api/pathao/orders-status
//
// BODY:
//
// {
//   "consignment_ids": [
//     "DW170926U7G8U6",
//     "DW170926AAAAAA",
//     "DW170926BBBBBB"
//   ]
// }
//
// ============================================================

app.post(
  '/api/pathao/orders-status',

  async (
    req,
    res
  ) => {

    const consignmentIds =
      req.body
        ?.consignment_ids;


    if (
      !Array.isArray(
        consignmentIds
      ) ||
      consignmentIds.length ===
        0
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            'consignment_ids must be a non-empty array'
        });
    }


    const results = [];


    // Get token once before loop
    try {

      await getPathaoToken();

    } catch (error) {

      return res
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


    // Check each Pathao order
    for (
      const consignmentId
      of consignmentIds
    ) {

      try {

        const order =
          await getPathaoOrder(
            consignmentId
          );


        results.push({

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
            null
        });


      } catch (error) {


        results.push({

          success:
            false,

          consignment_id:
            consignmentId,

          error:
            error.message
        });
      }
    }


    const successful =
      results.filter(
        item =>
          item.success
      ).length;


    res.json({

      success:
        true,

      total:
        results.length,

      successful:
        successful,

      failed:
        results.length -
        successful,

      orders:
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
          'Endpoint not found'
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
      '🚀 PATHAO ORDER STATUS API'
    );

    console.log(
      '============================================'
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🚚 Pathao: ${PATHAO_BASE_URL}`
    );

    console.log(
      '--------------------------------------------'
    );

    console.log(
      'GET  /health'
    );

    console.log(
      'GET  /api/test/pathao'
    );

    console.log(
      'GET  /api/pathao/order/:consignment_id'
    );

    console.log(
      'POST /api/pathao/orders-status'
    );

    console.log(
      '============================================'
    );
  }
);
