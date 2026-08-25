const router = require("express").Router();
const db = require("../config/db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { verifyToken, verifyAdmin } = require("../middleware/auth.middleware");

const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(
      null,
      `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(
        new Error("Only JPG, PNG and WEBP images are allowed")
      );
    }
    cb(null, true);
  }
});

function publicImage(pathValue) {
  if (!pathValue) return null;

  // If database already contains a complete URL,
  // return it unchanged.
  if (/^https?:\/\//i.test(pathValue)) {
    return pathValue;
  }

  const backendUrl =
    process.env.BACKEND_URL ||
    "https://charcoal-marketplace-main-production.up.railway.app";

  const cleanPath = pathValue.startsWith("/")
    ? pathValue
    : `/${pathValue}`;

  return `${backendUrl}${cleanPath}`;
}

/* Vendor/admin product creation. */
router.post("/", verifyToken(["vendor", "admin"]), (req, res) => {
  upload.single("image")(req, res, err => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "Image upload error"
      });
    }

    const {
      name,
      description = "",
      category = null,
      product_type = null,
      price_pi,
      price_ngn = null,
      location = "",
      unit = null,
      stock
    } = req.body || {};

    const price = Number(price_pi);
    const qty = Number(stock);

    if (
      !name?.trim() ||
      !location?.trim() ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isInteger(qty) ||
      qty < 0 ||
      !req.file
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Valid name, price, location, stock and image are required"
      });
    }

    const status =
      req.user.role === "admin" ? "approved" : "pending";

    const image = `/uploads/${req.file.filename}`;

    db.query(
      `INSERT INTO products
       (vendor_id,name,description,category,product_type,
        price_pi,price_ngn,stock,unit,image,location,status,is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,TRUE)`,
      [
        req.user.id,
        name.trim(),
        description.trim(),
        category?.trim() || null,
        product_type?.trim() || null,
        price,
        price_ngn === "" || price_ngn == null ? null : Number(price_ngn),
        qty,
        unit?.trim() || null,
        image,
        location.trim(),
        status
      ],
      (e, r) => {
        if (e) {
          console.error("Product create:", e);
          try {
            fs.unlinkSync(path.join(uploadDir, req.file.filename));
          } catch {}
          return res.status(500).json({
            success: false,
            message: "Failed to create product"
          });
        }

        res.status(201).json({
          success: true,
          product_id: r.insertId,
          status,
          message:
            status === "approved"
              ? "Product published"
              : "Product submitted for Admin approval"
        });
      }
    );
  });
});

/* Public approved products. */
router.get("/", (req, res) => {
  db.query(
    `SELECT
       p.*,
       u.name AS vendor_name,
       u.pi_username AS vendor_pi_username
     FROM products p
     LEFT JOIN users u ON p.vendor_id=u.id
     WHERE p.status='approved'
       AND p.is_active=TRUE
       AND p.stock >= 0
     ORDER BY p.id DESC`,
    (err, rows) => {
      if (err) {
        console.error("Products list:", err);
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(
        (rows || []).map(p => ({
          ...p,
          image: publicImage(p.image)
        }))
      );
    }
  );
});

/* Vendor's own products. */
router.get("/my", verifyToken(["vendor"]), (req, res) => {
  db.query(
    `SELECT *
     FROM products
     WHERE vendor_id=?
     ORDER BY id DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        console.error("My products:", err);
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(
        (rows || []).map(p => ({
          ...p,
          image: publicImage(p.image)
        }))
      );
    }
  );
});

/* Admin approval. */
router.post("/admin/approve/:id", verifyAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid product ID"
    });
  }

  db.query(
    `SELECT id,vendor_id
     FROM products
     WHERE id=? AND status='pending'
     LIMIT 1`,
    [id],
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
          message: "Pending product not found"
        });
      }

      db.query(
        `UPDATE products
         SET status='approved',
             approved_at=CURRENT_TIMESTAMP,
             approved_by=?
         WHERE id=?`,
        [req.user.id, id],
        updateErr => {
          if (updateErr) {
            return res.status(500).json({
              success: false,
              message: "Product approval failed"
            });
          }

          db.query(
            `INSERT INTO notifications(user_id,message,type)
             VALUES (?,?,?)`,
            [
              rows[0].vendor_id,
              "Your product has been approved ✅",
              "product"
            ],
            () => {}
          );

          res.json({
            success: true,
            message: "Product approved"
          });
        }
      );
    }
  );
});

/* Admin rejection. */
router.post("/admin/reject/:id", verifyAdmin, (req, res) => {
  const id = Number(req.params.id);
  const reason = String(
    req.body?.reason || "Product rejected by Admin"
  ).trim().slice(0, 500);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid product ID"
    });
  }

  db.query(
    `SELECT id,vendor_id
     FROM products
     WHERE id=? AND status='pending'
     LIMIT 1`,
    [id],
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
          message: "Pending product not found"
        });
      }

      db.query(
        `UPDATE products
         SET status='rejected',
             rejection_reason=?
         WHERE id=?`,
        [reason, id],
        updateErr => {
          if (updateErr) {
            return res.status(500).json({
              success: false,
              message: "Product rejection failed"
            });
          }

          db.query(
            `INSERT INTO notifications(user_id,message,type)
             VALUES (?,?,?)`,
            [
              rows[0].vendor_id,
              `Your product was rejected ❌ ${reason}`,
              "product"
            ],
            () => {}
          );

          res.json({
            success: true,
            message: "Product rejected"
          });
        }
      );
    }
  );
});

/* Admin pending products. */
router.get("/admin/pending", verifyAdmin, (req, res) => {
  db.query(
    `SELECT
       p.*,
       u.name AS vendor_name,
       u.email AS vendor_email,
       u.pi_username
     FROM products p
     LEFT JOIN users u ON p.vendor_id=u.id
     WHERE p.status='pending'
     ORDER BY p.created_at DESC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "DB error"
        });
      }

      res.json(
        (rows || []).map(p => ({
          ...p,
          image: publicImage(p.image)
        }))
      );
    }
  );
});

module.exports = router;
