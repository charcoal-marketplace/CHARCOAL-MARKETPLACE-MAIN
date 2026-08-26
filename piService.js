const axios = require("axios");
const StellarSdk = require("@stellar/stellar-sdk");

const PI_BASE_URL = "https://api.minepi.com/v2";


/* =========================================================
   SAFE PI ERROR DETAILS
   NEVER expose access tokens or private seeds.
========================================================= */

function getPiErrorDetails(error) {

  return {
    message:
      error?.message ||
      "Unknown Pi API error",

    status:
      error?.response?.status ||
      null,

    data:
      error?.response?.data ||
      null
  };

}


/* =========================================================
   PI API KEY
========================================================= */

function requireApiKey() {

  if (!process.env.PI_API_KEY) {

    throw new Error(
      "PI_API_KEY is missing"
    );

  }

  return process.env.PI_API_KEY;

}


/* =========================================================
   PI WALLET PRIVATE SEED
========================================================= */

function requirePrivateSeed() {

  if (!process.env.PI_WALLET_PRIVATE_SEED) {

    throw new Error(
      "PI_WALLET_PRIVATE_SEED is missing"
    );

  }

  return process.env.PI_WALLET_PRIVATE_SEED;

}


/* =========================================================
   SERVER API HEADERS
========================================================= */

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

async function getPiUser(accessToken) {

  if (!accessToken) {

    throw new Error(
      "Pi access token is missing"
    );

  }


  console.log(
    "[PI SERVICE] Verifying Pi user..."
  );


  try {

    const response =
      await axios.get(
        `${PI_BASE_URL}/me`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`
          },

          timeout: 10000
        }
      );


    if (!response.data?.uid) {

      throw new Error(
        "Invalid Pi user response"
      );

    }


    console.log(
      "[PI SERVICE] Pi user verified:",
      {
        uid:
          response.data.uid,

        username:
          response.data.username ||
          null
      }
    );


    return response.data;


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Pi user verification failed:",
      details
    );


    throw new Error(
      `Pi user verification failed: ${
        details.data?.error ||
        details.data?.message ||
        details.message
      }`
    );

  }

}


/* =========================================================
   GET PAYMENT
========================================================= */

async function fetchPayment(paymentId) {

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

          timeout: 15000
        }
      );


    const payment =
      response.data ||
      null;


    console.log(
      "[PI SERVICE] Payment fetched:",
      {
        paymentId,
        status:
          payment?.status ||
          null,

        amount:
          payment?.amount ||
          null
      }
    );


    return payment;


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Pi payment fetch failed:",
      {
        paymentId,
        ...details
      }
    );


    return null;

  }

}


/* =========================================================
   APPROVE U2A PAYMENT
========================================================= */

async function approvePayment(paymentId) {

  if (!paymentId) {

    throw new Error(
      "Payment ID is required for approval"
    );

  }


  console.log(
    "[PI SERVICE] Approving payment:",
    paymentId
  );


  try {

    const response =
      await axios.post(
        `${PI_BASE_URL}/payments/${paymentId}/approve`,
        {},
        {
          headers:
            apiHeaders(),

          timeout: 15000
        }
      );


    console.log(
      "[PI SERVICE] Pi payment approval response:",
      {
        paymentId,
        status:
          response.data?.status ||
          null
      }
    );


    return response.data ||
      null;


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Pi payment approval failed:",
      {
        paymentId,
        ...details
      }
    );


    throw error;

  }

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
      "Payment ID is required for completion"
    );

  }


  if (!txid) {

    throw new Error(
      "Transaction ID is required for completion"
    );

  }


  console.log(
    "[PI SERVICE] Completing payment:",
    {
      paymentId,
      txid
    }
  );


  try {

    const response =
      await axios.post(
        `${PI_BASE_URL}/payments/${paymentId}/complete`,
        {
          txid
        },
        {
          headers:
            apiHeaders(),

          timeout: 15000
        }
      );


    console.log(
      "[PI SERVICE] Pi payment completion response:",
      {
        paymentId,
        status:
          response.data?.status ||
          null
      }
    );


    return response.data ||
      null;


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Pi payment completion failed:",
      {
        paymentId,
        txid,
        ...details
      }
    );


    throw error;

  }

}


/* =========================================================
   CANCEL PAYMENT
========================================================= */

async function cancelPayment(paymentId) {

  if (!paymentId) {

    throw new Error(
      "Payment ID is required for cancellation"
    );

  }


  console.log(
    "[PI SERVICE] Cancelling payment:",
    paymentId
  );


  try {

    const response =
      await axios.post(
        `${PI_BASE_URL}/payments/${paymentId}/cancel`,
        {},
        {
          headers:
            apiHeaders(),

          timeout: 15000
        }
      );


    console.log(
      "[PI SERVICE] Pi payment cancellation response:",
      {
        paymentId,
        status:
          response.data?.status ||
          null
      }
    );


    return response.data ||
      null;


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Pi payment cancellation failed:",
      {
        paymentId,
        ...details
      }
    );


    throw error;

  }

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


  if (
    !Number.isFinite(
      Number(amount)
    ) ||
    Number(amount) <= 0
  ) {

    throw new Error(
      "Invalid A2U payment amount"
    );

  }


  console.log(
    "[PI SERVICE] Creating A2U payment:",
    {
      uid,
      amount:
        Number(amount)
    }
  );


  try {

    const response =
      await axios.post(
        `${PI_BASE_URL}/payments`,
        {
          payment: {
            amount:
              Number(amount),

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

          timeout: 20000
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


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] A2U payment creation failed:",
      details
    );


    throw error;

  }

}


/* =========================================================
   A2U: GET INCOMPLETE SERVER PAYMENTS
========================================================= */

async function getIncompleteServerPayments() {

  console.log(
    "[PI SERVICE] Fetching incomplete server payments..."
  );


  try {

    const response =
      await axios.get(
        `${PI_BASE_URL}/payments/incomplete_server_payments`,
        {
          headers:
            apiHeaders(),

          timeout: 15000
        }
      );


    return (
      response.data?.incomplete_server_payments ||
      []
    );


  } catch (error) {

    const details =
      getPiErrorDetails(error);


    console.error(
      "[PI SERVICE] Failed to fetch incomplete server payments:",
      details
    );


    throw error;

  }

}


/* =========================================================
   A2U: SUBMIT PAYMENT TO PI BLOCKCHAIN
========================================================= */

async function submitA2UPayment(paymentId) {

  if (!paymentId) {

    throw new Error(
      "A2U payment ID is required"
    );

  }


  console.log(
    "[PI SERVICE] Submitting A2U payment:",
    paymentId
  );


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
   * If Pi already has a transaction,
   * do not create another one.
   */

  const existingTxid =
    payment.transaction?.txid ||
    payment.transaction_id ||
    null;


  if (existingTxid) {

    console.log(
      "[PI SERVICE] A2U payment already submitted:",
      existingTxid
    );


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
   * The Pi API tells us which network
   * the payment belongs to.
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
   * Load developer/app wallet private seed.
   * NEVER expose this to the browser.
   */

  const privateSeed =
    requirePrivateSeed();


  const keypair =
    StellarSdk.Keypair.fromSecret(
      privateSeed
    );


  /*
   * Make sure the private seed belongs
   * to the sender address supplied by Pi.
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
   * Load developer/app wallet account.
   */

  const account =
    await server.loadAccount(
      publicKey
    );


  /*
   * Get current base fee.
   */

  const baseFee =
    await server.fetchBaseFee();


  /*
   * Build native Pi payment.
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
   * IMPORTANT:
   * The Pi payment identifier must be
   * included as the transaction memo.
   */

  const transaction =
    new StellarSdk.TransactionBuilder(
      account,
      {
        fee:
          String(baseFee),

        networkPassphrase,

        timebounds:
          await server.fetchTimebounds(180)
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
   * Sign using app wallet private seed.
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
      result?.extras?.result_codes
        ?.operations?.[0];

    const transactionCode =
      result?.extras?.result_codes
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