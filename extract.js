const express = require('express');

const app = express();

app.use(express.json());

const PORT =
  process.env.PORT || 3000;

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


// ============================================================
// TOKEN CACHE
// ============================================================

let ACCESS_TOKEN = null;
let REFRESH_TOKEN = null;
let TOKEN_EXPIRES_AT = 0;


// ============================================================
// PASSWORD LOGIN
// ============================================================

async function loginPathao() {

  console.log(
    '🔐 Logging into Pathao...'
  );

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

            grant_type:
              'password',

            username:
              PATHAO_USERNAME,

            password:
              PATHAO_PASSWORD
          })
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    console.error(
      '❌ Pathao login failed:',
      data
    );

    const error =
      new Error(
        data.message ||
        'Pathao authentication failed'
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }


  ACCESS_TOKEN =
    data.access_token;

  REFRESH_TOKEN =
    data.refresh_token;


  TOKEN_EXPIRES_AT =
    Date.now() +
    (
      Number(
        data.expires_in
      ) ||
      432000
    ) *
      1000;


  console.log(
    '✅ Pathao login successful'
  );

  console.log(
    'Access token received:',
    !!ACCESS_TOKEN
  );

  console.log(
    'Refresh token received:',
    !!REFRESH_TOKEN
  );


  return ACCESS_TOKEN;
}


// ============================================================
// REFRESH TOKEN
// ============================================================

async function refreshPathaoToken() {

  if (!REFRESH_TOKEN) {

    return loginPathao();
  }


  console.log(
    '🔄 Refreshing Pathao token...'
  );


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

            grant_type:
              'refresh_token',

            refresh_token:
              REFRESH_TOKEN
          })
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    console.log(
      '⚠️ Refresh failed. Logging in again...'
    );

    ACCESS_TOKEN =
      null;

    REFRESH_TOKEN =
      null;

    return loginPathao();
  }


  ACCESS_TOKEN =
    data.access_token;

  REFRESH_TOKEN =
    data.refresh_token ||
    REFRESH_TOKEN;


  TOKEN_EXPIRES_AT =
    Date.now() +
    (
      Number(
        data.expires_in
      ) ||
      432000
    ) *
      1000;


  console.log(
    '✅ Pathao token refreshed'
  );


  return ACCESS_TOKEN;
}


// ============================================================
// GET VALID ACCESS TOKEN
// ============================================================

async function getAccessToken() {

  if (
    ACCESS_TOKEN &&
    Date.now() <
      TOKEN_EXPIRES_AT - 60000
  ) {

    return ACCESS_TOKEN;
  }


  if (REFRESH_TOKEN) {

    return refreshPathaoToken();
  }


  return loginPathao();
}


// ============================================================
// GET ORDER DETAILS
// ============================================================

async function getPathaoOrder(
  consignmentId
) {

  const accessToken =
    await getAccessToken();


  const url =
    `${PATHAO_BASE_URL}` +
    `/aladdin/api/v1/orders/` +
    `${encodeURIComponent(
      consignmentId
    )}/info`;


  console.log(
    '📦 Getting Pathao order:',
    consignmentId
  );


  const response =
    await fetch(
      url,
      {
        method: 'GET',

        headers: {
          Authorization:
            `Bearer ${accessToken}`
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
// ROOT
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({
      success: true,

      service:
        'Pathao Order Status API',

      endpoints: {
        auth:
          'GET /api/test/pathao',

        order:
          'GET /api/pathao/order/:consignment_id'
      }
    });
  }
);


// ============================================================
// TEST AUTH
// ============================================================

app.get(
  '/api/test/pathao',

  async (req, res) => {

    try {

      const token =
        await getAccessToken();


      res.json({
        success: true,

        message:
          'Pathao authentication working',

        access_token_received:
          !!token,

        refresh_token_received:
          !!REFRESH_TOKEN
      });


    } catch (error) {

      res
        .status(
          error.status || 500
        )
        .json({
          success: false,

          error:
            error.message,

          details:
            error.data || null
        });
    }
  }
);


// ============================================================
// GET ORDER STATUS
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
        success: true,

        consignment_id:
          order.consignment_id ||
          req.params.consignment_id,

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
          error.status || 500
        )
        .json({
          success: false,

          consignment_id:
            req.params
              .consignment_id,

          error:
            error.message,

          details:
            error.data || null
        });
    }
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
      '🚀 PATHAO ORDER STATUS API'
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🚚 Pathao: ${PATHAO_BASE_URL}`
    );

    console.log(
      'GET /api/test/pathao'
    );

    console.log(
      'GET /api/pathao/order/:consignment_id'
    );

    console.log(
      '============================================'
    );
  }
);
