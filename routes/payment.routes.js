const router = require("express").Router();
const db = require("../config/db");
const { verifyToken } = require("../middleware/auth.middleware");

const {
  getPiUser,
  fetchPayment,
  approvePayment,
  completePayment,
  cancelPayment
} = require("../piService");

function roundPi(value) {
  return Number(Number(value || 0).toFixed(8));
}

async function getCheckoutForUser(
  checkoutRef,
  userId,
  connection
) {
  const [orders] = await connection.query(
    `SELECT
       o.*,
       oi.id AS item_id,
       oi.product_id,
       oi.vendor_id AS item_vendor_id,
       oi.product_name,
       oi.unit_price_pi,
       oi.quantity,
       oi.subtotal_pi
     FROM orders o
     JOIN order_items oi
       ON oi.order_id=o.id
     WHERE o.checkout_ref=?
       AND o.user_id=?
     ORDER BY oi.id`,
    [
      checkoutRef,
      userId
    ]
  );

  return orders;
}


/* =========================================================
   PI SDK -> SERVER APPROVAL
========================================================= */

router.post(
  "/approve",
  verifyToken(),
  async (req, res) => {

    const {
      paymentId,
      checkout_ref: checkoutRef,
      accessToken
    } = req.body || {};


    if (
      !paymentId ||
      !checkoutRef ||
      !accessToken
    ) {

      return res.status(400).json({
        success: false,
        message:
          "paymentId, checkout_ref and Pi accessToken are required"
      });

    }


    const connection =
      await db.promise().getConnection();


    try {

      /*
       * Verify Pi account.
       */

      const piUser =
        await getPiUser(accessToken);


      if (
        String(piUser.uid) !==
        String(req.user.pi_uid)
      ) {

        return res.status(403).json({
          success: false,
          message:
            "Pi account does not match the signed-in account"
        });

      }


      /*
       * Find checkout.
       */

      const orders =
        await getCheckoutForUser(
          checkoutRef,
          req.user.id,
          connection
        );


      if (!orders.length) {

        return res.status(404).json({
          success: false,
          message:
            "Checkout not found"
        });

      }


      const order =
        orders[0];


      /*
       * Checkout must still be pending.
       */

      if (
        order.status !== "pending"
      ) {

        return res.status(409).json({
          success: false,
          message:
            "Checkout is no longer pending"
        });

      }


      const expected =
        roundPi(order.total_pi);


      /*
       * Verify payment from Pi.
       */

      const payment =
        await fetchPayment(paymentId);


      if (!payment) {

        return res.status(400).json({
          success: false,
          message:
            "Pi payment not found"
        });

      }


      const amount =
        Number(payment.amount);


      if (
        !Number.isFinite(amount) ||
        Math.abs(amount - expected) >
          0.000001
      ) {

        return res.status(400).json({
          success: false,
          message:
            `Payment amount mismatch. Expected ${expected} Pi`
        });

      }


      /*
       * Verify payment owner.
       */

      const paymentUid =
        payment.user_uid ||
        payment.user?.uid;


      if (
        paymentUid &&
        String(paymentUid) !==
          String(req.user.pi_uid)
      ) {

        return res.status(403).json({
          success: false,
          message:
            "Payment user does not match buyer"
        });

      }


      /*
       * Verify checkout metadata.
       */

      const metadata =
        payment.metadata || {};


      if (
        metadata.checkout_ref &&
        String(metadata.checkout_ref) !==
          String(checkoutRef)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Payment checkout does not match order"
        });

      }


      await connection.beginTransaction();


      /*
       * Check if payment already exists.
       */

      const [existing] =
        await connection.query(
          `SELECT *
           FROM payments
           WHERE payment_id=?
           LIMIT 1
           FOR UPDATE`,
          [
            paymentId
          ]
        );


      let dbPaymentId;


      if (existing.length) {

        dbPaymentId =
          existing[0].id;


        if (
          existing[0].status ===
          "completed"
        ) {

          await connection.rollback();

          return res.json({
            success: true,
            message:
              "Payment already completed"
          });

        }


        await connection.query(
          `UPDATE payments
           SET
             order_id=?,
             user_id=?,
             amount_pi=?,
             status='created',
             pi_uid=?,
             pi_username=?,
             payment_data=?
           WHERE payment_id=?`,
          [
            order.id,
            req.user.id,
            expected,
            req.user.pi_uid,
            req.user.pi_username,
            JSON.stringify(payment),
            paymentId
          ]
        );

      } else {

        const [result] =
          await connection.query(
            `INSERT INTO payments
             (
               order_id,
               user_id,
               payment_id,
               pi_uid,
               pi_username,
               amount_pi,
               status,
               payment_data
             )
             VALUES (
               ?,
               ?,
               ?,
               ?,
               ?,
               ?,
               'created',
               ?
             )`,
            [
              order.id,
              req.user.id,
              paymentId,
              req.user.pi_uid,
              req.user.pi_username,
              expected,
              JSON.stringify(payment)
            ]
          );


        dbPaymentId =
          result.insertId;

      }


      /*
       * Put order into payment processing.
       *
       * Delivery remains pending until payment
       * is successfully completed.
       */

      await connection.query(
        `UPDATE orders
         SET
           pi_payment_id=?,
           payment_status='processing'
         WHERE id=?
           AND status='pending'`,
        [
          paymentId,
          order.id
        ]
      );


      await connection.commit();


      /*
       * Approve payment with Pi.
       */

      let approvedPayment =
        payment;


      if (
        payment.status !== "approved" &&
        payment.status !== "completed"
      ) {

        try {

          approvedPayment =
            await approvePayment(
              paymentId
            );

        } catch (piError) {

          await db.promise().query(
            `UPDATE payments
             SET
               status='failed',
               payment_data=?,
               failed_at=CURRENT_TIMESTAMP
             WHERE id=?`,
            [
              JSON.stringify(
                piError.response?.data ||
                piError.message
              ),
              dbPaymentId
            ]
          );


          return res.status(502).json({
            success: false,
            message:
              "Pi payment approval failed",
            error:
              piError.response?.data ||
              piError.message
          });

        }

      }


      /*
       * Save approval.
       */

      await db.promise().query(
        `UPDATE payments
         SET
           status='approved',
           approval_data=?,
           approved_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          JSON.stringify(
            approvedPayment || payment
          ),
          dbPaymentId
        ]
      );


      /*
       * Payment log.
       */

      await db.promise().query(
        `INSERT INTO payment_logs
         (
           payment_id,
           order_id,
           user_id,
           event_type,
           payment_status,
           pi_payment_id,
           amount_pi,
           request_data,
           response_data
         )
         VALUES (
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?
         )`,
        [
          dbPaymentId,
          order.id,
          req.user.id,
          "server_approval",
          "approved",
          paymentId,
          expected,
          JSON.stringify({
            paymentId,
            checkout_ref:
              checkoutRef
          }),
          JSON.stringify(
            approvedPayment || payment
          )
        ]
      );


      res.json({
        success: true,
        message:
          "Payment approved"
      });


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      console.error(
        "Payment approval:",
        error
      );


      res.status(500).json({
        success: false,
        message:
          "Payment approval failed",
        error:
          error.message
      });


    } finally {

      connection.release();

    }

  }
);


/* =========================================================
   PI SDK -> SERVER COMPLETION

   IMPORTANT ORDER FLOW:

   pending
      ↓
   payment completed
      ↓
   paid
      ↓
   vendor marks shipped
      ↓
   shipped
      ↓
   vendor marks delivered
      ↓
   completed / delivered
      ↓
   buyer confirms receipt
========================================================= */

router.post(
  "/complete",
  verifyToken(),
  async (req, res) => {

    const {
      paymentId,
      txid,
      accessToken
    } = req.body || {};


    if (
      !paymentId ||
      !txid ||
      !accessToken
    ) {

      return res.status(400).json({
        success: false,
        message:
          "paymentId, txid and Pi accessToken are required"
      });

    }


    const connection =
      await db.promise().getConnection();


    try {

      /*
       * Verify Pi account.
       */

      const piUser =
        await getPiUser(accessToken);


      if (
        String(piUser.uid) !==
        String(req.user.pi_uid)
      ) {

        return res.status(403).json({
          success: false,
          message:
            "Pi account does not match the signed-in account"
        });

      }


      await connection.beginTransaction();


      /*
       * Load payment.
       */

      const [paymentRows] =
        await connection.query(
          `SELECT *
           FROM payments
           WHERE payment_id=?
           LIMIT 1
           FOR UPDATE`,
          [
            paymentId
          ]
        );


      if (!paymentRows.length) {

        await connection.rollback();

        return res.status(404).json({
          success: false,
          message:
            "Payment record not found"
        });

      }


      const dbPayment =
        paymentRows[0];


      /*
       * Already completed?
       */

      if (
        dbPayment.status ===
        "completed"
      ) {

        await connection.rollback();

        return res.json({
          success: true,
          message:
            "Payment already completed"
        });

      }


      /*
       * Payment must belong to
       * authenticated account.
       */

      if (
        Number(dbPayment.user_id) !==
        Number(req.user.id)
      ) {

        await connection.rollback();

        return res.status(403).json({
          success: false,
          message:
            "Payment does not belong to this account"
        });

      }


      /*
       * Verify payment with Pi.
       */

      const piPayment =
        await fetchPayment(
          paymentId
        );


      if (!piPayment) {

        await connection.rollback();

        return res.status(400).json({
          success: false,
          message:
            "Unable to verify Pi payment"
        });

      }


      /*
       * Verify transaction ID.
       */

      const piTxid =
        piPayment.transaction_id ||
        piPayment.transaction?.txid;


      if (
        piTxid &&
        String(piTxid) !==
          String(txid)
      ) {

        await connection.rollback();

        return res.status(400).json({
          success: false,
          message:
            "Transaction ID mismatch"
        });

      }


      /*
       * Verify amount.
       */

      const expected =
        Number(
          dbPayment.amount_pi
        );


      if (
        !Number.isFinite(
          Number(piPayment.amount)
        ) ||
        Math.abs(
          Number(piPayment.amount) -
          expected
        ) > 0.000001
      ) {

        await connection.rollback();

        return res.status(400).json({
          success: false,
          message:
            "Payment amount mismatch"
        });

      }


      /*
       * Complete payment on Pi.
       */

      await completePayment(
        paymentId,
        txid
      );


      /*
       * Confirm completion with Pi.
       */

      const confirmed =
        await fetchPayment(
          paymentId
        );


      if (
        !confirmed ||
        confirmed.status !==
          "completed"
      ) {

        await connection.rollback();

        return res.status(400).json({
          success: false,
          message:
            "Pi did not confirm payment completion"
        });

      }


      /*
       * Find order.
       */

      const [orders] =
        await connection.query(
          `SELECT *
           FROM orders
           WHERE pi_payment_id=?
             AND user_id=?
           LIMIT 1
           FOR UPDATE`,
          [
            paymentId,
            req.user.id
          ]
        );


      if (!orders.length) {

        throw new Error(
          "Order not found for payment"
        );

      }


      const order =
        orders[0];


      /*
       * Load order items.
       */

      const [items] =
        await connection.query(
          `SELECT *
           FROM order_items
           WHERE order_id=?
           ORDER BY id`,
          [
            order.id
          ]
        );


      if (!items.length) {

        throw new Error(
          "Order items not found"
        );

      }


      /*
       * Calculate platform fee
       * and vendor earnings.
       */

      const feePercent =
        Number(
          process.env.PLATFORM_FEE_PERCENT || 0
        );


      let platformFeeTotal = 0;
      let vendorTotal = 0;


      for (const item of items) {

        const subtotal =
          Number(
            item.subtotal_pi
          );


        const fee =
          roundPi(
            subtotal *
            feePercent /
            100
          );


        const vendorAmount =
          roundPi(
            subtotal - fee
          );


        platformFeeTotal =
          roundPi(
            platformFeeTotal +
            fee
          );


        vendorTotal =
          roundPi(
            vendorTotal +
            vendorAmount
          );


        /*
         * Create vendor earning
         * only once.
         */

        const [existing] =
          await connection.query(
            `SELECT id
             FROM earnings
             WHERE order_id=?
               AND vendor_id=?
               AND type='sale'
             LIMIT 1`,
            [
              order.id,
              item.vendor_id
            ]
          );


        if (!existing.length) {

          await connection.query(
            `INSERT INTO earnings
             (
               user_id,
               order_id,
               vendor_id,
               type,
               amount_pi,
               status,
               description
             )
             VALUES (
               ?,
               ?,
               ?,
               ?,
               ?,
               'pending',
               ?
             )`,
            [
              item.vendor_id,
              order.id,
              item.vendor_id,
              "sale",
              vendorAmount,
              `Sale for ${item.product_name}`
            ]
          );

        }

      }


      /*
       * Platform fee.
       */

      if (
        platformFeeTotal > 0
      ) {

        const [admins] =
          await connection.query(
            `SELECT id
             FROM users
             WHERE role='admin'
               AND admin_level='super_admin'
               AND status='approved'
             LIMIT 1`
          );


        if (admins.length) {

          const [existingFee] =
            await connection.query(
              `SELECT id
               FROM earnings
               WHERE order_id=?
                 AND type='platform_fee'
               LIMIT 1`,
              [
                order.id
              ]
            );


          if (!existingFee.length) {

            await connection.query(
              `INSERT INTO earnings
               (
                 user_id,
                 order_id,
                 type,
                 amount_pi,
                 status,
                 description
               )
               VALUES (
                 ?,
                 ?,
                 ?,
                 ?,
                 'available',
                 ?
               )`,
              [
                admins[0].id,
                order.id,
                "platform_fee",
                platformFeeTotal,
                "Marketplace platform fee"
              ]
            );

          }

        }

      }


      /*
       * =====================================================
       * CRITICAL ORDER STATUS UPDATE
       *
       * Successful Pi payment changes:
       *
       * status:
       * pending -> paid
       *
       * payment_status:
       * processing -> paid
       *
       * delivery_status:
       * pending -> processing
       *
       * This is what allows account.js to display
       * "Mark as Shipped".
       * =====================================================
       */

      await connection.query(
        `UPDATE orders
         SET
           status='paid',
           payment_status='paid',
           delivery_status='processing',
           platform_fee_pi=?,
           vendor_amount_pi=?,
           pi_txid=?,
           paid_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          platformFeeTotal,
          vendorTotal,
          txid,
          order.id
        ]
      );


      /*
       * Update payment record.
       */

      await connection.query(
        `UPDATE payments
         SET
           status='completed',
           txid=?,
           completion_data=?,
           completed_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          txid,
          JSON.stringify(
            confirmed
          ),
          dbPayment.id
        ]
      );


      /*
       * Payment log.
       */

      await connection.query(
        `INSERT INTO payment_logs
         (
           payment_id,
           order_id,
           user_id,
           event_type,
           payment_status,
           pi_payment_id,
           txid,
           amount_pi,
           response_data
         )
         VALUES (
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?
         )`,
        [
          dbPayment.id,
          order.id,
          req.user.id,
          "server_completion",
          "completed",
          paymentId,
          txid,
          expected,
          JSON.stringify(
            confirmed
          )
        ]
      );


      /*
       * Notify buyer.
       */

      await connection.query(
        `INSERT INTO notifications
         (
           user_id,
           message,
           type
         )
         VALUES (
           ?,
           ?,
           ?
         )`,
        [
          req.user.id,
          `Payment of ${expected} Pi completed successfully. Your order is now being prepared for shipment.`,
          "payment"
        ]
      );


      /*
       * Notify vendors.
       */

      const vendorIds = [
        ...new Set(
          items.map(
            item =>
              Number(item.vendor_id)
          )
        )
      ];


      for (
        const vendorId
        of vendorIds
      ) {

        const vendorItems =
          items.filter(
            item =>
              Number(
                item.vendor_id
              ) === vendorId
          );


        const names =
          vendorItems
            .map(
              item =>
                item.product_name
            )
            .join(", ");


        await connection.query(
          `INSERT INTO notifications
           (
             user_id,
             message,
             type
           )
           VALUES (
             ?,
             ?,
             ?
           )`,
          [
            vendorId,
            `New paid order received for ${names}. Please prepare the order and mark it as shipped when handed to the delivery service.`,
            "order"
          ]
        );

      }


      /*
       * Everything succeeded.
       */

      await connection.commit();


      res.json({
        success: true,
        message:
          "Payment completed successfully",
        payment_id:
          paymentId,
        order_id:
          order.id,
        order_status:
          "paid",
        delivery_status:
          "processing"
      });


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      /*
       * IMPORTANT:
       * Keep the actual error visible in Railway
       * while we are debugging the deployment.
       */

      console.error(
        "Payment completion ERROR:",
        error
      );


      res.status(500).json({
        success: false,
        message:
          "Payment completion failed",
        error:
          error.message
      });


    } finally {

      connection.release();

    }

  }
);


/* =========================================================
   CANCEL / ERROR CALLBACK
   Restores reserved stock.
========================================================= */

router.post(
  "/cancel",
  verifyToken(),
  async (req, res) => {

    const {
      paymentId,
      checkout_ref: checkoutRef
    } = req.body || {};


    if (
      !paymentId &&
      !checkoutRef
    ) {

      return res.status(400).json({
        success: false,
        message:
          "paymentId or checkout_ref required"
      });

    }


    const connection =
      await db.promise().getConnection();


    try {

      /*
       * Cancel payment on Pi if
       * payment ID exists.
       */

      if (paymentId) {

        try {

          await cancelPayment(
            paymentId
          );

        } catch (error) {

          console.warn(
            "Pi cancellation:",
            error.response?.data ||
            error.message
          );

        }

      }


      await connection.beginTransaction();


      const where =
        paymentId
          ? "o.pi_payment_id=?"
          : "o.checkout_ref=?";


      const value =
        paymentId
          ? paymentId
          : checkoutRef;


      const [orders] =
        await connection.query(
          `SELECT o.*
           FROM orders o
           WHERE o.user_id=?
             AND ${where}
             AND o.status='pending'
           FOR UPDATE`,
          [
            req.user.id,
            value
          ]
        );


      for (
        const order
        of orders
      ) {

        /*
         * Restore reserved stock.
         */

        const [items] =
          await connection.query(
            `SELECT
               product_id,
               quantity
             FROM order_items
             WHERE order_id=?`,
            [
              order.id
            ]
          );


        for (
          const item
          of items
        ) {

          await connection.query(
            `UPDATE products
             SET stock=stock+?
             WHERE id=?`,
            [
              item.quantity,
              item.product_id
            ]
          );

        }


        /*
         * Cancel order.
         */

        await connection.query(
          `UPDATE orders
           SET
             status='cancelled',
             payment_status='cancelled',
             delivery_status='cancelled',
             cancelled_at=CURRENT_TIMESTAMP
           WHERE id=?`,
          [
            order.id
          ]
        );

      }


      /*
       * Cancel database payment record.
       */

      if (paymentId) {

        await connection.query(
          `UPDATE payments
           SET status=CASE
             WHEN status='completed'
               THEN status
             ELSE 'cancelled'
           END
           WHERE payment_id=?`,
          [
            paymentId
          ]
        );

      }


      await connection.commit();


      res.json({
        success: true,
        message:
          "Payment cancelled"
      });


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      console.error(
        "Payment cancellation:",
        error
      );


      res.status(500).json({
        success: false,
        message:
          "Cancellation failed",
        error:
          error.message
      });


    } finally {

      connection.release();

    }

  }
);


/* =========================================================
   RECOVER AN INCOMPLETE PI PAYMENT
========================================================= */

router.post(
  "/incomplete",
  verifyToken(),
  async (req, res) => {

    const {
      paymentId,
      txid,
      accessToken
    } = req.body || {};


    if (
      !paymentId ||
      !txid ||
      !accessToken
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Missing incomplete payment data"
      });

    }


    /*
     * Keep compatibility with
     * the existing frontend flow.
     */

    req.body.checkout_ref =
      req.body.checkout_ref ||
      null;


    return res.redirect(
      307,
      "/api/payments/complete"
    );

  }
);


module.exports = router;