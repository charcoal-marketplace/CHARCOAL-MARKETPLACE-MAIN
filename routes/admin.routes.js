const router = require("express").Router();

const db = require("../config/db");

const {
  verifyAdmin,
  requireSuperAdmin
} = require("../middleware/auth.middleware");


/* =========================================================
   ADMIN IDENTITY
========================================================= */

router.get(
  "/me",
  verifyAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        id,
        name,
        email,
        role,
        status,
        pi_uid,
        pi_username,
        admin_level,
        vendor_status,
        business_name,
        business_phone,
        business_location,
        business_description,
        pi_wallet_address,
        created_at
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [req.user.id],

      (err, rows) => {

        if (err) {

          console.error(
            "Admin identity error:",
            err
          );

          return res.status(500).json({
            success: false,
            message: "Failed to load administrator"
          });

        }


        if (!rows.length) {

          return res.status(404).json({
            success: false,
            message: "Administrator not found"
          });

        }


        const admin =
          rows[0];


        if (
          admin.role !== "admin" ||
          admin.status !== "approved"
        ) {

          return res.status(403).json({
            success: false,
            message: "Admin access denied"
          });

        }


        res.json({

          success: true,

          authenticated: true,

          admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            status: admin.status,
            pi_uid: admin.pi_uid,
            pi_username: admin.pi_username,
            admin_level:
              admin.admin_level || "none",

            vendor_status:
              admin.vendor_status || "none",

            business_name:
              admin.business_name || null,

            business_phone:
              admin.business_phone || null,

            business_location:
              admin.business_location || null,

            business_description:
              admin.business_description || null,

            pi_wallet_address:
              admin.pi_wallet_address || null,

            created_at:
              admin.created_at
          }

        });

      }
    );

  }
);


/* =========================================================
   DASHBOARD STATISTICS
   GET /api/admin/dashboard
========================================================= */

router.get(
  "/dashboard",
  verifyAdmin,
  (req, res) => {

    const stats = {};


    db.query(
      "SELECT COUNT(*) AS count FROM users",

      (err, usersResult) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message: "Failed to load users"
          });

        }


        stats.users =
          Number(usersResult[0].count);


        /*
         * IMPORTANT:
         * Vendor count is based on vendor_status.
         *
         * This means an account with:
         *
         * role='admin'
         * vendor_status='approved'
         *
         * is correctly counted as a vendor.
         */

        db.query(
          `
          SELECT COUNT(*) AS count
          FROM users
          WHERE vendor_status = 'approved'
          `,

          (err, vendorsResult) => {

            if (err) {

              return res.status(500).json({
                success: false,
                message: "Failed to load vendors"
              });

            }


            stats.vendors =
              Number(vendorsResult[0].count);


            db.query(
              `
              SELECT COUNT(*) AS count
              FROM products
              `,

              (err, productsResult) => {

                if (err) {

                  return res.status(500).json({
                    success: false,
                    message:
                      "Failed to load products"
                  });

                }


                stats.products =
                  Number(
                    productsResult[0].count
                  );


                db.query(
                  `
                  SELECT COUNT(*) AS count
                  FROM orders
                  `,

                  (err, ordersResult) => {

                    if (err) {

                      return res.status(500).json({
                        success: false,
                        message:
                          "Failed to load orders"
                      });

                    }


                    stats.orders =
                      Number(
                        ordersResult[0].count
                      );


                    db.query(
                      `
                      SELECT
                        COALESCE(
                          SUM(total_pi),
                          0
                        ) AS total
                      FROM orders
                      WHERE status IN (
                        'paid',
                        'shipped',
                        'completed'
                      )
                      `,

                      (err, salesResult) => {

                        if (err) {

                          return res.status(500).json({
                            success: false,
                            message:
                              "Failed to load sales"
                          });

                        }


                        stats.sales =
                          Number(
                            salesResult[0].total || 0
                          );


                        res.json({
                          success: true,
                          stats
                        });

                      }
                    );

                  }
                );

              }
            );

          }
        );

      }
    );

  }
);


/* =========================================================
   PENDING PRODUCTS
   GET /api/admin/products/pending
========================================================= */

router.get(
  "/products/pending",
  verifyAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        p.*,
        u.name AS vendor_name,
        u.email AS vendor_email
      FROM products p
      LEFT JOIN users u
        ON p.vendor_id = u.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
      `,

      (err, result) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message:
              "Failed to load pending products"
          });

        }


        res.json(
          result || []
        );

      }
    );

  }
);


/* =========================================================
   PENDING VENDORS
   GET /api/admin/vendors/pending

   IMPORTANT:
   Vendor approval is controlled by vendor_status,
   not by role.

   This allows an admin account to become a vendor
   without changing role='admin'.
========================================================= */

router.get(
  "/vendors/pending",
  verifyAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        id,
        name,
        email,
        role,
        status,
        pi_uid,
        pi_username,
        admin_level,
        vendor_status,
        business_name,
        business_phone,
        business_location,
        business_description,
        vendor_applied_at
      FROM users
      WHERE vendor_status = 'pending'
      ORDER BY vendor_applied_at DESC
      `,

      (err, result) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message:
              "Failed to load pending vendors"
          });

        }


        res.json(
          result || []
        );

      }
    );

  }
);


/* =========================================================
   ALL APPROVED / ACTIVE VENDORS
   GET /api/admin/vendors

   IMPORTANT:
   Uses vendor_status rather than role.

   Therefore:
   role='vendor' + vendor_status='approved'
   AND
   role='admin' + vendor_status='approved'

   are both vendors.
========================================================= */

router.get(
  "/vendors",
  verifyAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        id,
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
        vendor_applied_at,
        vendor_reviewed_at,
        created_at
      FROM users
      WHERE vendor_status = 'approved'
      ORDER BY created_at DESC
      `,
      (err, vendors) => {

        if (err) {

          console.error(
            "Admin vendors list error:",
            err
          );

          return res.status(500).json({

            success: false,

            message:
              "Failed to load vendors"

          });

        }


        return res.json({

          success: true,

          vendors:
            vendors || []

        });

      }
    );

  }
);


/* =========================================================
   REVOKE VENDOR
   POST /api/admin/vendors/:id/revoke

   IMPORTANT:
   If the vendor is also an administrator:

   BEFORE:
   role='admin'
   admin_level='admin/super_admin'
   vendor_status='approved'

   AFTER:
   role='admin'
   admin_level='admin/super_admin'
   vendor_status='rejected'

   Therefore the administrator DOES NOT lose
   admin dashboard access.

   A normal vendor becomes buyer when revoked.
========================================================= */

router.post(
  "/vendors/:id/revoke",
  verifyAdmin,
  (req, res) => {

    const vendorId =
      Number(req.params.id);


    if (
      !Number.isInteger(vendorId)
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid vendor ID"

      });

    }


    if (
      Number(req.user.id) ===
      vendorId
    ) {

      return res.status(400).json({

        success: false,

        message:
          "You cannot revoke your own account."

      });

    }


    db.query(
      `
      SELECT
        id,
        name,
        role,
        admin_level,
        status,
        vendor_status
      FROM users
      WHERE id=?
      LIMIT 1
      `,
      [vendorId],
      (err, rows) => {

        if (err) {

          console.error(
            "Vendor lookup for revoke:",
            err
          );

          return res.status(500).json({

            success: false,

            message:
              "Database error"

          });

        }


        if (!rows.length) {

          return res.status(404).json({

            success: false,

            message:
              "Vendor not found"

          });

        }


        const vendor =
          rows[0];


        if (
          vendor.vendor_status !==
          "approved"
        ) {

          return res.status(400).json({

            success: false,

            message:
              "This account is not currently an approved vendor"

          });

        }


        /*
         * IMPORTANT:
         *
         * Preserve admin role if this vendor
         * is also an administrator.
         *
         * Only normal vendors become buyers.
         */

        const preservedRole =
          vendor.role === "admin"
            ? "admin"
            : "buyer";


        db.query(
          `
          UPDATE users
          SET
            role=?,
            vendor_status='rejected',
            vendor_reviewed_at=CURRENT_TIMESTAMP,
            vendor_reviewed_by=?,
            vendor_rejection_reason='Vendor access revoked by Admin'
          WHERE id=?
          `,
          [
            preservedRole,
            req.user.id,
            vendorId
          ],
          (updateErr, result) => {

            if (updateErr) {

              console.error(
                "Vendor revoke update:",
                updateErr
              );

              return res.status(500).json({

                success: false,

                message:
                  "Failed to revoke vendor"

              });

            }


            if (
              !result.affectedRows
            ) {

              return res.status(404).json({

                success: false,

                message:
                  "Vendor could not be revoked"

              });

            }


            /* =========================================
               DISABLE VENDOR PRODUCTS
            ========================================= */

            db.query(
              `
              UPDATE products
              SET
                is_active=FALSE
              WHERE vendor_id=?
              `,
              [vendorId],
              productErr => {

                if (productErr) {

                  console.error(
                    "Vendor products disable error:",
                    productErr
                  );

                }


                /* =====================================
                   NOTIFY VENDOR
                ===================================== */

                db.query(
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
                    vendorId,
                    "Your vendor access has been revoked by an Administrator.",
                    "vendor"
                  ],
                  notificationErr => {

                    if (notificationErr) {

                      console.error(
                        "Vendor revoke notification error:",
                        notificationErr
                      );

                    }

                  }
                );


                return res.json({

                  success: true,

                  message:
                    `${vendor.name || "Vendor"} has been revoked successfully`

                });

              }
            );

          }
        );

      }
    );

  }
);


/* =========================================================
   APPROVE PRODUCT
   POST /api/admin/products/approve/:id
========================================================= */

router.post(
  "/products/approve/:id",
  verifyAdmin,
  (req, res) => {

    const id =
      Number(req.params.id);


    if (!Number.isInteger(id)) {

      return res.status(400).json({
        success: false,
        message: "Invalid product ID"
      });

    }


    db.query(
      `
      SELECT
        id,
        vendor_id
      FROM products
      WHERE id = ?
      AND status = 'pending'
      `,

      [id],

      (err, products) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message: "Database error"
          });

        }


        if (!products.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending product not found"
          });

        }


        const vendorId =
          products[0].vendor_id;


        db.query(
          `
          UPDATE products
          SET status = 'approved'
          WHERE id = ?
          `,

          [id],

          (updateErr) => {

            if (updateErr) {

              console.error(updateErr);

              return res.status(500).json({
                success: false,
                message:
                  "Product approval failed"
              });

            }


            db.query(
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
                vendorId,
                "Your product has been approved ✅",
                "product"
              ],

              (notificationErr) => {

                if (notificationErr) {

                  console.error(
                    "Notification error:",
                    notificationErr
                  );

                }

              }
            );


            res.json({
              success: true,
              message:
                "Product approved"
            });

          }
        );

      }
    );

  }
);


/* =========================================================
   REJECT PRODUCT
   POST /api/admin/products/reject/:id
========================================================= */

router.post(
  "/products/reject/:id",
  verifyAdmin,
  (req, res) => {

    const id =
      Number(req.params.id);


    if (!Number.isInteger(id)) {

      return res.status(400).json({
        success: false,
        message: "Invalid product ID"
      });

    }


    db.query(
      `
      SELECT
        id,
        vendor_id
      FROM products
      WHERE id = ?
      AND status = 'pending'
      `,

      [id],

      (err, products) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message: "Database error"
          });

        }


        if (!products.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending product not found"
          });

        }


        const vendorId =
          products[0].vendor_id;


        db.query(
          `
          UPDATE products
          SET status = 'rejected'
          WHERE id = ?
          `,

          [id],

          (updateErr) => {

            if (updateErr) {

              return res.status(500).json({
                success: false,
                message:
                  "Product rejection failed"
              });

            }


            db.query(
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
                vendorId,
                "Your product was rejected ❌",
                "product"
              ],

              (notificationErr) => {

                if (notificationErr) {

                  console.error(
                    "Notification error:",
                    notificationErr
                  );

                }

              }
            );


            res.json({
              success: true,
              message:
                "Product rejected"
            });

          }
        );

      }
    );

  }
);


/* =========================================================
   APPROVE VENDOR
   POST /api/admin/vendors/approve/:id

   IMPORTANT:
   If the applicant is already an administrator,
   KEEP role='admin'.

   Otherwise:
   role='vendor'.

   In both cases:
   vendor_status='approved'.
========================================================= */

router.post(
  "/vendors/approve/:id",
  verifyAdmin,
  (req, res) => {

    const id =
      Number(req.params.id);


    if (
      !Number.isInteger(id)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid vendor ID"
      });

    }


    db.query(
      `
      SELECT
        id,
        name,
        role,
        admin_level,
        status,
        vendor_status
      FROM users
      WHERE id=?
      AND vendor_status='pending'
      LIMIT 1
      `,
      [id],

      (lookupErr, users) => {

        if (lookupErr) {

          console.error(
            "Vendor approval lookup error:",
            lookupErr
          );

          return res.status(500).json({
            success: false,
            message:
              "Vendor approval failed"
          });

        }


        if (!users.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending vendor not found"
          });

        }


        const applicant =
          users[0];


        /*
         * CRITICAL:
         *
         * Admin remains admin.
         * Super Admin remains admin.
         * Normal buyer becomes vendor.
         */

        const newRole =
          applicant.role === "admin"
            ? "admin"
            : "vendor";


        db.query(
          `
          UPDATE users
          SET
            role=?,
            status='approved',
            vendor_status='approved',
            vendor_reviewed_at=CURRENT_TIMESTAMP,
            vendor_reviewed_by=?,
            vendor_rejection_reason=NULL
          WHERE id=?
          AND vendor_status='pending'
          `,
          [
            newRole,
            req.user.id,
            id
          ],

          (err, result) => {

            if (err) {

              console.error(
                "Vendor approval update error:",
                err
              );

              return res.status(500).json({
                success: false,
                message:
                  "Vendor approval failed"
              });

            }


            if (
              !result.affectedRows
            ) {

              return res.status(404).json({
                success: false,
                message:
                  "Pending vendor not found"
              });

            }


            db.query(
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
                id,
                "Your vendor application has been approved 🎉",
                "vendor"
              ],
              notificationErr => {

                if (notificationErr) {

                  console.error(
                    "Vendor approval notification error:",
                    notificationErr
                  );

                }

              }
            );


            res.json({
              success: true,
              message:
                "Vendor approved"
            });

          }
        );

      }
    );

  }
);


/* =========================================================
   REJECT VENDOR
   POST /api/admin/vendors/reject/:id
========================================================= */

router.post(
  "/vendors/reject/:id",
  verifyAdmin,
  (req, res) => {

    const id =
      Number(req.params.id);


    if (
      !Number.isInteger(id)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid vendor ID"
      });

    }


    const reason =
      String(
        req.body?.reason ||
        "Vendor application rejected by Admin"
      )
        .trim()
        .slice(0, 500);


    db.query(
      `
      UPDATE users
      SET
        vendor_status='rejected',
        vendor_reviewed_at=CURRENT_TIMESTAMP,
        vendor_reviewed_by=?,
        vendor_rejection_reason=?
      WHERE id=?
      AND vendor_status='pending'
      `,
      [
        req.user.id,
        reason,
        id
      ],

      (err, result) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message:
              "Vendor rejection failed"
          });

        }


        if (
          !result.affectedRows
        ) {

          return res.status(404).json({
            success: false,
            message:
              "Pending vendor not found"
          });

        }


        db.query(
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
            id,
            `Your vendor application was rejected ❌ ${reason}`,
            "vendor"
          ],
          notificationErr => {

            if (notificationErr) {

              console.error(
                "Vendor rejection notification error:",
                notificationErr
              );

            }

          }
        );


        res.json({
          success: true,
          message:
            "Vendor rejected"
        });

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   GET PENDING ADMIN REQUESTS
   GET /api/admin/admin-requests
========================================================= */

router.get(
  "/admin-requests",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        ar.id,
        ar.requested_by,
        ar.pi_username,
        ar.pi_uid,
        ar.admin_level,
        ar.status,
        ar.approved_by,
        ar.created_at,
        ar.approved_at,

        u.name AS requester_name,
        u.email AS requester_email

      FROM admin_requests ar

      LEFT JOIN users u
        ON ar.requested_by = u.id

      WHERE ar.status = 'pending'

      ORDER BY ar.created_at DESC
      `,

      (err, requests) => {

        if (err) {

          console.error(
            "Admin requests error:",
            err
          );

          return res.status(500).json({
            success: false,
            message:
              "Failed to load admin requests"
          });

        }


        res.json({

          success: true,

          requests:
            requests || []

        });

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   APPROVE ADMIN REQUEST

   POST /api/admin/admin-requests/:id/approve
========================================================= */

router.post(
  "/admin-requests/:id/approve",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const requestId =
      Number(req.params.id);


    if (
      !Number.isInteger(requestId)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid request ID"
      });

    }


    db.query(
      `
      SELECT *
      FROM admin_requests
      WHERE id = ?
      AND status = 'pending'
      LIMIT 1
      `,

      [requestId],

      (err, requests) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message:
              "Database error"
          });

        }


        if (!requests.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending admin request not found"
          });

        }


        const request =
          requests[0];


        const requestedLevel =
          request.admin_level;


        if (
          requestedLevel !== "admin" &&
          requestedLevel !== "moderator"
        ) {

          return res.status(400).json({
            success: false,
            message:
              "Invalid administrator level"
          });

        }


        db.query(
          `
          SELECT *
          FROM users
          WHERE id = ?
          LIMIT 1
          `,

          [request.requested_by],

          (userErr, users) => {

            if (userErr) {

              console.error(userErr);

              return res.status(500).json({
                success: false,
                message:
                  "Failed to load requesting user"
              });

            }


            if (!users.length) {

              return res.status(404).json({
                success: false,
                message:
                  "Requesting user no longer exists"
              });

            }


            const user =
              users[0];


            if (
              user.status === "rejected"
            ) {

              return res.status(400).json({
                success: false,
                message:
                  "Requesting account is rejected"
              });

            }


            /*
             * IMPORTANT:
             *
             * We only change administrator fields.
             *
             * vendor_status is NOT touched.
             *
             * Therefore a vendor can become an admin
             * without losing vendor access.
             */

            db.query(
              `
              UPDATE users

              SET
                role = 'admin',
                status = 'approved',
                admin_level = ?

              WHERE id = ?
              `,

              [
                requestedLevel,
                user.id
              ],

              (updateErr) => {

                if (updateErr) {

                  console.error(
                    "Admin promotion error:",
                    updateErr
                  );

                  return res.status(500).json({
                    success: false,
                    message:
                      "Failed to approve administrator"
                  });

                }


                db.query(
                  `
                  UPDATE admin_requests

                  SET
                    status = 'approved',
                    approved_by = ?,
                    approved_at = CURRENT_TIMESTAMP

                  WHERE id = ?
                  `,

                  [
                    req.user.id,
                    requestId
                  ],

                  (requestErr) => {

                    if (requestErr) {

                      console.error(
                        "Request update error:",
                        requestErr
                      );

                      return res.status(500).json({
                        success: false,
                        message:
                          "Administrator approved but request update failed"
                      });

                    }


                    db.query(
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
                        user.id,
                        `Your request to become an ${requestedLevel} has been approved by the Super Admin. 🎉`,
                        "admin"
                      ],

                      (notificationErr) => {

                        if (notificationErr) {

                          console.error(
                            "Notification error:",
                            notificationErr
                          );

                        }

                      }
                    );


                    return res.json({

                      success: true,

                      message:
                        "Administrator request approved successfully"

                    });

                  }
                );

              }
            );

          }
        );

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   REJECT ADMIN REQUEST

   POST /api/admin/admin-requests/:id/reject
========================================================= */

router.post(
  "/admin-requests/:id/reject",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const requestId =
      Number(req.params.id);


    if (
      !Number.isInteger(requestId)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid request ID"
      });

    }


    db.query(
      `
      SELECT
        id,
        requested_by,
        pi_username,
        admin_level
      FROM admin_requests
      WHERE id = ?
      AND status = 'pending'
      LIMIT 1
      `,

      [requestId],

      (err, requests) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message:
              "Database error"
          });

        }


        if (!requests.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending admin request not found"
          });

        }


        const request =
          requests[0];


        db.query(
          `
          UPDATE admin_requests

          SET
            status = 'rejected',
            approved_by = ?,
            approved_at = CURRENT_TIMESTAMP

          WHERE id = ?
          `,

          [
            req.user.id,
            requestId
          ],

          (updateErr) => {

            if (updateErr) {

              console.error(updateErr);

              return res.status(500).json({
                success: false,
                message:
                  "Failed to reject admin request"
              });

            }


            db.query(
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
                request.requested_by,
                `Your request to become an ${request.admin_level} has been rejected by the Super Admin.`,
                "admin"
              ],

              (notificationErr) => {

                if (notificationErr) {

                  console.error(
                    "Notification error:",
                    notificationErr
                  );

                }

              }
            );


            res.json({

              success: true,

              message:
                "Administrator request rejected"

            });

          }
        );

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   LIST ADMINISTRATORS

   GET /api/admin/administrators
========================================================= */

router.get(
  "/administrators",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        id,
        name,
        email,
        role,
        status,
        pi_uid,
        pi_username,
        admin_level,
        vendor_status,
        created_at
      FROM users
      WHERE role = 'admin'
      ORDER BY
        admin_level DESC,
        created_at ASC
      `,

      (err, admins) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message:
              "Failed to load administrators"
          });

        }


        res.json({

          success: true,

          administrators:
            admins || []

        });

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   CHANGE ADMIN LEVEL

   POST /api/admin/administrators/:id/level
========================================================= */

router.post(
  "/administrators/:id/level",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const adminId =
      Number(req.params.id);

    const {
      admin_level
    } = req.body || {};


    if (
      !Number.isInteger(adminId)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid administrator ID"
      });

    }


    if (
      admin_level !== "admin" &&
      admin_level !== "moderator"
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid administrator level"
      });

    }


    if (
      adminId === req.user.id
    ) {

      return res.status(400).json({
        success: false,
        message:
          "You cannot change your own administrator level"
      });

    }


    db.query(
      `
      SELECT
        id,
        role,
        admin_level,
        status
      FROM users
      WHERE id = ?
      AND role = 'admin'
      LIMIT 1
      `,

      [adminId],

      (err, admins) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message:
              "Database error"
          });

        }


        if (!admins.length) {

          return res.status(404).json({
            success: false,
            message:
              "Administrator not found"
          });

        }


        db.query(
          `
          UPDATE users

          SET
            admin_level = ?,
            status = 'approved'

          WHERE id = ?
          AND role = 'admin'
          `,

          [
            admin_level,
            adminId
          ],

          (updateErr) => {

            if (updateErr) {

              console.error(updateErr);

              return res.status(500).json({
                success: false,
                message:
                  "Failed to update administrator"
              });

            }


            res.json({

              success: true,

              message:
                `Administrator changed to ${admin_level}`

            });

          }
        );

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   REMOVE ADMINISTRATOR

   POST /api/admin/administrators/:id/remove

   IMPORTANT:
   If the administrator is also an approved vendor,
   preserve vendor role/access.

   ADMIN + VENDOR
   becomes
   VENDOR

   ADMIN ONLY
   becomes
   BUYER
========================================================= */

router.post(
  "/administrators/:id/remove",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const adminId =
      Number(req.params.id);


    if (
      !Number.isInteger(adminId)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid administrator ID"
      });

    }


    if (
      adminId === req.user.id
    ) {

      return res.status(400).json({
        success: false,
        message:
          "You cannot remove yourself"
      });

    }


    db.query(
      `
      SELECT
        id,
        name,
        pi_username,
        admin_level,
        vendor_status
      FROM users
      WHERE id = ?
      AND role = 'admin'
      LIMIT 1
      `,

      [adminId],

      (err, admins) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message:
              "Database error"
          });

        }


        if (!admins.length) {

          return res.status(404).json({
            success: false,
            message:
              "Administrator not found"
          });

        }


        const admin =
          admins[0];


        if (
          admin.admin_level ===
          "super_admin"
        ) {

          return res.status(403).json({
            success: false,
            message:
              "Super Admin accounts require special handling"
          });

        }


        /*
         * IMPORTANT:
         *
         * If the administrator is also an approved
         * vendor, preserve vendor role.
         *
         * Otherwise become buyer.
         */

        const newRole =
          admin.vendor_status === "approved"
            ? "vendor"
            : "buyer";


        db.query(
          `
          UPDATE users

          SET
            role = ?,
            status = 'approved',
            admin_level = 'none'

          WHERE id = ?
          AND role = 'admin'
          `,

          [
            newRole,
            adminId
          ],

          (updateErr) => {

            if (updateErr) {

              console.error(updateErr);

              return res.status(500).json({
                success: false,
                message:
                  "Failed to remove administrator"
              });

            }


            db.query(
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
                adminId,
                "Your administrator access has been removed by the Super Admin.",
                "admin"
              ],

              (notificationErr) => {

                if (notificationErr) {

                  console.error(
                    "Notification error:",
                    notificationErr
                  );

                }

              }
            );


            res.json({

              success: true,

              message:
                "Administrator access removed"

            });

          }
        );

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   SEND ADMIN INVITATION

   POST /api/admin/invitations

   Supports:
   - Pi UID
   - Pi username
   - Existing marketplace users
   - New users when Pi UID is supplied
========================================================= */

router.post(
  "/invitations",
  verifyAdmin,
  requireSuperAdmin,
  async (req, res) => {

    const {
      pi_uid,
      pi_username,
      admin_level
    } = req.body || {};


    const cleanPiUid =
      pi_uid
        ? String(pi_uid).trim()
        : "";

    const cleanUsername =
      pi_username
        ? String(pi_username).trim()
        : "";


    const requestedLevel =
      admin_level === "moderator"
        ? "moderator"
        : "admin";


    if (
      !cleanPiUid &&
      !cleanUsername
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Pi username or Pi UID is required"

      });

    }


    try {

      let targetUser = null;


      /* =====================================================
         FIND BY PI UID
      ===================================================== */

      if (cleanPiUid) {

        const [uidRows] =
          await db.promise().query(
            `
            SELECT
              id,
              name,
              email,
              role,
              status,
              pi_uid,
              pi_username,
              admin_level,
              vendor_status
            FROM users
            WHERE pi_uid = ?
            LIMIT 1
            `,
            [cleanPiUid]
          );


        if (uidRows.length) {

          targetUser =
            uidRows[0];

        }

      }


      /* =====================================================
         FIND BY PI USERNAME
      ===================================================== */

      if (
        !targetUser &&
        cleanUsername
      ) {

        const [usernameRows] =
          await db.promise().query(
            `
            SELECT
              id,
              name,
              email,
              role,
              status,
              pi_uid,
              pi_username,
              admin_level,
              vendor_status
            FROM users
            WHERE LOWER(pi_username) = LOWER(?)
            LIMIT 1
            `,
            [cleanUsername]
          );


        if (usernameRows.length) {

          targetUser =
            usernameRows[0];

        }

      }


      /* =====================================================
         IF USER EXISTS
      ===================================================== */

      if (targetUser) {

        if (
          !targetUser.pi_uid
        ) {

          return res.status(400).json({

            success: false,

            message:
              "This user does not yet have a verified Pi UID. Ask the user to sign in with Pi first."

          });

        }


        if (
          cleanPiUid &&
          String(targetUser.pi_uid) !==
          String(cleanPiUid)
        ) {

          return res.status(409).json({

            success: false,

            message:
              "Pi username and Pi UID belong to different accounts"

          });

        }


        targetUser.pi_uid =
          String(targetUser.pi_uid);

      }


      /* =====================================================
         NEW USER
      ===================================================== */

      if (!targetUser) {

        if (!cleanPiUid) {

          return res.status(404).json({

            success: false,

            message:
              "This Pi user is not registered in the marketplace yet. Ask the user to sign in once, then send the invitation again, or provide the user's Pi UID."

          });

        }

      }


      const finalPiUid =
        targetUser
          ? String(targetUser.pi_uid)
          : cleanPiUid;


      const finalUsername =
        targetUser?.pi_username ||
        cleanUsername ||
        null;


      /* =====================================================
         PREVENT SELF-INVITATION
      ===================================================== */

      if (
        req.user.pi_uid &&
        String(req.user.pi_uid) ===
        finalPiUid
      ) {

        return res.status(400).json({

          success: false,

          message:
            "You cannot invite yourself"

        });

      }


      /* =====================================================
         ALREADY ADMIN?
      ===================================================== */

      if (
        targetUser &&
        targetUser.role === "admin"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "This Pi account is already an administrator"

        });

      }


      /* =====================================================
         CHECK EXISTING PENDING INVITATION
      ===================================================== */

      const [existingInvitations] =
        await db.promise().query(
          `
          SELECT
            id,
            admin_level,
            status,
            expires_at
          FROM admin_invitations
          WHERE invited_pi_uid = ?
          AND status = 'pending'
          AND expires_at > NOW()
          LIMIT 1
          `,
          [finalPiUid]
        );


      if (
        existingInvitations.length
      ) {

        return res.status(409).json({

          success: false,

          message:
            "This Pi account already has a pending invitation"

        });

      }


      /* =====================================================
         CREATE INVITATION
      ===================================================== */

      const [insertResult] =
        await db.promise().query(
          `
          INSERT INTO admin_invitations
          (
            invited_pi_uid,
            invited_pi_username,
            invited_by,
            admin_level,
            status,
            expires_at
          )
          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            'pending',
            DATE_ADD(NOW(), INTERVAL 7 DAY)
          )
          `,
          [
            finalPiUid,
            finalUsername,
            req.user.id,
            requestedLevel
          ]
        );


      const invitationId =
        insertResult.insertId;


      /* =====================================================
         CREATE NORMAL NOTIFICATION
      ===================================================== */

      if (
        targetUser
      ) {

        try {

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
              targetUser.id,

              `You have received an invitation from the Super Admin to apply for ${requestedLevel} access.`,

              "admin_invitation"
            ]
          );

        } catch (
          notificationError
        ) {

          console.error(
            "Admin invitation notification error:",
            notificationError
          );

        }

      }


      return res.status(201).json({

        success: true,

        message:
          `Admin invitation created successfully for ${finalUsername || finalPiUid}`,

        invitation: {

          id:
            invitationId,

          pi_uid:
            finalPiUid,

          pi_username:
            finalUsername,

          admin_level:
            requestedLevel,

          status:
            "pending"

        }

      });


    } catch (error) {

      console.error(
        "Admin invitation creation error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Failed to create admin invitation"

      });

    }

  }
);


/* =========================================================
   SUPER ADMIN
   GET ADMIN INVITATIONS

   GET /api/admin/invitations
========================================================= */

router.get(
  "/invitations",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    db.query(
      `
      SELECT
        ai.id,
        ai.invited_pi_uid,
        ai.invited_pi_username,
        ai.admin_level,
        ai.status,
        ai.expires_at,
        ai.accepted_at,
        ai.revoked_at,
        ai.created_at,

        u.name AS invited_name,
        u.email AS invited_email,

        inviter.name AS invited_by_name,
        inviter.pi_username AS invited_by_username

      FROM admin_invitations ai

      LEFT JOIN users u
        ON ai.invited_pi_uid = u.pi_uid

      LEFT JOIN users inviter
        ON ai.invited_by = inviter.id

      ORDER BY ai.created_at DESC
      `,

      (err, invitations) => {

        if (err) {

          console.error(
            "Load invitations error:",
            err
          );

          return res.status(500).json({
            success: false,
            message:
              "Failed to load invitations"
          });

        }


        res.json({

          success: true,

          invitations:
            invitations || []

        });

      }
    );

  }
);


/* =========================================================
   SUPER ADMIN
   REVOKE INVITATION

   POST /api/admin/invitations/:id/revoke
========================================================= */

router.post(
  "/invitations/:id/revoke",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const invitationId =
      Number(req.params.id);


    if (
      !Number.isInteger(invitationId)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid invitation ID"
      });

    }


    db.query(
      `
      SELECT
        id,
        invited_pi_uid,
        invited_pi_username,
        status
      FROM admin_invitations
      WHERE id = ?
      AND status = 'pending'
      LIMIT 1
      `,
      [invitationId],

      (err, invitations) => {

        if (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            message:
              "Database error"
          });

        }


        if (!invitations.length) {

          return res.status(404).json({
            success: false,
            message:
              "Pending invitation not found"
          });

        }


        const invitation =
          invitations[0];


        db.query(
          `
          UPDATE admin_invitations
          SET
            status = 'revoked',
            revoked_at = CURRENT_TIMESTAMP
          WHERE id = ?
          AND status = 'pending'
          `,
          [invitationId],

          (updateErr, result) => {

            if (updateErr) {

              console.error(
                "Revoke invitation error:",
                updateErr
              );

              return res.status(500).json({
                success: false,
                message:
                  "Failed to revoke invitation"
              });

            }


            if (
              !result.affectedRows
            ) {

              return res.status(404).json({
                success: false,
                message:
                  "Pending invitation not found"
              });

            }


            db.query(
              `
              SELECT id
              FROM users
              WHERE pi_uid = ?
              LIMIT 1
              `,
              [invitation.invited_pi_uid],

              (userErr, users) => {

                if (
                  !userErr &&
                  users.length
                ) {

                  db.query(
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
                      users[0].id,
                      "Your administrator invitation has been revoked by the Super Admin.",
                      "admin_invitation"
                    ]
                  );

                }

              }
            );


            return res.json({

              success: true,

              message:
                "Invitation revoked successfully"

            });

          }
        );

      }
    );

  }
);


module.exports = router;