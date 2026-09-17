// ============================================================
// AUTOMATIC PATHAO -> SHOPIFY STATUS POLLING
// Checks every 60 seconds
// ============================================================

const POLL_INTERVAL_MS = 60 * 1000;

// Only scan recent Shopify orders.
// Change Railway variable POLL_LOOKBACK_DAYS if needed.
const POLL_LOOKBACK_DAYS =
  Number(process.env.POLL_LOOKBACK_DAYS) || 30;

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
// GET SHOPIFY ORDERS WITH PATHAO TRACKING
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
    query GetTrackedOrders(
      $first: Int!,
      $after: String,
      $search: String!
    ) {

      orders(
        first: $first,
        after: $after,
        query: $search
      ) {

        nodes {

          id
          name

          fulfillments(first: 20) {

            id
            status
            displayStatus

            trackingInfo(first: 10) {
              company
              number
            }

            events(last: 1) {

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


  const results = [];

  let after = null;
  let hasNextPage = true;


  while (hasNextPage) {

    const data =
      await shopifyGraphQL(
        query,
        {
          first: 100,

          after,

          search:
            `updated_at:>=${since}`
        }
      );


    const orders =
      data.orders.nodes || [];


    for (const order of orders) {

      for (
        const fulfillment of
        order.fulfillments || []
      ) {

        const tracking =
          (
            fulfillment.trackingInfo ||
            []
          ).find(
            info =>
              info.number &&
              info.company &&
              info.company
                .toLowerCase()
                .includes('pathao')
          );


        if (!tracking) {
          continue;
        }


        results.push({

          shopify_order_id:
            order.id,

          shopify_order_name:
            order.name,

          fulfillment_id:
            fulfillment.id,

          consignment_id:
            tracking.number,

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


    hasNextPage =
      data.orders.pageInfo
        .hasNextPage;


    after =
      data.orders.pageInfo
        .endCursor;
  }


  return results;
}


// ============================================================
// SYNC ONE EXISTING SHOPIFY FULFILLMENT
// ============================================================

async function autoSyncOneOrder(
  item
) {

  const consignmentId =
    item.consignment_id;


  // ----------------------------------------------------------
  // 1. GET CURRENT PATHAO STATUS
  // ----------------------------------------------------------

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

    return {
      updated: false,
      skipped: true,
      reason:
        'Pathao merchant_order_id or order_status missing'
    };
  }


  // ----------------------------------------------------------
  // 2. VERIFY:
  //
  // Pathao merchant_order_id
  // MUST equal Shopify order name
  //
  // Example:
  // #WELL26287635 === #WELL26287635
  // ----------------------------------------------------------

  if (
    merchantOrderId !==
    item.shopify_order_name
  ) {

    console.error(
      '❌ Order mismatch:',
      merchantOrderId,
      item.shopify_order_name
    );


    return {

      updated: false,

      skipped: true,

      reason:
        'Pathao merchant_order_id does not match Shopify order name',

      pathao_merchant_order_id:
        merchantOrderId,

      shopify_order_name:
        item.shopify_order_name
    };
  }


  // ----------------------------------------------------------
  // 3. CONVERT PATHAO STATUS -> SHOPIFY STATUS
  // ----------------------------------------------------------

  const shopifyStatus =
    mapPathaoStatus(
      pathaoStatus
    );


  if (!shopifyStatus) {

    console.log(
      'ℹ️ Unmapped Pathao status:',
      merchantOrderId,
      pathaoStatus
    );


    return {

      updated: false,

      skipped: true,

      reason:
        'Pathao status not mapped',

      pathao_status:
        pathaoStatus
    };
  }


  // ----------------------------------------------------------
  // 4. DON'T CREATE DUPLICATE STATUS EVENT
  // ----------------------------------------------------------

  if (
    item.current_shopify_status ===
    shopifyStatus
  ) {

    console.log(
      '✓ No change:',
      merchantOrderId,
      pathaoStatus
    );


    return {

      updated: false,

      skipped: true,

      reason:
        'Status already synchronized'
    };
  }


  // ----------------------------------------------------------
  // 5. UPDATE SHOPIFY DELIVERY STATUS
  // ----------------------------------------------------------

  const event =
    await updateShopifyDeliveryStatus(

      item.fulfillment_id,

      shopifyStatus,

      pathaoStatus
    );


  console.log(
    '✅ UPDATED:',
    merchantOrderId,
    '|',
    pathaoStatus,
    '->',
    event.status
  );


  return {

    updated: true,

    merchant_order_id:
      merchantOrderId,

    consignment_id:
      consignmentId,

    pathao_status:
      pathaoStatus,

    previous_shopify_status:
      item.current_shopify_status,

    shopify_status:
      event.status
  };
}


// ============================================================
// RUN COMPLETE AUTO SYNC
// ============================================================

async function runAutomaticStatusSync() {

  // Prevent overlapping jobs.
  //
  // If one check takes longer than 60 seconds,
  // another check will NOT start on top of it.

  if (autoSyncRunning) {

    console.log(
      '⏭ Auto-sync already running'
    );

    return;
  }


  autoSyncRunning = true;


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


    const orders =
      await getPathaoTrackedFulfillments();


    console.log(
      `📦 Pathao shipments found: ${orders.length}`
    );


    // Sequential checking is intentional.
    // Avoid hammering Pathao + Shopify APIs.

    for (const item of orders) {

      stats.checked++;


      try {

        const result =
          await autoSyncOneOrder(
            item
          );


        if (result.updated) {

          stats.updated++;

        } else {

          stats.skipped++;
        }


      } catch (error) {

        stats.errors++;


        console.error(
          '❌ Auto-sync order error:',
          item.shopify_order_name,
          item.consignment_id,
          error.data ||
          error.message
        );
      }
    }


  } catch (error) {

    stats.errors++;


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
}


// ============================================================
// AUTO-SYNC STATUS ENDPOINT
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
        POLL_INTERVAL_MS /
        1000,

      lookback_days:
        POLL_LOOKBACK_DAYS,

      last_run:
        lastAutoSync
    });
  }
);


// ============================================================
// OPTIONAL MANUAL RUN
// Useful for testing
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


    await runAutomaticStatusSync();


    res.json({

      success:
        true,

      result:
        lastAutoSync
    });
  }
);
