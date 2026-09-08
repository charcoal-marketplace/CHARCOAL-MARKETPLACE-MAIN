const router = require("express").Router();
const db = require("../config/db");

const {
  verifyToken,
  verifyAdmin,
  verifyVendor
} = require("../middleware/auth.middleware");

const {
  createA2UPayment,
  submitA2UPayment,
  completePayment,
  fetchPaymentStrict
} = require("../piService");

function roundPi(value) {
  return Number(Number(value || 0).toFixed(8));
}

function isAdmin(req) {
  return Boolean(
    req.user &&
    req.user.role === "admin" &&
    req.user.status === "approved"
  );
}

async function notifyAdmins(connectionOrDb, message) {
  await connectionOrDb.query(
    `
    INSERT INTO notifications (user_id, message, type)
    SELECT id, ?, 'refund'
    FROM users
    WHERE role='admin'
      AND status='approved'
    `,
    [message]
  );
}

/*
 * =========================================================
 * BUYER REQUESTS REFUND
 *
 * POST /api/refunds/request
 *
 * The buyer does NOT receive Pi here.
 * This only creates the refund request.
 *
 * The vendor must cancel the order before Admin can
 * release the refund to the buyer.
 * =========================================================
 */
router.post("/request", verifyToken(), async (req, res) => {
  const orderId = Number(req.body?.order_id);
  const reason =
    String(
      req.body?.reason ||
      "Buyer reports that the product was not received."
    )
      .trim()
      .slice(0, 500);

  if (!Number.isInteger(orderId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid order ID"
    });
  }

  if (isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Administrators cannot submit buyer refund requests"
    });
  }

  try {
    const connection = await db.promise().getConnection();

    try {
      await connection.beginTransaction();

      const [orders] = await connection.query(
        `
        SELECT
          id,
          user_id,
          vendor_id,
          status,
          payment_status,
          delivery_status,
          buyer_confirmed_at,
          refund_status
        FROM orders
        WHERE id=?
          AND user_id=?
        LIMIT 1
        FOR UPDATE
        `,
        [orderId, req.user.id]
      );

      if (!orders.length) {
        throw new Error("Order not found");
      }

      const order = orders[0];

      if (order.buyer_confirmed_at) {
        throw new Error(
          "You already confirmed receipt of this order, so a refund request cannot be opened from this flow."
        );
      }

      if (
        !["paid", "processing", "shipped"].includes(
          String(order.status)
        )
      ) {
        throw new Error(
          `This order cannot be refunded from its current status: ${order.status}`
        );
      }

      if (
        ["pending", "processing"].includes(
          String(order.refund_status)
        )
      ) {
        throw new Error("A refund request is already active for this order");
      }

      await connection.query(
        `
        UPDATE orders
        SET
          refund_status='pending',
          refund_reason=?,
          refund_requested_by=?,
          refund_requested_at=CURRENT_TIMESTAMP
        WHERE id=?
        `,
        [reason, req.user.id, orderId]
      );

      await connection.query(
        `
        INSERT INTO refund_logs
        (
          order_id,
          user_id,
          event_type,
          amount_pi,
          reason
        )
        SELECT
          o.id,
          ?,
          'refund_requested',
          o.total_pi,
          ?
        FROM orders o
        WHERE o.id=?
        `,
        [req.user.id, reason, orderId]
      );

      await connection.query(
        `
        INSERT INTO notifications
        (
          user_id,
          message,
          type
        )
        SELECT
          DISTINCT oi.vendor_id,
          ?,
          'refund'
        FROM order_items oi
        WHERE oi.order_id=?
          AND oi.vendor_id IS NOT NULL
        `,
        [
          `Buyer requested a refund for order #${orderId}. Please review the order and cancel it if the refund is justified.`,
          orderId
        ]
      );

      await notifyAdmins(
        connection,
        `Refund requested for order #${orderId}. Vendor cancellation is required before the refund can be released.`
      );

      await connection.commit();

      return res.status(201).json({
        success: true,
        message:
          "Refund request submitted. The vendor must cancel the order before an Admin can release the refund.",
        order_id: orderId,
        refund_status: "pending"
      });
    } catch (error) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: error.message || "Unable to request refund"
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Refund request error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create refund request"
    });
  }
});

/*
 * =========================================================
 * VENDOR CANCELS ORDER AFTER REFUND REQUEST
 *
 * POST /api/refunds/vendor-cancel/:id
 *
 * This is the business event that makes the refund eligible.
 * The vendor must own EVERY item in the order.
 *
 * Stock is restored.
 * Sale/platform-fee earnings are cancelled.
 * Actual Pi refund is NOT sent here.
 * =========================================================
 */
router.post(
  "/vendor-cancel/:id",
  verifyVendor,
  async (req, res) => {
    const orderId = Number(req.params.id);
    const reason =
      String(
        req.body?.reason ||
        "Vendor cancelled the order after a refund request."
      )
        .trim()
        .slice(0, 500);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    try {
      const connection = await db.promise().getConnection();

      try {
        await connection.beginTransaction();

        const [orders] = await connection.query(
          `
          SELECT
            id,
            user_id,
            status,
            payment_status,
            delivery_status,
            buyer_confirmed_at,
            refund_status,
            total_pi
          FROM orders
          WHERE id=?
          LIMIT 1
          FOR UPDATE
          `,
          [orderId]
        );

        if (!orders.length) {
          throw new Error("Order not found");
        }

        const order = orders[0];

        if (order.buyer_confirmed_at) {
          throw new Error(
            "Buyer has already confirmed receipt. The vendor cannot cancel this order."
          );
        }

        if (
          !["paid", "processing", "shipped"].includes(
            String(order.status)
          )
        ) {
          throw new Error(
            `Only paid/processing/shipped orders can be cancelled. Current status: ${order.status}`
          );
        }

        const [items] = await connection.query(
          `
          SELECT
            product_id,
            vendor_id,
            quantity
          FROM order_items
          WHERE order_id=?
          `,
          [orderId]
        );

        if (!items.length) {
          throw new Error("Order contains no items");
        }

        if (
          !items.every(
            item =>
              Number(item.vendor_id) ===
              Number(req.user.id)
          )
        ) {
          throw new Error(
            "You cannot cancel this order because it contains products from another vendor."
          );
        }

        if (
          !["none", "pending", "failed"].includes(
            String(order.refund_status)
          )
        ) {
          throw new Error(
            "This order already has an active or completed refund case."
          );
        }

        for (const item of items) {
          if (item.product_id) {
            await connection.query(
              `
              UPDATE products
              SET stock=stock+?
              WHERE id=?
              `,
              [item.quantity, item.product_id]
            );
          }
        }

        await connection.query(
          `
          UPDATE orders
          SET
            status='cancelled',
            delivery_status='cancelled',
            cancelled_by='vendor',
            cancellation_requested_at=CURRENT_TIMESTAMP,
            cancellation_reason=?,
            cancelled_at=CURRENT_TIMESTAMP,
            refund_status='pending'
          WHERE id=?
          `,
          [reason, orderId]
        );

        /*
         * Vendor sale earnings can no longer be paid.
         * Platform fee is also cancelled because the sale is
         * being refunded.
         */
        await connection.query(
          `
          UPDATE earnings
          SET status='cancelled'
          WHERE order_id=?
            AND type IN ('sale', 'platform_fee')
            AND status IN ('pending', 'available')
          `,
          [orderId]
        );

        await connection.query(
          `
          INSERT INTO refund_logs
          (
            order_id,
            user_id,
            event_type,
            amount_pi,
            reason
          )
          VALUES (?, ?, 'vendor_cancelled', ?, ?)
          `,
          [
            orderId,
            req.user.id,
            order.total_pi,
            reason
          ]
        );

        await connection.query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES (?, ?, 'refund')
          `,
          [
            order.user_id,
            `Vendor cancelled order #${orderId}. Your refund is now waiting for Admin processing.`
          ]
        );

        await notifyAdmins(
          connection,
          `Vendor cancelled order #${orderId}. Refund of ${roundPi(order.total_pi)} Pi is ready for Admin processing.`
        );

        await connection.commit();

        return res.json({
          success: true,
          message:
            "Order cancelled successfully. The refund is now ready for Admin processing.",
          order_id: orderId,
          refund_status: "pending"
        });
      } catch (error) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: error.message || "Unable to cancel order"
        });
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error("Vendor refund cancellation error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel order"
      });
    }
  }
);

/*
 * =========================================================
 * ADMIN: PENDING REFUNDS
 *
 * GET /api/refunds/admin/pending
 * =========================================================
 */
router.get(
  "/admin/pending",
  verifyAdmin,
  async (req, res) => {
    try {
      const [orders] = await db.promise().query(
        `
        SELECT
          o.id,
          o.user_id,
          o.vendor_id,
          o.checkout_ref,
          o.total_pi,
          o.status,
          o.payment_status,
          o.delivery_status,
          o.refund_status,
          o.refund_reason,
          o.refund_requested_at,
          o.refund_processed_at,
          o.refund_payment_id,
          o.refund_txid,
          o.refund_error,
          o.cancelled_by,
          o.cancelled_at,
          u.name AS buyer_name,
          u.email AS buyer_email,
          u.pi_uid AS buyer_pi_uid,
          u.pi_username AS buyer_pi_username,
          u2.name AS vendor_name,
          u2.pi_username AS vendor_pi_username
        FROM orders o
        JOIN users u
          ON u.id=o.user_id
        LEFT JOIN users u2
          ON u2.id=o.vendor_id
        WHERE o.refund_status IN ('pending', 'processing', 'failed')
        ORDER BY
          CASE o.refund_status
            WHEN 'processing' THEN 0
            WHEN 'pending' THEN 1
            ELSE 2
          END,
          o.refund_requested_at ASC,
          o.id DESC
        `
      );

      return res.json({
        success: true,
        refunds: orders || []
      });
    } catch (error) {
      console.error("Pending refunds error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load pending refunds"
      });
    }
  }
);

/*
 * =========================================================
 * ADMIN: CANCEL REFUND REQUEST
 *
 * POST /api/refunds/admin/:id/cancel
 *
 * This does not refund the buyer. It cancels the refund case.
 * The order remains cancelled if the vendor already cancelled it.
 * =========================================================
 */
router.post(
  "/admin/:id/cancel",
  verifyAdmin,
  async (req, res) => {
    const orderId = Number(req.params.id);
    const reason =
      String(
        req.body?.reason ||
        "Refund cancelled by Administrator."
      )
        .trim()
        .slice(0, 500);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    try {
      const connection = await db.promise().getConnection();

      try {
        await connection.beginTransaction();

        const [orders] = await connection.query(
          `
          SELECT id, user_id, refund_status, total_pi
          FROM orders
          WHERE id=?
          LIMIT 1
          FOR UPDATE
          `,
          [orderId]
        );

        if (!orders.length) {
          throw new Error("Order not found");
        }

        if (
          !["pending", "failed"].includes(
            String(orders[0].refund_status)
          )
        ) {
          throw new Error(
            "This refund cannot be cancelled in its current state"
          );
        }

        await connection.query(
          `
          UPDATE orders
          SET
            refund_status='cancelled',
            refund_error=?,
            refund_processed_by=?,
            refund_processed_at=CURRENT_TIMESTAMP
          WHERE id=?
          `,
          [reason, req.user.id, orderId]
        );

        await connection.query(
          `
          INSERT INTO refund_logs
          (
            order_id,
            user_id,
            event_type,
            amount_pi,
            reason
          )
          VALUES (?, ?, 'refund_cancelled', ?, ?)
          `,
          [
            orderId,
            req.user.id,
            orders[0].total_pi,
            reason
          ]
        );

        await connection.query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES (?, ?, 'refund')
          `,
          [
            orders[0].user_id,
            `Your refund request for order #${orderId} was cancelled by an Administrator. Reason: ${reason}`
          ]
        );

        await connection.commit();

        return res.json({
          success: true,
          message: "Refund request cancelled"
        });
      } catch (error) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: error.message || "Unable to cancel refund"
        });
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error("Admin refund cancellation error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel refund"
      });
    }
  }
);

/*
 * =========================================================
 * ADMIN: PROCESS A2U REFUND
 *
 * POST /api/refunds/admin/:id/process
 *
 * Buyer Pi UID is used as the A2U recipient.
 * PI_WALLET_PRIVATE_SEED stays on Railway/backend only.
 * =========================================================
 */
const REFUND_LOCK_NAME =
  "charcoal_marketplace_refund";

router.post(
  "/admin/:id/process",
  verifyAdmin,
  async (req, res) => {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    let connection = null;
    let lockAcquired = false;
    let paymentId = null;
    let txid = null;

    try {
      connection = await db.promise().getConnection();

      const [lockRows] = await connection.query(
        "SELECT GET_LOCK(?, 300) AS acquired",
        [REFUND_LOCK_NAME]
      );

      if (
        !lockRows.length ||
        Number(lockRows[0].acquired) !== 1
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Another refund is currently being processed. Please try again shortly."
        });
      }

      lockAcquired = true;

      await connection.beginTransaction();

      const [orders] = await connection.query(
        `
        SELECT
          o.*,
          u.name AS buyer_name,
          u.pi_uid AS buyer_pi_uid,
          u.pi_username AS buyer_pi_username
        FROM orders o
        JOIN users u
          ON u.id=o.user_id
        WHERE o.id=?
        LIMIT 1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!orders.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Order not found"
        });
      }

      const order = orders[0];

      if (
        !["pending", "failed", "processing"].includes(
          String(order.refund_status)
        )
      ) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message:
            `Refund is not processable from status '${order.refund_status}'`
        });
      }

      if (order.status !== "cancelled") {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message:
            "The vendor must cancel the order before Admin can release the refund."
        });
      }

      if (
        !order.buyer_pi_uid ||
        String(order.buyer_pi_uid).trim() === ""
      ) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message:
            "Buyer does not have a valid Pi UID, so the refund cannot be sent."
        });
      }

      const amount = roundPi(order.total_pi);

      if (!Number.isFinite(amount) || amount <= 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Invalid refund amount"
        });
      }

      await connection.query(
        `
        UPDATE orders
        SET
          refund_status='processing',
          refund_processed_by=?,
          refund_processed_at=CURRENT_TIMESTAMP,
          refund_error=NULL
        WHERE id=?
        `,
        [req.user.id, orderId]
      );

      await connection.query(
        `
        INSERT INTO refund_logs
        (
          order_id,
          user_id,
          event_type,
          amount_pi,
          reason
        )
        VALUES (?, ?, 'refund_processing', ?, ?)
        `,
        [
          orderId,
          req.user.id,
          amount,
          `Admin started A2U refund to ${order.buyer_pi_username || order.buyer_pi_uid}`
        ]
      );

      await connection.commit();

      paymentId = order.refund_payment_id || null;

      /*
       * Re-use an existing A2U payment when possible.
       * This prevents duplicate refunds if the request is retried.
       */
      let currentPayment = null;

      if (paymentId) {
        try {
          currentPayment =
            await fetchPaymentStrict(paymentId);
        } catch (fetchError) {
          if (
            Number(fetchError.status) === 404 ||
            fetchError.code === "payment_not_found"
          ) {
            await db.promise().query(
              `
              UPDATE orders
              SET
                refund_payment_id=NULL,
                refund_txid=NULL,
                refund_error=?
              WHERE id=?
                AND refund_status='processing'
              `,
              [
                "Previous refund payment was not found on Pi. A new refund payment will be created.",
                orderId
              ]
            );
            paymentId = null;
          } else {
            throw fetchError;
          }
        }
      }

      if (!paymentId) {
        const payment = await createA2UPayment({
          uid: String(order.buyer_pi_uid),
          amount,
          memo: `Charcoal Marketplace refund for order #${orderId}`,
          metadata: {
            type: "order_refund",
            order_id: String(orderId),
            buyer_id: String(order.user_id),
            admin_id: String(req.user.id)
          }
        });

        paymentId = payment.identifier;

        await db.promise().query(
          `
          UPDATE orders
          SET
            refund_payment_id=?,
            refund_error=NULL
          WHERE id=?
            AND refund_status='processing'
          `,
          [paymentId, orderId]
        );

        currentPayment = payment;
      }

      if (!currentPayment) {
        currentPayment =
          await fetchPaymentStrict(paymentId);
      }

      if (
        currentPayment.direction &&
        currentPayment.direction !== "app_to_user"
      ) {
        throw new Error(
          `Refund payment ${paymentId} is not an App-To-User payment`
        );
      }

      const currentStatus =
        currentPayment.status || {};

      if (
        currentStatus.cancelled === true ||
        currentStatus.user_cancelled === true
      ) {
        await db.promise().query(
          `
          UPDATE orders
          SET
            refund_status='failed',
            refund_payment_id=NULL,
            refund_txid=NULL,
            refund_error=?
          WHERE id=?
            AND refund_status='processing'
          `,
          [
            "Previous Pi refund payment was cancelled. A new refund can be attempted.",
            orderId
          ]
        );

        throw new Error(
          "The previous Pi refund payment was cancelled. Please process the refund again."
        );
      }

      const existingTxid =
        currentPayment.transaction?.txid ||
        currentPayment.transaction_id ||
        null;

      const alreadyCompleted =
        currentPayment.status?.developer_completed === true;

      if (alreadyCompleted && existingTxid) {
        txid = existingTxid;
      } else {
        const submission =
          await submitA2UPayment(paymentId);

        txid = submission.txid;
      }

      if (!txid) {
        throw new Error(
          "Pi blockchain submission did not return a transaction ID"
        );
      }

      await db.promise().query(
        `
        UPDATE orders
        SET
          refund_payment_id=?,
          refund_txid=?,
          refund_error=NULL
        WHERE id=?
          AND refund_status='processing'
        `,
        [paymentId, txid, orderId]
      );

      let completedPayment = currentPayment;

      if (!alreadyCompleted) {
        completedPayment =
          await completePayment(
            paymentId,
            txid
          );
      }

      const confirmed =
        await fetchPaymentStrict(paymentId);

      const completed =
        Boolean(
          completedPayment &&
          confirmed &&
          confirmed.status &&
          confirmed.status.developer_completed === true
        );

      if (!completed) {
        await db.promise().query(
          `
          UPDATE orders
          SET
            refund_error=?
          WHERE id=?
            AND refund_status='processing'
          `,
          [
            "Pi refund was submitted but is awaiting final confirmation.",
            orderId
          ]
        );

        return res.status(202).json({
          success: true,
          status: "processing",
          message:
            "Refund submitted to Pi and is awaiting final confirmation.",
          order_id: orderId,
          payment_id: paymentId,
          txid
        });
      }

      const connection2 =
        await db.promise().getConnection();

      try {
        await connection2.beginTransaction();

        const [finalOrderRows] =
          await connection2.query(
            `
            SELECT
              id,
              user_id,
              total_pi,
              refund_status
            FROM orders
            WHERE id=?
            LIMIT 1
            FOR UPDATE
            `,
            [orderId]
          );

        if (!finalOrderRows.length) {
          throw new Error("Order disappeared while completing refund");
        }

        if (
          finalOrderRows[0].refund_status === "completed"
        ) {
          await connection2.commit();

          return res.json({
            success: true,
            status: "completed",
            message: "Refund was already completed",
            order_id: orderId,
            payment_id: paymentId,
            txid
          });
        }

        await connection2.query(
          `
          UPDATE orders
          SET
            status='refunded',
            payment_status='refunded',
            delivery_status='cancelled',
            refund_status='completed',
            refund_payment_id=?,
            refund_txid=?,
            refund_error=NULL,
            refunded_at=CURRENT_TIMESTAMP,
            refund_processed_by=?,
            refund_processed_at=CURRENT_TIMESTAMP
          WHERE id=?
            AND refund_status='processing'
          `,
          [
            paymentId,
            txid,
            req.user.id,
            orderId
          ]
        );

        await connection2.query(
          `
          INSERT INTO earnings
          (
            user_id,
            order_id,
            type,
            amount_pi,
            status,
            description
          )
          VALUES (?, ?, 'refund', ?, 'paid', ?)
          `,
          [
            finalOrderRows[0].user_id,
            orderId,
            roundPi(finalOrderRows[0].total_pi),
            `Refund paid to buyer for order #${orderId}`
          ]
        );

        await connection2.query(
          `
          INSERT INTO refund_logs
          (
            order_id,
            user_id,
            event_type,
            amount_pi,
            pi_payment_id,
            txid,
            reason
          )
          VALUES (?, ?, 'refund_completed', ?, ?, ?, ?)
          `,
          [
            orderId,
            req.user.id,
            roundPi(finalOrderRows[0].total_pi),
            paymentId,
            txid,
            "A2U refund completed successfully"
          ]
        );

        await connection2.query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES (?, ?, 'refund')
          `,
          [
            finalOrderRows[0].user_id,
            `Your refund of ${roundPi(finalOrderRows[0].total_pi)} Pi for order #${orderId} has been sent successfully. Transaction: ${txid}`
          ]
        );

        await connection2.commit();
      } catch (finalError) {
        await connection2.rollback();
        throw finalError;
      } finally {
        connection2.release();
      }

      return res.json({
        success: true,
        status: "completed",
        message:
          `Refund of ${amount} Pi sent successfully to ${order.buyer_name || "buyer"}`,
        order_id: orderId,
        payment_id: paymentId,
        txid
      });
    } catch (error) {
      console.error(
        "Admin A2U refund error:",
        error.response?.data || error
      );

      try {
        await db.promise().query(
          `
          UPDATE orders
          SET
            refund_status='failed',
            refund_error=?,
            refund_payment_id=COALESCE(?, refund_payment_id),
            refund_txid=COALESCE(?, refund_txid)
          WHERE id=?
            AND refund_status='processing'
          `,
          [
            String(
              error.response?.data?.message ||
              error.message ||
              "Refund failed"
            ).slice(0, 5000),
            paymentId,
            txid,
            orderId
          ]
        );

        await db.promise().query(
          `
          INSERT INTO refund_logs
          (
            order_id,
            user_id,
            event_type,
            amount_pi,
            pi_payment_id,
            txid,
            error_message
          )
          SELECT
            id,
            ?,
            'refund_failed',
            total_pi,
            ?,
            ?,
            ?
          FROM orders
          WHERE id=?
          `,
          [
            req.user.id,
            paymentId,
            txid,
            String(
              error.message ||
              "Refund failed"
            ).slice(0, 5000),
            orderId
          ]
        );
      } catch (logError) {
        console.error(
          "Refund failure logging error:",
          logError
        );
      }

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Refund processing failed",
        order_id: orderId,
        payment_id: paymentId,
        txid
      });
    } finally {
      if (lockAcquired && connection) {
        try {
          await connection.query(
            "SELECT RELEASE_LOCK(?)",
            [REFUND_LOCK_NAME]
          );
        } catch (releaseError) {
          console.error(
            "Refund lock release error:",
            releaseError
          );
        }
      }

      if (connection) {
        connection.release();
      }
    }
  }
);

module.exports = router;
