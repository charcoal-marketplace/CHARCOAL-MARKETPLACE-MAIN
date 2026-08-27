require("dotenv").config();

const db =
  require("../config/db");


/* =========================================================
   EXPECTED DATABASE STRUCTURE
========================================================= */

const expected = {

  users: [
    "id",
    "name",
    "email",
    "password_hash",
    "pi_uid",
    "pi_username",
    "pi_wallet_address",
    "role",
    "status",
    "admin_level",
    "vendor_status"
  ],


  products: [
    "id",
    "vendor_id",
    "name",
    "price_pi",
    "stock",
    "image",
    "location",
    "status",
    "is_active"
  ],


  orders: [
    "id",
    "user_id",
    "vendor_id",
    "checkout_ref",
    "total_pi",
    "status",
    "payment_status",
    "pi_payment_id",
    "pi_txid",
    "buyer_confirmed_at"
  ],


  order_items: [
    "id",
    "order_id",
    "product_id",
    "vendor_id",
    "product_name",
    "unit_price_pi",
    "quantity",
    "subtotal_pi"
  ],


  payments: [
    "id",
    "order_id",
    "user_id",
    "payment_id",
    "amount_pi",
    "status",
    "txid"
  ],


  payment_logs: [
    "id",
    "payment_id",
    "order_id",
    "user_id",
    "event_type",
    "amount_pi"
  ],


  earnings: [
    "id",
    "user_id",
    "order_id",
    "payment_id",
    "vendor_id",
    "type",
    "amount_pi",
    "status",

    /*
     * Vendor A2U payout fields
     */
    "payout_payment_id",
    "payout_txid",
    "paid_at",
    "payout_error"
  ],


  notifications: [
    "id",
    "user_id",
    "message",
    "type",
    "is_read"
  ],


  admin_requests: [
    "id",
    "requested_by",
    "pi_username",
    "pi_uid",
    "admin_level",
    "status",
    "invitation_id"
  ],


  admin_invitations: [
    "id",
    "invited_pi_uid",
    "invited_pi_username",
    "invited_by",
    "admin_level",
    "status",
    "expires_at"
  ]

};


/* =========================================================
   CHECK DATABASE
========================================================= */

async function main() {

  let failed = false;


  for (
    const [table, columns]
    of Object.entries(expected)
  ) {

    try {

      const [rows] =
        await db.promise().query(
          `
          SELECT
            COLUMN_NAME

          FROM INFORMATION_SCHEMA.COLUMNS

          WHERE TABLE_SCHEMA =
                DATABASE()

          AND TABLE_NAME = ?
          `,
          [table]
        );


      if (!rows.length) {

        failed = true;

        console.error(
          `❌ ${table}: table does not exist`
        );

        continue;

      }


      const actual =
        new Set(
          rows.map(
            row =>
              row.COLUMN_NAME
          )
        );


      const missing =
        columns.filter(
          column =>
            !actual.has(column)
        );


      if (missing.length) {

        failed = true;

        console.error(
          `❌ ${table}: missing ${missing.join(", ")}`
        );

      } else {

        console.log(
          `✅ ${table}: OK`
        );

      }

    } catch (error) {

      failed = true;

      console.error(
        `❌ ${table}: ${error.message}`
      );

    }

  }


  await db.promise().end();


  if (failed) {

    console.error(
      "\n🔴 Schema compatibility check FAILED."
    );

    process.exit(1);

  }


  console.log(
    "\n🟢 Schema compatibility check passed."
  );

}


main().catch(
  error => {

    console.error(
      "❌ Schema check failed:",
      error.message
    );

    process.exit(1);

  }
);