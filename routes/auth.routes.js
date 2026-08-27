const router = require("express").Router();
const jwt = require("jsonwebtoken");
const axios = require("axios");
const db = require("../config/db");


/* =========================================================
   CONFIGURATION
========================================================= */

const SECRET =
  process.env.JWT_SECRET;


if (!SECRET) {

  throw new Error(
    "JWT_SECRET is required"
  );

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

      id:
        user.id,

      email:
        user.email,

      role:
        user.role,

      admin_level:
        user.admin_level ||
        "none",

      pi_uid:
        user.pi_uid ||
        null

    },

    SECRET,

    {

      expiresIn:
        "1d"

    }

  );

}


/* =========================================================
   PUBLIC USER DATA
========================================================= */

function publicUser(user) {

  return {

    id:
      user.id,

    name:
      user.name,

    email:
      user.email,

    role:
      user.role,

    status:
      user.status,

    pi_uid:
      user.pi_uid ||
      null,

    pi_username:
      user.pi_username ||
      null,

    /*
     * Public receiving wallet address.
     *
     * This field may be null when Pi does not return
     * the wallet address through /me.
     *
     * A2U payout uses the verified Pi UID so Pi can
     * resolve the user's current wallet.
     */
    pi_wallet_address:
      user.pi_wallet_address ||
      null,

    admin_level:
      user.admin_level ||
      "none",

    vendor_status:
      user.vendor_status ||
      "none",

    business_name:
      user.business_name ||
      null,

    business_phone:
      user.business_phone ||
      null,

    business_location:
      user.business_location ||
      null,

    business_description:
      user.business_description ||
      null

  };

}


/* =========================================================
   CHECK PI SCOPE
========================================================= */

function hasPiScope(
  piUser,
  scope
) {

  const scopes =
    piUser
      ?.credentials
      ?.scopes;


  return (
    Array.isArray(scopes) &&
    scopes.includes(scope)
  );

}


/* =========================================================
   VERIFY PI ACCOUNT
========================================================= */

async function verifyPiAccount(
  accessToken
) {

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

        timeout:
          10000

      }
    );


  const piUser =
    response.data;


  if (!piUser?.uid) {

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
        piUser.username ||
        null,

      scopes:
        piUser.credentials
          ?.scopes ||
        []

    }
  );


  return piUser;

}


/* =========================================================
   REQUIRE WALLET ADDRESS SCOPE
========================================================= */

function requireWalletScope(
  piUser
) {

  if (
    hasPiScope(
      piUser,
      "wallet_address"
    )
  ) {

    return true;

  }


  const error =
    new Error(
      "Pi wallet permission is required. Please authenticate again and authorize the wallet_address permission."
    );


  error.code =
    "PI_WALLET_SCOPE_REQUIRED";


  error.status =
    403;


  throw error;

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

      business_description

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

        success:
          false,

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


      /*
       * Vendor accounts need wallet_address permission
       * because the marketplace will eventually send
       * vendor earnings through Pi A2U.
       */

      requireWalletScope(
        piUser
      );


      const uid =
        piUser.uid;


      const username =
        piUser.username ||
        "Pi User";


      const email =
        `${uid}@pi.app`;


      /*
       * If Pi happens to return a wallet address through
       * the verified /me response, keep it.
       *
       * Otherwise leave it NULL.
       *
       * We NEVER trust a wallet address supplied manually
       * by the browser.
       */

      const walletAddress =
        piUser.wallet_address ||
        null;


      /* ===================================================
         FIND EXISTING PI USER
      =================================================== */

      db.query(

        "SELECT * FROM users WHERE pi_uid=? LIMIT 1",

        [uid],

        (err, rows) => {

          if (err) {

            console.error(
              "Vendor lookup:",
              err
            );

            return res.status(500).json({

              success:
                false,

              message:
                "Database error"

            });

          }


          /* ===============================================
             NEW PI USER
          =============================================== */

          if (!rows.length) {

            return db.query(

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
                 vendor_status,
                 business_name,
                 business_phone,
                 business_location,
                 business_description,
                 vendor_applied_at
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
                 ?,
                 ?,
                 ?,
                 ?,
                 ?,
                 CURRENT_TIMESTAMP
               )`,

              [

                name.trim(),

                email,

                "buyer",

                "approved",

                uid,

                username,

                walletAddress,

                "none",

                "pending",

                business_name.trim(),

                business_phone?.trim() ||
                  null,

                business_location.trim(),

                business_description?.trim() ||
                  null

              ],

              (e, result) => {

                if (e) {

                  console.error(
                    "Vendor insert:",
                    e
                  );

                  return res.status(500).json({

                    success:
                      false,

                    message:
                      "Failed to submit vendor application"

                  });

                }


                return res.status(201).json({

                  success:
                    true,

                  message:
                    "Vendor application submitted. Wait for Admin approval.",

                  vendor_status:
                    "pending",

                  user_id:
                    result.insertId

                });

              }

            );

          }


          /* ===============================================
             EXISTING PI USER
          =============================================== */

          const user =
            rows[0];


          /* ===============================================
             ADMIN CANNOT BECOME VENDOR
          =============================================== */

          if (
            user.role === "admin"
          ) {

            return res.status(403).json({

              success:
                false,

              message:
                "Administrator accounts cannot register as vendors"

            });

          }


          /* ===============================================
             ALREADY APPROVED VENDOR
          =============================================== */

          if (

            user.role === "vendor" &&
            user.vendor_status === "approved"

          ) {

            return res.status(409).json({

              success:
                false,

              message:
                "This Pi account is already an approved vendor"

            });

          }


          /* ===============================================
             APPLICATION ALREADY PENDING
          =============================================== */

          if (
            user.vendor_status ===
            "pending"
          ) {

            return res.status(409).json({

              success:
                false,

              message:
                "Vendor application is already pending"

            });

          }


          /* ===============================================
             RE-SUBMIT VENDOR APPLICATION
          =============================================== */

          db.query(

            `UPDATE users SET

              vendor_status='pending',

              pi_username=?,

              pi_wallet_address=?,

              business_name=?,

              business_phone=?,

              business_location=?,

              business_description=?,

              vendor_applied_at=CURRENT_TIMESTAMP,

              vendor_reviewed_at=NULL,

              vendor_reviewed_by=NULL,

              vendor_rejection_reason=NULL

             WHERE id=?`,

            [

              username,

              walletAddress,

              business_name.trim(),

              business_phone?.trim() ||
                null,

              business_location.trim(),

              business_description?.trim() ||
                null,

              user.id

            ],

            e => {

              if (e) {

                console.error(
                  "Vendor update:",
                  e
                );

                return res.status(500).json({

                  success:
                    false,

                  message:
                    "Failed to submit vendor application"

                });

              }


              return res.json({

                success:
                  true,

                message:
                  "Vendor application submitted. Wait for Admin approval.",

                vendor_status:
                  "pending"

              });

            }

          );

        }

      );

    } catch (error) {

      console.error(

        "Vendor Pi registration:",

        error.response?.data ||
        error.message

      );


      if (
        error.code ===
        "PI_WALLET_SCOPE_REQUIRED"
      ) {

        return res.status(403).json({

          success:
            false,

          code:
            "PI_WALLET_SCOPE_REQUIRED",

          message:
            "Pi wallet permission is required. Please authenticate again and authorize the wallet_address permission in Pi Browser."

        });

      }


      return res.status(401).json({

        success:
          false,

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
         FIND PI USER
      =================================================== */

      db.query(

        "SELECT * FROM users WHERE pi_uid=? LIMIT 1",

        [uid],

        (err, rows) => {

          if (err) {

            console.error(
              "Pi login lookup:",
              err
            );

            return res.status(500).json({

              success:
                false,

              message:
                "Database error"

            });

          }


          /* ===============================================
             EXISTING PI USER
          =============================================== */

          if (rows.length) {

            const user =
              rows[0];


            /* =============================================
               CHECK ACCOUNT STATUS
            ============================================= */

            if (
              user.status !==
              "approved"
            ) {

              return res.status(403).json({

                success:
                  false,

                message:

                  user.vendor_status ===
                  "pending"

                    ? "Your vendor application is awaiting Admin approval."

                    : "Account is not approved"

              });

            }


            /*
             * If this is an approved vendor, make sure
             * the wallet_address permission is present.
             *
             * This prevents the vendor from reaching the
             * payout stage with a token that Pi will reject.
             */

            if (
              user.role === "vendor" &&
              user.vendor_status === "approved"
            ) {

              try {

                requireWalletScope(
                  piUser
                );

              } catch (scopeError) {

                return res.status(403).json({

                  success:
                    false,

                  code:
                    "PI_WALLET_SCOPE_REQUIRED",

                  message:
                    "Your vendor account requires Pi wallet permission. Please authenticate again and authorize the wallet_address permission."

                });

              }

            }


            /* =============================================
               UPDATE PI USERNAME
            ============================================= */

            db.query(

              `UPDATE users SET
                 pi_username=?
               WHERE id=?`,

              [

                username,

                user.id

              ],

              updateError => {

                if (updateError) {

                  console.error(
                    "Pi username update:",
                    updateError
                  );

                }


                /* =========================================
                   SUCCESSFUL PI LOGIN
                ========================================= */

                return res.json({

                  success:
                    true,

                  token:
                    createToken(user),

                  user:
                    publicUser(user)

                });

              }

            );


            return;

          }


          /* ===============================================
             CREATE NEW PI USER
          =============================================== */

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

              "buyer",

              "approved",

              uid,

              username,

              null,

              "none",

              "none"

            ],

            (e, r) => {

              if (e) {

                console.error(
                  "Pi user insert:",
                  e
                );

                return res.status(500).json({

                  success:
                    false,

                  message:
                    "Failed to create Pi user"

                });

              }


              /* =========================================
                 FETCH CREATED USER
              ========================================= */

              db.query(

                "SELECT * FROM users WHERE id=? LIMIT 1",

                [r.insertId],

                (e2, rows2) => {

                  if (
                    e2 ||
                    !rows2.length
                  ) {

                    return res.status(500).json({

                      success:
                        false,

                      message:
                        "User fetch failed"

                    });

                  }


                  const user =
                    rows2[0];


                  return res.json({

                    success:
                      true,

                    token:
                      createToken(user),

                    user:
                      publicUser(user)

                  });

                }

              );

            }

          );

        }

      );

    } catch (error) {

      console.error(

        "Pi login:",

        error.response?.data ||
        error.message

      );


      if (
        error.code ===
        "PI_WALLET_SCOPE_REQUIRED"
      ) {

        return res.status(403).json({

          success:
            false,

          code:
            "PI_WALLET_SCOPE_REQUIRED",

          message:
            "Pi wallet permission is required. Please authenticate again and authorize the wallet_address permission."

        });

      }


      return res.status(401).json({

        success:
          false,

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
      =================================================== */

      db.query(

        "SELECT * FROM users WHERE pi_uid=? LIMIT 1",

        [uid],

        (err, rows) => {

          if (err) {

            console.error(
              "Pi admin lookup:",
              err
            );

            return res.status(500).json({

              success:
                false,

              message:
                "Database error"

            });

          }


          /* ===============================================
             EXISTING ADMIN
          =============================================== */

          if (rows.length) {

            const user =
              rows[0];


            if (
              user.status !==
              "approved"
            ) {

              return res.status(403).json({

                success:
                  false,

                message:
                  "Administrator account is not approved"

              });

            }


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

                success:
                  false,

                message:
                  "This Pi account is not authorized for the Admin Panel"

              });

            }


            return res.json({

              success:
                true,

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


          /* ===============================================
             FIRST SUPER ADMIN AUTHORIZATION
          =============================================== */

          if (

            !PI_SUPER_ADMIN_USERNAME ||

            username !==
              PI_SUPER_ADMIN_USERNAME

          ) {

            return res.status(403).json({

              success:
                false,

              message:
                "This Pi account is not an authorized administrator"

            });

          }


          const email =
            `${uid}@pi.app`;


          /* ===============================================
             CREATE SUPER ADMIN
          =============================================== */

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

              null,

              "super_admin",

              "none"

            ],

            (e, r) => {

              if (e) {

                console.error(
                  "Super Admin insert:",
                  e
                );

                return res.status(500).json({

                  success:
                    false,

                  message:
                    "Failed to create Super Admin"

                });

              }


              /* =========================================
                 FETCH SUPER ADMIN
              ========================================= */

              db.query(

                "SELECT * FROM users WHERE id=? LIMIT 1",

                [r.insertId],

                (e2, rows2) => {

                  if (
                    e2 ||
                    !rows2.length
                  ) {

                    return res.status(500).json({

                      success:
                        false,

                      message:
                        "Super Admin fetch failed"

                    });

                  }


                  const user =
                    rows2[0];


                  return res.json({

                    success:
                      true,

                    message:
                      "Super Admin created successfully",

                    token:
                      createToken(user),

                    user:
                      publicUser(user)

                  });

                }

              );

            }

          );

        }

      );

    } catch (error) {

      console.error(

        "Pi admin verification:",

        error.response?.data ||
        error.message

      );


      return res.status(401).json({

        success:
          false,

        message:
          "Pi account verification failed"

      });

    }

  }

);


/* =========================================================
   EXPORT ROUTER
========================================================= */

module.exports =
  router;