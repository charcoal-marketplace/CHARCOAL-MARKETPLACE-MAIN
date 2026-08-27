const axios =
  require("axios");

const StellarSdk =
  require("@stellar/stellar-sdk");


const PI_BASE_URL =
  "https://api.minepi.com/v2";


/* =========================================================
   CONFIGURATION
========================================================= */

function requireApiKey() {

  if (!process.env.PI_API_KEY) {

    throw new Error(
      "PI_API_KEY is missing"
    );

  }

  return process.env.PI_API_KEY;

}


function requirePrivateSeed() {

  if (
    !process.env.PI_WALLET_PRIVATE_SEED
  ) {

    throw new Error(
      "PI_WALLET_PRIVATE_SEED is missing"
    );

  }

  return process.env.PI_WALLET_PRIVATE_SEED;

}


function apiHeaders() {

  return {

    Authorization:
      `Key ${requireApiKey()}`,

    "Content-Type":
      "application/json"

  };

}


/* =========================================================
   PI USER
========================================================= */

async function getPiUser(
  accessToken
) {

  if (!accessToken) {

    throw new Error(
      "Pi access token is required"
    );

  }


  console.log(
    "[PI SERVICE] Verifying Pi user..."
  );


  const response =
    await axios.get(
      `${PI_BASE_URL}/me`,
      {

        headers: {

          Authorization:
            `Bearer ${accessToken}`

        },

        timeout:
          10000

      }
    );


  if (!response.data?.uid) {

    throw new Error(
      "Invalid Pi user"
    );

  }


  console.log(
    "[PI SERVICE] Pi user verified:",
    {
      uid:
        response.data.uid,

      username:
        response.data.username
    }
  );


  return response.data;

}


/* =========================================================
   GET PAYMENT
========================================================= */

async function fetchPayment(
  paymentId
) {

  if (!paymentId) {

    return null;

  }


  console.log(
    "[PI SERVICE] Fetching payment:",
    paymentId
  );


  try {

    const response =
      await axios.get(
        `${PI_BASE_URL}/payments/${paymentId}`,
        {

          headers:
            apiHeaders(),

          timeout:
            15000

        }
      );


    const payment =
      response.data ||
      null;


    if (payment) {

      console.log(
        "[PI SERVICE] Payment fetched:",
        {
          paymentId:
            payment.identifier,

          direction:
            payment.direction,

          status:
            payment.status,

          amount:
            payment.amount
        }
      );

    }


    return payment;

  } catch (error) {

    console.error(
      "[PI SERVICE] Pi payment fetch error:",
      error.response?.data ||
      error.message
    );


    return null;

  }

}


/* =========================================================
   APPROVE U2A PAYMENT
========================================================= */

async function approvePayment(
  paymentId
) {

  if (!paymentId) {

    throw new Error(
      "Pi payment ID is required"
    );

  }


  console.log(
    "[PI SERVICE] Approving U2A payment:",
    paymentId
  );


  const response =
    await axios.post(
      `${PI_BASE_URL}/payments/${paymentId}/approve`,
      {},
      {

        headers:
          apiHeaders(),

        timeout:
          15000

      }
    );


  return (
    response.data ||
    null
  );

}


/* =========================================================
   COMPLETE PAYMENT
========================================================= */

async function completePayment(
  paymentId,
  txid
) {

  if (!paymentId) {

    throw new Error(
      "Pi payment ID is required"
    );

  }


  if (!txid) {

    throw new Error(
      "Pi transaction ID is required"
    );

  }


  console.log(
    "[PI SERVICE] Completing payment:",
    {
      paymentId,
      txid
    }
  );


  const response =
    await axios.post(
      `${PI_BASE_URL}/payments/${paymentId}/complete`,
      {
        txid
      },
      {

        headers:
          apiHeaders(),

        timeout:
          20000

      }
    );


  return (
    response.data ||
    null
  );

}


/* =========================================================
   CANCEL PAYMENT
========================================================= */

async function cancelPayment(
  paymentId
) {

  if (!paymentId) {

    throw new Error(
      "Pi payment ID is required"
    );

  }


  const response =
    await axios.post(
      `${PI_BASE_URL}/payments/${paymentId}/cancel`,
      {},
      {

        headers:
          apiHeaders(),

        timeout:
          15000

      }
    );


  return (
    response.data ||
    null
  );

}


/* =========================================================
   A2U: CREATE PAYMENT
========================================================= */

async function createA2UPayment({
  uid,
  amount,
  memo,
  metadata
}) {

  if (!uid) {

    throw new Error(
      "Vendor Pi UID is required"
    );

  }


  const numericAmount =
    Number(amount);


  if (
    !Number.isFinite(
      numericAmount
    ) ||
    numericAmount <= 0
  ) {

    throw new Error(
      "Invalid A2U payment amount"
    );

  }


  const response =
    await axios.post(
      `${PI_BASE_URL}/payments`,
      {

        payment: {

          amount:
            numericAmount,

          memo:
            String(
              memo ||
              "Vendor marketplace earnings"
            ),

          metadata:
            metadata ||
            {},

          uid:
            String(uid)

        }

      },
      {

        headers:
          apiHeaders(),

        timeout:
          20000

      }
    );


  if (
    !response.data?.identifier
  ) {

    throw new Error(
      "Pi did not return an A2U payment identifier"
    );

  }


  return response.data;

}


/* =========================================================
   A2U:
   GET INCOMPLETE SERVER PAYMENTS
========================================================= */

async function getIncompleteServerPayments() {

  const response =
    await axios.get(
      `${PI_BASE_URL}/payments/incomplete_server_payments`,
      {

        headers:
          apiHeaders(),

        timeout:
          15000

      }
    );


  return (
    response.data
      ?.incomplete_server_payments ||
    []
  );

}


/* =========================================================
   A2U:
   SUBMIT PAYMENT TO PI BLOCKCHAIN
========================================================= */

async function submitA2UPayment(
  paymentId
) {

  if (!paymentId) {

    throw new Error(
      "A2U payment ID is required"
    );

  }


  const payment =
    await fetchPayment(
      paymentId
    );


  if (!payment) {

    throw new Error(
      "Unable to retrieve A2U payment from Pi"
    );

  }


  /*
   * Make sure this is actually
   * an App-To-User payment.
   */

  if (
    payment.direction &&
    payment.direction !==
      "app_to_user"
  ) {

    throw new Error(
      `Invalid A2U payment direction: ${payment.direction}`
    );

  }


  /*
   * If Pi already has a transaction,
   * never create another transaction.
   */

  const existingTxid =
    payment.transaction?.txid ||
    payment.transaction_id ||
    null;


  if (existingTxid) {

    return {

      txid:
        existingTxid,

      payment,

      alreadySubmitted:
        true

    };

  }


  const fromAddress =
    payment.from_address;


  const toAddress =
    payment.to_address;


  const amount =
    Number(
      payment.amount
    );


  const network =
    payment.network;


  if (!fromAddress) {

    throw new Error(
      "Pi A2U payment has no sender wallet address"
    );

  }


  if (!toAddress) {

    throw new Error(
      "Pi A2U payment has no recipient wallet address"
    );

  }


  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {

    throw new Error(
      "Pi A2U payment has an invalid amount"
    );

  }


  /*
   * A2U is currently supported
   * by Pi on Testnet.
   *
   * We nevertheless keep the network
   * validation explicit so the app does
   * not accidentally submit a transaction
   * against the wrong Horizon network.
   */

  let horizonUrl;
  let networkPassphrase;


  if (
    network ===
    "Pi Testnet"
  ) {

    horizonUrl =
      "https://api.testnet.minepi.com";

    networkPassphrase =
      "Pi Testnet";

  } else if (
    network ===
    "Pi Network"
  ) {

    /*
     * Keep this branch for compatibility
     * with Pi network responses, but note
     * that Pi's current Advanced Payments
     * documentation says A2U is Testnet-only.
     */

    horizonUrl =
      "https://api.mainnet.minepi.com";

    networkPassphrase =
      "Pi Network";

  } else {

    throw new Error(
      `Unsupported Pi network: ${network}`
    );

  }


  /*
   * NEVER expose this seed to frontend code.
   */

  const privateSeed =
    requirePrivateSeed();


  const keypair =
    StellarSdk.Keypair.fromSecret(
      privateSeed
    );


  /*
   * Verify that the configured app wallet
   * actually owns the sender address returned
   * by Pi.
   */

  const publicKey =
    keypair.publicKey();


  if (
    String(publicKey) !==
    String(fromAddress)
  ) {

    throw new Error(
      "PI_WALLET_PRIVATE_SEED does not match the Pi app wallet"
    );

  }


  const server =
    new StellarSdk.Horizon.Server(
      horizonUrl
    );


  /*
   * Load the app wallet account.
   */

  const account =
    await server.loadAccount(
      publicKey
    );


  /*
   * Current base fee.
   */

  const baseFee =
    await server.fetchBaseFee();


  /*
   * Native Pi payment.
   */

  const paymentOperation =
    StellarSdk.Operation.payment({

      destination:
        toAddress,

      asset:
        StellarSdk.Asset.native(),

      amount:
        amount.toString()

    });


  /*
   * Build transaction.
   *
   * The Pi payment identifier is stored
   * in the transaction memo so the blockchain
   * transaction can be associated with the
   * Pi payment.
   */

  const transaction =
    new StellarSdk.TransactionBuilder(
      account,
      {

        fee:
          String(baseFee),

        networkPassphrase,

        timebounds:
          await server.fetchTimebounds(
            180
          )

      }
    )

      .addOperation(
        paymentOperation
      )

      .addMemo(
        StellarSdk.Memo.text(
          payment.identifier
        )
      )

      .build();


  /*
   * Sign with the app wallet.
   */

  transaction.sign(
    keypair
  );


  /*
   * Submit to Pi blockchain.
   */

  const result =
    await server.submitTransaction(
      transaction
    );


  if (
    !result?.successful
  ) {

    const operationCode =
      result?.extras
        ?.result_codes
        ?.operations?.[0];


    const transactionCode =
      result?.extras
        ?.result_codes
        ?.transaction;


    throw new Error(
      `Pi blockchain transaction failed: ${
        operationCode ||
        transactionCode ||
        "unknown error"
      }`
    );

  }


  const txid =
    result.id;


  if (!txid) {

    throw new Error(
      "Pi blockchain did not return a transaction ID"
    );

  }


  return {

    txid,

    payment,

    alreadySubmitted:
      false

  };

}


/* =========================================================
   EXPORT
========================================================= */

module.exports = {

  getPiUser,

  fetchPayment,

  approvePayment,

  completePayment,

  cancelPayment,

  createA2UPayment,

  submitA2UPayment,

  getIncompleteServerPayments

};