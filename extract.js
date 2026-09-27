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
      notifyCustomer: false,

      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId:
            fulfillmentOrderId
        }
      ],

      trackingInfo: {
        company: "Other",
        number: String(consignmentId),
        url:
          "https://pcom.page.link/ZvxGGEEgwsiFguMA8"
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

  if (result?.userErrors?.length) {
    throw new Error(
      result.userErrors
        .map(error => error.message)
        .join(", ")
    );
  }

  if (!result?.fulfillment) {
    throw new Error(
      "Shopify fulfillment was not created."
    );
  }

  return result.fulfillment;
}
