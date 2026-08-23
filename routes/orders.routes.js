const router = require("express").Router();
const crypto = require("crypto");
const db = require("../config/db");
const { verifyToken } = require("../middleware/auth.middleware");

function money(value) {
  return Number(Number(value || 0).toFixed(8));
}

/*
 * Creates one order containing one or more order_items.
 * Product prices and stock are always read from MySQL.
 */
router.post("/checkout", verifyToken(), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

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

  const normalized = items.map(item => ({
    product_id: Number(item.product_id ?? item.id),
    quantity: Number(item.quantity ?? item.qty ?? 1)
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

  const connection = await db.promise().getConnection();
  const checkoutRef =
    `CHK-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;

  try {
    await connection.beginTransaction();

    let total = 0;
    const createdItems = [];
    const vendorIds = new Set();

    for (const item of normalized) {
      const [rows] = await connection.query(
        `SELECT id,name,price_pi,stock,vendor_id
         FROM products
         WHERE id=? AND status='approved' AND is_active=TRUE
         FOR UPDATE`,
        [item.product_id]
      );

      if (!rows.length) {
        throw new Error(
          `Product ${item.product_id} is not available`
        );
      }

      const product = rows[0];

      if (Number(product.stock) < item.quantity) {
        throw new Error(
          `${product.name} does not have enough stock`
        );
      }

      const subtotal =
        Number(product.price_pi) * item.quantity;

      total += subtotal;

      vendorIds.add(Number(product.vendor_id));

      await connection.query(
        `UPDATE products
         SET stock=stock-?
         WHERE id=? AND stock>=?`,
        [item.quantity, product.id, item.quantity]
      );

      createdItems.push({
        product_id: product.id,
        vendor_id: product.vendor_id,
        product_name: product.name,
        unit_price_pi: Number(product.price_pi),
        quantity: item.quantity,
        subtotal_pi: subtotal
      });
    }

    const totalPi = money(total);
    const vendorId =
      vendorIds.size === 1 ? [...vendorIds][0] : null;

    const [orderResult] = await connection.query(
      `INSERT INTO orders
       (user_id,vendor_id,checkout_ref,total_pi,status,payment_status,
        delivery_status)
       VALUES (?,?,?,?,'pending','pending','pending')`,
      [
        req.user.id,
        vendorId,
        checkoutRef,
        totalPi
      ]
    );

    const orderId = orderResult.insertId;

    for (const item of createdItems) {
      await connection.query(
        `INSERT INTO order_items
         (order_id,product_id,vendor_id,product_name,
          unit_price_pi,quantity,subtotal_pi)
         VALUES (?,?,?,?,?,?,?)`,
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

    res.status(201).json({
      success: true,
      checkout_ref: checkoutRef,
      order_id: orderId,
      total_pi: totalPi,
      orders: createdItems.map(item => ({
        product_id: item.product_id,
        name: item.product_name,
        quantity: item.quantity,
        line_total: money(item.subtotal_pi)
      }))
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}

    console.error("Checkout:", error);

    res.status(400).json({
      success: false,
      message:
        error.message || "Unable to create checkout"
    });
  } finally {
    connection.release();
  }
});

/* Legacy single-product endpoint. */
router.post("/", verifyToken(), async (req, res) => {
  const productId = Number(req.body?.product_id);
  const quantity = Number(req.body?.quantity || 1);

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

  req.body.items = [
    {
      product_id: productId,
      quantity
    }
  ];

  /* Keep the legacy endpoint independent so Express does not
     need to internally re-enter another middleware chain. */
  const connection = await db.promise().getConnection();
  const checkoutRef =
    `CHK-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id,name,price_pi,stock,vendor_id
       FROM products
       WHERE id=? AND status='approved' AND is_active=TRUE
       FOR UPDATE`,
      [productId]
    );

    if (!rows.length) {
      throw new Error("Product not found");
    }

    const product = rows[0];

    if (Number(product.stock) < quantity) {
      throw new Error("Insufficient stock");
    }

    const total = money(
      Number(product.price_pi) * quantity
    );

    await connection.query(
      `UPDATE products
       SET stock=stock-?
       WHERE id=? AND stock>=?`,
      [quantity, product.id, quantity]
    );

    const [orderResult] = await connection.query(
      `INSERT INTO orders
       (user_id,vendor_id,checkout_ref,total_pi,status,payment_status,
        delivery_status)
       VALUES (?,?,?,?,'pending','pending','pending')`,
      [
        req.user.id,
        product.vendor_id,
        checkoutRef,
        total
      ]
    );

    await connection.query(
      `INSERT INTO order_items
       (order_id,product_id,vendor_id,product_name,
        unit_price_pi,quantity,subtotal_pi)
       VALUES (?,?,?,?,?,?,?)`,
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

    res.status(201).json({
      success: true,
      order_id: orderResult.insertId,
      checkout_ref: checkoutRef,
      total,
      product
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}

    res.status(400).json({
      success: false,
      message:
        error.message || "Failed to create order"
    });
  } finally {
    connection.release();
  }
});

/* Buyer orders with item details. */
router.get("/my", verifyToken(), (req, res) => {
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
     JOIN order_items oi ON oi.order_id=o.id
     LEFT JOIN products p ON p.id=oi.product_id
     WHERE o.user_id=?
     ORDER BY o.id DESC, oi.id ASC`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        console.error("My orders:", err);
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(rows || []);
    }
  );
});

/* Vendor orders. */
router.get("/vendor", verifyToken(["vendor"]), (req, res) => {
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
     JOIN orders o ON o.id=oi.order_id
     JOIN users u ON u.id=o.user_id
     LEFT JOIN products p ON p.id=oi.product_id
     WHERE oi.vendor_id=?
     ORDER BY o.id DESC, oi.id ASC`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        console.error("Vendor orders:", err);
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(rows || []);
    }
  );
});

/* Admin orders. */
router.get("/", verifyToken(["admin"]), (req, res) => {
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
     JOIN users u ON u.id=o.user_id
     LEFT JOIN order_items oi ON oi.order_id=o.id
     LEFT JOIN products p ON p.id=oi.product_id
     ORDER BY o.id DESC, oi.id ASC`,
    (err, rows) => {
      if (err) {
        console.error("Admin orders:", err);
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(rows || []);
    }
  );
});

/* Status updates. */
router.put("/:id/status", verifyToken(), (req, res) => {
  const orderId = Number(req.params.id);
  const status = req.body?.status;

  const allowed = [
    "pending",
    "paid",
    "processing",
    "shipped",
    "completed",
    "cancelled",
    "rejected",
    "refunded"
  ];

  if (!Number.isInteger(orderId) || !allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid order/status"
    });
  }

  db.query(
    `SELECT o.*,oi.vendor_id
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id=o.id
     WHERE o.id=?
     LIMIT 1`,
    [orderId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Order not found"
        });
      }

      const order = rows[0];

      const allowedUser =
        req.user.role === "admin" ||
        (req.user.role === "vendor" &&
          Number(order.vendor_id) === Number(req.user.id));

      if (!allowedUser) {
        return res.status(403).json({
          success: false,
          message: "Not allowed"
        });
      }

      db.query(
        `UPDATE orders
         SET status=?,
             payment_status=CASE
               WHEN ?='paid' THEN 'paid'
               ELSE payment_status
             END,
             delivery_status=CASE
               WHEN ?='shipped' THEN 'shipped'
               WHEN ?='completed' THEN 'delivered'
               ELSE delivery_status
             END
         WHERE id=?`,
        [status, status, status, status, orderId],
        updateErr => {
          if (updateErr) {
            return res.status(500).json({
              success: false,
              message: "DB error"
            });
          }

          res.json({
            success: true,
            message: "Order updated successfully"
          });
        }
      );
    }
  );
});

router.delete("/:id", verifyToken(["admin"]), async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid order ID"
    });
  }

  try {
    const [orders] = await db.promise().query(
      "SELECT id,status FROM orders WHERE id=? LIMIT 1",
      [orderId]
    );

    if (!orders.length) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    if (["paid","processing","shipped","completed"].includes(orders[0].status)) {
      return res.status(409).json({
        success: false,
        message: "Paid/processed orders cannot be deleted"
      });
    }

    await db.promise().query(
      "DELETE FROM orders WHERE id=?",
      [orderId]
    );

    res.json({
      success: true
    });
  } catch (error) {
    console.error("Delete order:", error);
    res.status(500).json({
      success: false,
      message: "DB error"
    });
  }
});

module.exports = router;
