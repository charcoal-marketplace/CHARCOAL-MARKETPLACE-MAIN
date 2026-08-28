const router = require("express").Router();
const jwt = require("jsonwebtoken");
const axios = require("axios");
const db = require("../config/db");


/* =========================================================
   CONFIGURATION
========================================================= */

const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  throw new Error("JWT_SECRET is required");
}


const PI_BASE_URL =
  "https://api.minepi.com/v2";


const PI_SUPER_ADMIN_USERNAME =
  process.env.PI_SUPER_ADMIN_USERNAME;


if (!PI_SUPER_ADMIN_USERNAME) {

  console.warn(
    "⚠️ PI_SUPER_ADMIN_USERNAME is not configured."
  );

}


/* =========================================================
   CREATE JWT TOKEN
========================================================= */

function createToken(user) {

  return jwt.sign(

    {
      id: user.id,

      email: user.email,

      role: user.role,

      admin_level:
        user.admin_level || "none",

      pi_uid:
        user.pi_uid || null
    },

    SECRET,

    {
      expiresIn: "1d"
    }

  );

}


/* =========================================================
   PUBLIC USER DATA
========================================================= */

function publicUser(user) {

  return {

    id: user.id,

    name: user.name,

    email: user.email,

    role: user.role,

    status: user.status,

    pi_uid:
      user.pi_uid || null,

    pi_username:
      user.pi_username || null,

    /*
     * Public receiving wallet address.
     *
     * NEVER expose PI_WALLET_PRIVATE_SEED here.
     */
    pi_wallet_address:
      user.pi_wallet_address || null,

    admin_level:
      user.admin_level || "none",

    vendor_status:
      user.vendor_status || "none",

    business_name:
      user.business_name || null,

    business_phone:
      user.business_phone || null,

    business_location:
      user.business_location || null,

    business_description:
      user.business_description || null

  };

}


/* =========================================================
   VERIFY PI ACCOUNT
========================================================= */

async function verifyPiAccount(accessToken) {

  if (!accessToken) {

    throw new Error(
      "Missing Pi access token"
    );

  }


  console.log(
    "[PI AUTH] Verifying Pi access token..."
  );


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


  const piUser =
    response.data || {};


  if (!piUser.uid) {

    throw new Error(
      "Invalid Pi account"
    );

  }


  console.log(
    "[PI AUTH] Pi account verified:",
    {
      uid:
        piUser.uid,

      username:
        piUser.username,

      wallet_address:
        piUser.wallet_address ||
        null
    }
  );


  return piUser;

}


/* =========================================================
   FIND EXISTING USER
=========================================================

   IMPORTANT FOR TESTNET -> MAINNET MIGRATION

   Old users may have the same Pi username but a different
   app-local Pi UID.

   Therefore:

   1. Search by current pi_uid.
   2. If not found, search by pi_username.
   3. If found by username, update the old record with
      the current Mainnet UID.

   This preserves the existing database account.
========================================================= */

function findExistingPiUser(
  uid,
  username
) {

  return new Promise(
    (resolve, reject) => {

      /*
       * First try the current Pi UID.
       */

      db.query(

        `SELECT *
         FROM users
         WHERE pi_uid=?
         LIMIT 1`,

        [uid],

        (err, rows) => {

          if (err) {

            return reject(err);

          }


          if (rows.length) {

            return resolve({
              user:
                rows[0],

              matchedBy:
                "pi_uid"

            });

          }


          /*
           * UID was not found.
           *
           * This is where Testnet -> Mainnet
           * migration is handled.
           */

          if (!username) {

            return resolve({
              user:
                null,

              matchedBy:
                null

            });

          }


          db.query(

            `SELECT *
             FROM users
             WHERE pi_username=?
             LIMIT 1`,

            [username],

            (err2, rows2) => {

              if (err2) {

                return reject(err2);

              }


              if (!rows2.length) {

                return resolve({
                  user:
                    null,

                  matchedBy:
                    null

                });

              }


              return resolve({

                user:
                  rows2[0],

                matchedBy:
                  "pi_username"

              });

            }

          );

        }

      );

    }

  );

}


/* =========================================================
   RECONCILE PI USER
=========================================================

   If an existing account was found by username instead of
   UID, update the account with the current Mainnet UID.

   Existing role/admin/vendor/business data is preserved.
========================================================= */

function reconcilePiUser(
  user,
  piUser
) {

  return new Promise(
    (resolve, reject) => {

      const uid =
        piUser.uid;

      const username =
        piUser.username ||
        user.pi_username ||
        null;


      const walletAddress =
        piUser.wallet_address ||
        null;


      const fields = [];
      const values = [];


      /*
       * Always make sure current Mainnet UID is stored.
       */

      if (
        uid &&
        String(user.pi_uid || "") !==
        String(uid)
      ) {

        fields.push(
          "pi_uid=?"
        );

        values.push(uid);

      }


      /*
       * Keep the latest verified Pi username.
       */

      if (
        username &&
        String(user.pi_username || "") !==
        String(username)
      ) {

        fields.push(
          "pi_username=?"
        );

        values.push(username);

      }


      /*
       * Only update wallet address when Pi has actually
       * returned a verified wallet address.
       *
       * Never overwrite an existing wallet with NULL.
       */

      if (
        walletAddress &&
        String(user.pi_wallet_address || "") !==
        String(walletAddress)
      ) {

        fields.push(
          "pi_wallet_address=?"
        );

        values.push(walletAddress);

      }


      /*
       * Nothing needs changing.
       */

      if (!fields.length) {

        return resolve(user);

      }


      values.push(
        user.id
      );


      const sql =

        `UPDATE users
         SET ${fields.join(", ")}
         WHERE id=?`;


      db.query(

        sql,

        values,

        err => {

          if (err) {

            return reject(err);

          }


          /*
           * Return the updated account.
           */

          db.query(

            `SELECT *
             FROM users
             WHERE id=?
             LIMIT 1`,

            [user.id],

            (err2, rows) => {

              if (err2) {

                return reject(err2);

              }


              if (!rows.length) {

                return reject(
                  new Error(
                    "User disappeared after Pi account reconciliation"
                  )
                );

              }


              console.log(
                "[PI AUTH] Existing account reconciled:",
                {
                  user_id:
                    rows[0].id,

                  username:
                    rows[0].pi_username,

                  pi_uid:
                    rows[0].pi_uid
                }
              );


              resolve(
                rows[0]
              );

            }

          );

        }

      );

    }

  );

}


/* =========================================================
   CREATE NEW PI USER
========================================================= */

function createNewPiUser({
  name,
  email,
  uid,
  username,
  walletAddress
}) {

  return new Promise(
    (resolve, reject) => {

      db.query(

        `INSERT INTO users
         (
           name,
           email,
           role,
           status,
           pi_uid,
           pi_username,
           pi_wallet_address,
           admin_level,
           vendor_status
         )
         VALUES
         (
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

          name,

          email,

          "buyer",

          "approved",

          uid,

          username,

          walletAddress ||
            null,

          "none",

          "none"

        ],

        (err, result) => {

          if (err) {

            return reject(err);

          }


          db.query(

            `SELECT *
             FROM users
             WHERE id=?
             LIMIT 1`,

            [result.insertId],

            (err2, rows) => {

              if (err2) {

                return reject(err2);

              }


              if (!rows.length) {

                return reject(
                  new Error(
                    "Created Pi user could not be retrieved"
                  )
                );

              }


              resolve(
                rows[0]
              );

            }

          );

        }

      );

    }

  );

}


/* =========================================================
   PI-FIRST VENDOR APPLICATION
========================================================= */

router.post(
  "/vendor-register",
  async (req, res) => {

    const {

      accessToken,

      name,

      business_name,

      business_phone,

      business_location,

      business_description,

      /*
       * Kept for compatibility with your existing frontend.
       *
       * We do NOT trust this as the authoritative wallet
       * when Pi supplies wallet_address through /me.
       */
      pi_wallet_address

    } = req.body || {};


    /* =====================================================
       VALIDATION
    ===================================================== */

    if (
      !accessToken ||
      !name ||
      !business_name ||
      !business_location
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Pi authentication, name, business name and business location are required"

      });

    }


    try {

      /* ===================================================
         VERIFY PI ACCOUNT
      =================================================== */

      const piUser =
        await verifyPiAccount(
          accessToken
        );


      const uid =
        piUser.uid;


      const username =
        piUser.username ||
        "Pi User";


      const email =
        `${uid}@pi.app`;


      /*
       * Prefer wallet address verified/returned by Pi.
       *
       * The manually supplied field remains as a
       * compatibility fallback for existing registrations.
       */

      const verifiedWalletAddress =
        piUser.wallet_address ||
        null;


      const submittedWalletAddress =
        pi_wallet_address
          ? String(
              pi_wallet_address
            ).trim()
          : null;


      const walletAddress =
        verifiedWalletAddress ||
        submittedWalletAddress ||
        null;


      /*
       * Vendor payouts require a receiving wallet.
       */

      if (!walletAddress) {

        return res.status(400).json({

          success: false,

          message:
            "Pi wallet address is required. Please authorize the wallet address permission in Pi Browser and try again."

        });

      }


      /* ===================================================
         FIND EXISTING PI USER
      =================================================== */

      let match;

      try {

        match =
          await findExistingPiUser(
            uid,
            username
          );

      } catch (lookupError) {

        console.error(
          "[PI AUTH] Vendor lookup error:",
          lookupError
        );

        return res.status(500).json({

          success: false,

          message:
            "Database error while finding Pi account"

        });

      }


      /* ===================================================
         NEW PI USER
      =================================================== */

      if (!match.user) {

        try {

          const newUser =
            await createNewPiUser({

              name:
                name.trim(),

              email,

              uid,

              username,

              walletAddress

            });


          /*
           * Convert the new user into a pending vendor
           * application.
           */

          db.query(

            `UPDATE users SET

              vendor_status='pending',

              business_name=?,

              business_phone=?,

              business_location=?,

              business_description=?,

              pi_wallet_address=?,

              vendor_applied_at=CURRENT_TIMESTAMP,

              vendor_reviewed_at=NULL,

              vendor_reviewed_by=NULL,

              vendor_rejection_reason=NULL

             WHERE id=?`,

            [

              business_name.trim(),

              business_phone?.trim() ||
                null,

              business_location.trim(),

              business_description?.trim() ||
                null,

              walletAddress,

              newUser.id

            ],

            (updateError) => {

              if (updateError) {

                console.error(
                  "Vendor application update:",
                  updateError
                );

                return res.status(500).json({

                  success: false,

                  message:
                    "Failed to submit vendor application"

                });

              }


              return res.status(201).json({

                success: true,

                message:
                  "Vendor application submitted. Wait for Admin approval.",

                vendor_status:
                  "pending",

                user_id:
                  newUser.id

              });

            }

          );

          return;

        } catch (insertError) {

          /*
           * This protects against a race condition where
           * another request created the same username between
           * our SELECT and INSERT.
           */

          console.error(
            "[PI AUTH] Pi user insert:",
            insertError
          );


          if (
            insertError.code ===
            "ER_DUP_ENTRY"
          ) {

            return res.status(409).json({

              success: false,

              message:
                "A Pi account with this username already exists. Please log in again so your Mainnet account can be linked to your existing account."

            });

          }


          return res.status(500).json({

            success: false,

            message:
              "Failed to create Pi user"

          });

        }

      }


      /* ===================================================
         EXISTING USER FOUND
      =================================================== */

      let user =
        match.user;


      /* ===================================================
         RECONCILE MAINNET UID
      =================================================== */

      try {

        user =
          await reconcilePiUser(
            user,
            piUser
          );

      } catch (reconcileError) {

        console.error(
          "[PI AUTH] Vendor account reconciliation error:",
          reconcileError
        );

        return res.status(500).json({

          success: false,

          message:
            "Failed to update your Pi account for Mainnet"

        });

      }


      /* ===================================================
         ADMIN CANNOT BECOME VENDOR
      =================================================== */

      if (
        user.role === "admin"
      ) {

        return res.status(403).json({

          success: false,

          message:
            "Administrator accounts cannot register as vendors"

        });

      }


      /* ===================================================
         ALREADY APPROVED VENDOR
      =================================================== */

      if (
        user.role === "vendor" &&
        user.vendor_status === "approved"
      ) {

        return res.status(409).json({

          success: false,

          message:
            "This Pi account is already an approved vendor"

        });

      }


      /* ===================================================
         APPLICATION ALREADY PENDING
      =================================================== */

      if (
        user.vendor_status === "pending"
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Vendor application is already pending"

        });

      }


      /* ===================================================
         RE-SUBMIT VENDOR APPLICATION
      =================================================== */

      db.query(

        `UPDATE users SET

          vendor_status='pending',

          business_name=?,

          business_phone=?,

          business_location=?,

          business_description=?,

          pi_wallet_address=?,

          vendor_applied_at=CURRENT_TIMESTAMP,

          vendor_reviewed_at=NULL,

          vendor_reviewed_by=NULL,

          vendor_rejection_reason=NULL

         WHERE id=?`,

        [

          business_name.trim(),

          business_phone?.trim() ||
            null,

          business_location.trim(),

          business_description?.trim() ||
            null,

          walletAddress,

          user.id

        ],

        e => {

          if (e) {

            console.error(
              "Vendor update:",
              e
            );

            return res.status(500).json({

              success: false,

              message:
                "Failed to submit vendor application"

            });

          }


          return res.json({

            success: true,

            message:
              "Vendor application submitted. Wait for Admin approval.",

            vendor_status:
              "pending"

          });

        }

      );

    } catch (error) {

      console.error(

        "Vendor Pi registration:",

        error.response?.data ||
        error.message

      );


      return res.status(401).json({

        success: false,

        message:
          "Pi authentication failed"

      });

    }

  }

);


/* =========================================================
   PI USER LOGIN
========================================================= */

router.post(
  "/pi-login",
  async (req, res) => {

    try {

      /* ===================================================
         VERIFY PI ACCOUNT
      =================================================== */

      const piUser =
        await verifyPiAccount(
          req.body?.accessToken
        );


      const uid =
        piUser.uid;


      const username =
        piUser.username ||
        "Pi User";


      const email =
        `${uid}@pi.app`;


      /* ===================================================
         FIND EXISTING USER

         FIRST BY UID
         THEN BY USERNAME FOR MIGRATION
      =================================================== */

      let match;

      try {

        match =
          await findExistingPiUser(
            uid,
            username
          );

      } catch (lookupError) {

        console.error(
          "Pi login lookup:",
          lookupError
        );

        return res.status(500).json({

          success: false,

          message:
            "Database error"

        });

      }


      /* ===================================================
         EXISTING USER
      =================================================== */

      if (match.user) {

        let user =
          match.user;


        /*
         * MAINNET MIGRATION:
         *
         * If this account was found by username,
         * replace the old Testnet UID with the current
         * verified Mainnet UID.
         *
         * Existing account data remains untouched.
         */

        try {

          user =
            await reconcilePiUser(
              user,
              piUser
            );

        } catch (reconcileError) {

          console.error(
            "Pi login reconciliation:",
            reconcileError
          );

          return res.status(500).json({

            success: false,

            message:
              "Failed to update your Pi account for Mainnet"

          });

        }


        /* =============================================
           CHECK ACCOUNT STATUS
        ============================================= */

        if (
          user.status !== "approved"
        ) {

          return res.status(403).json({

            success: false,

            message:
              user.vendor_status ===
              "pending"

                ? "Your vendor application is awaiting Admin approval."

                : "Account is not approved"

          });

        }


        /* =============================================
           SUCCESSFUL PI LOGIN
        ============================================= */

        console.log(
          "[PI AUTH] Existing Pi user login:",
          {
            id:
              user.id,

            username:
              user.pi_username,

            role:
              user.role,

            admin_level:
              user.admin_level,

            vendor_status:
              user.vendor_status
          }
        );


        return res.json({

          success: true,

          token:
            createToken(user),

          user:
            publicUser(user)

        });

      }


      /* ===================================================
         CREATE NEW PI USER
      =================================================== */

      try {

        const user =
          await createNewPiUser({

            name:
              username,

            email,

            uid,

            username,

            walletAddress:
              piUser.wallet_address ||
              null

          });


        return res.json({

          success: true,

          token:
            createToken(user),

          user:
            publicUser(user)

        });

      } catch (insertError) {

        console.error(
          "Pi user insert:",
          insertError
        );


        /*
         * If the username already exists, this means the
         * account was created under the old UID/network.
         *
         * Tell the client to retry, while keeping the
         * database safe.
         */

        if (
          insertError.code ===
          "ER_DUP_ENTRY"
        ) {

          return res.status(409).json({

            success: false,

            message:
              "Your existing Pi account was found but could not yet be linked to Mainnet. Please try Pi login again."

          });

        }


        return res.status(500).json({

          success: false,

          message:
            "Failed to create Pi user"

        });

      }

    } catch (error) {

      console.error(

        "Pi login:",

        error.response?.data ||
        error.message

      );


      return res.status(401).json({

        success: false,

        message:
          "Pi authentication failed"

      });

    }

  }

);


/* =========================================================
   PI ADMINISTRATOR LOGIN
========================================================= */

router.post(
  "/pi-admin-login",
  async (req, res) => {

    try {

      /* ===================================================
         VERIFY PI ACCOUNT
      =================================================== */

      const piUser =
        await verifyPiAccount(
          req.body?.accessToken
        );


      const uid =
        piUser.uid;


      const username =
        piUser.username ||
        "Pi User";


      /* ===================================================
         FIND EXISTING PI USER

         FIRST BY UID
         THEN BY USERNAME

         This is critical for your existing Super Admin
         after Testnet -> Mainnet migration.
      =================================================== */

      let match;

      try {

        match =
          await findExistingPiUser(
            uid,
            username
          );

      } catch (lookupError) {

        console.error(
          "Pi admin lookup:",
          lookupError
        );

        return res.status(500).json({

          success: false,

          message:
            "Database error"

        });

      }


      /* ===================================================
         EXISTING ACCOUNT
      =================================================== */

      if (match.user) {

        let user =
          match.user;


        /*
         * MAINNET MIGRATION:
         *
         * Reconnect old Testnet UID to current Mainnet UID.
         */

        try {

          user =
            await reconcilePiUser(
              user,
              piUser
            );

        } catch (reconcileError) {

          console.error(
            "Pi admin reconciliation:",
            reconcileError
          );

          return res.status(500).json({

            success: false,

            message:
              "Failed to update administrator account for Mainnet"

          });

        }


        /* =============================================
           ACCOUNT STATUS
        ============================================= */

        if (
          user.status !==
          "approved"
        ) {

          return res.status(403).json({

            success: false,

            message:
              "Administrator account is not approved"

          });

        }


        /* =============================================
           ADMIN AUTHORIZATION
        ============================================= */

        if (

          user.role !==
            "admin" ||

          ![
            "super_admin",
            "admin",
            "moderator"
          ].includes(
            user.admin_level
          )

        ) {

          return res.status(403).json({

            success: false,

            message:
              "This Pi account is not authorized for the Admin Panel"

          });

        }


        console.log(
          "[PI ADMIN] Administrator login successful:",
          {
            id:
              user.id,

            username:
              user.pi_username,

            admin_level:
              user.admin_level
          }
        );


        return res.json({

          success: true,

          message:
            user.admin_level ===
            "super_admin"

              ? "Super Admin login successful"

              : "Administrator login successful",

          token:
            createToken(user),

          user:
            publicUser(user)

        });

      }


      /* ===================================================
         FIRST SUPER ADMIN AUTHORIZATION
      =================================================== */

      if (

        !PI_SUPER_ADMIN_USERNAME ||

        username !==
          PI_SUPER_ADMIN_USERNAME

      ) {

        return res.status(403).json({

          success: false,

          message:
            "This Pi account is not an authorized administrator"

        });

      }


      const email =
        `${uid}@pi.app`;


      /* ===================================================
         CREATE SUPER ADMIN
      =================================================== */

      try {

        const user =
          await new Promise(
            (resolve, reject) => {

              db.query(

                `INSERT INTO users
                 (
                   name,
                   email,
                   role,
                   status,
                   pi_uid,
                   pi_username,
                   pi_wallet_address,
                   admin_level,
                   vendor_status
                 )
                 VALUES
                 (
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

                  username,

                  email,

                  "admin",

                  "approved",

                  uid,

                  username,

                  piUser.wallet_address ||
                    null,

                  "super_admin",

                  "none"

                ],

                (e, r) => {

                  if (e) {

                    return reject(e);

                  }


                  db.query(

                    `SELECT *
                     FROM users
                     WHERE id=?
                     LIMIT 1`,

                    [r.insertId],

                    (e2, rows2) => {

                      if (e2) {

                        return reject(e2);

                      }


                      if (
                        !rows2.length
                      ) {

                        return reject(
                          new Error(
                            "Super Admin fetch failed"
                          )
                        );

                      }


                      resolve(
                        rows2[0]
                      );

                    }

                  );

                }

              );

            }

          );


        return res.json({

          success: true,

          message:
            "Super Admin created successfully",

          token:
            createToken(user),

          user:
            publicUser(user)

        });

      } catch (adminInsertError) {

        console.error(
          "Super Admin insert:",
          adminInsertError
        );


        if (
          adminInsertError.code ===
          "ER_DUP_ENTRY"
        ) {

          return res.status(409).json({

            success: false,

            message:
              "A Super Admin or Pi account with this username already exists. Please retry the Pi Admin login so the existing account can be reconciled."

          });

        }


        return res.status(500).json({

          success: false,

          message:
            "Failed to create Super Admin"

        });

      }

    } catch (error) {

      console.error(

        "Pi admin verification:",

        error.response?.data ||
        error.message

      );


      return res.status(401).json({

        success: false,

        message:
          "Pi account verification failed"

      });

    }

  }

);


/* =========================================================
   EXPORT ROUTER
========================================================= */

module.exports = router;