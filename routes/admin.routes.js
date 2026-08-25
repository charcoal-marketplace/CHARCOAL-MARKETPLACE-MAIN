const router = require("express").Router();

const db = require("../config/db");

const {
  verifyAdmin
} = require("../middleware/auth.middleware");

const {
  createA2UPayment,
  approvePayment,
  submitA2UPayment,
  completePayment,
  fetchPayment,
  getIncompleteServerPayments
} = require("../piService");


/* =========================================================
   HELPER: CHECK SUPER ADMIN
========================================================= */

function requireSuperAdmin(req, res, next) {

  if (!req.user) {

    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });

  }


  if (
    req.user.role !== "admin" ||
    req.user.admin_level !== "super_admin"
  ) {

    return res.status(403).json({
      success: false,
      message: "Super Admin access required"
    });

  }


  next();

}


/* =========================================================
   ADMIN IDENTITY
   GET /api/admin/me
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
            created_at: admin.created_at
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


        db.query(
          `
          SELECT COUNT(*) AS count
          FROM users
          WHERE role = 'vendor'
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
========================================================= */

router.get(
  "/vendors/pending",
  verifyAdmin,
  (req,res)=>{
    db.query(
      `SELECT
        id,name,email,role,status,pi_uid,pi_username,
        vendor_status,business_name,business_phone,business_location,
        business_description,vendor_applied_at
       FROM users
       WHERE vendor_status='pending'
       ORDER BY vendor_applied_at DESC`,
      (err,result)=>{
        if(err){
          console.error(err);
          return res.status(500).json({success:false,message:"Failed to load pending vendors"});
        }
        res.json(result||[]);
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
========================================================= */

router.post("/vendors/approve/:id",verifyAdmin,(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)) return res.status(400).json({success:false,message:"Invalid vendor ID"});

  db.query(
    `UPDATE users
     SET role='vendor',status='approved',vendor_status='approved',
         vendor_reviewed_at=CURRENT_TIMESTAMP,vendor_reviewed_by=?,
         vendor_rejection_reason=NULL
     WHERE id=? AND vendor_status='pending'`,
    [req.user.id,id],
    (err,result)=>{
      if(err) return res.status(500).json({success:false,message:"Vendor approval failed"});
      if(!result.affectedRows) return res.status(404).json({success:false,message:"Pending vendor not found"});

      db.query(
        `INSERT INTO notifications(user_id,message,type) VALUES (?,?,?)`,
        [id,"Your vendor application has been approved 🎉","vendor"],
        ()=>{}
      );

      res.json({success:true,message:"Vendor approved"});
    }
  );
});


/* =========================================================
   REJECT VENDOR
   POST /api/admin/vendors/reject/:id
========================================================= */

router.post("/vendors/reject/:id",verifyAdmin,(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)) return res.status(400).json({success:false,message:"Invalid vendor ID"});

  const reason=String(req.body?.reason||"Vendor application rejected by Admin").trim().slice(0,500);

  db.query(
    `UPDATE users
     SET vendor_status='rejected',
         vendor_reviewed_at=CURRENT_TIMESTAMP,
         vendor_reviewed_by=?,
         vendor_rejection_reason=?
     WHERE id=? AND vendor_status='pending'`,
    [req.user.id,reason,id],
    (err,result)=>{
      if(err) return res.status(500).json({success:false,message:"Vendor rejection failed"});
      if(!result.affectedRows) return res.status(404).json({success:false,message:"Pending vendor not found"});

      db.query(
        `INSERT INTO notifications(user_id,message,type) VALUES (?,?,?)`,
        [id,`Your vendor application was rejected ❌ ${reason}`,"vendor"],
        ()=>{}
      );

      res.json({success:true,message:"Vendor rejected"});
    }
  );
});


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


        /*
          Only admin or moderator
          can be created through
          this request system.
        */

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


            /*
              Make sure the requester
              has not already been
              deleted or disabled.
            */

            if (
              user.status === "rejected"
            ) {

              return res.status(400).json({
                success: false,
                message:
                  "Requesting account is rejected"
              });

            }


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


                    /*
                      Notify requester.
                    */

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


            /*
              Notify requester.
            */

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


    /*
      Super Admin cannot
      downgrade themselves.
    */

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


    /*
      Super Admin cannot
      remove themselves.
    */

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
        admin_level
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


        /*
          Do not allow another
          super_admin to be removed
          using this simple endpoint.
        */

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


        db.query(
          `
          UPDATE users

          SET
            role = 'buyer',
            status = 'approved',
            admin_level = 'none'

          WHERE id = ?
          AND role = 'admin'
          `,

          [adminId],

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
   EXPORT
========================================================= */

/* =========================================================
   SUPER ADMIN
   SEND ADMIN INVITATION

   POST /api/admin/invitations
========================================================= */

router.post(
  "/invitations",
  verifyAdmin,
  requireSuperAdmin,
  (req, res) => {

    const {
      pi_uid,
      pi_username,
      admin_level
    } = req.body || {};

    if (!pi_uid || !String(pi_uid).trim()) {

      return res.status(400).json({
        success: false,
        message: "Pi UID is required"
      });

    }

    const requestedLevel =
      admin_level === "moderator"
        ? "moderator"
        : "admin";

    const cleanPiUid =
      String(pi_uid).trim();

    const cleanUsername =
      pi_username
        ? String(pi_username).trim()
        : null;


    /*
     * Prevent inviting yourself.
     */

    if (
      req.user.pi_uid &&
      String(req.user.pi_uid) === cleanPiUid
    ) {

      return res.status(400).json({
        success: false,
        message:
          "You cannot invite yourself"
      });

    }


    /*
     * Check whether this Pi account exists.
     */

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
        admin_level
      FROM users
      WHERE pi_uid = ?
      LIMIT 1
      `,
      [cleanPiUid],

      (userErr, users) => {

        if (userErr) {

          console.error(
            "Invitation user lookup error:",
            userErr
          );

          return res.status(500).json({
            success: false,
            message:
              "Failed to find Pi account"
          });

        }


        /*
         * If account exists, make sure
         * it isn't already an administrator.
         */

        if (users.length) {

          const user =
            users[0];

          if (
            user.role === "admin"
          ) {

            return res.status(400).json({
              success: false,
              message:
                "This Pi account is already an administrator"
            });

          }

        }


        /*
         * Prevent duplicate active invitations.
         */

        db.query(
          `
          SELECT
            id
          FROM admin_invitations
          WHERE invited_pi_uid = ?
          AND status = 'pending'
          AND expires_at > NOW()
          LIMIT 1
          `,
          [cleanPiUid],

          (inviteCheckErr, existing) => {

            if (inviteCheckErr) {

              console.error(
                "Invitation check error:",
                inviteCheckErr
              );

              return res.status(500).json({
                success: false,
                message:
                  "Failed to check existing invitation"
              });

            }


            if (existing.length) {

              return res.status(409).json({
                success: false,
                message:
                  "This Pi account already has a pending invitation"
              });

            }


            /*
             * Invitation expires in 7 days.
             */

            db.query(
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
                ?, ?, ?, ?, 'pending',
                DATE_ADD(NOW(), INTERVAL 7 DAY)
              )
              `,
              [
                cleanPiUid,
                cleanUsername,
                req.user.id,
                requestedLevel
              ],

              (insertErr, result) => {

                if (insertErr) {

                  console.error(
                    "Invitation creation error:",
                    insertErr
                  );

                  return res.status(500).json({
                    success: false,
                    message:
                      "Failed to create invitation"
                  });

                }


                /*
                 * If the user already exists,
                 * create a notification immediately.
                 */

                if (users.length) {

                  const userId =
                    users[0].id;

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
                      userId,
                      `You have received an invitation from the Super Admin to apply for ${requestedLevel} access.`,
                      "admin_invitation"
                    ],
                    notificationErr => {

                      if (notificationErr) {

                        console.error(
                          "Invitation notification error:",
                          notificationErr
                        );

                      }

                    }
                  );

                }


                return res.status(201).json({

                  success: true,

                  message:
                    `Admin invitation sent successfully to ${cleanUsername || cleanPiUid}`,

                  invitation: {
                    id: result.insertId,
                    pi_uid: cleanPiUid,
                    pi_username: cleanUsername,
                    admin_level: requestedLevel,
                    status: "pending"
                  }

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


            /*
             * Notify the invited user if
             * the account exists.
             */

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

/* =========================================================
   VENDOR EARNINGS
   GET /api/admin/earnings/pending

   NORMAL ADMIN + SUPER ADMIN CAN VIEW
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

            p.business_name,
            p.pi_wallet_address

          FROM earnings e

          LEFT JOIN users u
            ON e.vendor_id = u.id

          LEFT JOIN users p
            ON e.vendor_id = p.id

          WHERE e.type = 'sale'
            AND e.status = 'pending'

          ORDER BY e.created_at ASC
          `
        );


      res.json({

        success: true,

        earnings:
          earnings || []

      });

    } catch (error) {

      console.error(
        "Pending vendor earnings:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to load pending vendor earnings"

      });

    }

  }
);

/* =========================================================
   RELEASE VENDOR EARNING
   POST /api/admin/earnings/:id/release

   NORMAL ADMIN + SUPER ADMIN CAN RELEASE

   MODERATOR CANNOT
========================================================= */

router.post(
  "/earnings/:id/release",
  verifyAdmin,
  async (req, res) => {

    const earningId =
      Number(req.params.id);


    if (!Number.isInteger(earningId)) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid earning ID"

      });

    }


    const connection =
      await db.promise().getConnection();


    let paymentId = null;
    let txid = null;


    try {

      /*
       * Make absolutely sure only actual
       * administrators can release funds.
       *
       * Super Admin:
       * allowed
       *
       * Normal Admin:
       * allowed
       *
       * Moderator:
       * denied
       */

      const [adminRows] =
        await connection.query(
          `
          SELECT
            id,
            role,
            status,
            admin_level
          FROM users
          WHERE id = ?
          LIMIT 1
          FOR UPDATE
          `,
          [req.user.id]
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
        admin.status !== "approved"
      ) {

        await connection.rollback();

        return res.status(403).json({

          success: false,

          message:
            "Administrator access denied"

        });

      }


      if (
        admin.admin_level !== "admin" &&
        admin.admin_level !== "super_admin"
      ) {

        await connection.rollback();

        return res.status(403).json({

          success: false,

          message:
            "Only Admin or Super Admin can release vendor earnings"

        });

      }


      /*
       * Lock the earning row.
       */

      await connection.beginTransaction();


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
      u.status AS vendor_status,
      u.vendor_status,
      u.pi_wallet_address

    FROM earnings e

    INNER JOIN users u
      ON e.vendor_id = u.id

    LEFT JOIN orders o
      ON e.order_id = o.id

    WHERE e.id = ?

    LIMIT 1

    FOR UPDATE
    `,
    [earningId]
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

      /*
 * =====================================================
 * BUYER RECEIPT CONFIRMATION
 * =====================================================
 *
 * Vendor earnings cannot be released until the
 * buyer has confirmed that the product was received.
 */

if (!earning.buyer_confirmed_at) {

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
      

      /*
       * Never pay something that is
       * already marked as paid.
       */

      if (
        earning.status === "paid"
      ) {

        await connection.rollback();

        return res.status(409).json({

          success: false,

          message:
            "This earning has already been paid",

          payout_txid:
            earning.payout_txid || null

        });

      }


      /*
       * Only sale earnings are released
       * to vendors.
       */

      if (
        earning.type !== "sale"
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "This earning is not a vendor sale earning"

        });

      }


      /*
       * Vendor must have an authenticated
       * Pi UID.
       */

      if (
        !earning.pi_uid
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "Vendor does not have a valid Pi UID"

        });

      }


      /*
       * Vendor must still be an approved vendor.
       */

      if (
        earning.vendor_role !== "vendor" ||
        earning.vendor_status !== "approved" ||
        earning.vendor_status === "rejected"
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "Vendor is not approved to receive earnings"

        });

      }


      const amount =
        Number(earning.amount_pi);


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        await connection.rollback();

        return res.status(400).json({

          success: false,

          message:
            "Invalid vendor earning amount"

        });

      }


      /*
       * Prevent a second payout if an
       * earlier A2U payment already exists.
       */

      if (
        earning.payout_payment_id
      ) {

        paymentId =
          earning.payout_payment_id;

      }


      await connection.commit();


      /*
       * =====================================================
       * A2U PAYMENT CREATION
       * =====================================================
       */

      if (!paymentId) {

        const payment =
          await createA2UPayment({

            uid:
              earning.pi_uid,

            amount,

            memo:
              `Vendor earnings payout #${earning.id}`,

            metadata: {

              type:
                "vendor_earnings",

              earning_id:
                earning.id,

              order_id:
                earning.order_id,

              vendor_id:
                earning.vendor_id

            }

          });


        paymentId =
          payment.identifier;


        /*
         * Store payment ID immediately.
         *
         * This is critical for preventing
         * accidental double payment.
         */

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_payment_id = ?,
            payout_error = NULL

          WHERE id = ?
            AND status = 'pending'
          `,
          [
            paymentId,
            earning.id
          ]
        );

      }


      /*
 * =====================================================
 * APPROVE A2U PAYMENT
 * =====================================================
 */

const currentPayment =
  await fetchPayment(
    paymentId
  );


if (!currentPayment) {

  throw new Error(
    "Unable to retrieve A2U payment before approval"
  );

}


/*
 * Do not approve again if Pi
 * already shows developer approval.
 */

if (
  currentPayment.status &&
  currentPayment.status.developer_approved !== true
) {

  await approvePayment(
    paymentId
  );

}
      
      /*
       * =====================================================
       * SUBMIT TO PI BLOCKCHAIN
       * =====================================================
       */

      const submission =
        await submitA2UPayment(
          paymentId
        );


      txid =
        submission.txid;


      /*
       * Store TXID immediately.
       */

      await db.promise().query(
        `
        UPDATE earnings

        SET
          payout_txid = ?,
          payout_error = NULL

        WHERE id = ?
        `,
        [
          txid,
          earning.id
        ]
      );


      /*
       * =====================================================
       * COMPLETE PAYMENT WITH PI
       * =====================================================
       */

      const completedPayment =
        await completePayment(
          paymentId,
          txid
        );


      /*
       * Verify completion.
       */

      const confirmed =
        await fetchPayment(
          paymentId
        );


      const completed =
        completedPayment &&
        confirmed &&
        confirmed.status &&
        confirmed.status.developer_completed === true;


      if (!completed) {

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_error = ?

          WHERE id = ?
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
            "Pi payout was submitted and is awaiting final Pi confirmation.",

          earning_id:
            earning.id,

          payment_id:
            paymentId,

          txid

        });

      }


      /*
       * =====================================================
       * MARK EARNING AS PAID
       * =====================================================
       */

      const [paidResult] =
        await db.promise().query(
          `
          UPDATE earnings

          SET
            status = 'paid',
            payout_payment_id = ?,
            payout_txid = ?,
            paid_at = CURRENT_TIMESTAMP,
            payout_error = NULL

          WHERE id = ?
            AND status = 'pending'
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


      /*
       * Notify vendor.
       */

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


      res.json({

        success: true,

        status:
          "paid",

        message:
          `Successfully released ${amount} Pi to ${earning.vendor_name}`,

        earning_id:
          earning.id,

        vendor_id:
          earning.vendor_id,

        amount_pi:
          amount,

        payment_id:
          paymentId,

        txid

      });


    } catch (error) {

      console.error(
        "Vendor A2U payout error:",
        error.response?.data ||
        error.message ||
        error
      );


      /*
       * Save the error without
       * falsely marking the earning as paid.
       */

      try {

        await db.promise().query(
          `
          UPDATE earnings

          SET
            payout_error = ?

          WHERE id = ?
            AND status = 'pending'
          `,
          [
            JSON.stringify(
              error.response?.data ||
              error.message ||
              "Unknown payout error"
            ).slice(0, 2000),

            earningId
          ]
        );

      } catch (dbError) {

        console.error(
          "Failed to save payout error:",
          dbError
        );

      }


      return res.status(500).json({

        success: false,

        message:
          "Vendor Pi payout failed",

        earning_id:
          earningId,

        payment_id:
          paymentId,

        txid

      });

    } finally {

      connection.release();

    }

  }
);

/* =========================================================
   SUPER ADMIN
   GET INCOMPLETE PI A2U PAYMENTS

   GET /api/admin/payments/incomplete

   Used to detect A2U payments that were created
   but were not completely processed.
========================================================= */

router.get(
  "/payments/incomplete",
  verifyAdmin,
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
        "Incomplete Pi A2U payments error:",
        error.response?.data ||
        error.message ||
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Failed to load incomplete Pi payments"

      });

    }

  }
);
module.exports = router;