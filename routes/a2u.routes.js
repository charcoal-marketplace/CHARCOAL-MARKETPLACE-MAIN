const router = require("express").Router();

const db =
  require("../config/db");

const {
  verifyAdmin,
  requireSuperAdmin
} =
  require("../middleware/auth.middleware");

const {
  createA2UPayment,
  submitA2UPayment,
  completePayment,
  fetchPaymentStrict,
  getIncompleteServerPayments
} =
  require("../piService");


/* =========================================================
   HELPERS
========================================================= */

function roundPi(value) {

  return Number(
    Number(value || 0).toFixed(8)
  );

}


/* =========================================================
   ADMIN CHECK
========================================================= */

function isAdmin(req) {

  return (
    req.user &&
    req.user.role === "admin" &&
    req.user.status === "approved" &&
    (
      req.user.admin_level === "admin" ||
      req.user.admin_level === "super_admin"
    )
  );

}


function requireA2UAdmin(
  req,
  res,
  next
) {

  if (!isAdmin(req)) {

    return res.status(403).json({

      success: false,

      message:
        "Only approved Admin or Super Admin can perform A2U payouts"

    });

  }

  next();

}


/* =========================================================
   GLOBAL A2U LOCK
========================================================= */

const A2U_LOCK_NAME =
  "charcoal_marketplace_a2u_payout";


/* =========================================================
   GET PENDING VENDOR EARNINGS
=========================================================

   GET /api/a2u/earnings/pending

   IMPORTANT:

   A Pi wallet address is NOT required here.

   The vendor's Pi UID is the recipient identity.

   Pi returns the actual recipient wallet address after
   the A2U payment is created.

========================================================= */

router.get(
  "/earnings/pending",
  verifyAdmin,
  async (req, res) => {

    try {

      const [earnings] =
        await db.promise().query(
          `
          SELECT

            e.id,
            e.user_id,
            e.order_id,
            e.vendor_id,
            e.type,
            e.amount_pi,
            e.status,
            e.description,

            e.payout_payment_id,
            e.payout_txid,
            e.paid_at,
            e.payout_error,
            e.created_at,

            u.name AS vendor_name,
            u.email AS vendor_email,

            u.pi_uid,
            u.pi_username,

            u.business_name,

            u.role AS vendor_role,
            u.admin_level AS vendor_admin_level,

            u.pi_wallet_address AS wallet_address,

            u.vendor_status,

            o.status AS order_status,
            o.delivery_status,
            o.buyer_confirmed_at,

            CASE

              WHEN
                o.buyer_confirmed_at IS NOT NULL

                AND e.status = 'pending'

                AND u.pi_uid IS NOT NULL

                AND TRIM(u.pi_uid) <> ''

                AND u.vendor_status = 'approved'

                AND u.status = 'approved'

              THEN 1

              ELSE 0

            END AS payout_ready,

            CASE

              WHEN
                o.buyer_confirmed_at IS NULL

              THEN
                'Buyer has not confirmed receipt'

              WHEN
                e.status <> 'pending'

              THEN
                'This earning is no longer pending'

              WHEN
                u.vendor_status <> 'approved'

              THEN
                'Vendor status is not approved'

              WHEN
                u.status <> 'approved'

              THEN
                'Vendor account is not approved'

              WHEN
                u.pi_uid IS NULL

                OR TRIM(u.pi_uid) = ''

              THEN
                'Vendor Pi UID is missing'

              ELSE
                'Ready for payout'

            END AS payout_ready_reason

          FROM earnings e

          LEFT JOIN users u
            ON e.vendor_id = u.id

          LEFT JOIN orders o
            ON e.order_id = o.id

          WHERE
            e.type = 'sale'

            AND e.status = 'pending'

          ORDER BY
            e.created_at ASC
          `
        );


      return res.json({

        success: true,

        earnings:
          earnings || []

      });


    } catch (error) {

      console.error(
        "[A2U PENDING EARNINGS]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Failed to load pending vendor earnings"

      });

    }

  }
);


/* =========================================================
   RELEASE VENDOR EARNING
=========================================================

   POST /api/a2u/earnings/:id/release

   Flow:

   Buyer confirms receipt
        ↓
   Admin releases earning
        ↓
   Vendor Pi UID
        ↓
   Create A2U payment
        ↓
   Submit to Pi blockchain
        ↓
   Complete payment
        ↓
   Mark earning paid

========================================================= */

router.post(
  "/earnings/:id/release",
  verifyAdmin,
  requireA2UAdmin,
  async (req, res) => {

    const earningId =
      Number(req.params.id);


    if (
      !Number.isInteger(
        earningId
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid earning ID"

      });

    }


    let connection = null;

    let lockAcquired = false;

    let paymentId = null;

    let txid = null;


    try {

      connection =
        await db.promise()
          .getConnection();


      /* =====================================================
         GLOBAL LOCK
      ===================================================== */

      const [lockRows] =
        await connection.query(
          "SELECT GET_LOCK(?, 300) AS acquired",
          [
            A2U_LOCK_NAME
          ]
        );


      if (
        !lockRows.length ||
        Number(
          lockRows[0].acquired
        ) !== 1
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Another Pi A2U payout is currently being processed. Please try again shortly."

        });

      }


      lockAcquired =
        true;


      /* =====================================================
         START TRANSACTION
      ===================================================== */

      await connection.beginTransaction();


      /* =====================================================
         VERIFY CURRENT ADMIN
      ===================================================== */

      const [adminRows] =
        await connection.query(
          `
          SELECT

            id,
            role,
            status,
            admin_level

          FROM users

          WHERE id=?

          LIMIT 1

          FOR UPDATE
          `,
          [
            req.user.id
          ]
        );


      if (!adminRows.length) {

        await connection.rollback();

        return res.status(401).json({

          success: false,

          message:
            "Administrator account not found"

        });

      }


      const admin =
        adminRows[0];


      if (
        admin.role !== "admin" ||
        admin.status !== "approved" ||
        (
          admin.admin_level !== "admin" &&
          admin.admin_level !== "super_admin"
        )
      ) {

        await connection.rollback();

        return res.status(403).json({

          success: false,

          message:
            "Only Admin or Super Admin can release vendor earnings"

        });

      }


      /* =====================================================
         LOAD EARNING + VENDOR + ORDER
      ===================================================== */

      const [earningRows] =
        await connection.query(
          `
          SELECT

            e.*,

            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.delivery_status AS order_delivery_status,
            o.buyer_confirmed_at,

            u.name AS vendor_name,
            u.email AS vendor_email,

            u.pi_uid,
            u.pi_username,

            u.role AS vendor_role,
            u.status AS vendor_account_status,
            u.vendor_status,

            u.pi_wallet_address

          FROM earnings e

          INNER JOIN users u
            ON e.vendor_id = u.id

          LEFT JOIN orders o
            ON e.order_id = o.id

          WHERE e.id=?

          LIMIT 1

          FOR UPDATE
          `,
          [
            earningId
          ]
        );


      if (!earningRows.length) {

        await connection.rollback();

        return res.status(404).json({

          success: false,

          message:
            "Vendor earning not found"

        });

      }


      const earning =
        earningRows[0];


      /* =====================================================
         ALREADY PAID
      ===================================================== */

      if (
        earning.status ===
        "paid"
      ) {

        await connection.rollback();

        return res.status(409).json({

          success: false,

          message:
            "This earning has already been paid",

          payout_txid:
            earning.payout_txid ||
            null

        });

      }


      /* =====================================================
         ONLY SALE EARNINGS
      ===================================================== */

      if (
        earning.type !==
        "sale"
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "This earning is not a vendor sale earning"

        });

      }


      /* =====================================================
         BUYER MUST HAVE CONFIRMED RECEIPT
      ===================================================== */

      if (
        !earning.buyer_confirmed_at
      ) {

        await connection.rollback();

        return res.status(409).json({

          success: false,

          message:
            "Vendor payout is locked until the buyer confirms receipt of the product.",

          earning_id:
            earning.id,

          order_id:
            earning.order_id,

          payout_status:
            "awaiting_buyer_confirmation"

        });

      }


      /* =====================================================
         VENDOR PI UID
      ===================================================== */

      if (
        !earning.pi_uid ||
        String(
          earning.pi_uid
        ).trim() === ""
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            `Vendor ${earning.vendor_name || earning.vendor_id} does not have a valid Pi UID.`

        });

      }


      /* =====================================================
         VENDOR ACCOUNT
      ===================================================== */

      if (
        earning.vendor_account_status !==
          "approved" ||

        earning.vendor_status !==
          "approved"
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "Vendor is not approved to receive earnings"

        });

      }


      /* =====================================================
         AMOUNT
      ===================================================== */

      const amount =
        roundPi(
          earning.amount_pi
        );


      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "Invalid vendor earning amount"

        });

      }


      /* =====================================================
         IMPORTANT:
         DO NOT REQUIRE pi_wallet_address
      =====================================================

         The Pi UID is the recipient identity.

         createA2UPayment() sends the UID to Pi.

         Pi returns the recipient wallet address in the
         created A2U payment.

      ===================================================== */


      paymentId =
        earning.payout_payment_id ||
        null;


      await connection.commit();


      /* =====================================================
         RESUME EXISTING A2U PAYMENT
      ===================================================== */

      let currentPayment =
        null;


      if (paymentId) {

        try {

          currentPayment =
            await fetchPaymentStrict(
              paymentId
            );


        } catch (paymentFetchError) {

          if (
            Number(
              paymentFetchError.status
            ) === 404 ||

            paymentFetchError.code ===
              "payment_not_found"
          ) {

            await db.promise().query(
              `
              UPDATE earnings

              SET
                payout_payment_id=NULL,
                payout_txid=NULL,
                payout_error=?

              WHERE id=?

                AND status='pending'
              `,
              [

                "Previous A2U payment was not found on Pi. A new payout payment will be created.",

                earning.id

              ]
            );


            paymentId =
              null;


          } else {

            throw paymentFetchError;

          }

        }

      }


      /* =====================================================
         CREATE A2U PAYMENT
      ===================================================== */

      if (!paymentId) {

        const payment =
          await createA2UPayment({

            uid:
              String(
                earning.pi_uid
              ),

            amount,

            memo:
              `Charcoal Marketplace vendor payout #${earning.id}`,

            metadata: {

              type:
                "vendor_earnings",

              earning_id:
                String(
                  earning.id
                ),

              order_id:
                String(
                  earning.order_id
                ),

              vendor_id:
                String(
                  earning.vendor_id
                )

            }

          });


        paymentId =
          payment.identifier;


        if (!paymentId) {

          throw new Error(
            "Pi did not return an A2U payment identifier"
          );

        }


        const [paymentUpdate] =
          await db.promise().query(
            `
            UPDATE earnings

            SET
              payout_payment_id=?,
              payout_error=NULL

            WHERE id=?

              AND status='pending'

              AND payout_payment_id IS NULL
            `,
            [
              paymentId,
              earning.id
            ]
          );


        if (
          !paymentUpdate.affectedRows
        ) {

          throw new Error(
            "Unable to safely store A2U payment identifier"
          );

        }


        currentPayment =
          payment;

      }


      /* =====================================================
         FETCH PAYMENT IF NECESSARY
      ===================================================== */

      if (!currentPayment) {

        currentPayment =
          await fetchPaymentStrict(
            paymentId
          );

      }


      if (!currentPayment) {

        throw new Error(
          "Unable to retrieve A2U payment from Pi"
        );

      }


      /* =====================================================
         VERIFY PAYMENT DIRECTION
      ===================================================== */

      if (
        currentPayment.direction &&

        currentPayment.direction !==
          "app_to_user"
      ) {

        throw new Error(
          `Payment ${paymentId} is not an App-To-User payment`
        );

      }


      /* =====================================================
         HANDLE CANCELLED PAYMENT
      ===================================================== */

      const currentStatus =
        currentPayment.status ||
        {};


      if (
        currentStatus.cancelled ===
          true ||

        currentStatus.user_cancelled ===
          true
      ) {

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_payment_id=NULL,
            payout_txid=NULL,
            payout_error=?

          WHERE id=?

            AND status='pending'
          `,
          [

            "Previous A2U payment was cancelled. A new payout will be created on the next release attempt.",

            earning.id

          ]
        );


        throw new Error(
          "The previous Pi vendor payout payment was cancelled. Please press Release Pi again."
        );

      }


      /* =====================================================
         GET EXISTING TRANSACTION
      ===================================================== */

      const existingTxid =
        currentPayment.transaction?.txid ||
        currentPayment.transaction_id ||
        null;


      const alreadyCompleted =
        currentPayment.status
          ?.developer_completed ===
            true;


      /* =====================================================
         SUBMIT A2U TO BLOCKCHAIN
      ===================================================== */

      if (
        alreadyCompleted &&
        existingTxid
      ) {

        txid =
          existingTxid;

      } else {

        const submission =
          await submitA2UPayment(
            paymentId
          );


        txid =
          submission.txid;

      }


      if (!txid) {

        throw new Error(
          "Pi blockchain submission did not return a transaction ID"
        );

      }


      /* =====================================================
         SAVE TRANSACTION ID
      ===================================================== */

      await db.promise().query(
        `
        UPDATE earnings

        SET
          payout_txid=?,
          payout_error=NULL

        WHERE id=?

          AND status='pending'
        `,
        [
          txid,
          earning.id
        ]
      );


      /* =====================================================
         COMPLETE A2U PAYMENT
      ===================================================== */

      let completedPayment =
        currentPayment;


      if (
        !alreadyCompleted
      ) {

        completedPayment =
          await completePayment(
            paymentId,
            txid
          );

      }


      /* =====================================================
         VERIFY FINAL PI STATE
      ===================================================== */

      const confirmed =
        await fetchPaymentStrict(
          paymentId
        );


      const completed =
        Boolean(
          completedPayment &&
          confirmed &&
          confirmed.status &&
          confirmed.status
            .developer_completed ===
              true
        );


      if (!completed) {

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_error=?

          WHERE id=?

            AND status='pending'
          `,
          [
            "Pi payment was submitted but has not yet been confirmed as completed.",
            earning.id
          ]
        );


        return res.status(202).json({

          success: true,

          status:
            "processing",

          message:
            "Pi vendor payout was submitted and is awaiting final confirmation.",

          earning_id:
            earning.id,

          payment_id:
            paymentId,

          txid

        });

      }


      /* =====================================================
         MARK EARNING PAID
      ===================================================== */

      const [paidResult] =
        await db.promise().query(
          `
          UPDATE earnings

          SET

            status='paid',

            payout_payment_id=?,

            payout_txid=?,

            paid_at=CURRENT_TIMESTAMP,

            payout_error=NULL

          WHERE id=?

            AND status='pending'
          `,
          [
            paymentId,
            txid,
            earning.id
          ]
        );


      if (
        !paidResult.affectedRows
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Payout completed but earning status could not be updated safely",

          payment_id:
            paymentId,

          txid

        });

      }


      /* =====================================================
         NOTIFY VENDOR
      ===================================================== */

      await db.promise().query(
        `
        INSERT INTO notifications
        (
          user_id,
          message,
          type
        )

        VALUES (?, ?, ?)
        `,
        [

          earning.vendor_id,

          `Your vendor earning of ${amount} Pi has been released successfully. Transaction: ${txid}`,

          "earning"

        ]
      );


      /* =====================================================
         SUCCESS
      ===================================================== */

      return res.json({

        success: true,

        status:
          "paid",

        message:
          `Successfully released ${amount} Pi to ${earning.vendor_name}`,

        earning_id:
          earning.id,

        vendor_id:
          earning.vendor_id,

        pi_uid:
          earning.pi_uid,

        pi_username:
          earning.pi_username,

        amount_pi:
          amount,

        payment_id:
          paymentId,

        txid

      });


    } catch (error) {

      console.error(
        "[A2U VENDOR PAYOUT ERROR]",
        error.response?.data ||
        error.message ||
        error
      );


      try {

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_error=?

          WHERE id=?

            AND status='pending'
          `,
          [

            JSON.stringify(
              error.response?.data ||
              error.message ||
              "Unknown A2U payout error"
            ).slice(
              0,
              2000
            ),

            earningId

          ]
        );

      } catch (dbError) {

        console.error(
          "[A2U] Failed to save payout error:",
          dbError
        );

      }


      return res.status(500).json({

        success: false,

        message:
          error.response?.data?.error_message ||
          error.response?.data?.message ||
          error.message ||
          "Vendor A2U payout failed",

        earning_id:
          earningId,

        payment_id:
          paymentId,

        txid,

        error:
          error.response?.data ||
          error.message ||
          null

      });


    } finally {

      if (
        connection &&
        lockAcquired
      ) {

        try {

          await connection.query(
            "SELECT RELEASE_LOCK(?)",
            [
              A2U_LOCK_NAME
            ]
          );

        } catch (lockError) {

          console.error(
            "[A2U] Failed to release lock:",
            lockError
          );

        }

      }


      if (connection) {

        connection.release();

      }

    }

  }
);


/* =========================================================
   PLATFORM WITHDRAWAL SUMMARY
=========================================================

   GET /api/a2u/withdrawals/summary

========================================================= */

router.get(
  "/withdrawals/summary",
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

          WHERE
            type='platform_fee'

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

          WHERE
            role='admin'

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
          availableRows[0]
            ?.available_pi
        );


      const withdrawnPi =
        roundPi(
          withdrawalRows[0]
            ?.withdrawn_pi
        );


      const totalPercent =
        adminRows.reduce(
          (
            total,
            admin
          ) => {

            return total +
              Number(
                admin.admin_share_percent ||
                0
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
        "[A2U WITHDRAWAL SUMMARY]",
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
   PLATFORM WITHDRAWAL HISTORY
========================================================= */

router.get(
  "/withdrawals/history",
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
        "[A2U WITHDRAWAL HISTORY]",
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
   PLATFORM WITHDRAWAL DETAILS
========================================================= */

router.get(
  "/withdrawals/:id",
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

          WHERE
            wi.withdrawal_id=?

          ORDER BY
            wi.id
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
        "[A2U WITHDRAWAL DETAILS]",
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
========================================================= */

router.post(
  "/withdrawals/admin-shares",
  requireSuperAdmin,
  async (req, res) => {

    const shares =
      Array.isArray(
        req.body?.shares
      )
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
            SELECT
              id

            FROM users

            WHERE
              id=?

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
        "[A2U ADMIN SHARES]",
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
   PROCESS ONE PLATFORM WITHDRAWAL
========================================================= */

async function processPlatformWithdrawal(
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

      WHERE
        wi.withdrawal_id=?

      ORDER BY
        wi.id
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


      let payment = null;


      let paymentId =
        item.payout_payment_id ||
        null;


      /* =====================================================
         RESUME EXISTING PAYMENT
      ===================================================== */

      if (paymentId) {

        try {

          payment =
            await fetchPaymentStrict(
              paymentId
            );


        } catch (error) {

          if (
            Number(
              error.status
            ) === 404 ||

            error.code ===
              "payment_not_found"
          ) {

            await db.promise().query(
              `
              UPDATE withdrawal_items

              SET
                payout_payment_id=NULL,
                payout_txid=NULL,
                error_message=?

              WHERE id=?
              `,
              [
                "Previous A2U payment was not found on Pi. A new payout payment will be created.",
                item.id
              ]
            );


            paymentId =
              null;

          } else {

            throw error;

          }

        }

      }


      /* =====================================================
         CREATE A2U PAYMENT
      ===================================================== */

      if (!paymentId) {

        if (
          !item.pi_uid ||
          String(
            item.pi_uid
          ).trim() === ""
        ) {

          throw new Error(
            `${item.name} does not have a valid Pi UID`
          );

        }


        const amount =
          roundPi(
            item.amount_pi
          );


        if (
          amount <= 0
        ) {

          throw new Error(
            `Invalid withdrawal amount for ${item.name}`
          );

        }


        payment =
          await createA2UPayment({

            uid:
              String(
                item.pi_uid
              ),

            amount,

            memo:
              `Charcoal Marketplace admin earnings withdrawal #${withdrawalId}`,

            metadata: {

              type:
                "admin_platform_earnings",

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


        paymentId =
          payment.identifier;


        if (!paymentId) {

          throw new Error(
            "Pi did not return an A2U payment identifier"
          );

        }


        await db.promise().query(
          `
          UPDATE withdrawal_items

          SET
            payout_payment_id=?,
            error_message=NULL

          WHERE id=?
          `,
          [
            paymentId,
            item.id
          ]
        );

      }


      /* =====================================================
         FETCH CURRENT PAYMENT
      ===================================================== */

      if (!payment) {

        payment =
          await fetchPaymentStrict(
            paymentId
          );

      }


      if (!payment) {

        throw new Error(
          "Unable to retrieve A2U payment from Pi"
        );

      }


      /* =====================================================
         SAVE PI-RESOLVED WALLET ADDRESS
      ===================================================== */

      const piRecipientAddress =
        payment.to_address ||
        null;


      if (
        piRecipientAddress
      ) {

        await db.promise().query(
          `
          UPDATE withdrawal_items

          SET
            wallet_address=?

          WHERE id=?
          `,
          [
            piRecipientAddress,
            item.id
          ]
        );

      }


      /* =====================================================
         VERIFY DIRECTION
      ===================================================== */

      if (
        payment.direction &&

        payment.direction !==
          "app_to_user"
      ) {

        throw new Error(
          `Payment ${paymentId} is not an App-To-User payment`
        );

      }


      /* =====================================================
         CANCELLED PAYMENT
      ===================================================== */

      if (
        payment.status?.cancelled ===
          true ||

        payment.status?.user_cancelled ===
          true
      ) {

        await db.promise().query(
          `
          UPDATE withdrawal_items

          SET
            payout_payment_id=NULL,
            payout_txid=NULL,
            error_message=?

          WHERE id=?
          `,
          [
            "Previous A2U payment was cancelled. A new payout will be created on the next attempt.",
            item.id
          ]
        );


        throw new Error(
          "The previous Pi A2U withdrawal was cancelled. Please retry the withdrawal."
        );

      }


      /* =====================================================
         EXISTING TRANSACTION
      ===================================================== */

      const existingTxid =
        payment.transaction?.txid ||
        payment.transaction_id ||
        null;


      const alreadyCompleted =
        payment.status
          ?.developer_completed ===
            true;


      let txid =
        existingTxid;


      /* =====================================================
         SUBMIT A2U
      ===================================================== */

      if (
        !alreadyCompleted
      ) {

        const submission =
          await submitA2UPayment(
            paymentId
          );


        txid =
          submission.txid;

      }


      if (!txid) {

        throw new Error(
          "Pi did not return an A2U transaction ID"
        );

      }


      /* =====================================================
         SAVE TXID
      ===================================================== */

      await db.promise().query(
        `
        UPDATE withdrawal_items

        SET
          payout_txid=?,
          status='processing',
          error_message=NULL

        WHERE id=?
        `,
        [
          txid,
          item.id
        ]
      );


      /* =====================================================
         COMPLETE PAYMENT
      ===================================================== */

      if (
        !alreadyCompleted
      ) {

        await completePayment(
          paymentId,
          txid
        );

      }


      /* =====================================================
         VERIFY COMPLETION
      ===================================================== */

      const confirmed =
        await fetchPaymentStrict(
          paymentId
        );


      if (
        !confirmed?.status
          ?.developer_completed
      ) {

        results.push({

          user_id:
            item.user_id,

          name:
            item.name,

          amount_pi:
            item.amount_pi,

          status:
            "processing",

          payout_payment_id:
            paymentId,

          payout_txid:
            txid,

          error:
            "Pi payment is awaiting final confirmation"

        });


        continue;

      }


      /* =====================================================
         MARK WITHDRAWAL ITEM COMPLETED
      ===================================================== */

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


      /* =====================================================
         WITHDRAWAL LEDGER
      ===================================================== */

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

          `Admin platform earnings withdrawal #${withdrawalId}`

        ]
      );


      /* =====================================================
         NOTIFY ADMIN
      ===================================================== */

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

          `Your platform earnings withdrawal of ${item.amount_pi} Pi has been completed successfully. Transaction: ${txid}`

        ]
      );


      results.push({

        user_id:
          item.user_id,

        name:
          item.name,

        pi_uid:
          item.pi_uid,

        pi_username:
          item.pi_username,

        amount_pi:
          item.amount_pi,

        status:
          "completed",

        payout_payment_id:
          paymentId,

        payout_txid:
          txid,

        wallet_address:
          piRecipientAddress

      });


    } catch (error) {

      console.error(
        `[A2U WITHDRAWAL ITEM ${item.id}]`,
        error.response?.data ||
        error.message ||
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

          JSON.stringify(
            error.response?.data ||
            error.message ||
            "Unknown A2U withdrawal error"
          ).slice(
            0,
            2000
          ),

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

          `Your platform earnings withdrawal of ${item.amount_pi} Pi could not be completed. Please contact the Super Admin.`

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


  const completedCount =
    results.filter(
      item =>
        item.status ===
        "completed"
    ).length;


  const failedCount =
    results.filter(
      item =>
        item.status ===
        "failed"
    ).length;


  const processingCount =
    results.filter(
      item =>
        item.status ===
        "processing"
    ).length;


  let withdrawalStatus;


  if (
    completedCount ===
      results.length
  ) {

    withdrawalStatus =
      "completed";

  } else if (
    completedCount > 0
  ) {

    withdrawalStatus =
      "partial";

  } else if (
    processingCount > 0
  ) {

    withdrawalStatus =
      "processing";

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

          : withdrawalStatus ===
              "processing"

            ? "Withdrawal is still being processed"

            : "Withdrawal failed",

    results

  };

}


/* =========================================================
   START PLATFORM EARNINGS WITHDRAWAL
=========================================================

   POST /api/a2u/withdrawals/start

========================================================= */

router.post(
  "/withdrawals/start",
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


    let withdrawalId = null;

    let lockAcquired = false;


    try {

      /* =====================================================
         GLOBAL LOCK
      ===================================================== */

      const [lockRows] =
        await connection.query(
          "SELECT GET_LOCK(?, 300) AS acquired",
          [
            A2U_LOCK_NAME
          ]
        );


      if (
        !lockRows.length ||
        Number(
          lockRows[0].acquired
        ) !== 1
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Another Pi A2U payout is currently being processed. Please try again shortly."

        });

      }


      lockAcquired =
        true;


      await connection.beginTransaction();


      /* =====================================================
         PREVENT DUPLICATE WITHDRAWAL
      ===================================================== */

      const [activeWithdrawals] =
        await connection.query(
          `
          SELECT
            id

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


      /* =====================================================
         LOAD AVAILABLE PLATFORM FEES
      ===================================================== */

      const [earnings] =
        await connection.query(
          `
          SELECT

            id,
            amount_pi

          FROM earnings

          WHERE
            type='platform_fee'

            AND status='available'

            AND withdrawal_id IS NULL

          ORDER BY
            id

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


      /* =====================================================
         LOAD APPROVED ADMINS
      ===================================================== */

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

          WHERE
            role='admin'

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
          "No approved administrators are configured"
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
            admin.admin_share_percent ||
            0
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


      /* =====================================================
         IMPORTANT:
         ONLY PI UID IS REQUIRED.

         Wallet address is resolved by Pi after the A2U
         payment is created.

      ===================================================== */

      for (
        const admin
        of admins
      ) {

        if (
          !admin.pi_uid ||
          String(
            admin.pi_uid
          ).trim() === ""
        ) {

          throw new Error(
            `${admin.name} does not have a valid Pi UID`
          );

        }

      }


      /* =====================================================
         CREATE WITHDRAWAL
      ===================================================== */

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


      /* =====================================================
         CREATE ADMIN DISTRIBUTION ITEMS
      ===================================================== */

      for (
        const admin
        of admins
      ) {

        const percentage =
          Number(
            admin.admin_share_percent ||
            0
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

            /*
             * This may be NULL.
             *
             * Pi will provide the actual recipient address
             * when the A2U payment is created.
             */
            admin.pi_wallet_address ||
              null

          ]
        );

      }


      /* =====================================================
         ASSIGN PLATFORM EARNINGS TO WITHDRAWAL
      ===================================================== */

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
        "[A2U WITHDRAWAL START]",
        error
      );


      return res.status(400).json({

        success: false,

        message:
          error.message

      });


    } finally {

      if (
        lockAcquired
      ) {

        try {

          await connection.query(
            "SELECT RELEASE_LOCK(?)",
            [
              A2U_LOCK_NAME
            ]
          );

        } catch (error) {

          console.error(
            "[A2U] Failed to release start lock:",
            error
          );

        }

      }

      connection.release();

    }


    /* =====================================================
       PROCESS A2U OUTSIDE DB TRANSACTION
    ===================================================== */

    try {

      /*
       * Use a second processing lock so another payout
       * cannot start simultaneously.
       */

      const processingConnection =
        await db.promise()
          .getConnection();


      let processingLock =
        false;


      try {

        const [lockRows] =
          await processingConnection.query(
            "SELECT GET_LOCK(?, 300) AS acquired",
            [
              A2U_LOCK_NAME
            ]
          );


        if (
          !lockRows.length ||
          Number(
            lockRows[0].acquired
          ) !== 1
        ) {

          throw new Error(
            "Another A2U payment is currently being processed"
          );

        }


        processingLock =
          true;


        const result =
          await processPlatformWithdrawal(
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


      } finally {

        if (
          processingLock
        ) {

          try {

            await processingConnection.query(
              "SELECT RELEASE_LOCK(?)",
              [
                A2U_LOCK_NAME
              ]
            );

          } catch {}

        }


        processingConnection.release();

      }


    } catch (error) {

      console.error(
        "[A2U WITHDRAWAL PROCESS]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Withdrawal was created but A2U processing failed",

        withdrawal_id:
          withdrawalId,

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   RETRY FAILED / PARTIAL WITHDRAWAL
========================================================= */

router.post(
  "/withdrawals/:id/retry",
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
          SELECT *

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

          WHERE
            withdrawal_id=?

            AND status IN (
              'pending',
              'failed',
              'processing'
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
            "There are no pending or failed payout items to retry"

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


      const connection =
        await db.promise()
          .getConnection();


      let lockAcquired =
        false;


      try {

        const [lockRows] =
          await connection.query(
            "SELECT GET_LOCK(?, 300) AS acquired",
            [
              A2U_LOCK_NAME
            ]
          );


        if (
          !lockRows.length ||
          Number(
            lockRows[0].acquired
          ) !== 1
        ) {

          throw new Error(
            "Another A2U payment is currently being processed"
          );

        }


        lockAcquired =
          true;


        const result =
          await processPlatformWithdrawal(
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


      } finally {

        if (
          lockAcquired
        ) {

          try {

            await connection.query(
              "SELECT RELEASE_LOCK(?)",
              [
                A2U_LOCK_NAME
              ]
            );

          } catch {}

        }


        connection.release();

      }


    } catch (error) {

      console.error(
        "[A2U WITHDRAWAL RETRY]",
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


/* =========================================================
   INCOMPLETE PI A2U PAYMENTS
=========================================================

   GET /api/a2u/payments/incomplete

========================================================= */

router.get(
  "/payments/incomplete",
  requireSuperAdmin,
  async (req, res) => {

    try {

      const payments =
        await getIncompleteServerPayments();


      return res.json({

        success: true,

        payments:
          payments || []

      });


    } catch (error) {

      console.error(
        "[A2U INCOMPLETE PAYMENTS]",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Failed to load incomplete Pi A2U payments",

        error:
          error.message

      });

    }

  }
);


/* =========================================================
   EXPORT
========================================================= */

module.exports =
  router;