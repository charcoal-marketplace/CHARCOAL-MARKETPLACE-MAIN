const router = require("express").Router();
const db = require("../config/db");
const {
  verifyToken,
  verifyAdmin,
  verifyVendor
} = require("../middleware/auth.middleware");

/*
 * =========================================================
 * CHARCOAL MARKETPLACE SUPPORT CHAT
 *
 * Buyers/vendors can create support conversations.
 * Admins can see and answer every conversation.
 *
 * A user may be both ADMIN and VENDOR. Admin identity
 * always wins when the user is using an admin token/dashboard.
 * =========================================================
 */

function isAdmin(req) {
  return Boolean(
    req.user &&
    req.user.role === "admin" &&
    req.user.status === "approved"
  );
}

function senderType(req) {
  if (isAdmin(req)) return "admin";
  if (req.user.vendor_status === "approved") return "vendor";
  return "buyer";
}

async function getConversation(id) {
  const [rows] = await db.promise().query(
    `
    SELECT
      sc.*,
      u.name AS user_name,
      u.email AS user_email,
      u.pi_username,
      o.checkout_ref,
      o.status AS order_status,
      o.payment_status,
      o.delivery_status,
      o.total_pi,
      admin_user.name AS assigned_admin_name
    FROM support_conversations sc
    JOIN users u
      ON u.id = sc.user_id
    LEFT JOIN orders o
      ON o.id = sc.order_id
    LEFT JOIN users admin_user
      ON admin_user.id = sc.assigned_admin_id
    WHERE sc.id = ?
    LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
}

async function userCanAccessConversation(req, conversation) {
  if (!conversation) return false;
  if (isAdmin(req)) return true;
  return Number(conversation.user_id) === Number(req.user.id);
}

/* =========================================================
   LIST CONVERSATIONS
   GET /api/support/conversations
========================================================= */
router.get("/conversations", verifyToken(), async (req, res) => {
  try {
    const admin = isAdmin(req);

    const [rows] = await db.promise().query(
      admin
        ? `
          SELECT
            sc.*,
            u.name AS user_name,
            u.email AS user_email,
            u.pi_username,
            o.checkout_ref,
            o.status AS order_status,
            o.payment_status,
            o.delivery_status,
            o.total_pi,
            admin_user.name AS assigned_admin_name,
            (
              SELECT COUNT(*)
              FROM support_messages sm
              WHERE sm.conversation_id = sc.id
                AND sm.is_read = FALSE
                AND sm.sender_type <> 'admin'
            ) AS unread_for_admin
          FROM support_conversations sc
          JOIN users u
            ON u.id = sc.user_id
          LEFT JOIN orders o
            ON o.id = sc.order_id
          LEFT JOIN users admin_user
            ON admin_user.id = sc.assigned_admin_id
          ORDER BY
            CASE sc.status
              WHEN 'open' THEN 0
              WHEN 'pending' THEN 1
              WHEN 'resolved' THEN 2
              ELSE 3
            END,
            sc.last_message_at DESC,
            sc.created_at DESC
        `
        : `
          SELECT
            sc.*,
            u.name AS user_name,
            u.email AS user_email,
            u.pi_username,
            o.checkout_ref,
            o.status AS order_status,
            o.payment_status,
            o.delivery_status,
            o.total_pi,
            (
              SELECT COUNT(*)
              FROM support_messages sm
              WHERE sm.conversation_id = sc.id
                AND sm.is_read = FALSE
                AND sm.sender_type = 'admin'
            ) AS unread_for_user
          FROM support_conversations sc
          JOIN users u
            ON u.id = sc.user_id
          LEFT JOIN orders o
            ON o.id = sc.order_id
          WHERE sc.user_id = ?
          ORDER BY sc.last_message_at DESC, sc.created_at DESC
        `,
      admin ? [] : [req.user.id]
    );

    return res.json({
      success: true,
      conversations: rows || []
    });
  } catch (error) {
    console.error("Support conversation list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load support conversations"
    });
  }
});

/* =========================================================
   CREATE CONVERSATION
   POST /api/support/conversations
========================================================= */
router.post("/conversations", verifyToken(), async (req, res) => {
  const subject = String(req.body?.subject || "").trim().slice(0, 255);
  const message = String(req.body?.message || "").trim();
  const orderId =
    req.body?.order_id === undefined ||
    req.body?.order_id === null ||
    req.body?.order_id === ""
      ? null
      : Number(req.body.order_id);

  if (!subject) {
    return res.status(400).json({
      success: false,
      message: "Conversation subject is required"
    });
  }

  if (!message) {
    return res.status(400).json({
      success: false,
      message: "Initial message is required"
    });
  }

  if (
    orderId !== null &&
    !Number.isInteger(orderId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid order ID"
    });
  }

  if (isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Administrators should reply to an existing support conversation"
    });
  }

  const type = senderType(req);

  try {
    const connection = await db.promise().getConnection();

    try {
      await connection.beginTransaction();

      if (orderId !== null) {
        if (type === "buyer") {
          const [orders] = await connection.query(
            `
            SELECT id
            FROM orders
            WHERE id = ?
              AND user_id = ?
            LIMIT 1
            `,
            [orderId, req.user.id]
          );

          if (!orders.length) {
            throw new Error("Order not found or does not belong to you");
          }
        } else {
          const [items] = await connection.query(
            `
            SELECT oi.id
            FROM order_items oi
            WHERE oi.order_id = ?
              AND oi.vendor_id = ?
            LIMIT 1
            `,
            [orderId, req.user.id]
          );

          if (!items.length) {
            throw new Error("Order not found or does not belong to your vendor account");
          }
        }
      }

      const [conversationResult] = await connection.query(
        `
        INSERT INTO support_conversations
        (
          user_id,
          order_id,
          user_type,
          subject,
          status,
          priority,
          last_message_at,
          last_message_by
        )
        VALUES (?, ?, ?, ?, 'open', 'normal', CURRENT_TIMESTAMP, ?)
        `,
        [
          req.user.id,
          orderId,
          type,
          subject,
          req.user.id
        ]
      );

      const conversationId = conversationResult.insertId;

      await connection.query(
        `
        INSERT INTO support_messages
        (
          conversation_id,
          sender_id,
          sender_type,
          message,
          is_read
        )
        VALUES (?, ?, ?, ?, FALSE)
        `,
        [
          conversationId,
          req.user.id,
          type,
          message
        ]
      );

      await connection.commit();

      return res.status(201).json({
        success: true,
        conversation_id: conversationId,
        message: "Support conversation created successfully"
      });
    } catch (error) {
      await connection.rollback();

      const status =
        /not found|does not belong/i.test(error.message)
          ? 404
          : 400;

      return res.status(status).json({
        success: false,
        message: error.message || "Failed to create conversation"
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Support conversation create error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create support conversation"
    });
  }
});

/* =========================================================
   GET MESSAGES
   GET /api/support/conversations/:id/messages
========================================================= */
router.get(
  "/conversations/:id/messages",
  verifyToken(),
  async (req, res) => {
    const conversationId = Number(req.params.id);

    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID"
      });
    }

    try {
      const conversation = await getConversation(conversationId);

      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: "Support conversation not found"
        });
      }

      if (!(await userCanAccessConversation(req, conversation))) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this conversation"
        });
      }

      const [messages] = await db.promise().query(
        `
        SELECT
          sm.id,
          sm.conversation_id,
          sm.sender_id,
          sm.sender_type,
          sm.message,
          sm.attachment_url,
          sm.is_read,
          sm.read_at,
          sm.created_at,
          u.name AS sender_name,
          u.pi_username AS sender_pi_username
        FROM support_messages sm
        JOIN users u
          ON u.id = sm.sender_id
        WHERE sm.conversation_id = ?
        ORDER BY sm.created_at ASC, sm.id ASC
        `,
        [conversationId]
      );

      const unreadCondition = isAdmin(req)
        ? "sender_type <> 'admin'"
        : "sender_type = 'admin'";

      await db.promise().query(
        `
        UPDATE support_messages
        SET
          is_read = TRUE,
          read_at = CURRENT_TIMESTAMP
        WHERE conversation_id = ?
          AND is_read = FALSE
          AND ${unreadCondition}
        `,
        [conversationId]
      );

      return res.json({
        success: true,
        conversation,
        messages: messages || []
      });
    } catch (error) {
      console.error("Support message load error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load support messages"
      });
    }
  }
);

/* =========================================================
   SEND MESSAGE
   POST /api/support/conversations/:id/messages
========================================================= */
router.post(
  "/conversations/:id/messages",
  verifyToken(),
  async (req, res) => {
    const conversationId = Number(req.params.id);
    const message = String(req.body?.message || "").trim();

    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID"
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty"
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Message is too long"
      });
    }

    try {
      const conversation = await getConversation(conversationId);

      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: "Support conversation not found"
        });
      }

      if (!(await userCanAccessConversation(req, conversation))) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this conversation"
        });
      }

      if (conversation.status === "closed") {
        return res.status(409).json({
          success: false,
          message: "This support conversation is closed"
        });
      }

      const type = senderType(req);

      await db.promise().query(
        `
        INSERT INTO support_messages
        (
          conversation_id,
          sender_id,
          sender_type,
          message,
          is_read
        )
        VALUES (?, ?, ?, ?, FALSE)
        `,
        [
          conversationId,
          req.user.id,
          type,
          message
        ]
      );

      await db.promise().query(
        `
        UPDATE support_conversations
        SET
          last_message_at = CURRENT_TIMESTAMP,
          last_message_by = ?,
          status =
            CASE
              WHEN ? = 'admin' THEN 'pending'
              ELSE 'open'
            END
        WHERE id = ?
        `,
        [
          req.user.id,
          type,
          conversationId
        ]
      );

      if (type !== "admin") {
        await db.promise().query(
          `
          INSERT INTO notifications
          (
            user_id,
            message,
            type
          )
          SELECT
            id,
            ?,
            'support'
          FROM users
          WHERE role = 'admin'
            AND status = 'approved'
          `,
          [
            `New support message from ${conversation.user_name || "a user"}: ${message.slice(0, 120)}`
          ]
        );
      }

      return res.status(201).json({
        success: true,
        message: "Message sent successfully"
      });
    } catch (error) {
      console.error("Support message send error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to send support message"
      });
    }
  }
);

/* =========================================================
   UPDATE CONVERSATION STATUS
   PATCH /api/support/conversations/:id/status
========================================================= */
router.patch(
  "/conversations/:id/status",
  verifyToken(),
  async (req, res) => {
    const conversationId = Number(req.params.id);
    const status = String(req.body?.status || "").toLowerCase();

    const allowed = ["open", "pending", "resolved", "closed"];

    if (!Number.isInteger(conversationId) || !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation or status"
      });
    }

    try {
      const conversation = await getConversation(conversationId);

      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: "Support conversation not found"
        });
      }

      if (!isAdmin(req) && Number(conversation.user_id) !== Number(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this conversation"
        });
      }

      await db.promise().query(
        `
        UPDATE support_conversations
        SET status = ?
        WHERE id = ?
        `,
        [status, conversationId]
      );

      return res.json({
        success: true,
        message: `Conversation marked ${status}`,
        status
      });
    } catch (error) {
      console.error("Support status error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update support conversation"
      });
    }
  }
);

/* =========================================================
   ADMIN ASSIGNMENT
   PATCH /api/support/conversations/:id/assign
========================================================= */
router.patch(
  "/conversations/:id/assign",
  verifyAdmin,
  async (req, res) => {
    const conversationId = Number(req.params.id);
    const adminId =
      req.body?.admin_id === null ||
      req.body?.admin_id === "" ||
      req.body?.admin_id === undefined
        ? null
        : Number(req.body.admin_id);

    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID"
      });
    }

    if (adminId !== null && !Number.isInteger(adminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid administrator ID"
      });
    }

    try {
      if (adminId !== null) {
        const [admins] = await db.promise().query(
          `
          SELECT id
          FROM users
          WHERE id = ?
            AND role = 'admin'
            AND status = 'approved'
          LIMIT 1
          `,
          [adminId]
        );

        if (!admins.length) {
          return res.status(404).json({
            success: false,
            message: "Administrator not found"
          });
        }
      }

      const [result] = await db.promise().query(
        `
        UPDATE support_conversations
        SET assigned_admin_id = ?
        WHERE id = ?
        `,
        [adminId, conversationId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Support conversation not found"
        });
      }

      return res.json({
        success: true,
        message: adminId === null
          ? "Conversation unassigned"
          : "Conversation assigned successfully"
      });
    } catch (error) {
      console.error("Support assignment error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to assign support conversation"
      });
    }
  }
);

module.exports = router;
