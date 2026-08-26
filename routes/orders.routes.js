const router = require("express").Router();
const crypto = require("crypto");
const db = require("../config/db");
const { verifyToken } = require("../middleware/auth.middleware");

function money(value) {
  return Number(Number(value || 0).toFixed(8));
}


/* =========================================================
   CHECKOUT
   Creates one order containing one or more order_items.

   Product prices and stock are always read from MySQL.
========================================================= */

router.post("/checkout", verifyToken(), async (req, res) => {

  const items =
    Array.isArray(req.body?.items)
      ? req.body.items
      : [];


  if (!items.length) {

    return res.status(400).json({
      success: false,
      message: "Cart is empty"
    });

  }


  if (items.length > 30) {

    return res.status(400).json({
      success: false,
      message: "Too many items"
    });

  }


  const normalized =
    items.map(item => ({
      product_id:
        Number(
          item.product_id ??
          item.id
        ),

      quantity:
        Number(
          item.quantity ??
          item.qty ??
          1
        )
    }));


  if (
    normalized.some(
      item =>
        !Number.isInteger(item.product_id) ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100
    )
  ) {

    return res.status(400).json({
      success: false,
      message: "Invalid cart item"
    });

  }


  const connection =
    await db.promise().getConnection();


  const checkoutRef =
    `CHK-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;


  try {

    await connection.beginTransaction();


    let total = 0;

    const createdItems = [];

    const vendorIds =
      new Set();


    for (const item of normalized) {

      const [rows] =
        await connection.query(
          `SELECT
             id,
             name,
             price_pi,
             stock,
             vendor_id
           FROM products
           WHERE id=?
             AND status='approved'
             AND is_active=TRUE
           FOR UPDATE`,
          [
            item.product_id
          ]
        );


      if (!rows.length) {

        throw new Error(
          `Product ${item.product_id} is not available`
        );

      }


      const product =
        rows[0];


      if (
        Number(product.stock) <
        item.quantity
      ) {

        throw new Error(
          `${product.name} does not have enough stock`
        );

      }


      const subtotal =
        Number(product.price_pi) *
        item.quantity;


      total += subtotal;


      vendorIds.add(
        Number(product.vendor_id)
      );


      await connection.query(
        `UPDATE products
         SET stock=stock-?
         WHERE id=?
           AND stock>=?`,
        [
          item.quantity,
          product.id,
          item.quantity
        ]
      );


      createdItems.push({

        product_id:
          product.id,

        vendor_id:
          product.vendor_id,

        product_name:
          product.name,

        unit_price_pi:
          Number(product.price_pi),

        quantity:
          item.quantity,

        subtotal_pi:
          subtotal

      });

    }


    const totalPi =
      money(total);


    const vendorId =
      vendorIds.size === 1
        ? [...vendorIds][0]
        : null;


    const [orderResult] =
      await connection.query(
        `INSERT INTO orders
         (
           user_id,
           vendor_id,
           checkout_ref,
           total_pi,
           status,
           payment_status,
           delivery_status
         )
         VALUES
         (
           ?,
           ?,
           ?,
           ?,
           'pending',
           'pending',
           'pending'
         )`,
        [
          req.user.id,
          vendorId,
          checkoutRef,
          totalPi
        ]
      );


    const orderId =
      orderResult.insertId;


    for (const item of createdItems) {

      await connection.query(
        `INSERT INTO order_items
         (
           order_id,
           product_id,
           vendor_id,
           product_name,
           unit_price_pi,
           quantity,
           subtotal_pi
         )
         VALUES
         (
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?
         )`,
        [
          orderId,
          item.product_id,
          item.vendor_id,
          item.product_name,
          item.unit_price_pi,
          item.quantity,
          item.subtotal_pi
        ]
      );

    }


    await connection.commit();


    return res.status(201).json({

      success: true,

      checkout_ref:
        checkoutRef,

      order_id:
        orderId,

      total_pi:
        totalPi,

      orders:
        createdItems.map(item => ({

          product_id:
            item.product_id,

          name:
            item.product_name,

          quantity:
            item.quantity,

          line_total:
            money(item.subtotal_pi)

        }))

    });


  } catch (error) {

    try {
      await connection.rollback();
    } catch {}


    console.error(
      "Checkout:",
      error
    );


    return res.status(400).json({

      success: false,

      message:
        error.message ||
        "Unable to create checkout"

    });


  } finally {

    connection.release();

  }

});


/* =========================================================
   LEGACY SINGLE-PRODUCT CHECKOUT
========================================================= */

router.post("/", verifyToken(), async (req, res) => {

  const productId =
    Number(req.body?.product_id);


  const quantity =
    Number(
      req.body?.quantity || 1
    );


  if (
    !Number.isInteger(productId) ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {

    return res.status(400).json({
      success: false,
      message: "Invalid product or quantity"
    });

  }


  const connection =
    await db.promise().getConnection();


  const checkoutRef =
    `CHK-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;


  try {

    await connection.beginTransaction();


    const [rows] =
      await connection.query(
        `SELECT
           id,
           name,
           price_pi,
           stock,
           vendor_id
         FROM products
         WHERE id=?
           AND status='approved'
           AND is_active=TRUE
         FOR UPDATE`,
        [
          productId
        ]
      );


    if (!rows.length) {

      throw new Error(
        "Product not found"
      );

    }


    const product =
      rows[0];


    if (
      Number(product.stock) <
      quantity
    ) {

      throw new Error(
        "Insufficient stock"
      );

    }


    const total =
      money(
        Number(product.price_pi) *
        quantity
      );


    await connection.query(
      `UPDATE products
       SET stock=stock-?
       WHERE id=?
         AND stock>=?`,
      [
        quantity,
        product.id,
        quantity
      ]
    );


    const [orderResult] =
      await connection.query(
        `INSERT INTO orders
         (
           user_id,
           vendor_id,
           checkout_ref,
           total_pi,
           status,
           payment_status,
           delivery_status
         )
         VALUES
         (
           ?,
           ?,
           ?,
           ?,
           'pending',
           'pending',
           'pending'
         )`,
        [
          req.user.id,
          product.vendor_id,
          checkoutRef,
          total
        ]
      );


    await connection.query(
      `INSERT INTO order_items
       (
         order_id,
         product_id,
         vendor_id,
         product_name,
         unit_price_pi,
         quantity,
         subtotal_pi
       )
       VALUES
       (
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         ?
       )`,
      [
        orderResult.insertId,
        product.id,
        product.vendor_id,
        product.name,
        product.price_pi,
        quantity,
        total
      ]
    );


    await connection.commit();


    return res.status(201).json({

      success: true,

      order_id:
        orderResult.insertId,

      checkout_ref:
        checkoutRef,

      total,

      product

    });


  } catch (error) {

    try {
      await connection.rollback();
    } catch {}


    console.error(
      "Legacy checkout:",
      error
    );


    return res.status(400).json({

      success: false,

      message:
        error.message ||
        "Failed to create order"

    });


  } finally {

    connection.release();

  }

});


/* =========================================================
   BUYER ORDERS
   GET /api/orders/my
========================================================= */

router.get(
  "/my",
  verifyToken(),
  (req, res) => {

    db.query(
      `SELECT
         o.*,
         oi.product_id,
         oi.vendor_id AS item_vendor_id,
         oi.product_name,
         oi.unit_price_pi,
         oi.quantity,
         oi.subtotal_pi,
         p.image,
         p.location
       FROM orders o
       JOIN order_items oi
         ON oi.order_id=o.id
       LEFT JOIN products p
         ON p.id=oi.product_id
       WHERE o.user_id=?
       ORDER BY o.id DESC, oi.id ASC`,
      [
        req.user.id
      ],
      (err, rows) => {

        if (err) {

          console.error(
            "My orders:",
            err
          );


          return res.status(500).json({
            success: false,
            message: "DB error"
          });

        }


        return res.json(
          rows || []
        );

      }
    );

  }
);


/* =========================================================
   BUYER CONFIRM PRODUCT RECEIVED

   POST /api/orders/:id/confirm-received

   IMPORTANT PAYOUT FLOW:

   Buyer confirms receipt
        ↓
   orders.buyer_confirmed_at
        ↓
   Calculate vendor earnings
        ↓
   Create earnings rows
        ↓
   earnings.type = 'sale'
   earnings.status = 'pending'
        ↓
   Admin can see the vendor payout
        ↓
   Admin releases Pi
========================================================= */

router.post(
  "/:id/confirm-received",
  verifyToken(),
  async (req, res) => {

    const orderId =
      Number(req.params.id);


    if (!Number.isInteger(orderId)) {

      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });

    }


    const connection =
      await db.promise().getConnection();


    try {

      await connection.beginTransaction();


      /* =====================================================
         LOAD AND LOCK ORDER
      ===================================================== */

      const [orders] =
        await connection.query(
          `
          SELECT
            id,
            user_id,
            status,
            payment_status,
            delivery_status,
            buyer_confirmed_at
          FROM orders
          WHERE id=?
            AND user_id=?
          LIMIT 1
          FOR UPDATE
          `,
          [
            orderId,
            req.user.id
          ]
        );


      if (!orders.length) {

        await connection.rollback();


        return res.status(404).json({
          success: false,
          message: "Order not found"
        });

      }


      const order =
        orders[0];


      /* =====================================================
         PREVENT DUPLICATE BUYER CONFIRMATION
      ===================================================== */

      if (
        order.buyer_confirmed_at
      ) {

        await connection.rollback();


        return res.status(409).json({

          success: false,

          message:
            "You have already confirmed receipt of this order",

          confirmed_at:
            order.buyer_confirmed_at

        });

      }


      /* =====================================================
         PAYMENT MUST BE COMPLETED
      ===================================================== */

      if (
        order.payment_status !==
        "paid"
      ) {

        await connection.rollback();


        return res.status(400).json({

          success: false,

          message:
            "This order has not been paid successfully"

        });

      }


      /* =====================================================
         DELIVERY MUST BE COMPLETED
      ===================================================== */

      if (
        order.delivery_status !==
          "delivered" &&
        order.status !==
          "completed"
      ) {

        await connection.rollback();


        return res.status(400).json({

          success: false,

          message:
            "You can only confirm an order after it has been delivered"

        });

      }


      /* =====================================================
         GET ALL ORDER ITEMS
         
         We use order_items because one order may contain
         products belonging to multiple vendors.
      ===================================================== */

      const [orderItems] =
        await connection.query(
          `
          SELECT
            oi.id,
            oi.order_id,
            oi.product_id,
            oi.vendor_id,
            oi.product_name,
            oi.unit_price_pi,
            oi.quantity,
            oi.subtotal_pi,

            u.name AS vendor_name,
            u.pi_uid,
            u.pi_username,
            u.role AS vendor_role,
            u.status AS vendor_account_status,
            u.vendor_status,
            u.pi_wallet_address

          FROM order_items oi

          LEFT JOIN users u
            ON u.id=oi.vendor_id

          WHERE oi.order_id=?

          ORDER BY oi.id ASC

          FOR UPDATE
          `,
          [
            orderId
          ]
        );


      if (!orderItems.length) {

        await connection.rollback();


        return res.status(400).json({

          success: false,

          message:
            "This order contains no valid order items"

        });

      }


      /* =====================================================
         MARK ORDER AS CONFIRMED
         
         We do this inside the SAME transaction as earnings
         creation.
         
         Therefore:
         - either confirmation + earnings succeed together
         - or everything rolls back
      ===================================================== */

      const [confirmResult] =
        await connection.query(
          `
          UPDATE orders
          SET
            buyer_confirmed_at =
              CURRENT_TIMESTAMP
          WHERE id=?
            AND user_id=?
            AND buyer_confirmed_at IS NULL
          `,
          [
            orderId,
            req.user.id
          ]
        );


      if (!confirmResult.affectedRows) {

        await connection.rollback();


        return res.status(409).json({

          success: false,

          message:
            "Order has already been confirmed"

        });

      }


      /* =====================================================
         GROUP ORDER ITEMS BY VENDOR
         
         This is important for the multivendor marketplace.

         Example:

         Vendor A:
           Product 1 = 20 Pi
           Product 2 = 10 Pi

         Vendor B:
           Product 3 = 15 Pi

         Result:

         Vendor A = 30 Pi
         Vendor B = 15 Pi
      ===================================================== */

      const vendorEarnings =
        new Map();


      for (const item of orderItems) {

        const vendorId =
          Number(item.vendor_id);


        if (
          !Number.isInteger(vendorId) ||
          vendorId <= 0
        ) {

          continue;

        }


        const subtotal =
          money(
            item.subtotal_pi
          );


        if (
          !Number.isFinite(subtotal) ||
          subtotal <= 0
        ) {

          continue;

        }


        if (
          !vendorEarnings.has(
            vendorId
          )
        ) {

          vendorEarnings.set(
            vendorId,
            {
              vendor_id:
                vendorId,

              vendor_name:
                item.vendor_name ||
                "Vendor",

              pi_uid:
                item.pi_uid ||
                null,

              pi_username:
                item.pi_username ||
                null,

              pi_wallet_address:
                item.pi_wallet_address ||
                null,

              amount_pi:
                0
            }
          );

        }


        const vendor =
          vendorEarnings.get(
            vendorId
          );


        vendor.amount_pi =
          money(
            vendor.amount_pi +
            subtotal
          );

      }


      /* =====================================================
         MAKE SURE AT LEAST ONE VALID VENDOR EXISTS
      ===================================================== */

      if (
        vendorEarnings.size === 0
      ) {

        await connection.rollback();


        return res.status(400).json({

          success: false,

          message:
            "No valid vendor earnings could be calculated for this order"

        });

      }


      /* =====================================================
         CREATE VENDOR EARNINGS
         
         Each vendor gets one earnings record per order.

         earnings:
           type   = sale
           status = pending

         This is exactly what
         /api/admin/earnings/pending searches for.
      ===================================================== */

      const createdEarnings = [];


      for (
        const vendor of
        vendorEarnings.values()
      ) {

        /* =================================================
           VALIDATE VENDOR ACCOUNT
        ================================================= */

        if (
          vendor.pi_uid === null ||
          String(
            vendor.pi_uid
          ).trim() === ""
        ) {

          await connection.rollback();


          return res.status(400).json({

            success: false,

            message:
              `Vendor ${vendor.vendor_name} does not have a valid Pi UID and cannot receive earnings.`

          });

        }


        /* =================================================
           VERIFY VENDOR STATUS
        ================================================= */

        const [vendorRows] =
          await connection.query(
            `
            SELECT
              id,
              name,
              role,
              status,
              vendor_status,
              pi_uid,
              pi_username,
              pi_wallet_address

            FROM users

            WHERE id=?

            LIMIT 1

            FOR UPDATE
            `,
            [
              vendor.vendor_id
            ]
          );


        if (!vendorRows.length) {

          await connection.rollback();


          return res.status(404).json({

            success: false,

            message:
              `Vendor account ${vendor.vendor_id} was not found`

          });

        }


        const vendorAccount =
          vendorRows[0];


        if (
          vendorAccount.role !==
            "vendor" ||
          vendorAccount.status !==
            "approved" ||
          vendorAccount.vendor_status !==
            "approved"
        ) {

          await connection.rollback();


          return res.status(400).json({

            success: false,

            message:
              `Vendor ${vendorAccount.name || vendor.vendor_id} is not approved to receive earnings`

          });

        }


        /* =================================================
           CHECK FOR EXISTING EARNING
           
           This prevents duplicate vendor earnings if,
           for any reason, the same order reaches this
           logic again.
        ================================================= */

        const [existingEarnings] =
          await connection.query(
            `
            SELECT
              id,
              status,
              amount_pi,
              payout_payment_id,
              payout_txid

            FROM earnings

            WHERE order_id=?
              AND vendor_id=?
              AND type='sale'

            LIMIT 1

            FOR UPDATE
            `,
            [
              orderId,
              vendor.vendor_id
            ]
          );


        if (
          existingEarnings.length
        ) {

          const existing =
            existingEarnings[0];


          /*
           * If the earning already exists and is paid,
           * do not create another one.
           */

          if (
            existing.status ===
            "paid"
          ) {

            await connection.rollback();


            return res.status(409).json({

              success: false,

              message:
                `Vendor earning for ${vendor.vendor_name} has already been paid.`

            });

          }


          /*
           * If it already exists but is still pending,
           * simply reuse it.
           */

          createdEarnings.push({

            id:
              existing.id,

            vendor_id:
              vendor.vendor_id,

            amount_pi:
              money(
                existing.amount_pi
              ),

            status:
              existing.status,

            existing:
              true

          });


          continue;

        }


        /* =================================================
           INSERT NEW PENDING VENDOR EARNING
        ================================================= */

        const [earningResult] =
          await connection.query(
            `
            INSERT INTO earnings
            (
              user_id,
              order_id,
              vendor_id,
              type,
              amount_pi,
              status,
              description,
              payout_payment_id,
              payout_txid,
              paid_at,
              payout_error,
              created_at
            )
            VALUES
            (
              ?,
              ?,
              ?,
              'sale',
              ?,
              'pending',
              ?,
              NULL,
              NULL,
              NULL,
              NULL,
              CURRENT_TIMESTAMP
            )
            `,
            [
              vendor.vendor_id,
              orderId,
              vendor.vendor_id,

              money(
                vendor.amount_pi
              ),

              `Vendor sale earning for order #${orderId}`
            ]
          );


        createdEarnings.push({

          id:
            earningResult.insertId,

          vendor_id:
            vendor.vendor_id,

          vendor_name:
            vendor.vendor_name,

          amount_pi:
            money(
              vendor.amount_pi
            ),

          status:
            "pending",

          existing:
            false

        });

      }


      /* =====================================================
         CREATE VENDOR NOTIFICATIONS
      ===================================================== */

      for (
        const vendor of
        vendorEarnings.values()
      ) {

        await connection.query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES
          (
            ?,
            ?,
            ?
          )
          `,
          [
            vendor.vendor_id,

            `Buyer has confirmed receipt of order #${orderId}. Your earning of ${money(vendor.amount_pi)} Pi is now pending Admin release.`,

            "earning"
          ]
        );

      }


      /* =====================================================
         COMMIT EVERYTHING
         
         At this point the following are committed together:

         1. buyer_confirmed_at
         2. vendor earnings
         3. vendor notifications
      ===================================================== */

      await connection.commit();


      /* =====================================================
         RETURN SUCCESS
      ===================================================== */

      return res.json({

        success: true,

        message:
          "Product receipt confirmed successfully. Vendor earnings are now pending Admin release.",

        order_id:
          orderId,

        buyer_confirmed_at:
          new Date().toISOString(),

        payout_status:
          "awaiting_admin_release",

        earnings:
          createdEarnings.map(
            earning => ({
              earning_id:
                earning.id,

              vendor_id:
                earning.vendor_id,

              amount_pi:
                earning.amount_pi,

              status:
                earning.status
            })
          )

      });


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      console.error(
        "Confirm product received:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Failed to confirm product receipt"

      });


    } finally {

      connection.release();

    }

  }
);


/* =========================================================
   VENDOR ORDERS
   GET /api/orders/vendor
========================================================= */

router.get(
  "/vendor",
  verifyToken(["vendor"]),
  (req, res) => {

    db.query(
      `SELECT
         o.*,
         oi.product_id,
         oi.product_name AS name,
         oi.quantity,
         oi.unit_price_pi,
         oi.subtotal_pi,
         oi.vendor_id,
         u.name AS buyer_name,
         u.pi_username,
         p.image
       FROM order_items oi
       JOIN orders o
         ON o.id=oi.order_id
       JOIN users u
         ON u.id=o.user_id
       LEFT JOIN products p
         ON p.id=oi.product_id
       WHERE oi.vendor_id=?
       ORDER BY o.id DESC, oi.id ASC`,
      [
        req.user.id
      ],
      (err, rows) => {

        if (err) {

          console.error(
            "Vendor orders:",
            err
          );


          return res.status(500).json({
            success: false,
            message: "DB error"
          });

        }


        return res.json(
          rows || []
        );

      }
    );

  }
);


/* =========================================================
   ADMIN ORDERS
   GET /api/orders
========================================================= */

router.get(
  "/",
  verifyToken(["admin"]),
  (req, res) => {

    db.query(
      `SELECT
         o.*,
         u.name AS buyer_name,
         u.pi_username,
         oi.product_name AS name,
         oi.product_id,
         oi.vendor_id,
         oi.quantity,
         oi.unit_price_pi,
         oi.subtotal_pi,
         p.image
       FROM orders o
       JOIN users u
         ON u.id=o.user_id
       LEFT JOIN order_items oi
         ON oi.order_id=o.id
       LEFT JOIN products p
         ON p.id=oi.product_id
       ORDER BY o.id DESC, oi.id ASC`,
      (err, rows) => {

        if (err) {

          console.error(
            "Admin orders:",
            err
          );


          return res.status(500).json({
            success: false,
            message: "DB error"
          });

        }


        return res.json(
          rows || []
        );

      }
    );

  }
);


/* =========================================================
   ORDER STATUS UPDATES

   PUT /api/orders/:id/status

   Vendor flow:

   paid
      ↓
   processing
      ↓
   shipped
      ↓
   completed
      ↓
   buyer confirms receipt

   Admin can update order status when necessary.
========================================================= */

router.put(
  "/:id/status",
  verifyToken(),
  async (req, res) => {

    const orderId =
      Number(req.params.id);


    const requestedStatus =
      String(
        req.body?.status || ""
      ).toLowerCase();


    const allowedStatuses = [
      "pending",
      "paid",
      "processing",
      "shipped",
      "completed",
      "cancelled",
      "rejected",
      "refunded"
    ];


    if (
      !Number.isInteger(orderId) ||
      !allowedStatuses.includes(
        requestedStatus
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid order or status"

      });

    }


    try {

      const [orders] =
        await db.promise().query(
          `
          SELECT
            id,
            user_id,
            vendor_id,
            status,
            payment_status,
            delivery_status,
            buyer_confirmed_at
          FROM orders
          WHERE id=?
          LIMIT 1
          `,
          [
            orderId
          ]
        );


      if (!orders.length) {

        return res.status(404).json({

          success: false,

          message:
            "Order not found"

        });

      }


      const order =
        orders[0];


      /*
       * Only admin and vendor can use
       * this endpoint.
       */

      if (
        req.user.role !== "admin" &&
        req.user.role !== "vendor"
      ) {

        return res.status(403).json({

          success: false,

          message:
            "Not allowed"

        });

      }


      /* =====================================================
         ADMIN
      ===================================================== */

      if (
        req.user.role === "admin"
      ) {

        await db.promise().query(
          `
          UPDATE orders
          SET
            status=?,

            payment_status=
              CASE
                WHEN ?='paid'
                  THEN 'paid'

                WHEN ?='cancelled'
                  THEN 'cancelled'

                WHEN ?='refunded'
                  THEN 'refunded'

                ELSE payment_status
              END,

            delivery_status=
              CASE
                WHEN ?='shipped'
                  THEN 'shipped'

                WHEN ?='completed'
                  THEN 'delivered'

                WHEN ?='cancelled'
                  THEN 'cancelled'

                ELSE delivery_status
              END,

            paid_at=
              CASE
                WHEN ?='paid'
                  AND paid_at IS NULL
                  THEN CURRENT_TIMESTAMP

                ELSE paid_at
              END,

            shipped_at=
              CASE
                WHEN ?='shipped'
                  AND shipped_at IS NULL
                  THEN CURRENT_TIMESTAMP

                ELSE shipped_at
              END,

            completed_at=
              CASE
                WHEN ?='completed'
                  AND completed_at IS NULL
                  THEN CURRENT_TIMESTAMP

                ELSE completed_at
              END,

            cancelled_at=
              CASE
                WHEN ?='cancelled'
                  AND cancelled_at IS NULL
                  THEN CURRENT_TIMESTAMP

                ELSE cancelled_at
              END,

            refunded_at=
              CASE
                WHEN ?='refunded'
                  AND refunded_at IS NULL
                  THEN CURRENT_TIMESTAMP

                ELSE refunded_at
              END

          WHERE id=?
          `,
          [
            requestedStatus,

            requestedStatus,
            requestedStatus,
            requestedStatus,

            requestedStatus,
            requestedStatus,
            requestedStatus,

            requestedStatus,
            requestedStatus,
            requestedStatus,
            requestedStatus,
            requestedStatus,

            orderId
          ]
        );


        return res.json({

          success: true,

          message:
            "Order status updated successfully",

          order_id:
            orderId,

          status:
            requestedStatus

        });

      }


      /* =====================================================
         VENDOR
      ===================================================== */

      const [items] =
        await db.promise().query(
          `
          SELECT
            vendor_id
          FROM order_items
          WHERE order_id=?
          `,
          [
            orderId
          ]
        );


      if (!items.length) {

        return res.status(400).json({

          success: false,

          message:
            "Order contains no items"

        });

      }


      /*
       * Vendor must own EVERY item.
       */

      const vendorOwnsEveryItem =
        items.every(
          item =>
            Number(item.vendor_id) ===
            Number(req.user.id)
        );


      if (!vendorOwnsEveryItem) {

        return res.status(403).json({

          success: false,

          message:
            "You cannot update this order because it contains products from another vendor"

        });

      }


      /*
       * Do not allow changes after
       * buyer confirmation.
       */

      if (
        order.buyer_confirmed_at
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Buyer has already confirmed receipt. This order can no longer be changed by the vendor."

        });

      }


      const currentStatus =
        String(
          order.status ||
          "pending"
        ).toLowerCase();


      /* =====================================================
         VENDOR STATUS TRANSITIONS
      ===================================================== */

      const validTransition =

        (
          currentStatus === "paid" &&
          requestedStatus === "processing"
        )

        ||

        (
          currentStatus === "paid" &&
          requestedStatus === "shipped"
        )

        ||

        (
          currentStatus === "processing" &&
          requestedStatus === "shipped"
        )

        ||

        (
          currentStatus === "shipped" &&
          requestedStatus === "completed"
        );


      if (!validTransition) {

        return res.status(409).json({

          success: false,

          message:
            `Invalid status transition: ${currentStatus} → ${requestedStatus}`

        });

      }


      /*
       * Vendor cannot mark an order as completed
       * unless it has first been shipped.
       *
       * completed = delivered.
       */

      await db.promise().query(
        `
        UPDATE orders
        SET
          status=?,

          delivery_status=
            CASE
              WHEN ?='shipped'
                THEN 'shipped'

              WHEN ?='completed'
                THEN 'delivered'

              ELSE delivery_status
            END,

          shipped_at=
            CASE
              WHEN ?='shipped'
                THEN CURRENT_TIMESTAMP

              ELSE shipped_at
            END,

          completed_at=
            CASE
              WHEN ?='completed'
                THEN CURRENT_TIMESTAMP

              ELSE completed_at
            END

        WHERE id=?
        `,
        [
          requestedStatus,

          requestedStatus,
          requestedStatus,

          requestedStatus,
          requestedStatus,

          orderId
        ]
      );


      /*
       * Notify buyer when shipped.
       */

      if (
        requestedStatus === "shipped"
      ) {

        await db.promise().query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES
          (
            ?,
            ?,
            ?
          )
          `,
          [
            order.user_id,

            `Your order #${orderId} has been shipped by the vendor.`,

            "order"
          ]
        );

      }


      /*
       * Notify buyer when delivered.
       */

      if (
        requestedStatus === "completed"
      ) {

        await db.promise().query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          VALUES
          (
            ?,
            ?,
            ?
          )
          `,
          [
            order.user_id,

            `Your order #${orderId} has been delivered. Please confirm that you received your product.`,

            "order"
          ]
        );

      }


      return res.json({

        success: true,

        message:
          requestedStatus === "processing"
            ? "Order is now being processed."

            : requestedStatus === "shipped"
              ? "Order marked as shipped successfully."

              : "Order marked as delivered successfully.",

        order_id:
          orderId,

        status:
          requestedStatus,

        delivery_status:
          requestedStatus === "shipped"
            ? "shipped"

            : requestedStatus === "completed"
              ? "delivered"

              : order.delivery_status

      });


    } catch (error) {

      console.error(
        "Update order status:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to update order status"

      });

    }

  }
);


/* =========================================================
   DELETE ORDER
   DELETE /api/orders/:id

   Admin only.

   Paid/processed orders cannot be deleted.
========================================================= */

router.delete(
  "/:id",
  verifyToken(["admin"]),
  async (req, res) => {

    const orderId =
      Number(req.params.id);


    if (!Number.isInteger(orderId)) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid order ID"

      });

    }


    try {

      const [orders] =
        await db.promise().query(
          `
          SELECT
            id,
            status
          FROM orders
          WHERE id=?
          LIMIT 1
          `,
          [
            orderId
          ]
        );


      if (!orders.length) {

        return res.status(404).json({

          success: false,

          message:
            "Order not found"

        });

      }


      if (
        [
          "paid",
          "processing",
          "shipped",
          "completed"
        ].includes(
          orders[0].status
        )
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Paid/processed orders cannot be deleted"

        });

      }


      await db.promise().query(
        `
        DELETE FROM orders
        WHERE id=?
        `,
        [
          orderId
        ]
      );


      return res.json({

        success: true

      });


    } catch (error) {

      console.error(
        "Delete order:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "DB error"

      });

    }

  }
);


/* =========================================================
   EXPORT ROUTER
========================================================= */

module.exports = router;