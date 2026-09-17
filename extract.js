const express = require('express');

const app = express();

const PORT =
  process.env.PORT || 3000;

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  'https://api-hermes.pathao.com';

const PATHAO_ACCESS_TOKEN =
  process.env.PATHAO_ACCESS_TOKEN;


// ============================================================
// CHECK TOKEN
// ============================================================

if (!PATHAO_ACCESS_TOKEN) {

  console.error(
    '❌ Missing PATHAO_ACCESS_TOKEN'
  );

  process.exit(1);
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

      endpoint:
        'GET /api/pathao/order/:consignment_id'
    });
  }
);


// ============================================================
// GET PATHAO ORDER DETAILS
//
// Equivalent to:
//
// curl --location \
// '{{base_url}}/aladdin/api/v1/orders/{{consignment_id}}/info' \
// --header 'Authorization: Bearer {{access_token}}'
//
// ============================================================

app.get(
  '/api/pathao/order/:consignment_id',

  async (req, res) => {

    try {

      const consignmentId =
        req.params
          .consignment_id;


      const url =
        `${PATHAO_BASE_URL}` +
        `/aladdin/api/v1/orders/` +
        `${encodeURIComponent(
          consignmentId
        )}/info`;


      console.log(
        '============================================'
      );

      console.log(
        '📦 GET PATHAO ORDER'
      );

      console.log(
        'Consignment:',
        consignmentId
      );

      console.log(
        'URL:',
        url
      );

      console.log(
        '============================================'
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
                `Bearer ${PATHAO_ACCESS_TOKEN}`
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

        console.error(
          '❌ Pathao error:',
          data
        );


        return res
          .status(
            response.status
          )
          .json({

            success:
              false,

            consignment_id:
              consignmentId,

            error:
              data.message ||
              data.error ||
              `Pathao API ${response.status}`,

            details:
              data
          });
      }


      const order =
        data.data ||
        data;


      console.log(
        '✅ ORDER FOUND'
      );

      console.log(
        'Merchant Order:',
        order.merchant_order_id
      );

      console.log(
        'Status:',
        order.order_status
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

        data:
          order
      });


    } catch (error) {

      console.error(
        '❌ Error:',
        error.message
      );


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
      'GET /api/pathao/order/:consignment_id'
    );

    console.log(
      '============================================'
    );
  }
);
