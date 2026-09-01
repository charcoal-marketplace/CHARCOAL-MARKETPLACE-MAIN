const router = require("express").Router();

const db = require("../config/db");

const {
  verifyToken
} = require("../middleware/auth.middleware");

const {
  createA2UPayment,
  submitA2UPayment,
  completePayment,
  fetchPaymentStrict
} = require("../piService");


/* =========================================================
   HELPERS
========================================================= */

function roundPi(value) {

  return Number(
    Number(value || 0).toFixed(8)
  );

}


function isSuperAdmin(req) {

  return (
    req.user &&
    req.user.role === "admin" &&
    req.user.admin_level === "super_admin" &&
    req.user.status === "approved"
  );

}


/* =========================================================
   SUPER ADMIN CHECK
========================================================= */

function requireSuperAdmin(req, res, next) {

  if (!isSuperAdmin(req)) {

    return res.status(403).json({

      success: false,

      message:
        "Super Admin permission required"

    });

  }

  next();

}


/* =========================================================
   GET WITHDRAWAL DASHBOARD
========================================================= */

router.get(
  "/summary",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    try {

      const [availableRows] =
        await db.promise().query(
          `
          SELECT
            COALESCE(
              SUM(amount_pi),
              0
            ) AS available_pi
          FROM earnings
          WHERE type='platform_fee'
            AND status='available'
            AND withdrawal_id IS NULL
          `
        );


      const [withdrawalRows] =
        await db.promise().query(
          `
          SELECT
            COALESCE(
              SUM(total_amount_pi),
              0
            ) AS withdrawn_pi
          FROM withdrawals
          WHERE status='completed'
          `
        );


      const [adminRows] =
        await db.promise().query(
          `
          SELECT
            id,
            name,
            pi_uid,
            pi_username,
            pi_wallet_address,
            admin_level,
            admin_share_percent
          FROM users
          WHERE role='admin'
            AND status='approved'
            AND admin_level IN (
              'admin',
              'super_admin'
            )
          ORDER BY
            admin_level DESC,
            id ASC
          `
        );


      const availablePi =
        roundPi(
          availableRows[0]?.available_pi
        );


      const withdrawnPi =
        roundPi(
          withdrawalRows[0]?.withdrawn_pi
        );


      const totalPercent =
        adminRows.reduce(
          (total, admin) => {

            return total +
              Number(
                admin.admin_share_percent || 0
              );

          },
          0
        );


      return res.json({

        success: true,

        available_pi:
          availablePi,

        withdrawn_pi:
          withdrawnPi,

        admins:
          adminRows,

        total_admin_percentage:
          Number(
            totalPercent.toFixed(2)
          )

      });


    } catch (error) {

      console.error(
        "[WITHDRAWAL SUMMARY]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to load withdrawal summary",

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   GET WITHDRAWAL HISTORY
========================================================= */

router.get(
  "/history",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    try {

      const [rows] =
        await db.promise().query(
          `
          SELECT
            w.id,
            w.total_amount_pi,
            w.status,
            w.description,
            w.error_message,
            w.created_at,
            w.processing_started_at,
            w.completed_at,

            u.name AS initiated_by_name

          FROM withdrawals w

          LEFT JOIN users u
            ON u.id=w.initiated_by

          ORDER BY
            w.id DESC
          `
        );


      return res.json({

        success: true,

        withdrawals:
          rows

      });


    } catch (error) {

      console.error(
        "[WITHDRAWAL HISTORY]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to load withdrawal history",

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   GET WITHDRAWAL DETAILS
========================================================= */

router.get(
  "/:id",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    const withdrawalId =
      Number(req.params.id);


    if (
      !Number.isInteger(
        withdrawalId
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid withdrawal ID"

      });

    }


    try {

      const [withdrawals] =
        await db.promise().query(
          `
          SELECT
            w.*,
            u.name AS initiated_by_name
          FROM withdrawals w
          LEFT JOIN users u
            ON u.id=w.initiated_by
          WHERE w.id=?
          LIMIT 1
          `,
          [
            withdrawalId
          ]
        );


      if (!withdrawals.length) {

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal not found"

        });

      }


      const [items] =
        await db.promise().query(
          `
          SELECT
            wi.*,

            u.name,
            u.pi_username,
            u.pi_uid

          FROM withdrawal_items wi

          JOIN users u
            ON u.id=wi.user_id

          WHERE wi.withdrawal_id=?

          ORDER BY wi.id
          `,
          [
            withdrawalId
          ]
        );


      return res.json({

        success: true,

        withdrawal:
          withdrawals[0],

        items

      });


    } catch (error) {

      console.error(
        "[WITHDRAWAL DETAILS]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to load withdrawal details",

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   UPDATE ADMIN PERCENTAGES
   SUPER ADMIN ONLY
========================================================= */

router.post(
  "/admin-shares",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    const shares =
      Array.isArray(req.body?.shares)
        ? req.body.shares
        : [];


    if (!shares.length) {

      return res.status(400).json({

        success: false,

        message:
          "Admin share data is required"

      });

    }


    const connection =
      await db.promise()
        .getConnection();


    try {

      await connection.beginTransaction();


      let totalPercent =
        0;


      for (
        const share
        of shares
      ) {

        const userId =
          Number(
            share.user_id
          );


        const percentage =
          Number(
            share.admin_share_percent
          );


        if (
          !Number.isInteger(
            userId
          )
        ) {

          throw new Error(
            "Invalid admin user ID"
          );

        }


        if (
          !Number.isFinite(
            percentage
          ) ||
          percentage < 0 ||
          percentage > 100
        ) {

          throw new Error(
            `Invalid percentage for admin ${userId}`
          );

        }


        totalPercent +=
          percentage;


        const [admins] =
          await connection.query(
            `
            SELECT id
            FROM users
            WHERE id=?
              AND role='admin'
              AND status='approved'
              AND admin_level IN (
                'admin',
                'super_admin'
              )
            LIMIT 1
            `,
            [
              userId
            ]
          );


        if (!admins.length) {

          throw new Error(
            `User ${userId} is not an approved admin`
          );

        }


        await connection.query(
          `
          UPDATE users
          SET
            admin_share_percent=?
          WHERE id=?
          `,
          [
            percentage,
            userId
          ]
        );

      }


      if (
        Math.abs(
          totalPercent - 100
        ) > 0.0001
      ) {

        throw new Error(
          `Admin percentages must total exactly 100%. Current total: ${totalPercent}%`
        );

      }


      await connection.commit();


      return res.json({

        success: true,

        message:
          "Admin percentages updated successfully",

        total_percentage:
          totalPercent

      });


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      console.error(
        "[ADMIN SHARES]",
        error
      );


      return res.status(400).json({

        success: false,

        message:
          error.message

      });


    } finally {

      connection.release();

    }

  }
);


/* =========================================================
   START WITHDRAWAL
   SUPER ADMIN ONLY
========================================================= */

router.post(
  "/start",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    const description =
      String(
        req.body?.description ||
        "Marketplace platform earnings withdrawal"
      )
      .trim()
      .slice(
        0,
        500
      );


    const connection =
      await db.promise()
        .getConnection();


    let withdrawalId;


    try {

      await connection.beginTransaction();


      /*
       * Prevent two withdrawals from being
       * started at the same time.
       */

      const [activeWithdrawals] =
        await connection.query(
          `
          SELECT id
          FROM withdrawals
          WHERE status IN (
            'pending',
            'processing',
            'partial'
          )
          LIMIT 1
          FOR UPDATE
          `
        );


      if (
        activeWithdrawals.length
      ) {

        await connection.rollback();


        return res.status(409).json({

          success: false,

          message:
            "Another withdrawal is already being processed",

          withdrawal_id:
            activeWithdrawals[0].id

        });

      }


      /*
       * Lock all currently available
       * platform earnings.
       */

      const [earnings] =
        await connection.query(
          `
          SELECT
            id,
            amount_pi
          FROM earnings
          WHERE type='platform_fee'
            AND status='available'
            AND withdrawal_id IS NULL
          ORDER BY id
          FOR UPDATE
          `
        );


      if (!earnings.length) {

        await connection.rollback();


        return res.status(400).json({

          success: false,

          message:
            "No platform earnings are currently available for withdrawal"

        });

      }


      let totalAmount =
        0;


      for (
        const earning
        of earnings
      ) {

        totalAmount =
          roundPi(
            totalAmount +
            Number(
              earning.amount_pi
            )
          );

      }


      /*
       * Load approved admins.
       */

      const [admins] =
        await connection.query(
          `
          SELECT
            id,
            name,
            pi_uid,
            pi_username,
            pi_wallet_address,
            admin_level,
            admin_share_percent

          FROM users

          WHERE role='admin'
            AND status='approved'
            AND admin_level IN (
              'admin',
              'super_admin'
            )

          ORDER BY
            admin_level DESC,
            id ASC

          FOR UPDATE
          `
        );


      if (!admins.length) {

        throw new Error(
          "No approved admins are configured"
        );

      }


      let percentageTotal =
        0;


      for (
        const admin
        of admins
      ) {

        percentageTotal +=
          Number(
            admin.admin_share_percent || 0
          );

      }


      if (
        Math.abs(
          percentageTotal - 100
        ) > 0.0001
      ) {

        throw new Error(
          `Admin percentages must total 100%. Current total: ${percentageTotal}%`
        );

      }


      /*
       * Every receiving admin must have
       * a Pi UID and wallet address.
       */

      for (
        const admin
        of admins
      ) {

        if (
          !admin.pi_uid
        ) {

          throw new Error(
            `${admin.name} does not have a Pi UID`
          );

        }


        if (
          !admin.pi_wallet_address
        ) {

          throw new Error(
            `${admin.name} does not have a Pi wallet address`
          );

        }

      }


      /*
       * Create withdrawal batch.
       */

      const [withdrawalResult] =
        await connection.query(
          `
          INSERT INTO withdrawals
          (
            initiated_by,
            total_amount_pi,
            status,
            description,
            processing_started_at
          )
          VALUES (
            ?,
            ?,
            'processing',
            ?,
            CURRENT_TIMESTAMP
          )
          `,
          [
            req.user.id,
            totalAmount,
            description
          ]
        );


      withdrawalId =
        withdrawalResult.insertId;


      /*
       * Create distribution items.
       */

      for (
        const admin
        of admins
      ) {

        const percentage =
          Number(
            admin.admin_share_percent || 0
          );


        const amount =
          roundPi(
            totalAmount *
            percentage /
            100
          );


        if (
          amount <= 0
        ) {

          continue;

        }


        await connection.query(
          `
          INSERT INTO withdrawal_items
          (
            withdrawal_id,
            user_id,
            admin_share_percent,
            amount_pi,
            wallet_address,
            status
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            'pending'
          )
          `,
          [
            withdrawalId,
            admin.id,
            percentage,
            amount,
            admin.pi_wallet_address
          ]
        );

      }


      /*
       * Mark platform earnings as belonging
       * to this withdrawal.
       */

      for (
        const earning
        of earnings
      ) {

        await connection.query(
          `
          UPDATE earnings
          SET
            withdrawal_id=?
          WHERE id=?
            AND status='available'
            AND withdrawal_id IS NULL
          `,
          [
            withdrawalId,
            earning.id
          ]
        );

      }


      await connection.commit();


    } catch (error) {

      try {
        await connection.rollback();
      } catch {}


      console.error(
        "[WITHDRAWAL START]",
        error
      );


      return res.status(400).json({

        success: false,

        message:
          error.message

      });


    } finally {

      connection.release();

    }


    /*
     * Execute A2U payouts OUTSIDE the database
     * transaction.
     */

    try {

      const result =
        await processWithdrawal(
          withdrawalId
        );


      return res.json({

        success:
          result.success,

        message:
          result.message,

        withdrawal_id:
          withdrawalId,

        results:
          result.results

      });


    } catch (error) {

      console.error(
        "[WITHDRAWAL PROCESS]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Withdrawal was created but payout processing failed",

        withdrawal_id:
          withdrawalId,

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   PROCESS WITHDRAWAL
========================================================= */

async function processWithdrawal(
  withdrawalId
) {

  const [items] =
    await db.promise().query(
      `
      SELECT
        wi.*,

        u.name,
        u.pi_uid,
        u.pi_username,
        u.pi_wallet_address

      FROM withdrawal_items wi

      JOIN users u
        ON u.id=wi.user_id

      WHERE wi.withdrawal_id=?

      ORDER BY wi.id
      `,
      [
        withdrawalId
      ]
    );


  if (!items.length) {

    throw new Error(
      "Withdrawal contains no payout items"
    );

  }


  const results = [];


  for (
    const item
    of items
  ) {

    /*
     * Already completed:
     * never pay twice.
     */

    if (
      item.status ===
      "completed"
    ) {

      results.push({

        user_id:
          item.user_id,

        amount_pi:
          item.amount_pi,

        status:
          "completed",

        payout_txid:
          item.payout_txid

      });

      continue;

    }


    try {

      await db.promise().query(
        `
        UPDATE withdrawal_items
        SET
          status='processing',
          processing_started_at=CURRENT_TIMESTAMP,
          error_message=NULL
        WHERE id=?
        `,
        [
          item.id
        ]
      );


      /*
       * If an A2U payment was already created,
       * recover it instead of creating another one.
       */

      let payment;


      if (
        item.payout_payment_id
      ) {

        payment =
          await fetchPaymentStrict(
            item.payout_payment_id
          );

      } else {

        payment =
          await createA2UPayment({

            uid:
              item.pi_uid,

            amount:
              Number(
                item.amount_pi
              ),

            memo:
              `Charcoal Marketplace admin withdrawal #${withdrawalId}`,

            metadata: {

              withdrawal_id:
                String(
                  withdrawalId
                ),

              withdrawal_item_id:
                String(
                  item.id
                ),

              admin_user_id:
                String(
                  item.user_id
                )

            }

          });


        await db.promise().query(
          `
          UPDATE withdrawal_items
          SET
            payout_payment_id=?
          WHERE id=?
          `,
          [
            payment.identifier,
            item.id
          ]
        );

      }


      /*
       * If Pi already has a blockchain transaction,
       * recover it.
       */

      let txid =
        payment?.transaction?.txid ||
        payment?.transaction_id ||
        null;


      /*
       * No transaction yet:
       * submit the A2U payment.
       */

      if (!txid) {

        const submitted =
          await submitA2UPayment(
            payment.identifier
          );


        txid =
          submitted.txid;

      }


      if (!txid) {

        throw new Error(
          "Pi did not return an A2U transaction ID"
        );

      }


      /*
       * Save transaction immediately.
       */

      await db.promise().query(
        `
        UPDATE withdrawal_items
        SET
          payout_txid=?,
          status='processing'
        WHERE id=?
        `,
        [
          txid,
          item.id
        ]
      );


      /*
       * Complete the A2U payment on Pi.
       */

      let confirmed =
        await fetchPaymentStrict(
          payment.identifier
        );


      const alreadyCompleted =
        confirmed?.status
          ?.developer_completed === true;


      if (
        !alreadyCompleted
      ) {

        await completePayment(
          payment.identifier,
          txid
        );

      }


      /*
       * Confirm final Pi state.
       */

      confirmed =
        await fetchPaymentStrict(
          payment.identifier
        );


      if (
        !confirmed?.status
          ?.developer_completed
      ) {

        throw new Error(
          "Pi did not confirm A2U payment completion"
        );

      }


      /*
       * Mark payout complete.
       */

      await db.promise().query(
        `
        UPDATE withdrawal_items
        SET
          status='completed',
          completed_at=CURRENT_TIMESTAMP,
          error_message=NULL
        WHERE id=?
        `,
        [
          item.id
        ]
      );


      /*
       * Create withdrawal earning ledger record.
       */

      await db.promise().query(
        `
        INSERT INTO earnings
        (
          user_id,
          type,
          amount_pi,
          status,
          description
        )
        VALUES (
          ?,
          'withdrawal',
          ?,
          'paid',
          ?
        )
        `,
        [
          item.user_id,

          Number(
            item.amount_pi
          ),

          `Admin withdrawal #${withdrawalId}`
        ]
      );


      /*
       * Notify admin.
       */

      await db.promise().query(
        `
        INSERT INTO notifications
        (
          user_id,
          message,
          type
        )
        VALUES (
          ?,
          ?,
          'withdrawal'
        )
        `,
        [
          item.user_id,

          `Your marketplace earnings withdrawal of ${item.amount_pi} Pi has been completed successfully. Transaction: ${txid}`
        ]
      );


      results.push({

        user_id:
          item.user_id,

        name:
          item.name,

        amount_pi:
          item.amount_pi,

        status:
          "completed",

        payout_payment_id:
          payment.identifier,

        payout_txid:
          txid

      });


    } catch (error) {

      console.error(
        `[WITHDRAWAL ITEM ${item.id}]`,
        error
      );


      await db.promise().query(
        `
        UPDATE withdrawal_items
        SET
          status='failed',
          error_message=?
        WHERE id=?
        `,
        [
          error.message,
          item.id
        ]
      );


      await db.promise().query(
        `
        INSERT INTO notifications
        (
          user_id,
          message,
          type
        )
        VALUES (
          ?,
          ?,
          'withdrawal'
        )
        `,
        [
          item.user_id,

          `Your marketplace withdrawal of ${item.amount_pi} Pi could not be completed. Please contact the Super Admin.`
        ]
      );


      results.push({

        user_id:
          item.user_id,

        name:
          item.name,

        amount_pi:
          item.amount_pi,

        status:
          "failed",

        error:
          error.message

      });

    }

  }


  const completed =
    results.filter(
      item =>
        item.status ===
        "completed"
    ).length;


  const failed =
    results.filter(
      item =>
        item.status ===
        "failed"
    ).length;


  let withdrawalStatus;


  if (
    completed ===
    results.length
  ) {

    withdrawalStatus =
      "completed";

  } else if (
    completed > 0 &&
    failed > 0
  ) {

    withdrawalStatus =
      "partial";

  } else {

    withdrawalStatus =
      "failed";

  }


  await db.promise().query(
    `
    UPDATE withdrawals
    SET
      status=?,

      completed_at=
        CASE
          WHEN ?='completed'
          THEN CURRENT_TIMESTAMP
          ELSE completed_at
        END

    WHERE id=?
    `,
    [
      withdrawalStatus,
      withdrawalStatus,
      withdrawalId
    ]
  );


  return {

    success:
      withdrawalStatus ===
      "completed",

    message:
      withdrawalStatus ===
      "completed"
        ? "Withdrawal completed successfully"
        : withdrawalStatus ===
          "partial"
            ? "Withdrawal partially completed"
            : "Withdrawal failed",

    results

  };

}


/* =========================================================
   RETRY FAILED / PARTIAL WITHDRAWAL
========================================================= */

router.post(
  "/:id/retry",
  verifyToken(),
  requireSuperAdmin,
  async (req, res) => {

    const withdrawalId =
      Number(req.params.id);


    if (
      !Number.isInteger(
        withdrawalId
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid withdrawal ID"

      });

    }


    try {

      const [withdrawals] =
        await db.promise().query(
          `
          SELECT
            *
          FROM withdrawals
          WHERE id=?
          LIMIT 1
          `,
          [
            withdrawalId
          ]
        );


      if (!withdrawals.length) {

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal not found"

        });

      }


      if (
        withdrawals[0].status ===
        "completed"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "This withdrawal is already completed"

        });

      }


      const [items] =
        await db.promise().query(
          `
          SELECT
            id
          FROM withdrawal_items
          WHERE withdrawal_id=?
            AND status IN (
              'pending',
              'failed'
            )
          `,
          [
            withdrawalId
          ]
        );


      if (!items.length) {

        return res.status(400).json({

          success: false,

          message:
            "There are no failed or pending payout items to retry"

        });

      }


      await db.promise().query(
        `
        UPDATE withdrawals
        SET
          status='processing',
          error_message=NULL,
          processing_started_at=CURRENT_TIMESTAMP
        WHERE id=?
        `,
        [
          withdrawalId
        ]
      );


      const result =
        await processWithdrawal(
          withdrawalId
        );


      return res.json({

        success:
          result.success,

        message:
          result.message,

        withdrawal_id:
          withdrawalId,

        results:
          result.results

      });


    } catch (error) {

      console.error(
        "[WITHDRAWAL RETRY]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Withdrawal retry failed",

        error:
          error.message

      });

    }

  }
);


module.exports = router;